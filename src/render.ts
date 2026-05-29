// Pure rendering helpers. No I/O. Easy to unit-test.
//
// A "Prompt" mirrors opencode's `Question.Info` shape:
//   { question, header, options[{ label, description }], multiple?, custom? }
//
// We render each sub-question to:
//   - a body text (markdown-free; Telegram default mode)
//   - an inline keyboard with one button per option, plus optional
//     "Type your own answer" and (when `multiple`) "Done" rows.

export type Option = { label: string; description: string }

export type Prompt = {
  question: string
  header: string
  options: ReadonlyArray<Option>
  multiple?: boolean
  custom?: boolean
}

export type InlineButton = { text: string; callback_data: string }
export type InlineKeyboard = InlineButton[][]

// Maximum number of characters of a free-text answer to echo back in the
// answered-question record. The user always has the full text in their own
// sent-messages history; the bot's record is just a confirmation, so we cap
// it to keep the chat tidy.
export const MAX_ANSWER_DISPLAY = 300

// Telegram limits callback_data to 64 bytes. We encode actions as compact
// strings: `o:<idx>` (option toggle), `c` (custom-text mode), `d` (done for
// multi-select), `x` (cancel), `q:<idx>` (quick reply, stock free-text).
export const CB = {
  option: (idx: number) => `o:${idx}`,
  custom: "c",
  done: "d",
  cancel: "x",
  quick: (idx: number) => `q:${idx}`,
} as const

// Telegram HTML parse-mode requires that `<`, `>` and `&` be escaped in
// any user-provided text. We assemble messages with HTML tags for bold
// and italic but every interpolated value goes through this helper so a
// stray `<` in a session title or question text can't corrupt the message
// or trigger a Telegram parse error.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Render the description in parentheses only when it adds information.
// Many callers pass the same string as both label and description (this
// is the default behavior of opencode's `question` tool when only a
// label is provided), which produces a redundant `name (name)` output.
function describeOption(label: string, description: string): string {
  if (!description || description.trim() === label.trim()) return ""
  return ` (${escapeHtml(description)})`
}

export function renderQuestion(
  prompt: Prompt,
  context: {
    index: number
    total: number
    selected: ReadonlySet<number>
    transcript?: string
    quickReplies?: ReadonlyArray<string>
    sessionTitle?: string
  },
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = []
  // Top metadata: which opencode session this came from (helpful when
  // several sessions share the bot) and any recent transcript for
  // context. Both are italic so the bold header below stands out.
  if (context.sessionTitle) lines.push(`<i>Session:</i> ${escapeHtml(context.sessionTitle)}`)
  if (context.transcript) {
    lines.push(`<i>Recent context:</i>`)
    lines.push(escapeHtml(context.transcript))
  }
  if (lines.length) lines.push("")
  // Header in bold; sub-question counter as a small prefix when relevant.
  const header = escapeHtml(prompt.header)
  const counter = context.total > 1 ? `<i>Question ${context.index + 1}/${context.total}:</i> ` : ""
  lines.push(`${counter}<b>${header}</b>`)
  lines.push("")
  lines.push(escapeHtml(prompt.question))
  if (prompt.options.length) {
    lines.push("")
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "\u2705" : "\u26AA"
      lines.push(`${mark} ${i + 1}. ${escapeHtml(opt.label)}${describeOption(opt.label, opt.description)}`)
    })
  }
  const keyboard: InlineKeyboard = prompt.options.map((opt, i) => [
    {
      // Prefix buttons with the same 1-based number used in the message
      // body so users can match a button to its line at a glance,
      // especially when option labels are long and Telegram truncates
      // them in the keyboard.
      text: `${context.selected.has(i) ? "\u2705 " : ""}${i + 1}. ${opt.label}`,
      callback_data: CB.option(i),
    },
  ])
  const allowCustom = prompt.custom !== false
  if (allowCustom) keyboard.push([{ text: "Type your own answer", callback_data: CB.custom }])
  if (prompt.multiple) keyboard.push([{ text: "Done", callback_data: CB.done }])
  // Stock free-text replies the user configured globally. Each becomes
  // one button that, when tapped, submits its text as the answer (no
  // typing needed). Useful for "decide yourself", "skip", etc.
  if (context.quickReplies) {
    for (let i = 0; i < context.quickReplies.length; i++) {
      keyboard.push([{ text: context.quickReplies[i], callback_data: CB.quick(i) }])
    }
  }
  // No Cancel button: rejecting a question is destructive (it propagates
  // as a tool error to the agent), and a misclick on a phone keyboard
  // shouldn't be able to kill the request. If you want to cancel, do it
  // from the CLI/TUI; the Telegram message will be cleaned up via the
  // question.rejected event.
  return { text: lines.join("\n"), keyboard }
}

// Render the final answered state of a question for in-place editing.
// Shows the question, marks chosen options, and (for free-text) appends
// the typed answer below.
export function renderAnsweredQuestion(
  prompt: Prompt,
  context: { index: number; total: number; selected: ReadonlySet<number>; customAnswer?: string; sessionTitle?: string },
): { text: string } {
  const lines: string[] = []
  if (context.sessionTitle) {
    lines.push(`<i>Session:</i> ${escapeHtml(context.sessionTitle)}`)
    lines.push("")
  }
  const header = escapeHtml(prompt.header)
  const counter = context.total > 1 ? `<i>Question ${context.index + 1}/${context.total}:</i> ` : ""
  lines.push(`${counter}<b>${header}</b>`)
  lines.push("")
  lines.push(escapeHtml(prompt.question))
  if (prompt.options.length) {
    lines.push("")
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "\u2705" : "\u26AA"
      lines.push(`${mark} ${i + 1}. ${escapeHtml(opt.label)}${describeOption(opt.label, opt.description)}`)
    })
  }
  if (context.customAnswer !== undefined) {
    lines.push("")
    // Clip the echoed free-text answer: long answers bloat the question
    // record without adding value (the full text is still in the user's own
    // sent-messages history). Keep the head: free-text answers typically
    // front-load the key point, so the start is the most representative.
    lines.push(`\u270D\uFE0F <i>Your answer:</i> ${escapeHtml(clip(context.customAnswer, MAX_ANSWER_DISPLAY))}`)
  } else {
    lines.push("")
    lines.push(`\u2714\uFE0F <i>Answered from Telegram</i>`)
  }
  return { text: lines.join("\n") }
}
// expected by opencode's reply API. Each answer is `string[]` (list of
// selected option labels, or a single free-text string).
export function selectionToAnswer(
  prompt: Prompt,
  selected: ReadonlySet<number>,
  custom?: string,
): string[] {
  if (custom !== undefined) return [custom]
  return [...selected].sort((a, b) => a - b).map((i) => prompt.options[i].label)
}

// Truncate a string preserving the head and adding an ellipsis. Telegram
// caps message text at 4096 characters.
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "\u2026"
}

// Truncate a string preserving the TAIL (the end), prefixing an ellipsis.
// The last message before a question usually ends with the details the
// question is about (a summary, a list of next steps, the thing being
// asked), so when it's too long to show in full we keep the end rather
// than the start.
export function clipTail(s: string, max: number): string {
  if (s.length <= max) return s
  return "\u2026" + s.slice(s.length - (max - 1))
}

// Render recent session context. The most recent message is the one most
// likely to carry the detail the question hinges on, so it gets a generous
// budget shown from its tail; older messages are kept short (head-clipped)
// purely as breadcrumbs. Newlines inside the last message are preserved so
// structure (e.g. a numbered "next steps" list) survives.
export function renderTranscript(
  messages: ReadonlyArray<{ role: string; text: string }>,
  max: number,
  opts?: { lastMessageChars?: number; olderMessageChars?: number },
): string {
  const lastMessageChars = opts?.lastMessageChars ?? 1200
  const olderMessageChars = opts?.olderMessageChars ?? 240
  const slice = messages.slice(-max)
  return slice
    .map((m, i) => {
      const isLast = i === slice.length - 1
      if (isLast) {
        // Keep newlines; only collapse runs of spaces/tabs and trailing
        // whitespace so the tail stays readable.
        const cleaned = m.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
        return `${m.role}: ${clipTail(cleaned, lastMessageChars)}`
      }
      return `${m.role}: ${clip(m.text.replace(/\s+/g, " ").trim(), olderMessageChars)}`
    })
    .join("\n")
}

// Extract a short human-readable summary from any opencode message Part.
// Returns "" for parts that carry no useful text (step-start, snapshot,
// patch, compaction, retry without message). The result is meant to be
// joined with spaces and then truncated; do not include newlines.
export function summarizePart(part: any): string {
  if (!part || typeof part !== "object") return ""
  switch (part.type) {
    case "text":
    case "reasoning":
      return typeof part.text === "string" ? part.text : ""
    case "tool": {
      const name = typeof part.tool === "string" ? part.tool : "tool"
      const title = part.state?.title
      if (typeof title === "string" && title) return `[${name}: ${title}]`
      const status = part.state?.status
      return status ? `[${name} ${status}]` : `[${name}]`
    }
    case "file":
      return part.filename ? `[file: ${part.filename}]` : "[file]"
    case "agent":
      return part.name ? `[agent: ${part.name}]` : "[agent]"
    case "subtask":
      return typeof part.description === "string" ? `[subtask: ${part.description}]` : "[subtask]"
    default:
      return ""
  }
}
