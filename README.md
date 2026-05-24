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

## Install

### Option A: drop-in file (zero config)

1. Build a single-file bundle:

   ```bash
   bun install
   bun run build
   ```

2. Copy `dist/index.js` to one of opencode's auto-discovered plugin paths:

   ```bash
   mkdir -p ~/.opencode/plugin
   cp dist/index.js ~/.opencode/plugin/telegram-question.js
   ```

3. Set credentials in your shell environment (or in opencode.json, see
   below):

   ```bash
   export TELEGRAM_BOT_TOKEN="123:ABC..."
   export TELEGRAM_CHAT_ID="987654321"
   ```

### Option B: npm package

```bash
bun add -d opencode-telegram-question
```

In `opencode.json`:

```jsonc
{
  "plugin": [
    [
      "opencode-telegram-question",
      {
        "botToken": "123:ABC...",
        "chatId": 987654321,
        "historyMessages": 3
      }
    ]
  ]
}
```

Options:

| Key | Env fallback | Default | Notes |
|---|---|---|---|
| `botToken` | `TELEGRAM_BOT_TOKEN` | (required) | From `@BotFather` |
| `chatId` | `TELEGRAM_CHAT_ID` | (required) | Your private chat ID with the bot |
| `historyMessages` | `OPENCODE_TELEGRAM_HISTORY` | `3` | Lines of recent history prepended to the first sub-question |

If either credential is missing the plugin disables itself (with a warning)
and the CLI/TUI flow is unchanged.

## Getting `chatId`

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Send any message to your bot.
3. `curl https://api.telegram.org/bot<TOKEN>/getUpdates | jq '.result[-1].message.chat.id'`

## Security notes

- The plugin only accepts callback queries and messages from the configured
  `chatId`. Other chats receive "Not authorized".
- The bot token grants full bot control; treat it like a password.

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
