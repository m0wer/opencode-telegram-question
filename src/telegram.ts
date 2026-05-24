// Thin Telegram Bot API client. Uses `fetch` directly to avoid heavyweight
// deps. Only the endpoints we need.
//
// All methods accept a token at construction. The client is a single object
// with method properties so tests can substitute a fake.

import type { InlineKeyboard } from "./render"

export type Update = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    from?: { id: number }
    text?: string
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    from: { id: number }
    message?: { message_id: number; chat: { id: number } }
    data?: string
  }
}

export interface TelegramClient {
  sendMessage(
    chatID: number,
    text: string,
    keyboard?: InlineKeyboard,
    options?: { replyTo?: number; forceReply?: boolean },
  ): Promise<{ message_id: number }>
  editMessage(chatID: number, messageID: number, text: string, keyboard?: InlineKeyboard): Promise<void>
  removeKeyboard(chatID: number, messageID: number): Promise<void>
  deleteMessage(chatID: number, messageID: number): Promise<void>
  answerCallback(callbackID: string, text?: string): Promise<void>
  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<Update[]>
}

export function makeTelegramClient(token: string): TelegramClient {
  const base = `https://api.telegram.org/bot${token}`

  async function call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(data)}`)
    }
    return data.result
  }

  return {
    async sendMessage(chatID, text, keyboard, opts) {
      const reply_markup = (() => {
        if (keyboard) return { inline_keyboard: keyboard }
        if (opts?.forceReply) return { force_reply: true, selective: true }
        return undefined
      })()
      const result = await call("sendMessage", {
        chat_id: chatID,
        text,
        ...(opts?.replyTo && { reply_to_message_id: opts.replyTo, allow_sending_without_reply: true }),
        ...(reply_markup && { reply_markup }),
      })
      return { message_id: result.message_id }
    },
    async editMessage(chatID, messageID, text, keyboard) {
      try {
        await call("editMessageText", {
          chat_id: chatID,
          message_id: messageID,
          text,
          ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }),
        })
      } catch (err) {
        // Telegram returns an error when the new content is identical; safe
        // to ignore so we don't crash the polling loop.
        if (!String(err).includes("message is not modified")) throw err
      }
    },
    async removeKeyboard(chatID, messageID) {
      try {
        await call("editMessageReplyMarkup", { chat_id: chatID, message_id: messageID, reply_markup: { inline_keyboard: [] } })
      } catch (err) {
        if (!String(err).includes("message is not modified")) {
          // Best-effort; don't blow up on transient errors.
        }
      }
    },
    async deleteMessage(chatID, messageID) {
      try {
        await call("deleteMessage", { chat_id: chatID, message_id: messageID })
      } catch {
        // Message may already be gone; ignore.
      }
    },
    async answerCallback(callbackID, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackID,
        ...(text && { text }),
      })
    },
    async getUpdates(offset, timeoutSec, signal) {
      // Long-poll. The signal lets the supervisor cancel cleanly on shutdown.
      const result = await call(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
        signal,
      )
      return result as Update[]
    },
  }
}
