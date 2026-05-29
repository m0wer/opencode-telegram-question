import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { joinOrLead, ipcPathFor } from "../src/ipc"

function freshSocketPath(): { p: string; cleanup: () => void } {
  if (process.platform === "win32") {
    const id = Math.random().toString(36).slice(2)
    return { p: `\\\\?\\pipe\\opencode-telegram-test-${id}`, cleanup: () => {} }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "octq-ipc-"))
  return { p: path.join(dir, "s.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("ipc", () => {
  test("ipcPathFor is stable per token and varies between tokens", () => {
    expect(ipcPathFor("abc")).toEqual(ipcPathFor("abc"))
    expect(ipcPathFor("abc")).not.toEqual(ipcPathFor("def"))
  })

  test("first joiner is leader; second is follower; broadcast reaches follower", async () => {
    const { p, cleanup } = freshSocketPath()
    try {
      const leader = await joinOrLead({ path: p })
      expect(leader.role).toBe("leader")
      const follower = await joinOrLead({ path: p })
      expect(follower.role).toBe("follower")
      if (leader.role !== "leader" || follower.role !== "follower") throw new Error("role assertion")

      const received: unknown[] = []
      follower.onMessage((m) => received.push(m))
      // Give the leader a tick to register the new follower.
      await new Promise((r) => setTimeout(r, 50))
      expect(leader.followerCount()).toBe(1)

      leader.broadcast({ type: "update", data: { update_id: 7 } })
      await new Promise((r) => setTimeout(r, 50))
      expect(received).toEqual([{ type: "update", data: { update_id: 7 } }])

      await follower.close()
      await leader.close()
    } finally {
      cleanup()
    }
  })

  test("when leader exits, follower's onDisconnect fires so it can re-elect", async () => {
    const { p, cleanup } = freshSocketPath()
    try {
      const leader = await joinOrLead({ path: p })
      const follower = await joinOrLead({ path: p })
      if (follower.role !== "follower") throw new Error("role assertion")
      const disconnected = new Promise<void>((resolve) => follower.onDisconnect(() => resolve()))
      await leader.close()
      await disconnected
      // After the leader closes, a fresh joinOrLead should succeed as
      // leader again on the same path.
      const next = await joinOrLead({ path: p })
      expect(next.role).toBe("leader")
      await next.close()
      await follower.close()
    } finally {
      cleanup()
    }
  })

  test("heartbeat keeps a live follower connected and pongs back to the leader", async () => {
    const { p, cleanup } = freshSocketPath()
    try {
      // Fast heartbeat so the test runs quickly; a generous timeout so a
      // responsive follower is never falsely dropped.
      const hb = { heartbeatMs: 20, heartbeatTimeoutMs: 1000 }
      const leader = await joinOrLead({ path: p, ...hb })
      const follower = await joinOrLead({ path: p, ...hb })
      if (leader.role !== "leader" || follower.role !== "follower") throw new Error("role assertion")
      let disconnected = false
      follower.onDisconnect(() => {
        disconnected = true
      })
      // Let several ping/pong cycles elapse. The follower must NOT be
      // dropped, and the leader must still count it (pongs refresh lastSeen).
      await new Promise((r) => setTimeout(r, 200))
      expect(disconnected).toBe(false)
      expect(leader.followerCount()).toBe(1)
      // A broadcast after many heartbeats still reaches the follower.
      const received: unknown[] = []
      follower.onMessage((m) => received.push(m))
      leader.broadcast({ type: "update", data: { update_id: 99 } })
      await new Promise((r) => setTimeout(r, 50))
      expect(received).toEqual([{ type: "update", data: { update_id: 99 } }])
      await follower.close()
      await leader.close()
    } finally {
      cleanup()
    }
  })

  test("follower watchdog fires onDisconnect when the leader goes silent", async () => {
    const { p, cleanup } = freshSocketPath()
    try {
      // Leader with heartbeats disabled (never pings); follower with a very
      // short timeout. This simulates a wedged / half-open leader whose
      // socket stays open but produces no traffic.
      const leader = await joinOrLead({ path: p, heartbeatMs: 0 })
      const follower = await joinOrLead({ path: p, heartbeatMs: 20, heartbeatTimeoutMs: 60 })
      if (follower.role !== "follower") throw new Error("role assertion")
      const reason = await new Promise<Error | undefined>((resolve) => follower.onDisconnect((err) => resolve(err)))
      expect(String(reason)).toContain("heartbeat timeout")
      await follower.close()
      await leader.close()
    } finally {
      cleanup()
    }
  })
})
