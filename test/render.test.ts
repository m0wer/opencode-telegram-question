import { describe, expect, test } from "bun:test"
import { renderQuestion, renderAnsweredQuestion, selectionToAnswer, renderTranscript, clip, summarizePart, CB } from "../src/render"

describe("renderQuestion", () => {
  test("renders header, question, options, and one keyboard button per option plus the custom row", () => {
    const r = renderQuestion(
      {
        header: "Pick color",
        question: "Which color?",
        options: [
          { label: "red", description: "warm" },
          { label: "blue", description: "cool" },
        ],
      },
      { index: 0, total: 1, selected: new Set() },
    )
    expect(r.text).toContain("Pick color")
    expect(r.text).toContain("Which color?")
    expect(r.text).toContain("\u26AA 1. red")
    expect(r.text).toContain("\u26AA 2. blue")
    // 2 option rows + custom. No cancel button: rejecting a question is
    // destructive and a misclick shouldn't kill the request.
    expect(r.keyboard).toHaveLength(3)
    expect(r.keyboard[0][0].callback_data).toBe(CB.option(0))
    expect(r.keyboard[2][0].callback_data).toBe(CB.custom)
    expect(r.keyboard.flat().some((b) => b.callback_data === CB.cancel)).toBe(false)
  })

  test("omits custom row when custom is false", () => {
    const r = renderQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }], custom: false },
      { index: 0, total: 1, selected: new Set() },
    )
    expect(r.keyboard.flat().some((b) => b.callback_data === CB.custom)).toBe(false)
    expect(r.keyboard.flat().some((b) => b.callback_data === CB.cancel)).toBe(false)
  })

  test("adds done button only for multiple", () => {
    const single = renderQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }] },
      { index: 0, total: 1, selected: new Set() },
    )
    const multi = renderQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }], multiple: true },
      { index: 0, total: 1, selected: new Set() },
    )
    expect(single.keyboard.flat().some((b) => b.callback_data === CB.done)).toBe(false)
    expect(multi.keyboard.flat().some((b) => b.callback_data === CB.done)).toBe(true)
  })

  test("shows selected marks", () => {
    const r = renderQuestion(
      {
        header: "h",
        question: "q",
        options: [
          { label: "a", description: "" },
          { label: "b", description: "" },
        ],
        multiple: true,
      },
      { index: 0, total: 1, selected: new Set([1]) },
    )
    expect(r.text).toContain("\u26AA 1. a")
    expect(r.text).toContain("\u2705 2. b")
    expect(r.keyboard[1][0].text.startsWith("\u2705 ")).toBe(true)
  })

  test("button text includes the same 1-based number shown in the message body", () => {
    const r = renderQuestion(
      {
        header: "h",
        question: "q",
        options: [
          { label: "alpha", description: "" },
          { label: "beta", description: "" },
        ],
      },
      { index: 0, total: 1, selected: new Set([1]) },
    )
    // Unselected option: no checkmark, but the number prefix matches the body.
    expect(r.keyboard[0][0].text).toBe("1. alpha")
    // Selected option: checkmark then number prefix.
    expect(r.keyboard[1][0].text).toBe("\u2705 2. beta")
  })

  test("appends one button per quickReply with q:<idx> callback", () => {
    const r = renderQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }] },
      { index: 0, total: 1, selected: new Set(), quickReplies: ["decide yourself", "skip"] },
    )
    const labels = r.keyboard.flat().map((b) => b.text)
    expect(labels).toContain("decide yourself")
    expect(labels).toContain("skip")
    const datas = r.keyboard.flat().map((b) => b.callback_data)
    expect(datas).toContain(CB.quick(0))
    expect(datas).toContain(CB.quick(1))
  })

  test("no quickReplies => no q: buttons", () => {
    const r = renderQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }] },
      { index: 0, total: 1, selected: new Set() },
    )
    expect(r.keyboard.flat().some((b) => b.callback_data.startsWith("q:"))).toBe(false)
  })

  test("prepends recent context transcript when provided", () => {
    const r = renderQuestion(
      { header: "h", question: "q", options: [] },
      { index: 0, total: 1, selected: new Set(), transcript: "user: hi\nassistant: hello" },
    )
    expect(r.text.startsWith("Recent context:")).toBe(true)
    expect(r.text).toContain("assistant: hello")
  })
})

describe("selectionToAnswer", () => {
  test("returns custom text wrapped when custom is provided", () => {
    expect(
      selectionToAnswer(
        { header: "h", question: "q", options: [{ label: "x", description: "" }] },
        new Set([0]),
        "freeform",
      ),
    ).toEqual(["freeform"])
  })
  test("returns selected labels sorted by option index", () => {
    expect(
      selectionToAnswer(
        {
          header: "h",
          question: "q",
          options: [
            { label: "a", description: "" },
            { label: "b", description: "" },
            { label: "c", description: "" },
          ],
        },
        new Set([2, 0]),
      ),
    ).toEqual(["a", "c"])
  })
})

describe("renderTranscript", () => {
  test("keeps only the last N messages and trims whitespace", () => {
    const out = renderTranscript(
      [
        { role: "user", text: "one  two\nthree" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "again" },
      ],
      2,
    )
    expect(out).not.toContain("one")
    expect(out).toContain("assistant: ok")
    expect(out).toContain("user: again")
  })
})

describe("renderAnsweredQuestion", () => {
  test("marks the chosen option and adds an answered marker", () => {
    const r = renderAnsweredQuestion(
      {
        header: "h",
        question: "q",
        options: [
          { label: "a", description: "" },
          { label: "b", description: "" },
        ],
      },
      { index: 0, total: 1, selected: new Set([1]) },
    )
    expect(r.text).toContain("\u26AA 1. a")
    expect(r.text).toContain("\u2705 2. b")
    expect(r.text).toContain("Answered from Telegram")
  })
  test("appends the custom answer when provided", () => {
    const r = renderAnsweredQuestion(
      { header: "h", question: "q", options: [{ label: "a", description: "" }] },
      { index: 0, total: 1, selected: new Set(), customAnswer: "hello world" },
    )
    expect(r.text).toContain("Your answer: hello world")
    expect(r.text).not.toContain("Answered from Telegram")
  })
})

describe("clip", () => {
  test("truncates with ellipsis", () => {
    expect(clip("abcdef", 4)).toBe("abc\u2026")
    expect(clip("abc", 10)).toBe("abc")
  })
})

describe("summarizePart", () => {
  test("text and reasoning return their text", () => {
    expect(summarizePart({ type: "text", text: "hello" })).toBe("hello")
    expect(summarizePart({ type: "reasoning", text: "thinking" })).toBe("thinking")
  })
  test("tool prefers state.title, falls back to status, then bare name", () => {
    expect(summarizePart({ type: "tool", tool: "bash", state: { title: "ls -la", status: "completed" } })).toBe("[bash: ls -la]")
    expect(summarizePart({ type: "tool", tool: "read", state: { status: "running" } })).toBe("[read running]")
    expect(summarizePart({ type: "tool", tool: "edit", state: {} })).toBe("[edit]")
  })
  test("file uses filename, agent uses name, subtask uses description", () => {
    expect(summarizePart({ type: "file", filename: "a.ts" })).toBe("[file: a.ts]")
    expect(summarizePart({ type: "agent", name: "sub" })).toBe("[agent: sub]")
    expect(summarizePart({ type: "subtask", description: "lookup" })).toBe("[subtask: lookup]")
  })
  test("uninteresting parts return empty string", () => {
    expect(summarizePart({ type: "step-start" })).toBe("")
    expect(summarizePart({ type: "step-finish", reason: "done" })).toBe("")
    expect(summarizePart({ type: "snapshot", snapshot: "x" })).toBe("")
    expect(summarizePart({ type: "patch", hash: "h", files: [] })).toBe("")
    expect(summarizePart({ type: "compaction", auto: true })).toBe("")
    expect(summarizePart({ type: "retry", attempt: 1 })).toBe("")
    expect(summarizePart(null)).toBe("")
    expect(summarizePart(undefined)).toBe("")
  })
})
