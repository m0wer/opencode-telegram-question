// File-backed logger so plugin output never pollutes the opencode TUI.
//
// We deliberately avoid console.log/warn/error because the TUI surfaces
// any stdout/stderr written by plugins as visible text in the chat pane.
// Instead, we append JSON-lines to a per-user state file the user can
// tail when they actually want to see what the plugin is doing.

import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export type LogLevel = "info" | "warn" | "error"
export type LogFn = (level: LogLevel, msg: string, data?: unknown) => void

export function defaultLogDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "opencode-telegram-question")
  }
  const xdg = process.env.XDG_STATE_HOME
  if (xdg) return path.join(xdg, "opencode-telegram-question")
  return path.join(homedir(), ".local", "state", "opencode-telegram-question")
}

export function defaultLogFile(): string {
  return path.join(defaultLogDir(), "plugin.log")
}

// Create a logger that appends to `file`. Failures (disk full, perms) are
// swallowed; we never throw from the logger because that would leak back
// into the TUI via unhandled-rejection paths.
export function makeFileLogger(file = defaultLogFile()): LogFn {
  const dir = path.dirname(file)
  let ready: Promise<void> | undefined
  const ensure = () => {
    if (!ready) ready = mkdir(dir, { recursive: true }).then(() => undefined).catch(() => undefined)
    return ready
  }
  return (level, msg, data) => {
    const pid = process.pid
    const ts = new Date().toISOString()
    const line = data === undefined
      ? `${ts} [pid ${pid}] ${level} ${msg}\n`
      : `${ts} [pid ${pid}] ${level} ${msg} ${safeStringify(data)}\n`
    void ensure().then(() => appendFile(file, line).catch(() => undefined))
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
