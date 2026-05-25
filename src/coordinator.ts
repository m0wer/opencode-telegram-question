// Coordinator: produces a stream of Telegram updates either by long-polling
// (if we're the leader for this bot token) or by receiving them from the
// leader over IPC (if we're a follower). The caller drives a single loop
// that feeds updates to its controller without caring which role this
// process plays.
//
// Failover: when a follower's connection to the leader drops, the
// coordinator re-runs leader election. Whichever peer wins the listen()
// race becomes the new leader and resumes polling; the rest reconnect as
// followers. There is a brief window during failover where updates may
// be delayed (bounded by the long-poll timeout).

import { joinOrLead, ipcPathFor, type IPCRole, type IPCMessage } from "./ipc"
import type { TelegramClient, Update } from "./telegram"

export type CoordinatorDeps = {
  telegram: TelegramClient
  token: string
  signal: AbortSignal
  log?(level: "info" | "warn" | "error", msg: string, data?: unknown): void
  // Test seam: override the IPC path (default: ipcPathFor(token)).
  ipcPath?: string
}

// Runs the update pump until `signal` aborts. Each update produced by the
// leader (locally or remotely) is delivered to `onUpdate` exactly once
// per process.
export async function runCoordinator(deps: CoordinatorDeps, onUpdate: (u: Update) => Promise<void>): Promise<void> {
  const log = deps.log ?? (() => {})
  const path = deps.ipcPath ?? ipcPathFor(deps.token)

  while (!deps.signal.aborted) {
    let role: IPCRole
    try {
      role = await joinOrLead({ path })
    } catch (err) {
      log("error", "ipc bind/connect failed; falling back to standalone leader", String(err))
      await runAsLeader(deps, onUpdate, undefined)
      return
    }

    if (role.role === "leader") {
      log("info", "telegram-question: this process is the leader", { path, followers: role.followerCount() })
      await runAsLeader(deps, onUpdate, role)
      // runAsLeader returns when signal aborts.
      return
    }

    log("info", "telegram-question: this process is a follower", { path })
    const reelect = await runAsFollower(deps, role, onUpdate)
    if (!reelect) return
    // Leader died; loop and re-run election.
  }
}

async function runAsLeader(
  deps: CoordinatorDeps,
  onUpdate: (u: Update) => Promise<void>,
  role: IPCRole | undefined,
): Promise<void> {
  let offset = 0
  const log = deps.log ?? (() => {})
  while (!deps.signal.aborted) {
    try {
      const updates = await deps.telegram.getUpdates(offset, 30, deps.signal)
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        if (role && role.role === "leader") role.broadcast({ type: "update", data: u })
        await onUpdate(u).catch((err) => log("error", "leader update handler error", String(err)))
      }
    } catch (err) {
      if (deps.signal.aborted) break
      log("warn", "leader poll error, retrying in 5s", String(err))
      await sleep(5000, deps.signal)
    }
  }
  if (role && role.role === "leader") await role.close().catch(() => {})
}

// Returns true if the caller should re-run leader election (the leader
// died while we were following). Returns false on a clean abort.
async function runAsFollower(
  deps: CoordinatorDeps,
  role: IPCRole,
  onUpdate: (u: Update) => Promise<void>,
): Promise<boolean> {
  if (role.role !== "follower") return false
  const log = deps.log ?? (() => {})
  return await new Promise<boolean>((resolve) => {
    const offMsg = role.onMessage((m: IPCMessage) => {
      if (m.type !== "update") return
      const u = m.data as Update
      void onUpdate(u).catch((err) => log("error", "follower update handler error", String(err)))
    })
    const offDisc = role.onDisconnect(() => {
      offMsg()
      offDisc()
      if (deps.signal.aborted) resolve(false)
      else resolve(true)
    })
    deps.signal.addEventListener(
      "abort",
      () => {
        offMsg()
        offDisc()
        void role.close()
        resolve(false)
      },
      { once: true },
    )
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
