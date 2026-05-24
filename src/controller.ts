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
    })
    const mid = state.messageIDs[subIndex]
    await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX), keyboard)
  }

  async function trySubmit(state: RequestState): Promise<void> {
    if (state.closed) return
    if (!state.subStates.every((s) => s.answered)) return
    state.closed = true
    state.answeredFromTelegram = true
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
    if (cb.message.chat.id !== deps.chatID) {
      await deps.telegram.answerCallback(cb.id, "Not authorized").catch(() => {})
      return
    }
    const target = messageIndex.get(cb.message.message_id)
    if (!target) {
      await deps.telegram.answerCallback(cb.id, "This question is no longer active").catch(() => {})
      return
    }
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
    // Prefer routing by `reply_to_message_id` so concurrent custom prompts
    // don't get crossed.
    const replyTo = msg.reply_to_message?.message_id
    if (replyTo !== undefined) {
      for (const state of requests.values()) {
        const idx = state.customPrompts.get(replyTo)
        if (idx === undefined) continue
        state.customPrompts.delete(replyTo)
        await deps.telegram.deleteMessage(deps.chatID, replyTo).catch(() => {})
        applyFreeText(state, idx, msg.text)
        await trySubmit(state)
        return
      }
    }
    // Fallback: oldest open request with any awaiting custom prompt.
    for (const state of requests.values()) {
      if (state.customPrompts.size === 0) continue
      const [promptMID, idx] = state.customPrompts.entries().next().value!
      state.customPrompts.delete(promptMID)
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {})
      applyFreeText(state, idx, msg.text)
      await trySubmit(state)
      return
    }
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
