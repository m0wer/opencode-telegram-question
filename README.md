# opencode-telegram-question

Mirror opencode's built-in `question` tool to a Telegram bot. When opencode
asks you something while you're AFK, answer it from your phone. The CLI
session keeps working as if you'd answered locally.

The plugin does **not** patch the opencode binary. It is a regular plugin
that hooks into opencode's bus events and the public SDK client; it should
keep working across minor opencode upgrades.

## How it works

1. opencode's `question` tool publishes `question.asked` on the internal bus
   with the full request (including sub-questions, options, `multiple` and
   `custom` flags).
2. This plugin's `event` hook receives that event, sends one Telegram
   message per sub-question, with inline-keyboard buttons for each option
   plus a "Type your own answer" entry and a "Cancel" entry. The first
   message also includes a short transcript of the last few session messages
   for context.
3. When you tap a button (or send a free-text reply), the plugin assembles
   the answer array and calls `POST /question/{id}/reply` via the SDK
   client. opencode unblocks the tool and the session continues. The
   Telegram message is edited in place: chosen options are marked with
   `(check)` and the inline keyboard is removed, so you keep a record of what
   you answered.
4. If you answer in the CLI/TUI instead, the bus emits `question.replied`
   (or `question.rejected`), and the plugin deletes its Telegram messages so
   you don't see stale buttons.

Free-text answers use Telegram's `force_reply`, so tapping "Type your own
answer" pops the reply composer pre-quoted to the question. Concurrent
custom prompts (one per sub-question) are routed back to the correct slot
via `reply_to_message_id`.

Multi-question calls are supported: every sub-question gets its own
message, and the plugin only replies to opencode once all sub-questions
have been answered (preserving order).

## Setup

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram and run `/newbot`.
   Follow the prompts to choose a name and username. BotFather will reply
   with a **bot token** that looks like `123456:AA...`. Save it.
2. Open the chat with your new bot and send it any message (e.g. `/start`).
   This makes the bot able to message you (Telegram blocks unsolicited
   outbound messages otherwise).

### 2. Find your chat id

Open [@userinfobot](https://t.me/userinfobot) in Telegram and send it any
message. It will reply with your numeric user id, which is what you pass
as `chatId` for a private 1:1 chat with your own bot.

### 3. Install the plugin

Option A: drop-in file (no npm publish required, recommended for now).

```bash
git clone https://github.com/m0wer/opencode-telegram-question.git
cd opencode-telegram-question
bun install
bun run build
mkdir -p ~/.config/opencode/plugin
cp dist/index.js ~/.config/opencode/plugin/telegram-question.js
```

opencode auto-loads any `*.js` or `*.ts` file under
`~/.config/opencode/plugin/`, so the file alone is enough. Auto-discovered
plugins can't receive inline options, so use the environment variables in
step 4 for this option (or switch to Option B if you prefer inline config).

Option B: reference the built file by absolute path from `opencode.json`.

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    [
      "/absolute/path/to/opencode-telegram-question/dist/index.js",
      {
        "botToken": "123456:AA...",
        "chatId": 987654321,
        "historyMessages": 3
      }
    ]
  ]
}
```

Option C: install from npm (once published).

```bash
bun add -d opencode-telegram-question
```

```jsonc
{
  "plugin": [
    [
      "opencode-telegram-question",
      {
        "botToken": "123456:AA...",
        "chatId": 987654321,
        "historyMessages": 3
      }
    ]
  ]
}
```

### 4. Credentials

You can either pass them inline in `opencode.json` (as shown above) or
through the environment. Inline wins if both are set.

```bash
export TELEGRAM_BOT_TOKEN="123456:AA..."
export TELEGRAM_CHAT_ID="987654321"
```

Options:

| Key | Env fallback | Default | Notes |
|---|---|---|---|
| `botToken` | `TELEGRAM_BOT_TOKEN` | (required) | From [@BotFather](https://t.me/BotFather) |
| `chatId` | `TELEGRAM_CHAT_ID` | (required) | Your numeric user id from [@userinfobot](https://t.me/userinfobot) |
| `historyMessages` | `OPENCODE_TELEGRAM_HISTORY` | `3` | Lines of recent history prepended to the first sub-question |

If either credential is missing the plugin disables itself (with a warning)
and the CLI/TUI flow is unchanged.

## Security notes

- The plugin only accepts callback queries and messages from the configured
  `chatId`. Other chats receive "Not authorized".
- The bot token grants full control of the bot; treat it like a password.

## Development

```bash
bun install
bun test            # unit + integration tests against an in-memory transport
bun run typecheck
bun run build
```

Tests cover: single-choice, multi-choice, free-text with `force_reply`,
concurrent custom-prompt routing via `reply_to_message`, multi sub-question
ordering, cancel/reject, CLI-answers-first cleanup, message edit-on-answer
behavior, and chat-id isolation.
