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
import { runCoordinator } from "./coordinator"
import { defaultLogFile, makeFileLogger } from "./log"

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
      // Best-effort: tolerate SDK shape drift across opencode versions.
      const anyClient = input.client as any
      const sessionAPI = anyClient?.session
      const messagesAPI = sessionAPI?.messages ?? sessionAPI?.message
      if (!messagesAPI || typeof messagesAPI.list !== "function") return []
      const res = await messagesAPI.list({ sessionID }).catch(() => undefined)
      const data: any[] = (res as any)?.data ?? (res as any) ?? []
      const out: { role: string; text: string }[] = []
      for (const m of data) {
        const info = m.info ?? m
        const parts = m.parts ?? info?.parts ?? []
        const text = parts
          .map((p: any) => (p?.type === "text" ? p.text : ""))
          .filter(Boolean)
          .join(" ")
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

  // Long-poll Telegram for updates. The coordinator transparently elects
  // a leader per bot token across opencode sessions on the same machine,
  // so only one process actually long-polls and the rest receive updates
  // via IPC. Each process still sends its own outbound Telegram calls.
  const abort = new AbortController()
  void runCoordinator(
    { telegram, token, signal: abort.signal, log },
    (u) => controller.handleUpdate(u).catch((err) => log("error", "handler error", String(err))),
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
      }
    },
  }
}

// V1 plugin shape: a default export object `{ server, id }`. Do NOT add
// extra named exports — opencode's legacy plugin loader iterates all named
// exports and throws "Plugin export is not a function" on non-function ones
// (e.g. a string `id`).
export default { server: TelegramQuestionPlugin, id: "opencode-telegram-question" }
