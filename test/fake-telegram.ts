// In-memory TelegramClient used by tests. It is a real implementation of
// the interface that records calls and lets tests inject inbound updates.
// We avoid mocking the controller itself: it runs unchanged against this
// transport, exactly as it would against the real Telegram API.

import type { TelegramClient, Update } from "../src/telegram"
import type { InlineKeyboard } from "../src/render"

export type SentMessage = {
  message_id: number
  chat_id: number
  text: string
  keyboard?: InlineKeyboard
  reply_to?: number
  force_reply?: boolean
  deleted: boolean
}

export type FakeTelegram = TelegramClient & {
  sent: SentMessage[]
  callbacksAnswered: { id: string; text?: string }[]
  pushUpdate(u: Update): void
}

export function makeFakeTelegram(): FakeTelegram {
  let nextID = 1000
  const sent: SentMessage[] = []
  const callbacksAnswered: { id: string; text?: string }[] = []
  const inbox: Update[] = []
  // resolvers waiting on getUpdates when inbox is empty
  const waiters: ((u: Update[]) => void)[] = []

  function flushTo(resolve: (u: Update[]) => void) {
    const batch = inbox.splice(0, inbox.length)
    resolve(batch)
  }

  return {
    sent,
    callbacksAnswered,
    pushUpdate(u) {
      inbox.push(u)
      const w = waiters.shift()
      if (w) flushTo(w)
    },
    async sendMessage(chat_id, text, keyboard, opts) {
      const message_id = nextID++
      sent.push({
        message_id,
        chat_id,
        text,
        keyboard,
        reply_to: opts?.replyTo,
        force_reply: opts?.forceReply,
        deleted: false,
      })
      return { message_id }
    },
    async editMessage(chat_id, message_id, text, keyboard) {
      const m = sent.find((s) => s.message_id === message_id && s.chat_id === chat_id)
      if (!m) throw new Error(`editMessage: not found ${message_id}`)
      m.text = text
      m.keyboard = keyboard
    },
    async removeKeyboard(chat_id, message_id) {
      const m = sent.find((s) => s.message_id === message_id && s.chat_id === chat_id)
      if (m) m.keyboard = undefined
    },
    async deleteMessage(chat_id, message_id) {
      const m = sent.find((s) => s.message_id === message_id && s.chat_id === chat_id)
      if (m) m.deleted = true
    },
    async answerCallback(id, text) {
      callbacksAnswered.push({ id, text })
    },
    async getUpdates(_offset, _timeoutSec, signal) {
      if (inbox.length) return inbox.splice(0, inbox.length)
      return new Promise<Update[]>((resolve, reject) => {
        waiters.push(resolve)
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    },
  }
}
