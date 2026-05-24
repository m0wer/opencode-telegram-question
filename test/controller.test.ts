import { describe, expect, test } from "bun:test"
import { makeController, type QuestionEvent } from "../src/controller"
import { CB } from "../src/render"
import { makeFakeTelegram } from "./fake-telegram"

const CHAT = 42

function setup(opts?: { history?: { role: string; text: string }[] }) {
  const telegram = makeFakeTelegram()
  const replies: { requestID: string; answers: ReadonlyArray<ReadonlyArray<string>> }[] = []
  const rejects: string[] = []
  const controller = makeController({
    telegram,
    chatID: CHAT,
    historyMessages: 3,
    fetchHistory: async () => opts?.history ?? [],
    replyToOpencode: async (requestID, answers) => {
      replies.push({ requestID, answers })
    },
    rejectInOpencode: async (requestID) => {
      rejects.push(requestID)
    },
  })
  return { telegram, controller, replies, rejects }
}

function evt(questions: QuestionEvent["questions"], id = "q1"): QuestionEvent {
  return { id, sessionID: "s1", questions }
}

describe("controller — single-choice", () => {
  test("clicking an option submits, keeps the message, and strips the keyboard", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([
        {
          header: "h",
          question: "q",
          options: [
            { label: "yes", description: "" },
            { label: "no", description: "" },
          ],
        },
      ]),
    )
    expect(telegram.sent).toHaveLength(1)
    const mid = telegram.sent[0].message_id
    await controller.handleUpdate({
      update_id: 1,
      callback_query: { id: "c1", from: { id: 1 }, message: { message_id: mid, chat: { id: CHAT } }, data: CB.option(0) },
    })
    expect(replies).toEqual([{ requestID: "q1", answers: [["yes"]] }])
    expect(telegram.sent[0].deleted).toBe(false)
    expect(telegram.sent[0].keyboard).toBeUndefined()
    expect(telegram.sent[0].text).toContain("\u2705 1. yes")
    expect(telegram.sent[0].text).toContain("Answered from Telegram")
    // The subsequent question.replied event must not delete it either.
    await controller.onQuestionResolved("q1")
    expect(telegram.sent[0].deleted).toBe(false)
  })
})

describe("controller — multi-choice", () => {
  test("toggling and Done submits with selected labels", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([
        {
          header: "h",
          question: "q",
          multiple: true,
          options: [
            { label: "a", description: "" },
            { label: "b", description: "" },
            { label: "c", description: "" },
          ],
        },
      ]),
    )
    const mid = telegram.sent[0].message_id
    const fire = (data: string) =>
      controller.handleUpdate({
        update_id: 1,
        callback_query: { id: "x", from: { id: 1 }, message: { message_id: mid, chat: { id: CHAT } }, data },
      })
    await fire(CB.option(0))
    await fire(CB.option(2))
    expect(replies).toEqual([])
    expect(telegram.sent[0].text).toContain("\u2705 1. a")
    expect(telegram.sent[0].text).toContain("\u2705 3. c")
    await fire(CB.done)
    expect(replies).toEqual([{ requestID: "q1", answers: [["a", "c"]] }])
  })
})

describe("controller — free-text answer", () => {
  test("custom button sends a force-reply prompt and a reply-to-prompt message yields the typed answer", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([{ header: "h", question: "q", options: [{ label: "a", description: "" }] }]),
    )
    const questionMID = telegram.sent[0].message_id
    await controller.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "c",
        from: { id: 1 },
        message: { message_id: questionMID, chat: { id: CHAT } },
        data: CB.custom,
      },
    })
    expect(telegram.sent.length).toBe(2)
    const prompt = telegram.sent[1]
    expect(prompt.reply_to).toBe(questionMID)
    expect(prompt.force_reply).toBe(true)
    await controller.handleUpdate({
      update_id: 2,
      message: {
        message_id: 1,
        chat: { id: CHAT },
        text: "made up answer",
        reply_to_message: { message_id: prompt.message_id },
      },
    })
    expect(replies).toEqual([{ requestID: "q1", answers: [["made up answer"]] }])
  })

  test("routes concurrent custom prompts via reply_to_message", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([
        { header: "h1", question: "q1", options: [{ label: "a", description: "" }] },
        { header: "h2", question: "q2", options: [{ label: "b", description: "" }] },
      ]),
    )
    const q1mid = telegram.sent[0].message_id
    const q2mid = telegram.sent[1].message_id
    // Open custom prompt for sub-question 2 first, then sub-question 1.
    await controller.handleUpdate({
      update_id: 1,
      callback_query: { id: "a", from: { id: 1 }, message: { message_id: q2mid, chat: { id: CHAT } }, data: CB.custom },
    })
    await controller.handleUpdate({
      update_id: 2,
      callback_query: { id: "b", from: { id: 1 }, message: { message_id: q1mid, chat: { id: CHAT } }, data: CB.custom },
    })
    const prompt2 = telegram.sent[2]
    const prompt1 = telegram.sent[3]
    expect(prompt2.reply_to).toBe(q2mid)
    expect(prompt1.reply_to).toBe(q1mid)
    // Answer q2 first (out of order), then q1; both must end up in the right slot.
    await controller.handleUpdate({
      update_id: 3,
      message: { message_id: 10, chat: { id: CHAT }, text: "answer two", reply_to_message: { message_id: prompt2.message_id } },
    })
    expect(replies).toEqual([])
    await controller.handleUpdate({
      update_id: 4,
      message: { message_id: 11, chat: { id: CHAT }, text: "answer one", reply_to_message: { message_id: prompt1.message_id } },
    })
    expect(replies).toEqual([{ requestID: "q1", answers: [["answer one"], ["answer two"]] }])
  })
})

describe("controller — multi sub-questions", () => {
  test("only submits when every sub-question is answered", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([
        { header: "h1", question: "q1", options: [{ label: "yes", description: "" }] },
        { header: "h2", question: "q2", options: [{ label: "no", description: "" }] },
      ]),
    )
    expect(telegram.sent).toHaveLength(2)
    const fire = (mid: number, data: string) =>
      controller.handleUpdate({
        update_id: 1,
        callback_query: { id: "x", from: { id: 1 }, message: { message_id: mid, chat: { id: CHAT } }, data },
      })
    await fire(telegram.sent[0].message_id, CB.option(0))
    expect(replies).toEqual([])
    await fire(telegram.sent[1].message_id, CB.option(0))
    expect(replies).toEqual([{ requestID: "q1", answers: [["yes"], ["no"]] }])
  })
})

describe("controller — CLI answers first", () => {
  test("onQuestionResolved deletes all Telegram messages and ignores later callbacks", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([{ header: "h", question: "q", options: [{ label: "a", description: "" }] }]),
    )
    const mid = telegram.sent[0].message_id
    await controller.onQuestionResolved("q1")
    expect(telegram.sent[0].deleted).toBe(true)
    // A subsequent click should be a no-op (no replies sent).
    await controller.handleUpdate({
      update_id: 1,
      callback_query: { id: "c", from: { id: 1 }, message: { message_id: mid, chat: { id: CHAT } }, data: CB.option(0) },
    })
    expect(replies).toEqual([])
  })
})

describe("controller — cancel", () => {
  test("cancel callback triggers reject and cleanup", async () => {
    const { telegram, controller, replies, rejects } = setup()
    await controller.onQuestionAsked(
      evt([{ header: "h", question: "q", options: [{ label: "a", description: "" }] }]),
    )
    const mid = telegram.sent[0].message_id
    await controller.handleUpdate({
      update_id: 1,
      callback_query: { id: "c", from: { id: 1 }, message: { message_id: mid, chat: { id: CHAT } }, data: CB.cancel },
    })
    expect(rejects).toEqual(["q1"])
    expect(replies).toEqual([])
    expect(telegram.sent[0].deleted).toBe(true)
  })
})

describe("controller — wrong chat", () => {
  test("callback from a different chat is rejected and does nothing", async () => {
    const { telegram, controller, replies } = setup()
    await controller.onQuestionAsked(
      evt([{ header: "h", question: "q", options: [{ label: "a", description: "" }] }]),
    )
    const mid = telegram.sent[0].message_id
    await controller.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "c",
        from: { id: 999 },
        message: { message_id: mid, chat: { id: 9999 } },
        data: CB.option(0),
      },
    })
    expect(replies).toEqual([])
    expect(telegram.callbacksAnswered[0].text).toBe("Not authorized")
  })
})

describe("controller — history transcript", () => {
  test("includes recent history in first message only", async () => {
    const { telegram, controller } = setup({
      history: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "what color do you want" },
      ],
    })
    await controller.onQuestionAsked(
      evt([
        { header: "h1", question: "q1", options: [{ label: "a", description: "" }] },
        { header: "h2", question: "q2", options: [{ label: "b", description: "" }] },
      ]),
    )
    expect(telegram.sent[0].text).toContain("Recent context:")
    expect(telegram.sent[1].text).not.toContain("Recent context:")
  })
})
