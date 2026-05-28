// src/telegram.ts
function makeTelegramClient(token) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body, signal) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data.result;
  }
  return {
    async sendMessage(chatID, text, keyboard, opts) {
      const reply_markup = (() => {
        if (keyboard)
          return { inline_keyboard: keyboard };
        if (opts?.forceReply)
          return { force_reply: true, selective: true };
        return;
      })();
      const result = await call("sendMessage", {
        chat_id: chatID,
        text,
        ...opts?.parseMode && { parse_mode: opts.parseMode },
        ...opts?.replyTo && { reply_to_message_id: opts.replyTo, allow_sending_without_reply: true },
        ...reply_markup && { reply_markup }
      });
      return { message_id: result.message_id };
    },
    async editMessage(chatID, messageID, text, keyboard, opts) {
      try {
        await call("editMessageText", {
          chat_id: chatID,
          message_id: messageID,
          text,
          ...opts?.parseMode && { parse_mode: opts.parseMode },
          ...keyboard && { reply_markup: { inline_keyboard: keyboard } }
        });
      } catch (err) {
        if (!String(err).includes("message is not modified"))
          throw err;
      }
    },
    async removeKeyboard(chatID, messageID) {
      try {
        await call("editMessageReplyMarkup", { chat_id: chatID, message_id: messageID, reply_markup: { inline_keyboard: [] } });
      } catch (err) {
        if (!String(err).includes("message is not modified")) {}
      }
    },
    async deleteMessage(chatID, messageID) {
      try {
        await call("deleteMessage", { chat_id: chatID, message_id: messageID });
      } catch {}
    },
    async answerCallback(callbackID, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackID,
        ...text && { text }
      });
    },
    async getUpdates(offset, timeoutSec, signal) {
      const result = await call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal);
      return result;
    }
  };
}

// src/render.ts
var CB = {
  option: (idx) => `o:${idx}`,
  custom: "c",
  done: "d",
  cancel: "x",
  quick: (idx) => `q:${idx}`
};
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function describeOption(label, description) {
  if (!description || description.trim() === label.trim())
    return "";
  return ` (${escapeHtml(description)})`;
}
function renderQuestion(prompt, context) {
  const lines = [];
  if (context.sessionTitle)
    lines.push(`<i>Session:</i> ${escapeHtml(context.sessionTitle)}`);
  if (context.transcript) {
    lines.push(`<i>Recent context:</i>`);
    lines.push(escapeHtml(context.transcript));
  }
  if (lines.length)
    lines.push("");
  const header = escapeHtml(prompt.header);
  const counter = context.total > 1 ? `<i>Question ${context.index + 1}/${context.total}:</i> ` : "";
  lines.push(`${counter}<b>${header}</b>`);
  lines.push("");
  lines.push(escapeHtml(prompt.question));
  if (prompt.options.length) {
    lines.push("");
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "✅" : "⚪";
      lines.push(`${mark} ${i + 1}. ${escapeHtml(opt.label)}${describeOption(opt.label, opt.description)}`);
    });
  }
  const keyboard = prompt.options.map((opt, i) => [
    {
      text: `${context.selected.has(i) ? "✅ " : ""}${i + 1}. ${opt.label}`,
      callback_data: CB.option(i)
    }
  ]);
  const allowCustom = prompt.custom !== false;
  if (allowCustom)
    keyboard.push([{ text: "Type your own answer", callback_data: CB.custom }]);
  if (prompt.multiple)
    keyboard.push([{ text: "Done", callback_data: CB.done }]);
  if (context.quickReplies) {
    for (let i = 0;i < context.quickReplies.length; i++) {
      keyboard.push([{ text: context.quickReplies[i], callback_data: CB.quick(i) }]);
    }
  }
  return { text: lines.join(`
`), keyboard };
}
function renderAnsweredQuestion(prompt, context) {
  const lines = [];
  if (context.sessionTitle) {
    lines.push(`<i>Session:</i> ${escapeHtml(context.sessionTitle)}`);
    lines.push("");
  }
  const header = escapeHtml(prompt.header);
  const counter = context.total > 1 ? `<i>Question ${context.index + 1}/${context.total}:</i> ` : "";
  lines.push(`${counter}<b>${header}</b>`);
  lines.push("");
  lines.push(escapeHtml(prompt.question));
  if (prompt.options.length) {
    lines.push("");
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "✅" : "⚪";
      lines.push(`${mark} ${i + 1}. ${escapeHtml(opt.label)}${describeOption(opt.label, opt.description)}`);
    });
  }
  if (context.customAnswer !== undefined) {
    lines.push("");
    lines.push(`✍️ <i>Your answer:</i> ${escapeHtml(context.customAnswer)}`);
  } else {
    lines.push("");
    lines.push(`✔️ <i>Answered from Telegram</i>`);
  }
  return { text: lines.join(`
`) };
}
function selectionToAnswer(prompt, selected, custom) {
  if (custom !== undefined)
    return [custom];
  return [...selected].sort((a, b) => a - b).map((i) => prompt.options[i].label);
}
function clip(s, max) {
  if (s.length <= max)
    return s;
  return s.slice(0, max - 1) + "…";
}
function renderTranscript(messages, max) {
  return messages.slice(-max).map((m) => `${m.role}: ${clip(m.text.replace(/\s+/g, " ").trim(), 240)}`).join(`
`);
}
function summarizePart(part) {
  if (!part || typeof part !== "object")
    return "";
  switch (part.type) {
    case "text":
    case "reasoning":
      return typeof part.text === "string" ? part.text : "";
    case "tool": {
      const name = typeof part.tool === "string" ? part.tool : "tool";
      const title = part.state?.title;
      if (typeof title === "string" && title)
        return `[${name}: ${title}]`;
      const status = part.state?.status;
      return status ? `[${name} ${status}]` : `[${name}]`;
    }
    case "file":
      return part.filename ? `[file: ${part.filename}]` : "[file]";
    case "agent":
      return part.name ? `[agent: ${part.name}]` : "[agent]";
    case "subtask":
      return typeof part.description === "string" ? `[subtask: ${part.description}]` : "[subtask]";
    default:
      return "";
  }
}

// src/controller.ts
var TELEGRAM_MAX = 4000;
function makeController(deps) {
  const requests = new Map;
  const messageIndex = new Map;
  const log = deps.log ?? (() => {});
  const freeTextDebounceMs = deps.freeTextDebounceMs ?? 1500;
  const quickReplies = deps.quickReplies ?? [];
  function clearFreeTextTimers(state) {
    for (const buf of state.freeTextBuffers.values()) {
      if (buf.timer)
        clearTimeout(buf.timer);
    }
    state.freeTextBuffers.clear();
  }
  async function onQuestionAsked(event) {
    log("info", "question.asked", { id: event.id, count: event.questions.length });
    const transcript = await deps.fetchHistory(event.sessionID).catch((err) => {
      log("warn", "history fetch failed", String(err));
      return [];
    });
    const transcriptText = transcript.length ? renderTranscript(transcript, deps.historyMessages) : undefined;
    const sessionTitle = await (deps.fetchSessionTitle?.(event.sessionID) ?? Promise.resolve(undefined)).catch((err) => {
      log("warn", "session title fetch failed", String(err));
      return;
    });
    const state = {
      event,
      sessionTitle,
      messageIDs: [],
      subStates: event.questions.map(() => ({ selected: new Set, awaitingCustom: false, answered: false })),
      customPrompts: new Map,
      freeTextBuffers: new Map,
      closed: false,
      answeredFromTelegram: false
    };
    requests.set(event.id, state);
    for (let i = 0;i < event.questions.length; i++) {
      const { text, keyboard } = renderQuestion(event.questions[i], {
        index: i,
        total: event.questions.length,
        selected: state.subStates[i].selected,
        transcript: i === 0 ? transcriptText : undefined,
        quickReplies,
        sessionTitle
      });
      const sent = await deps.telegram.sendMessage(deps.chatID, clip(text, TELEGRAM_MAX), keyboard, { parseMode: "HTML" });
      state.messageIDs.push(sent.message_id);
      messageIndex.set(sent.message_id, { requestID: event.id, subIndex: i });
    }
  }
  async function onQuestionResolved(requestID) {
    const state = requests.get(requestID);
    if (!state || state.closed)
      return;
    state.closed = true;
    requests.delete(requestID);
    clearFreeTextTimers(state);
    if (state.answeredFromTelegram)
      return;
    for (const promptMID of state.customPrompts.keys()) {
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {});
    }
    state.customPrompts.clear();
    for (const mid of state.messageIDs) {
      messageIndex.delete(mid);
      await deps.telegram.deleteMessage(deps.chatID, mid).catch(() => {});
    }
  }
  async function refreshMessage(state, subIndex) {
    const prompt = state.event.questions[subIndex];
    const sub = state.subStates[subIndex];
    const { text, keyboard } = renderQuestion(prompt, {
      index: subIndex,
      total: state.event.questions.length,
      selected: sub.selected,
      quickReplies,
      sessionTitle: state.sessionTitle
    });
    const mid = state.messageIDs[subIndex];
    await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX), keyboard, { parseMode: "HTML" });
  }
  async function trySubmit(state) {
    if (state.closed)
      return;
    if (!state.subStates.every((s) => s.answered))
      return;
    state.closed = true;
    state.answeredFromTelegram = true;
    clearFreeTextTimers(state);
    const answers = state.subStates.map((sub, i) => sub.customAnswer !== undefined ? [sub.customAnswer] : selectionToAnswer(state.event.questions[i], sub.selected));
    try {
      await deps.replyToOpencode(state.event.id, answers);
    } catch (err) {
      log("warn", "replyToOpencode failed (likely already answered)", String(err));
      state.answeredFromTelegram = false;
    }
    requests.delete(state.event.id);
    for (const promptMID of state.customPrompts.keys()) {
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {});
    }
    state.customPrompts.clear();
    for (let i = 0;i < state.messageIDs.length; i++) {
      const mid = state.messageIDs[i];
      messageIndex.delete(mid);
      if (state.answeredFromTelegram) {
        const prompt = state.event.questions[i];
        const sub = state.subStates[i];
        const { text } = renderAnsweredQuestion(prompt, { index: i, total: state.event.questions.length, selected: sub.selected, customAnswer: sub.customAnswer, sessionTitle: state.sessionTitle });
        await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX), undefined, { parseMode: "HTML" }).catch(() => {});
        await deps.telegram.removeKeyboard(deps.chatID, mid).catch(() => {});
      } else {
        await deps.telegram.deleteMessage(deps.chatID, mid).catch(() => {});
      }
    }
  }
  async function handleCallback(update) {
    const cb = update.callback_query;
    if (!cb || !cb.message || !cb.data)
      return;
    if (cb.message.chat.id !== deps.chatID)
      return;
    const target = messageIndex.get(cb.message.message_id);
    if (!target)
      return;
    const state = requests.get(target.requestID);
    if (!state) {
      await deps.telegram.answerCallback(cb.id).catch(() => {});
      return;
    }
    const sub = state.subStates[target.subIndex];
    const prompt = state.event.questions[target.subIndex];
    await deps.telegram.answerCallback(cb.id).catch(() => {});
    if (cb.data === CB.cancel) {
      try {
        await deps.rejectInOpencode(state.event.id);
      } catch (err) {
        log("warn", "rejectInOpencode failed", String(err));
      }
      await onQuestionResolved(state.event.id);
      return;
    }
    if (cb.data === CB.custom) {
      sub.awaitingCustom = true;
      const questionMID = state.messageIDs[target.subIndex];
      for (const [pmid, sIdx] of state.customPrompts) {
        if (sIdx === target.subIndex) {
          state.customPrompts.delete(pmid);
          const buf = state.freeTextBuffers.get(pmid);
          if (buf?.timer)
            clearTimeout(buf.timer);
          state.freeTextBuffers.delete(pmid);
          await deps.telegram.deleteMessage(deps.chatID, pmid).catch(() => {});
        }
      }
      const sent = await deps.telegram.sendMessage(deps.chatID, `Reply with your answer for: "${prompt.header}"`, undefined, { replyTo: questionMID, forceReply: true });
      state.customPrompts.set(sent.message_id, target.subIndex);
      return;
    }
    if (cb.data === CB.done) {
      if (prompt.multiple && sub.selected.size > 0) {
        sub.answered = true;
        await trySubmit(state);
      }
      return;
    }
    if (cb.data.startsWith("q:")) {
      const idx = Number(cb.data.slice(2));
      if (!Number.isInteger(idx) || idx < 0 || idx >= quickReplies.length)
        return;
      for (const [pmid, sIdx] of state.customPrompts) {
        if (sIdx === target.subIndex) {
          state.customPrompts.delete(pmid);
          const buf = state.freeTextBuffers.get(pmid);
          if (buf?.timer)
            clearTimeout(buf.timer);
          state.freeTextBuffers.delete(pmid);
          await deps.telegram.deleteMessage(deps.chatID, pmid).catch(() => {});
        }
      }
      applyFreeText(state, target.subIndex, quickReplies[idx]);
      await trySubmit(state);
      return;
    }
    if (cb.data.startsWith("o:")) {
      const idx = Number(cb.data.slice(2));
      if (!Number.isInteger(idx) || idx < 0 || idx >= prompt.options.length)
        return;
      if (prompt.multiple) {
        if (sub.selected.has(idx))
          sub.selected.delete(idx);
        else
          sub.selected.add(idx);
        await refreshMessage(state, target.subIndex);
      } else {
        sub.selected.clear();
        sub.selected.add(idx);
        sub.answered = true;
        await trySubmit(state);
      }
    }
  }
  async function handleMessage(update) {
    const msg = update.message;
    if (!msg || msg.chat.id !== deps.chatID || !msg.text)
      return;
    const replyTo = msg.reply_to_message?.message_id;
    if (replyTo === undefined)
      return;
    for (const state of requests.values()) {
      const idx = state.customPrompts.get(replyTo);
      if (idx === undefined)
        continue;
      let buf = state.freeTextBuffers.get(replyTo);
      if (!buf) {
        buf = { subIndex: idx, parts: [], timer: null };
        state.freeTextBuffers.set(replyTo, buf);
      }
      buf.parts.push({ mid: msg.message_id, text: msg.text });
      if (buf.timer)
        clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        flushFreeText(state, replyTo).catch((err) => log("error", "flushFreeText error", String(err)));
      }, freeTextDebounceMs);
      return;
    }
  }
  async function flushFreeText(state, promptMID) {
    if (state.closed)
      return;
    const buf = state.freeTextBuffers.get(promptMID);
    if (!buf)
      return;
    state.freeTextBuffers.delete(promptMID);
    buf.timer = null;
    const text = buf.parts.slice().sort((a, b) => a.mid - b.mid).map((p) => p.text).join(`
`);
    state.customPrompts.delete(promptMID);
    await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {});
    applyFreeText(state, buf.subIndex, text);
    await trySubmit(state);
  }
  function applyFreeText(state, idx, text) {
    const sub = state.subStates[idx];
    sub.customAnswer = text;
    sub.answered = true;
    sub.awaitingCustom = false;
  }
  async function handleUpdate(update) {
    if (update.callback_query)
      return handleCallback(update);
    if (update.message)
      return handleMessage(update);
  }
  return { onQuestionAsked, onQuestionResolved, handleUpdate, _state: { requests, messageIndex } };
}

// src/permission.ts
var TELEGRAM_MAX2 = 4000;
var PERMISSION_CB = {
  once: "p:once",
  always: "p:always",
  reject: "p:reject"
};
function renderPermission(req) {
  const lines = [];
  lines.push("Permission requested");
  lines.push("");
  lines.push(`Tool: ${req.permission}`);
  if (req.patterns && req.patterns.length) {
    lines.push("");
    lines.push("Patterns:");
    for (const p of req.patterns.slice(0, 8))
      lines.push(`  ${p}`);
    if (req.patterns.length > 8)
      lines.push(`  ...and ${req.patterns.length - 8} more`);
  }
  if (req.metadata && Object.keys(req.metadata).length) {
    lines.push("");
    lines.push("Details:");
    for (const [k, v] of Object.entries(req.metadata).slice(0, 8)) {
      const sv = typeof v === "string" ? v : JSON.stringify(v);
      lines.push(`  ${k}: ${clip(sv, 200)}`);
    }
  }
  const keyboard = [
    [
      { text: "Allow once", callback_data: PERMISSION_CB.once },
      { text: "Always allow", callback_data: PERMISSION_CB.always }
    ],
    [{ text: "Reject", callback_data: PERMISSION_CB.reject }]
  ];
  return { text: lines.join(`
`), keyboard };
}
function renderResolvedPermission(req, choice) {
  const lines = [];
  lines.push("Permission requested");
  lines.push("");
  lines.push(`Tool: ${req.permission}`);
  if (req.patterns && req.patterns.length) {
    lines.push("");
    for (const p of req.patterns.slice(0, 8))
      lines.push(`  ${p}`);
  }
  lines.push("");
  const verb = choice === "reject" ? "❌ Rejected" : choice === "always" ? "✅ Allowed (always)" : "✅ Allowed once";
  lines.push(`${verb} from Telegram`);
  return lines.join(`
`);
}
function makePermissionController(deps) {
  const requests = new Map;
  const messageIndex = new Map;
  const log = deps.log ?? (() => {});
  async function onPermissionAsked(req) {
    log("info", "permission.asked", { id: req.id, permission: req.permission });
    const { text, keyboard } = renderPermission(req);
    const sent = await deps.telegram.sendMessage(deps.chatID, clip(text, TELEGRAM_MAX2), keyboard);
    requests.set(req.id, {
      request: req,
      messageID: sent.message_id,
      closed: false,
      resolvedFromTelegram: false
    });
    messageIndex.set(sent.message_id, req.id);
  }
  async function onPermissionResolved(requestID) {
    const state = requests.get(requestID);
    if (!state || state.closed)
      return;
    state.closed = true;
    requests.delete(requestID);
    messageIndex.delete(state.messageID);
    if (state.resolvedFromTelegram)
      return;
    await deps.telegram.deleteMessage(deps.chatID, state.messageID).catch(() => {});
  }
  async function handleCallback(update) {
    const cb = update.callback_query;
    if (!cb || !cb.message || !cb.data)
      return false;
    if (cb.message.chat.id !== deps.chatID)
      return false;
    const requestID = messageIndex.get(cb.message.message_id);
    if (!requestID)
      return false;
    const state = requests.get(requestID);
    if (!state) {
      await deps.telegram.answerCallback(cb.id).catch(() => {});
      return true;
    }
    const choice = cb.data === PERMISSION_CB.once ? "once" : cb.data === PERMISSION_CB.always ? "always" : cb.data === PERMISSION_CB.reject ? "reject" : undefined;
    if (!choice)
      return false;
    await deps.telegram.answerCallback(cb.id).catch(() => {});
    state.closed = true;
    state.resolvedFromTelegram = true;
    requests.delete(requestID);
    messageIndex.delete(state.messageID);
    try {
      await deps.reply(requestID, choice);
    } catch (err) {
      log("warn", "permission reply failed (likely already resolved)", String(err));
      await deps.telegram.deleteMessage(deps.chatID, state.messageID).catch(() => {});
      return true;
    }
    const finalText = renderResolvedPermission(state.request, choice);
    await deps.telegram.editMessage(deps.chatID, state.messageID, clip(finalText, TELEGRAM_MAX2)).catch(() => {});
    await deps.telegram.removeKeyboard(deps.chatID, state.messageID).catch(() => {});
    return true;
  }
  return { onPermissionAsked, onPermissionResolved, handleCallback, _state: { requests, messageIndex } };
}

// src/ipc.ts
import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { access, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
function ipcPathFor(token) {
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  if (process.platform === "win32")
    return `\\\\?\\pipe\\opencode-telegram-${id}`;
  return path.join(tmpdir(), `opencode-telegram-${id}.sock`);
}
async function joinOrLead(opts) {
  const listen = opts.netListen ?? defaultNetListen;
  const connect = opts.netConnect ?? defaultNetConnect;
  const unlinkStale = opts.unlinkStaleSocket ?? defaultUnlinkStale;
  const probe = await pathExists(opts.path) ? await tryConnect(connect, opts.path) : undefined;
  if (probe)
    return makeFollower(probe);
  const first = await tryListen(listen, opts.path);
  if (first.ok)
    return makeLeader(first.server);
  if (first.code === "EADDRINUSE") {
    const second = await pathExists(opts.path) ? await tryConnect(connect, opts.path) : undefined;
    if (second)
      return makeFollower(second);
    await unlinkStale(opts.path).catch(() => {});
    const third = await tryListen(listen, opts.path);
    if (third.ok)
      return makeLeader(third.server);
  }
  throw new Error(`opencode-telegram-question: cannot bind nor connect IPC at ${opts.path}: ${first.code ?? "unknown"}`);
}
function makeLeader(server) {
  const peers = new Set;
  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    peers.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf(`
`)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line)
          continue;
      }
    });
    const dispose = () => {
      peers.delete(socket);
    };
    socket.on("close", dispose);
    socket.on("error", dispose);
  });
  return {
    role: "leader",
    broadcast(message) {
      const line = JSON.stringify(message) + `
`;
      for (const peer of peers) {
        if (!peer.writable)
          continue;
        peer.write(line);
      }
    },
    followerCount: () => peers.size,
    close: () => new Promise((resolve) => {
      for (const peer of peers)
        peer.destroy();
      server.close(() => resolve());
    })
  };
}
function makeFollower(socket) {
  socket.setEncoding("utf8");
  const handlers = new Set;
  const disconnectHandlers = new Set;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf(`
`)) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line)
        continue;
      const parsed = safeParse(line);
      if (!parsed)
        continue;
      for (const h of handlers)
        h(parsed);
    }
  });
  socket.on("close", () => {
    for (const h of disconnectHandlers)
      h();
  });
  socket.on("error", (err) => {
    for (const h of disconnectHandlers)
      h(err);
  });
  return {
    role: "follower",
    onMessage(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    onDisconnect(h) {
      disconnectHandlers.add(h);
      return () => disconnectHandlers.delete(h);
    },
    close: () => new Promise((resolve) => {
      if (socket.destroyed)
        return resolve();
      socket.once("close", () => resolve());
      socket.destroy();
    })
  };
}
function safeParse(line) {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object" && typeof obj.type === "string")
      return obj;
    return;
  } catch {
    return;
  }
}
function tryListen(impl, p) {
  return new Promise((resolve) => {
    const server = impl();
    server.once("error", (err) => resolve({ ok: false, code: err.code }));
    server.listen(p, () => resolve({ ok: true, server }));
  });
}
function tryConnect(impl, p) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    try {
      socket = impl(p);
    } catch {
      resolve(undefined);
      return;
    }
    socket.on("error", () => {
      if (settled)
        return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(undefined);
    });
    socket.once("connect", () => {
      if (settled)
        return;
      settled = true;
      resolve(socket);
    });
  });
}
function defaultNetListen() {
  return createServer();
}
function defaultNetConnect(p) {
  return createConnection(p);
}
async function pathExists(p) {
  if (process.platform === "win32")
    return true;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function defaultUnlinkStale(p) {
  if (process.platform === "win32")
    return;
  await unlink(p).catch(() => {});
}

// src/coordinator.ts
async function runCoordinator(deps, onUpdate) {
  const log = deps.log ?? (() => {});
  const path2 = deps.ipcPath ?? ipcPathFor(deps.token);
  while (!deps.signal.aborted) {
    let role;
    try {
      role = await joinOrLead({ path: path2 });
    } catch (err) {
      log("error", "ipc bind/connect failed; falling back to standalone leader", String(err));
      await runAsLeader(deps, onUpdate, undefined);
      return;
    }
    if (role.role === "leader") {
      log("info", "telegram-question: this process is the leader", { path: path2, followers: role.followerCount() });
      await runAsLeader(deps, onUpdate, role);
      return;
    }
    log("info", "telegram-question: this process is a follower", { path: path2 });
    const reelect = await runAsFollower(deps, role, onUpdate);
    if (!reelect)
      return;
  }
}
async function runAsLeader(deps, onUpdate, role) {
  let offset = 0;
  const log = deps.log ?? (() => {});
  while (!deps.signal.aborted) {
    try {
      const updates = await deps.telegram.getUpdates(offset, 30, deps.signal);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        if (role && role.role === "leader")
          role.broadcast({ type: "update", data: u });
        await onUpdate(u).catch((err) => log("error", "leader update handler error", String(err)));
      }
    } catch (err) {
      if (deps.signal.aborted)
        break;
      log("warn", "leader poll error, retrying in 5s", String(err));
      await sleep(5000, deps.signal);
    }
  }
  if (role && role.role === "leader")
    await role.close().catch(() => {});
}
async function runAsFollower(deps, role, onUpdate) {
  if (role.role !== "follower")
    return false;
  const log = deps.log ?? (() => {});
  return await new Promise((resolve) => {
    const offMsg = role.onMessage((m) => {
      if (m.type !== "update")
        return;
      const u = m.data;
      onUpdate(u).catch((err) => log("error", "follower update handler error", String(err)));
    });
    const offDisc = role.onDisconnect(() => {
      offMsg();
      offDisc();
      if (deps.signal.aborted)
        resolve(false);
      else
        resolve(true);
    });
    deps.signal.addEventListener("abort", () => {
      offMsg();
      offDisc();
      role.close();
      resolve(false);
    }, { once: true });
  });
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// src/log.ts
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";
function defaultLogDir() {
  if (process.platform === "win32") {
    return path2.join(process.env.LOCALAPPDATA ?? path2.join(homedir(), "AppData", "Local"), "opencode-telegram-question");
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg)
    return path2.join(xdg, "opencode-telegram-question");
  return path2.join(homedir(), ".local", "state", "opencode-telegram-question");
}
function defaultLogFile() {
  return path2.join(defaultLogDir(), "plugin.log");
}
function makeFileLogger(file = defaultLogFile()) {
  const dir = path2.dirname(file);
  let ready;
  const ensure = () => {
    if (!ready)
      ready = mkdir(dir, { recursive: true }).then(() => {
        return;
      }).catch(() => {
        return;
      });
    return ready;
  };
  return (level, msg, data) => {
    const pid = process.pid;
    const ts = new Date().toISOString();
    const line = data === undefined ? `${ts} [pid ${pid}] ${level} ${msg}
` : `${ts} [pid ${pid}] ${level} ${msg} ${safeStringify(data)}
`;
    ensure().then(() => appendFile(file, line).catch(() => {
      return;
    }));
  };
}
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// src/index.ts
var TelegramQuestionPlugin = async (input, options) => {
  const opts = options ?? {};
  const token = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatIdRaw = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const historyMessages = opts.historyMessages ?? Number(process.env.OPENCODE_TELEGRAM_HISTORY ?? 3);
  const log = makeFileLogger(opts.logFile ?? defaultLogFile());
  const quickReplies = opts.quickReplies ?? parseQuickRepliesEnv(process.env.OPENCODE_TELEGRAM_QUICK_REPLIES, log);
  if (!token || chatIdRaw === undefined || chatIdRaw === "") {
    log("warn", "disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID (set in opencode.json plugin options or env)");
    return {};
  }
  const chatID = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  if (!Number.isFinite(chatID)) {
    log("warn", "disabled: invalid chatId", { chatId: chatIdRaw });
    return {};
  }
  const telegram = opts.telegram ?? makeTelegramClient(token);
  const controller = makeController({
    telegram,
    chatID,
    historyMessages,
    quickReplies,
    fetchHistory: async (sessionID) => {
      const anyClient = input.client;
      const sessionAPI = anyClient?.session;
      const messages = sessionAPI?.messages;
      if (typeof messages !== "function") {
        log("warn", "session.messages SDK method not found", { keys: sessionAPI ? Object.keys(sessionAPI) : null });
        return [];
      }
      const tryShapes = [{ path: { id: sessionID } }, { sessionID }, { id: sessionID }];
      let res;
      let lastErr;
      for (const args of tryShapes) {
        try {
          res = await messages.call(sessionAPI, args);
        } catch (err) {
          lastErr = err;
          res = undefined;
          continue;
        }
        if (res && typeof res === "object" && "error" in res && res.error !== undefined && res.data === undefined) {
          lastErr = res.error;
          res = undefined;
          continue;
        }
        if (res !== undefined)
          break;
      }
      if (res === undefined) {
        log("warn", "session.messages returned no data for any SDK shape", { err: String(lastErr ?? "") });
        return [];
      }
      const data = Array.isArray(res) ? res : res?.data ?? res?.items ?? [];
      if (!Array.isArray(data) || data.length === 0) {
        log("info", "session.messages returned empty payload", { shape: Array.isArray(res) ? "bare-array" : Object.keys(res ?? {}) });
        return [];
      }
      const out = [];
      for (const m of data) {
        const info = m.info ?? m;
        const parts = m.parts ?? info?.parts ?? [];
        const text = parts.map((p) => summarizePart(p)).filter(Boolean).join(" ");
        if (text)
          out.push({ role: info?.role ?? "?", text });
      }
      log("info", "session.messages transcript built", { rawMessages: data.length, kept: out.length });
      return out;
    },
    fetchSessionTitle: async (sessionID) => {
      const anyClient = input.client;
      const sessionAPI = anyClient?.session;
      const get = sessionAPI?.get;
      if (typeof get !== "function")
        return;
      const tryShapes = [{ path: { id: sessionID } }, { id: sessionID }, { sessionID }];
      for (const args of tryShapes) {
        let res;
        try {
          res = await get.call(sessionAPI, args);
        } catch {
          continue;
        }
        if (res && typeof res === "object" && "error" in res && res.error !== undefined && res.data === undefined)
          continue;
        const info = (res && typeof res === "object" && "data" in res ? res.data : res) ?? undefined;
        const title = info?.title;
        if (typeof title === "string" && title.length)
          return title;
      }
      return;
    },
    replyToOpencode: async (requestID, answers) => {
      const client = input.client;
      const body = { answers: answers.map((a) => [...a]) };
      const url = `/question/${encodeURIComponent(requestID)}/reply`;
      if (client?.question?.reply) {
        await client.question.reply({ requestID, answers: body.answers });
        return;
      }
      if (client?._client?.post) {
        await client._client.post({ url, body });
        return;
      }
      throw new Error("No way to POST to question reply endpoint");
    },
    rejectInOpencode: async (requestID) => {
      const client = input.client;
      const url = `/question/${encodeURIComponent(requestID)}/reject`;
      if (client?.question?.reject) {
        await client.question.reject({ requestID });
        return;
      }
      if (client?._client?.post) {
        await client._client.post({ url });
        return;
      }
      throw new Error("No way to POST to question reject endpoint");
    },
    log
  });
  const permissionController = makePermissionController({
    telegram,
    chatID,
    reply: async (requestID, choice) => {
      const client = input.client;
      if (client?.permission?.reply) {
        await client.permission.reply({ requestID, reply: choice });
        return;
      }
      if (client?._client?.post) {
        await client._client.post({
          url: `/permission/${encodeURIComponent(requestID)}/reply`,
          body: { reply: choice }
        });
        return;
      }
      throw new Error("No way to POST to permission reply endpoint");
    },
    log
  });
  const abort = new AbortController;
  runCoordinator({ telegram, token, signal: abort.signal, log }, async (u) => {
    try {
      const claimed = await permissionController.handleCallback(u);
      if (claimed)
        return;
    } catch (err) {
      log("error", "permission handler error", String(err));
    }
    await controller.handleUpdate(u).catch((err) => log("error", "handler error", String(err)));
  }).catch((err) => log("error", "coordinator stopped", String(err)));
  process.once?.("beforeExit", () => abort.abort());
  return {
    event: async ({ event }) => {
      const e = event;
      switch (e.type) {
        case "question.asked": {
          const props = e.properties;
          await controller.onQuestionAsked(props).catch((err) => log("error", "asked error", String(err)));
          return;
        }
        case "question.replied":
        case "question.rejected": {
          const props = e.properties;
          if (props?.requestID)
            await controller.onQuestionResolved(props.requestID).catch(() => {});
          return;
        }
        case "permission.asked": {
          const props = e.properties;
          await permissionController.onPermissionAsked(props).catch((err) => log("error", "permission asked error", String(err)));
          return;
        }
        case "permission.replied": {
          const props = e.properties;
          if (props?.requestID)
            await permissionController.onPermissionResolved(props.requestID).catch(() => {});
          return;
        }
      }
    }
  };
};
function parseQuickRepliesEnv(raw, log) {
  if (!raw)
    return [];
  const trimmed = raw.trim();
  if (!trimmed)
    return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string"))
        return parsed;
      log("warn", "OPENCODE_TELEGRAM_QUICK_REPLIES JSON is not an array of strings", { value: trimmed });
      return [];
    } catch (err) {
      log("warn", "OPENCODE_TELEGRAM_QUICK_REPLIES JSON parse failed", String(err));
      return [];
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}
var src_default = { server: TelegramQuestionPlugin, id: "opencode-telegram-question" };
export {
  src_default as default
};
