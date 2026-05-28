// Controller wiring opencode question events to a Telegram chat.
//
// Pure orchestration. Talks to Telegram via TelegramClient and back to
// opencode via the two `replyToOpencode` / `rejectInOpencode` callbacks.
// This shape makes the controller trivially testable without spinning up
// real I/O.

import { clip, renderAnsweredQuestion, renderQuestion, renderTranscript, selectionToAnswer, CB, type Prompt } from "./render"
import type { TelegramClient, Update } from "./telegram"

const TELEGRAM_MAX = 4000

export type QuestionEvent = {
  id: string
  sessionID: string
  questions: ReadonlyArray<Prompt>
}

export type ControllerDeps = {
  telegram: TelegramClient
  chatID: number
  historyMessages: number
  fetchHistory(sessionID: string): Promise<ReadonlyArray<{ role: string; text: string }>>
  replyToOpencode(requestID: string, answers: ReadonlyArray<ReadonlyArray<string>>): Promise<void>
  rejectInOpencode(requestID: string): Promise<void>
  log?(level: "info" | "warn" | "error", msg: string, data?: unknown): void
  // Stock free-text answers shown as extra buttons after the options and
  // the "Type your own answer" row. Tapping one submits its text as the
  // sub-question's answer without typing anything. Defaults to [].
  quickReplies?: ReadonlyArray<string>
  // How long to wait, after the most recent free-text chunk replying to
  // a force_reply prompt, before treating the buffered chunks as one
  // complete answer. Telegram clients split messages longer than 4096
  // chars into multiple sends, each carrying the same reply_to_message,
  // so we must coalesce them. Defaults to 1500ms.
  freeTextDebounceMs?: number
}

type SubState = {
  selected: Set<number>
  awaitingCustom: boolean
  customAnswer?: string
  answered: boolean
}

type RequestState = {
  event: QuestionEvent
  messageIDs: number[] // one per sub-question
  subStates: SubState[]
  // While the user is typing a free-text answer, we record which sub-question
  // is waiting. Key is the prompt-message id (the bot's "type your answer"
  // message), value is the sub-question index. This lets concurrent custom
  // prompts coexist: each inbound text message includes
  // `reply_to_message.message_id` pointing to its prompt.
  customPrompts: Map<number, number>
  // Buffer of in-flight free-text chunks per force_reply prompt. Telegram
  // splits replies longer than 4096 chars into multiple messages, each
  // marked `reply_to_message_id = <prompt mid>`. We accumulate them and
  // flush after `freeTextDebounceMs` of silence, joining by message_id
  // order so chunks land in the order the user typed them.
  freeTextBuffers: Map<number, { subIndex: number; parts: { mid: number; text: string }[]; timer: ReturnType<typeof setTimeout> | null }>
  closed: boolean
  // Set to true after we successfully relay the answer to opencode. The
  // subsequent `question.replied` event then must NOT delete the telegram
  // messages (the user already saw their own answer there).
  answeredFromTelegram: boolean
}

export function makeController(deps: ControllerDeps) {
  const requests = new Map<string, RequestState>()
  // Reverse index: telegram message_id -> { requestID, subIndex } so we can
  // route callback queries cheaply.
  const messageIndex = new Map<number, { requestID: string; subIndex: number }>()

  const log = deps.log ?? (() => {})
  const freeTextDebounceMs = deps.freeTextDebounceMs ?? 1500
  const quickReplies = deps.quickReplies ?? []

  // Clear any pending free-text debounce timers for a request. Used when the
  // request resolves (either side) so a late timer can't fire against a
  // closed RequestState.
  function clearFreeTextTimers(state: RequestState): void {
    for (const buf of state.freeTextBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer)
    }
    state.freeTextBuffers.clear()
  }

  async function onQuestionAsked(event: QuestionEvent): Promise<void> {
    log("info", "question.asked", { id: event.id, count: event.questions.length })
    const transcript = await deps.fetchHistory(event.sessionID).catch((err) => {
      log("warn", "history fetch failed", String(err))
      return []
    })
    const transcriptText = transcript.length ? renderTranscript(transcript, deps.historyMessages) : undefined

    const state: RequestState = {
      event,
      messageIDs: [],
      subStates: event.questions.map(() => ({ selected: new Set<number>(), awaitingCustom: false, answered: false })),
      customPrompts: new Map(),
      freeTextBuffers: new Map(),
      closed: false,
      answeredFromTelegram: false,
    }
    requests.set(event.id, state)

    for (let i = 0; i < event.questions.length; i++) {
      const { text, keyboard } = renderQuestion(event.questions[i], {
        index: i,
        total: event.questions.length,
        selected: state.subStates[i].selected,
        transcript: i === 0 ? transcriptText : undefined,
        quickReplies,
      })
      const sent = await deps.telegram.sendMessage(deps.chatID, clip(text, TELEGRAM_MAX), keyboard)
      state.messageIDs.push(sent.message_id)
      messageIndex.set(sent.message_id, { requestID: event.id, subIndex: i })
    }
  }

  async function onQuestionResolved(requestID: string): Promise<void> {
    // Called when opencode resolves (replied or rejected) the request by
    // any path. When the answer came from us (Telegram), we keep the
    // messages so the user has a record of what they answered; otherwise
    // the CLI/TUI was the source and the Telegram messages are stale, so
    // we delete them.
    const state = requests.get(requestID)
    if (!state || state.closed) return
    state.closed = true
    requests.delete(requestID)
    clearFreeTextTimers(state)
    if (state.answeredFromTelegram) return
    for (const promptMID of state.customPrompts.keys()) {
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {})
    }
    state.customPrompts.clear()
    for (const mid of state.messageIDs) {
      messageIndex.delete(mid)
      await deps.telegram.deleteMessage(deps.chatID, mid).catch(() => {})
    }
  }

  async function refreshMessage(state: RequestState, subIndex: number): Promise<void> {
    const prompt = state.event.questions[subIndex]
    const sub = state.subStates[subIndex]
    const { text, keyboard } = renderQuestion(prompt, {
      index: subIndex,
      total: state.event.questions.length,
      selected: sub.selected,
      quickReplies,
    })
    const mid = state.messageIDs[subIndex]
    await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX), keyboard)
  }

  async function trySubmit(state: RequestState): Promise<void> {
    if (state.closed) return
    if (!state.subStates.every((s) => s.answered)) return
    state.closed = true
    state.answeredFromTelegram = true
    clearFreeTextTimers(state)
    const answers = state.subStates.map((sub, i) =>
      sub.customAnswer !== undefined
        ? [sub.customAnswer]
        : selectionToAnswer(state.event.questions[i], sub.selected),
    )
    try {
      await deps.replyToOpencode(state.event.id, answers)
    } catch (err) {
      log("warn", "replyToOpencode failed (likely already answered)", String(err))
      // Reply failed; the CLI/TUI most likely already answered. Treat this
      // as an externally-resolved request so we still tidy up the chat.
      state.answeredFromTelegram = false
    }
    requests.delete(state.event.id)
    // Any "Reply with your answer for..." prompts must go, whether the
    // submit succeeded or failed: Telegram clients otherwise keep the
    // force-reply quote pinned to the chat input.
    for (const promptMID of state.customPrompts.keys()) {
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {})
    }
    state.customPrompts.clear()
    // Strip the inline keyboards so buttons can't be re-pressed, but keep
    // the question text and any selection marks so the user sees a record
    // of what they answered. For single-choice and free-text we also edit
    // the body so the chosen option is visibly marked. If the reply failed
    // (CLI raced), nuke the messages instead.
    for (let i = 0; i < state.messageIDs.length; i++) {
      const mid = state.messageIDs[i]
      messageIndex.delete(mid)
      if (state.answeredFromTelegram) {
        const prompt = state.event.questions[i]
        const sub = state.subStates[i]
        const { text } = renderAnsweredQuestion(prompt, { index: i, total: state.event.questions.length, selected: sub.selected, customAnswer: sub.customAnswer })
        await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX)).catch(() => {})
        await deps.telegram.removeKeyboard(deps.chatID, mid).catch(() => {})
      } else {
        await deps.telegram.deleteMessage(deps.chatID, mid).catch(() => {})
      }
    }
  }

  async function handleCallback(update: Update): Promise<void> {
    const cb = update.callback_query
    if (!cb || !cb.message || !cb.data) return
    if (cb.message.chat.id !== deps.chatID) return
    const target = messageIndex.get(cb.message.message_id)
    // Updates fan out to every opencode session sharing this bot token, so
    // callbacks for messages we never sent are normal and must be ignored
    // silently. Whichever peer owns the message (or none, if the question
    // was already resolved) will answer (or not).
    if (!target) return
    const state = requests.get(target.requestID)
    if (!state) {
      await deps.telegram.answerCallback(cb.id).catch(() => {})
      return
    }
    const sub = state.subStates[target.subIndex]
    const prompt = state.event.questions[target.subIndex]
    await deps.telegram.answerCallback(cb.id).catch(() => {})

    if (cb.data === CB.cancel) {
      try {
        await deps.rejectInOpencode(state.event.id)
      } catch (err) {
        log("warn", "rejectInOpencode failed", String(err))
      }
      await onQuestionResolved(state.event.id)
      return
    }

    if (cb.data === CB.custom) {
      sub.awaitingCustom = true
      const questionMID = state.messageIDs[target.subIndex]
      // If we already have an open prompt for this same sub-question (user
      // tapped the button twice), retire the stale one so only one
      // force-reply target is alive.
      for (const [pmid, sIdx] of state.customPrompts) {
        if (sIdx === target.subIndex) {
          state.customPrompts.delete(pmid)
          const buf = state.freeTextBuffers.get(pmid)
          if (buf?.timer) clearTimeout(buf.timer)
          state.freeTextBuffers.delete(pmid)
          await deps.telegram.deleteMessage(deps.chatID, pmid).catch(() => {})
        }
      }
      // Send a force-reply prompt that quotes the question message so
      // Telegram pre-fills the reply target in the chat input. We then map
      // the prompt-message id back to the sub-question, so even when the
      // user has multiple custom prompts open we route their text to the
      // right one via `reply_to_message.message_id`.
      const sent = await deps.telegram.sendMessage(
        deps.chatID,
        `Reply with your answer for: "${prompt.header}"`,
        undefined,
        { replyTo: questionMID, forceReply: true },
      )
      state.customPrompts.set(sent.message_id, target.subIndex)
      return
    }

    if (cb.data === CB.done) {
      if (prompt.multiple && sub.selected.size > 0) {
        sub.answered = true
        await trySubmit(state)
      }
      return
    }

    if (cb.data.startsWith("q:")) {
      // Quick reply: a stock free-text answer the user pre-configured.
      // We treat it exactly like a typed custom answer (single string,
      // wrapped in a 1-element answer array), and tidy up any open
      // force_reply prompt for this sub-question.
      const idx = Number(cb.data.slice(2))
      if (!Number.isInteger(idx) || idx < 0 || idx >= quickReplies.length) return
      for (const [pmid, sIdx] of state.customPrompts) {
        if (sIdx === target.subIndex) {
          state.customPrompts.delete(pmid)
          const buf = state.freeTextBuffers.get(pmid)
          if (buf?.timer) clearTimeout(buf.timer)
          state.freeTextBuffers.delete(pmid)
          await deps.telegram.deleteMessage(deps.chatID, pmid).catch(() => {})
        }
      }
      applyFreeText(state, target.subIndex, quickReplies[idx])
      await trySubmit(state)
      return
    }

    if (cb.data.startsWith("o:")) {
      const idx = Number(cb.data.slice(2))
      if (!Number.isInteger(idx) || idx < 0 || idx >= prompt.options.length) return
      if (prompt.multiple) {
        if (sub.selected.has(idx)) sub.selected.delete(idx)
        else sub.selected.add(idx)
        await refreshMessage(state, target.subIndex)
      } else {
        sub.selected.clear()
        sub.selected.add(idx)
        sub.answered = true
        await trySubmit(state)
      }
    }
  }

  async function handleMessage(update: Update): Promise<void> {
    const msg = update.message
    if (!msg || msg.chat.id !== deps.chatID || !msg.text) return
    // Strict routing: free-text replies are only consumed when the user
    // used Telegram's Reply gesture against one of our force_reply prompts
    // (which Telegram's UI does automatically when the user taps the
    // pre-filled reply). Anything else is either chitchat or belongs to
    // another opencode session sharing this bot, so we ignore it.
    const replyTo = msg.reply_to_message?.message_id
    if (replyTo === undefined) return
    for (const state of requests.values()) {
      const idx = state.customPrompts.get(replyTo)
      if (idx === undefined) continue
      // Buffer this chunk. Telegram clients split messages longer than
      // 4096 chars into multiple sends, each carrying the same
      // reply_to_message_id, so naively submitting on the first chunk
      // would drop the rest. We instead append and debounce.
      let buf = state.freeTextBuffers.get(replyTo)
      if (!buf) {
        buf = { subIndex: idx, parts: [], timer: null }
        state.freeTextBuffers.set(replyTo, buf)
      }
      buf.parts.push({ mid: msg.message_id, text: msg.text })
      if (buf.timer) clearTimeout(buf.timer)
      buf.timer = setTimeout(() => {
        // Fire-and-forget: the timer callback can't be awaited. Any errors
        // inside the flush already log via the controller's logger.
        void flushFreeText(state, replyTo).catch((err) => log("error", "flushFreeText error", String(err)))
      }, freeTextDebounceMs)
      return
    }
  }

  async function flushFreeText(state: RequestState, promptMID: number): Promise<void> {
    if (state.closed) return
    const buf = state.freeTextBuffers.get(promptMID)
    if (!buf) return
    state.freeTextBuffers.delete(promptMID)
    buf.timer = null
    // Join chunks by message_id so the original typing order is preserved
    // even if updates arrived slightly out of order. Telegram emits chunks
    // a few ms apart with strictly increasing message_id.
    const text = buf.parts
      .slice()
      .sort((a, b) => a.mid - b.mid)
      .map((p) => p.text)
      .join("\n")
    state.customPrompts.delete(promptMID)
    await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {})
    applyFreeText(state, buf.subIndex, text)
    await trySubmit(state)
  }

  function applyFreeText(state: RequestState, idx: number, text: string): void {
    const sub = state.subStates[idx]
    sub.customAnswer = text
    sub.answered = true
    sub.awaitingCustom = false
  }

  async function handleUpdate(update: Update): Promise<void> {
    if (update.callback_query) return handleCallback(update)
    if (update.message) return handleMessage(update)
  }

  return { onQuestionAsked, onQuestionResolved, handleUpdate, _state: { requests, messageIndex } }
}

export type Controller = ReturnType<typeof makeController>
