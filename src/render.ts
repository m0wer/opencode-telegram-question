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

// Telegram limits callback_data to 64 bytes. We encode actions as compact
// strings: `o:<idx>` (option toggle), `c` (custom-text mode), `d` (done for
// multi-select), `x` (cancel).
export const CB = {
  option: (idx: number) => `o:${idx}`,
  custom: "c",
  done: "d",
  cancel: "x",
} as const

export function renderQuestion(
  prompt: Prompt,
  context: { index: number; total: number; selected: ReadonlySet<number>; transcript?: string },
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = []
  if (context.total > 1) lines.push(`Question ${context.index + 1}/${context.total}: ${prompt.header}`)
  else lines.push(prompt.header)
  lines.push("")
  lines.push(prompt.question)
  if (prompt.options.length) {
    lines.push("")
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "\u2705" : "\u26AA"
      lines.push(`${mark} ${i + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}`)
    })
  }
  if (context.transcript) {
    lines.unshift("")
    lines.unshift(context.transcript)
    lines.unshift("Recent context:")
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
  context: { index: number; total: number; selected: ReadonlySet<number>; customAnswer?: string },
): { text: string } {
  const lines: string[] = []
  if (context.total > 1) lines.push(`Question ${context.index + 1}/${context.total}: ${prompt.header}`)
  else lines.push(prompt.header)
  lines.push("")
  lines.push(prompt.question)
  if (prompt.options.length) {
    lines.push("")
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "\u2705" : "\u26AA"
      lines.push(`${mark} ${i + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}`)
    })
  }
  if (context.customAnswer !== undefined) {
    lines.push("")
    lines.push(`\u270D\uFE0F Your answer: ${context.customAnswer}`)
  } else {
    lines.push("")
    lines.push("\u2714\uFE0F Answered from Telegram")
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

export function renderTranscript(
  messages: ReadonlyArray<{ role: string; text: string }>,
  max: number,
): string {
  return messages
    .slice(-max)
    .map((m) => `${m.role}: ${clip(m.text.replace(/\s+/g, " ").trim(), 240)}`)
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
