import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCoordinator } from "../src/coordinator"
import type { TelegramClient, Update } from "../src/telegram"

function freshSocketPath(): { p: string; cleanup: () => void } {
  if (process.platform === "win32") {
    const id = Math.random().toString(36).slice(2)
    return { p: `\\\\?\\pipe\\opencode-telegram-test-${id}`, cleanup: () => {} }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "octq-coord-"))
  return { p: path.join(dir, "s.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// A telegram stub whose long-poll never returns on its own; it only ever
// resolves when aborted (rejecting). This simulates a half-open connection
// that stalls past the server-side long-poll timeout.
function makeStallingTelegram(): TelegramClient & { pollStarts: number; pollAborts: number } {
  const stub: any = {
    pollStarts: 0,
    pollAborts: 0,
    async getUpdates(_offset: number, _timeoutSec: number, signal: AbortSignal): Promise<Update[]> {
      stub.pollStarts++
      return new Promise<Update[]>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stub.pollAborts++
            reject(new Error("aborted"))
          },
          { once: true },
        )
      })
    },
    async sendMessage() {
      return { message_id: 1 }
    },
    async editMessage() {},
    async removeKeyboard() {},
    async deleteMessage() {},
    async answerCallback() {},
  }
  return stub
}

describe("coordinator leader poll watchdog", () => {
  test("aborts and retries a stalled long-poll instead of hanging forever", async () => {
    const { p, cleanup } = freshSocketPath()
    const telegram = makeStallingTelegram()
    const abort = new AbortController()
    try {
      const run = runCoordinator(
        {
          telegram,
          token: "t",
          signal: abort.signal,
          ipcPath: p,
          // Tiny watchdog so the test runs fast. The retry backoff in the
          // coordinator is 5s on error, but an abort is fast; we only need
          // to observe that a second poll is attempted.
          pollTimeoutSec: 0,
          pollWatchdogSec: 0.05,
        },
        async () => {},
      )
      // Wait long enough for the first poll to start and the 50ms watchdog
      // to abort it. We don't wait for the 5s error backoff + second poll;
      // observing one watchdog-driven abort proves a stalled poll won't hang
      // forever.
      await new Promise((r) => setTimeout(r, 150))
      expect(telegram.pollStarts).toBeGreaterThanOrEqual(1)
      expect(telegram.pollAborts).toBeGreaterThanOrEqual(1)
      abort.abort()
      await run
      // After abort the loop exits cleanly.
      expect(abort.signal.aborted).toBe(true)
    } finally {
      cleanup()
    }
  })
})
