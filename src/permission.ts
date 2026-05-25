// Mirror opencode's permission flow to Telegram.
//
// When a tool needs the user's approval, opencode publishes
// `permission.asked` on the bus and blocks until the user replies via the
// HTTP API (POST /permission/:requestID/reply with body
// { reply: "once" | "always" | "reject", message? }). We render the
// request as a chat message with three inline buttons and forward the
// user's choice back to opencode through the same endpoint.
//
// Unlike questions, permissions never carry sub-prompts, free-text, or
// multi-select, so the UX is much simpler: one message, one tap, done.

import type { TelegramClient, Update } from "./telegram"
import { clip } from "./render"

const TELEGRAM_MAX = 4000

export const PERMISSION_CB = {
  once: "p:once",
  always: "p:always",
  reject: "p:reject",
} as const

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns?: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  always?: ReadonlyArray<string>
  tool?: { messageID: string; callID: string }
}

export type PermissionDeps = {
  telegram: TelegramClient
  chatID: number
  reply(requestID: string, choice: "once" | "always" | "reject"): Promise<void>
  log?(level: "info" | "warn" | "error", msg: string, data?: unknown): void
}

type State = {
  request: PermissionRequest
  messageID: number
  closed: boolean
  resolvedFromTelegram: boolean
}

export function renderPermission(req: PermissionRequest): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  const lines: string[] = []
  lines.push("Permission requested")
  lines.push("")
  lines.push(`Tool: ${req.permission}`)
  if (req.patterns && req.patterns.length) {
    lines.push("")
    lines.push("Patterns:")
    for (const p of req.patterns.slice(0, 8)) lines.push(`  ${p}`)
    if (req.patterns.length > 8) lines.push(`  ...and ${req.patterns.length - 8} more`)
  }
  if (req.metadata && Object.keys(req.metadata).length) {
    lines.push("")
    lines.push("Details:")
    for (const [k, v] of Object.entries(req.metadata).slice(0, 8)) {
      const sv = typeof v === "string" ? v : JSON.stringify(v)
      lines.push(`  ${k}: ${clip(sv, 200)}`)
    }
  }
  const keyboard = [
    [
      { text: "Allow once", callback_data: PERMISSION_CB.once },
      { text: "Always allow", callback_data: PERMISSION_CB.always },
    ],
    [{ text: "Reject", callback_data: PERMISSION_CB.reject }],
  ]
  return { text: lines.join("\n"), keyboard }
}

export function renderResolvedPermission(req: PermissionRequest, choice: "once" | "always" | "reject"): string {
  const lines: string[] = []
  lines.push("Permission requested")
  lines.push("")
  lines.push(`Tool: ${req.permission}`)
  if (req.patterns && req.patterns.length) {
    lines.push("")
    for (const p of req.patterns.slice(0, 8)) lines.push(`  ${p}`)
  }
  lines.push("")
  const verb = choice === "reject" ? "\u274C Rejected" : choice === "always" ? "\u2705 Allowed (always)" : "\u2705 Allowed once"
  lines.push(`${verb} from Telegram`)
  return lines.join("\n")
}

export function makePermissionController(deps: PermissionDeps) {
  const requests = new Map<string, State>()
  const messageIndex = new Map<number, string>() // telegram message_id -> requestID
  const log = deps.log ?? (() => {})

  async function onPermissionAsked(req: PermissionRequest): Promise<void> {
    log("info", "permission.asked", { id: req.id, permission: req.permission })
    const { text, keyboard } = renderPermission(req)
    const sent = await deps.telegram.sendMessage(deps.chatID, clip(text, TELEGRAM_MAX), keyboard)
    requests.set(req.id, {
      request: req,
      messageID: sent.message_id,
      closed: false,
      resolvedFromTelegram: false,
    })
    messageIndex.set(sent.message_id, req.id)
  }

  async function onPermissionResolved(requestID: string): Promise<void> {
    const state = requests.get(requestID)
    if (!state || state.closed) return
    state.closed = true
    requests.delete(requestID)
    messageIndex.delete(state.messageID)
    if (state.resolvedFromTelegram) return
    // CLI resolved it; the chat message is stale, drop it.
    await deps.telegram.deleteMessage(deps.chatID, state.messageID).catch(() => {})
  }

  async function handleCallback(update: Update): Promise<boolean> {
    const cb = update.callback_query
    if (!cb || !cb.message || !cb.data) return false
    if (cb.message.chat.id !== deps.chatID) return false
    const requestID = messageIndex.get(cb.message.message_id)
    if (!requestID) return false
    const state = requests.get(requestID)
    if (!state) {
      await deps.telegram.answerCallback(cb.id).catch(() => {})
      return true
    }
    const choice = cb.data === PERMISSION_CB.once
      ? "once"
      : cb.data === PERMISSION_CB.always
        ? "always"
        : cb.data === PERMISSION_CB.reject
          ? "reject"
          : undefined
    if (!choice) return false
    await deps.telegram.answerCallback(cb.id).catch(() => {})
    state.closed = true
    state.resolvedFromTelegram = true
    requests.delete(requestID)
    messageIndex.delete(state.messageID)
    try {
      await deps.reply(requestID, choice)
    } catch (err) {
      log("warn", "permission reply failed (likely already resolved)", String(err))
      await deps.telegram.deleteMessage(deps.chatID, state.messageID).catch(() => {})
      return true
    }
    const finalText = renderResolvedPermission(state.request, choice)
    await deps.telegram.editMessage(deps.chatID, state.messageID, clip(finalText, TELEGRAM_MAX)).catch(() => {})
    await deps.telegram.removeKeyboard(deps.chatID, state.messageID).catch(() => {})
    return true
  }

  return { onPermissionAsked, onPermissionResolved, handleCallback, _state: { requests, messageIndex } }
}

export type PermissionController = ReturnType<typeof makePermissionController>
