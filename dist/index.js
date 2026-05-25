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
        ...opts?.replyTo && { reply_to_message_id: opts.replyTo, allow_sending_without_reply: true },
        ...reply_markup && { reply_markup }
      });
      return { message_id: result.message_id };
    },
    async editMessage(chatID, messageID, text, keyboard) {
      try {
        await call("editMessageText", {
          chat_id: chatID,
          message_id: messageID,
          text,
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
  cancel: "x"
};
function renderQuestion(prompt, context) {
  const lines = [];
  if (context.total > 1)
    lines.push(`Question ${context.index + 1}/${context.total}: ${prompt.header}`);
  else
    lines.push(prompt.header);
  lines.push("");
  lines.push(prompt.question);
  if (prompt.options.length) {
    lines.push("");
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "✅" : "⚪";
      lines.push(`${mark} ${i + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}`);
    });
  }
  if (context.transcript) {
    lines.unshift("");
    lines.unshift(context.transcript);
    lines.unshift("Recent context:");
  }
  const keyboard = prompt.options.map((opt, i) => [
    {
      text: `${context.selected.has(i) ? "✅ " : ""}${opt.label}`,
      callback_data: CB.option(i)
    }
  ]);
  const allowCustom = prompt.custom !== false;
  if (allowCustom)
    keyboard.push([{ text: "Type your own answer", callback_data: CB.custom }]);
  if (prompt.multiple)
    keyboard.push([{ text: "Done", callback_data: CB.done }]);
  keyboard.push([{ text: "Cancel", callback_data: CB.cancel }]);
  return { text: lines.join(`
`), keyboard };
}
function renderAnsweredQuestion(prompt, context) {
  const lines = [];
  if (context.total > 1)
    lines.push(`Question ${context.index + 1}/${context.total}: ${prompt.header}`);
  else
    lines.push(prompt.header);
  lines.push("");
  lines.push(prompt.question);
  if (prompt.options.length) {
    lines.push("");
    prompt.options.forEach((opt, i) => {
      const mark = context.selected.has(i) ? "✅" : "⚪";
      lines.push(`${mark} ${i + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}`);
    });
  }
  if (context.customAnswer !== undefined) {
    lines.push("");
    lines.push(`✍️ Your answer: ${context.customAnswer}`);
  } else {
    lines.push("");
    lines.push("✔️ Answered from Telegram");
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

// src/controller.ts
var TELEGRAM_MAX = 4000;
function makeController(deps) {
  const requests = new Map;
  const messageIndex = new Map;
  const log = deps.log ?? (() => {});
  async function onQuestionAsked(event) {
    log("info", "question.asked", { id: event.id, count: event.questions.length });
    const transcript = await deps.fetchHistory(event.sessionID).catch((err) => {
      log("warn", "history fetch failed", String(err));
      return [];
    });
    const transcriptText = transcript.length ? renderTranscript(transcript, deps.historyMessages) : undefined;
    const state = {
      event,
      messageIDs: [],
      subStates: event.questions.map(() => ({ selected: new Set, awaitingCustom: false, answered: false })),
      customPrompts: new Map,
      closed: false,
      answeredFromTelegram: false
    };
    requests.set(event.id, state);
    for (let i = 0;i < event.questions.length; i++) {
      const { text, keyboard } = renderQuestion(event.questions[i], {
        index: i,
        total: event.questions.length,
        selected: state.subStates[i].selected,
        transcript: i === 0 ? transcriptText : undefined
      });
      const sent = await deps.telegram.sendMessage(deps.chatID, clip(text, TELEGRAM_MAX), keyboard);
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
      selected: sub.selected
    });
    const mid = state.messageIDs[subIndex];
    await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX), keyboard);
  }
  async function trySubmit(state) {
    if (state.closed)
      return;
    if (!state.subStates.every((s) => s.answered))
      return;
    state.closed = true;
    state.answeredFromTelegram = true;
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
        const { text } = renderAnsweredQuestion(prompt, { index: i, total: state.event.questions.length, selected: sub.selected, customAnswer: sub.customAnswer });
        await deps.telegram.editMessage(deps.chatID, mid, clip(text, TELEGRAM_MAX)).catch(() => {});
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
    if (cb.message.chat.id !== deps.chatID) {
      await deps.telegram.answerCallback(cb.id, "Not authorized").catch(() => {});
      return;
    }
    const target = messageIndex.get(cb.message.message_id);
    if (!target) {
      await deps.telegram.answerCallback(cb.id, "This question is no longer active").catch(() => {});
      return;
    }
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
    if (replyTo !== undefined) {
      for (const state of requests.values()) {
        const idx = state.customPrompts.get(replyTo);
        if (idx === undefined)
          continue;
        state.customPrompts.delete(replyTo);
        await deps.telegram.deleteMessage(deps.chatID, replyTo).catch(() => {});
        applyFreeText(state, idx, msg.text);
        await trySubmit(state);
        return;
      }
    }
    for (const state of requests.values()) {
      if (state.customPrompts.size === 0)
        continue;
      const [promptMID, idx] = state.customPrompts.entries().next().value;
      state.customPrompts.delete(promptMID);
      await deps.telegram.deleteMessage(deps.chatID, promptMID).catch(() => {});
      applyFreeText(state, idx, msg.text);
      await trySubmit(state);
      return;
    }
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

// src/index.ts
var TelegramQuestionPlugin = async (input, options) => {
  const opts = options ?? {};
  const token = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatIdRaw = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const historyMessages = opts.historyMessages ?? Number(process.env.OPENCODE_TELEGRAM_HISTORY ?? 3);
  if (!token || chatIdRaw === undefined || chatIdRaw === "") {
    console.warn("[telegram-question] disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID (set in opencode.json plugin options or env)");
    return {};
  }
  const chatID = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  if (!Number.isFinite(chatID)) {
    console.warn(`[telegram-question] disabled: invalid chatId ${chatIdRaw}`);
    return {};
  }
  const telegram = opts.telegram ?? makeTelegramClient(token);
  const controller = makeController({
    telegram,
    chatID,
    historyMessages,
    fetchHistory: async (sessionID) => {
      const anyClient = input.client;
      const sessionAPI = anyClient?.session;
      const messagesAPI = sessionAPI?.messages ?? sessionAPI?.message;
      if (!messagesAPI || typeof messagesAPI.list !== "function")
        return [];
      const res = await messagesAPI.list({ sessionID }).catch(() => {
        return;
      });
      const data = res?.data ?? res ?? [];
      const out = [];
      for (const m of data) {
        const info = m.info ?? m;
        const parts = m.parts ?? info?.parts ?? [];
        const text = parts.map((p) => p?.type === "text" ? p.text : "").filter(Boolean).join(" ");
        if (text)
          out.push({ role: info?.role ?? "?", text });
      }
      return out;
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
    log: (level, msg, data) => {
      const line = `[telegram-question] ${msg}` + (data ? " " + JSON.stringify(data) : "");
      if (level === "error")
        console.error(line);
      else if (level === "warn")
        console.warn(line);
      else
        console.log(line);
    }
  });
  const abort = new AbortController;
  (async () => {
    let offset = 0;
    while (!abort.signal.aborted) {
      try {
        const updates = await telegram.getUpdates(offset, 30, abort.signal);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await controller.handleUpdate(u).catch((err) => console.error("[telegram-question] handler error", err));
        }
      } catch (err) {
        if (abort.signal.aborted)
          return;
        console.error("[telegram-question] poll error, retrying in 5s", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  process.once?.("beforeExit", () => abort.abort());
  return {
    event: async ({ event }) => {
      const e = event;
      switch (e.type) {
        case "question.asked": {
          const props = e.properties;
          await controller.onQuestionAsked(props).catch((err) => console.error("[telegram-question] asked error", err));
          return;
        }
        case "question.replied":
        case "question.rejected": {
          const props = e.properties;
          if (props?.requestID)
            await controller.onQuestionResolved(props.requestID).catch(() => {});
          return;
        }
      }
    }
  };
};
var src_default = { server: TelegramQuestionPlugin, id: "opencode-telegram-question" };
export {
  src_default as default
};
