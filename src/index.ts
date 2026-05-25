// opencode plugin entry. Subscribes to question.asked / question.replied /
// question.rejected via the `event` hook and forwards each pending question
// to a Telegram chat. Answers may come back from either the CLI/TUI (in
// which case the Telegram messages are deleted) or from Telegram (in which
// case `client.question.reply` is called).
//
// Configuration is sourced from plugin options first, then env vars:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   OPENCODE_TELEGRAM_HISTORY  (optional, default 3)
//
// All log output is appended to a file under the user's state directory
// (XDG_STATE_HOME on POSIX, LOCALAPPDATA on Windows) so the opencode TUI
// stays clean. Tail the file to see what the plugin is doing.

import type { Plugin } from "@opencode-ai/plugin"
import { makeTelegramClient, type TelegramClient } from "./telegram"
import { makeController, type QuestionEvent } from "./controller"
import { makePermissionController, type PermissionRequest } from "./permission"
import { runCoordinator } from "./coordinator"
import { defaultLogFile, makeFileLogger } from "./log"
import { summarizePart } from "./render"

type Options = {
  botToken?: string
  chatId?: number | string
  historyMessages?: number
  // Allow tests / advanced users to swap the transport.
  telegram?: TelegramClient
  // Override the log file path. Default: see defaultLogFile().
  logFile?: string
}

const TelegramQuestionPlugin: Plugin = async (input, options) => {
  const opts = (options ?? {}) as Options
  const token = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN
  const chatIdRaw = opts.chatId ?? process.env.TELEGRAM_CHAT_ID
  const historyMessages = opts.historyMessages ?? Number(process.env.OPENCODE_TELEGRAM_HISTORY ?? 3)
  // Route every log line to a file so the TUI stays clean. Tail with e.g.
  // `tail -f ~/.local/state/opencode-telegram-question/plugin.log`.
  const log = makeFileLogger(opts.logFile ?? defaultLogFile())

  if (!token || chatIdRaw === undefined || chatIdRaw === "") {
    log("warn", "disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID (set in opencode.json plugin options or env)")
    return {}
  }
  const chatID = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw)
  if (!Number.isFinite(chatID)) {
    log("warn", "disabled: invalid chatId", { chatId: chatIdRaw })
    return {}
  }

  const telegram = opts.telegram ?? makeTelegramClient(token)
  const controller = makeController({
    telegram,
    chatID,
    historyMessages,
    fetchHistory: async (sessionID) => {
      // Best-effort: tolerate SDK shape drift across opencode versions. The
      // method is `client.session.messages(...)` (not `.messages.list`).
      // v1 SDK takes `{ path: { id } }`; the v2 SDK takes `{ sessionID }`.
      // The response is a bare `Array<{ info, parts }>`, no `data` wrapper.
      const anyClient = input.client as any
      const sessionAPI = anyClient?.session
      const messages = sessionAPI?.messages
      if (typeof messages !== "function") {
        log("warn", "session.messages SDK method not found", { keys: sessionAPI ? Object.keys(sessionAPI) : null })
        return []
      }
      const tryShapes: any[] = [{ sessionID }, { path: { id: sessionID } }]
      let res: any
      for (const args of tryShapes) {
        res = await messages.call(sessionAPI, args).catch(() => undefined)
        if (res !== undefined) break
      }
      if (res === undefined) {
        log("warn", "session.messages returned no data for either SDK shape")
        return []
      }
      const data: any[] = Array.isArray(res) ? res : res?.data ?? res?.items ?? []
      const out: { role: string; text: string }[] = []
      for (const m of data) {
        const info = m.info ?? m
        const parts: any[] = m.parts ?? info?.parts ?? []
        const text = parts.map((p) => summarizePart(p)).filter(Boolean).join(" ")
        if (text) out.push({ role: info?.role ?? "?", text })
      }
      return out
    },
    replyToOpencode: async (requestID, answers) => {
      const client = input.client as any
      const body = { answers: answers.map((a) => [...a]) }
      const url = `/question/${encodeURIComponent(requestID)}/reply`
      // Prefer the typed namespace (newer SDKs); fall back to the raw HTTP
      // transport so older SDKs without `client.question.*` still work.
      if (client?.question?.reply) {
        await client.question.reply({ requestID, answers: body.answers })
        return
      }
      if (client?._client?.post) {
        await client._client.post({ url, body })
        return
      }
      throw new Error("No way to POST to question reply endpoint")
    },
    rejectInOpencode: async (requestID) => {
      const client = input.client as any
      const url = `/question/${encodeURIComponent(requestID)}/reject`
      if (client?.question?.reject) {
        await client.question.reject({ requestID })
        return
      }
      if (client?._client?.post) {
        await client._client.post({ url })
        return
      }
      throw new Error("No way to POST to question reject endpoint")
    },
    log,
  })

  const permissionController = makePermissionController({
    telegram,
    chatID,
    reply: async (requestID, choice) => {
      // Prefer the typed namespace (newer SDKs); fall back to the deprecated
      // session-scoped endpoint, then to the raw HTTP transport.
      const client = input.client as any
      if (client?.permission?.reply) {
        await client.permission.reply({ requestID, reply: choice })
        return
      }
      if (client?._client?.post) {
        await client._client.post({
          url: `/permission/${encodeURIComponent(requestID)}/reply`,
          body: { reply: choice },
        })
        return
      }
      throw new Error("No way to POST to permission reply endpoint")
    },
    log,
  })

  // Long-poll Telegram for updates. The coordinator transparently elects
  // a leader per bot token across opencode sessions on the same machine,
  // so only one process actually long-polls and the rest receive updates
  // via IPC. Each process still sends its own outbound Telegram calls.
  const abort = new AbortController()
  void runCoordinator(
    { telegram, token, signal: abort.signal, log },
    async (u) => {
      // Try the permission controller first; it claims the update by
      // returning true. Falling through is normal: most updates belong to
      // the question flow.
      try {
        const claimed = await permissionController.handleCallback(u)
        if (claimed) return
      } catch (err) {
        log("error", "permission handler error", String(err))
      }
      await controller.handleUpdate(u).catch((err) => log("error", "handler error", String(err)))
    },
  ).catch((err) => log("error", "coordinator stopped", String(err)))
  // Best-effort shutdown if the host process exits cleanly.
  process.once?.("beforeExit", () => abort.abort())

  return {
    event: async ({ event }) => {
      const e = event as { type: string; properties?: any }
      switch (e.type) {
        case "question.asked": {
          const props = e.properties as QuestionEvent
          await controller.onQuestionAsked(props).catch((err) => log("error", "asked error", String(err)))
          return
        }
        case "question.replied":
        case "question.rejected": {
          const props = e.properties as { requestID: string }
          if (props?.requestID) await controller.onQuestionResolved(props.requestID).catch(() => {})
          return
        }
        case "permission.asked": {
          const props = e.properties as PermissionRequest
          await permissionController.onPermissionAsked(props).catch((err) => log("error", "permission asked error", String(err)))
          return
        }
        case "permission.replied": {
          const props = e.properties as { requestID: string }
          if (props?.requestID) await permissionController.onPermissionResolved(props.requestID).catch(() => {})
          return
        }
      }
    },
  }
}

// V1 plugin shape: a default export object `{ server, id }`. Do NOT add
// extra named exports — opencode's legacy plugin loader iterates all named
// exports and throws "Plugin export is not a function" on non-function ones
// (e.g. a string `id`).
export default { server: TelegramQuestionPlugin, id: "opencode-telegram-question" }
