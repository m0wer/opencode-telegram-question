import { describe, expect, test } from "bun:test"
import { makePermissionController, renderPermission, renderResolvedPermission, PERMISSION_CB } from "../src/permission"
import { makeFakeTelegram } from "./fake-telegram"

const CHAT = 4338540
const REQ = {
  id: "per_abc",
  sessionID: "ses_xyz",
  permission: "bash",
  patterns: ["rm -rf"],
  metadata: { command: "rm -rf /" },
}

describe("renderPermission", () => {
  test("includes the tool, patterns, and three buttons", () => {
    const r = renderPermission(REQ)
    expect(r.text).toContain("Permission requested")
    expect(r.text).toContain("Tool: bash")
    expect(r.text).toContain("rm -rf")
    expect(r.text).toContain("command:")
    expect(r.keyboard.flat().map((b) => b.callback_data)).toEqual([
      PERMISSION_CB.once,
      PERMISSION_CB.always,
      PERMISSION_CB.reject,
    ])
  })
})

describe("renderResolvedPermission", () => {
  test("once vs always vs reject distinct", () => {
    expect(renderResolvedPermission(REQ, "once")).toContain("Allowed once")
    expect(renderResolvedPermission(REQ, "always")).toContain("Allowed (always)")
    expect(renderResolvedPermission(REQ, "reject")).toContain("Rejected")
  })
})

describe("permission controller flow", () => {
  function setup() {
    const tg = makeFakeTelegram()
    const replies: { requestID: string; choice: string }[] = []
    const ctl = makePermissionController({
      telegram: tg,
      chatID: CHAT,
      reply: async (requestID, choice) => {
        replies.push({ requestID, choice })
      },
    })
    return { tg, ctl, replies }
  }

  test("ask sends one message; tap 'once' edits it, removes keyboard, and calls reply('once')", async () => {
    const { tg, ctl, replies } = setup()
    await ctl.onPermissionAsked(REQ)
    expect(tg.sent).toHaveLength(1)
    const m = tg.sent[0]
    expect(m.deleted).toBe(false)

    await ctl.handleCallback({
      update_id: 1,
      callback_query: {
        id: "cb1", from: { id: 1 },
        data: PERMISSION_CB.once,
        message: { message_id: m.message_id, chat: { id: CHAT } },
      },
    })

    expect(replies).toEqual([{ requestID: REQ.id, choice: "once" }])
    expect(tg.sent[0].keyboard).toBeUndefined()
    expect(tg.sent[0].text).toContain("Allowed once")
    expect(tg.sent[0].deleted).toBe(false)
  })

  test("CLI-side resolution deletes the stale chat message", async () => {
    const { tg, ctl } = setup()
    await ctl.onPermissionAsked(REQ)
    await ctl.onPermissionResolved(REQ.id)
    expect(tg.sent[0].deleted).toBe(true)
  })

  test("callbacks for unknown messages return false (let other controller handle them)", async () => {
    const { tg, ctl } = setup()
    await ctl.onPermissionAsked(REQ)
    const claimed = await ctl.handleCallback({
      update_id: 2,
      callback_query: {
        id: "cb2", from: { id: 1 },
        data: PERMISSION_CB.once,
        message: { message_id: 999999, chat: { id: CHAT } },
      },
    })
    expect(claimed).toBe(false)
  })

  test("foreign chat id is silently ignored", async () => {
    const { tg, ctl, replies } = setup()
    await ctl.onPermissionAsked(REQ)
    const claimed = await ctl.handleCallback({
      update_id: 3,
      callback_query: {
        id: "cb3", from: { id: 1 },
        data: PERMISSION_CB.once,
        message: { message_id: tg.sent[0].message_id, chat: { id: 999 } },
      },
    })
    expect(claimed).toBe(false)
    expect(replies).toHaveLength(0)
  })

  test("reply failure still tidies the chat", async () => {
    const tg = makeFakeTelegram()
    const ctl = makePermissionController({
      telegram: tg,
      chatID: CHAT,
      reply: async () => {
        throw new Error("already resolved")
      },
    })
    await ctl.onPermissionAsked(REQ)
    await ctl.handleCallback({
      update_id: 4,
      callback_query: {
        id: "cb4", from: { id: 1 },
        data: PERMISSION_CB.reject,
        message: { message_id: tg.sent[0].message_id, chat: { id: CHAT } },
      },
    })
    expect(tg.sent[0].deleted).toBe(true)
  })
})
