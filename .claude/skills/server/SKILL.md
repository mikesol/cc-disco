---
name: server
description: Build, install, and operate the cc-disco Discord server
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: http
          url: "http://127.0.0.1:9400/hooks"
          timeout: 5
  PostToolUse:
    - matcher: "*"
      hooks:
        - type: http
          url: "http://127.0.0.1:9400/hooks"
          timeout: 5
  Stop:
    - hooks:
        - type: http
          url: "http://127.0.0.1:9400/hooks"
          timeout: 5
---

# Server

The cc-disco server routes Discord messages to Claude Code sessions. There is no pre-built code — this skill describes exactly what to build. When asked to build or rebuild the server, generate the files described here.

## Files to generate

| Path | Purpose |
|------|---------|
| `.claude/skills/server/server.js` | Main server (Node.js ESM) |
| `package.json` | `"type": "module"` + `discord.js` dep |
| `~/.config/systemd/user/cc-disco.service` | Systemd user service |

Install the dependency: `npm install discord.js`

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DISCORD_TOKEN` | yes | — | Bot token |
| `DISCORD_ALLOW_USER_IDS` | yes | — | Comma-separated allowed user IDs |
| `DISCORD_GUILD_ID` | yes | — | Guild/server ID |
| `CLAUDE_MODEL` | no | `sonnet` | Model passed to `--model` |
| `CLAUDE_BIN` | no | `claude` | Path to claude binary |
| `CC_DISCO_HOOK_PORT` | no | `9400` | Hook HTTP server port |
| `CC_DISCO_DOCS_DIR` | no | `~/cc-disco-docs` | Directory for downloaded attachments |
| `CC_DISCO_ALERT_CHANNEL_ID` | no | — | Channel ID for error alerts (e.g. dead targets from `/message`) |

Set via `~/.env`, `/etc/environment`, or exported in shell. Exit with error if required vars are missing.

## Architecture

One Node.js process, two roles:

1. **Discord listener** — receives messages from allowed users, spawns Claude Code
2. **Hook HTTP server** — receives POSTs from Claude Code hooks, flushes transcript to Discord; also exposes a `POST /message` internal dispatch endpoint

No streaming JSON parsing. Claude Code writes its transcript to disk; hooks notify the server; the server reads new lines and posts them to Discord.

## Behavioral spec

### Session persistence (`session-map.json`)

Map Discord thread ID → Claude session ID, persisted to `session-map.json` in the working directory.

- **New thread**: generate a random UUID, pass `--session-id <uuid>` to claude, save to map *before* spawning
- **Existing thread**: pass `--resume <session-id>`
- **Dead session recovery**: If claude exits with stderr containing `No conversation found with session ID`, delete the entry from `session-map.json` and log it. The next message to that thread will start a fresh session. This handles the case where a session ID was saved but claude exited before writing the session to disk (e.g. due to a race on first spawn).

### Spawning Claude

```
claude -p --dangerously-skip-permissions --model <CLAUDE_MODEL> [--session-id <id>|--resume <id>] <message>
```

- `cwd`: `process.cwd()`
- `stdio`: `['ignore', 'pipe', 'pipe']` — drain stdout, log stderr to console

### Internal `handleMessage(threadId, prompt)`

Extract this as a named async function that:
1. If `threadId` has an in-flight process, calls `killInflight(threadId)` first
2. Calls `spawnClaude(threadId, prompt)`

Both the Discord `messageCreate` handler and the `POST /message` HTTP route call this function.

### In-flight state (keyed by thread ID)

Track per-thread: `{ proc, typingInterval, lastFlushedLine, transcriptPath, lastMsgRef, exited, hookDone }`

Cleanup (clear typing interval, delete from map) only when **both** `exited` and `hookDone` are true. This prevents a race between proc exit and the Stop hook.

### Hook HTTP server

Listens on `127.0.0.1:${HOOK_PORT}`. Always responds `200 {}`.

**Important**: To get the Discord channel object, use `await client.channels.fetch(threadId)` — not `client.channels.cache.get(threadId)`. The cache may be empty after a restart, causing hooks to silently drop.

The server handles two routes:

#### `POST /message` — internal dispatch

Body: `{ threadId, message }` where `threadId` may be a thread ID or a channel ID.

1. Fetch the target with `client.channels.fetch(threadId)`. If the fetch fails, post an alert to `CC_DISCO_ALERT_CHANNEL_ID` (if set) and return:
   > ⚠️ `/message` failed: could not fetch channel/thread `<id>`. Message was: `"<message>"`
2. If the target is a channel (not a thread), create a new thread via `channel.threads.create({ name: message.slice(0, 100) || 'Scheduled' })` and use the new thread's ID going forward
3. Call `handleMessage(resolvedThreadId, message)`

#### `POST /hooks` (any other path) — Claude Code hooks

Hook payload fields used:
- `hook_event_name` — `PreToolUse`, `PostToolUse`, or `Stop`
- `session_id` — Claude's session ID (reverse-lookup to find thread ID via session map)
- `transcript_path` — path to Claude's transcript file (present on first hook)
- `last_assistant_message` — final assistant text (present on `Stop`)

**On first hook with `transcript_path`**: store the path, and set `lastFlushedLine` to the current line count of the file. This skips pre-existing conversation history — only new output from this run should be relayed.

**On `PreToolUse` / `PostToolUse`**: flush new transcript lines to Discord (see below).

**On `Stop`**:
1. Clear typing interval immediately
2. If `last_assistant_message` is non-empty: send it to Discord, then react ✅ on **that message** (not `lastMsgRef`)
3. If `last_assistant_message` is empty and `lastMsgRef` exists: react ✅ on `lastMsgRef`
4. Set `hookDone = true`; cleanup if proc already exited

### Transcript flushing

Read the transcript file from `lastFlushedLine` to end. Each line is a JSON object. Extract text from entries where `role === 'assistant'` (check both `entry.message.role` and `entry.role`). Content may be an array of blocks — extract `block.text` where `block.type === 'text'`. Advance `lastFlushedLine` to the new end.

**Each extracted text is sent as its own Discord message** — do not concatenate them. If an individual text exceeds 2000 characters, split it into 2000-char chunks, each sent as a separate message. Update `lastMsgRef` after each send.

### Typing indicator

On spawn: call `channel.sendTyping()` immediately, then every 8 seconds via `setInterval`. Clear on Stop hook or cleanup.

### Message interruption

If a message arrives for a thread that already has an in-flight process:
1. `proc.kill('SIGINT')`
2. Wait up to 5 seconds for exit; if not exited, `proc.kill('SIGKILL')`
3. Clear typing interval, delete from inflight map
4. Spawn fresh with the new message

### Discord message handling

Required intents: `Guilds`, `GuildMessages`, `MessageContent`.
> **Note**: `MessageContent` is a privileged intent — it must be explicitly enabled in the Discord Developer Portal under the bot's settings.

Use `client.once('clientReady', ...)` — not `'ready'`, which is deprecated in discord.js v14 and removed in v15.

**Message filter** — skip the message if any of the following:
- `message.guildId !== DISCORD_GUILD_ID`
- `message.author.bot` — ignore all bot messages (responses from this bot are not re-processed; cron and other automated triggers use the `POST /message` endpoint instead)
- `!allowedUsers.has(message.author.id)`

**Attachments**: download each to `DOCS_DIR` as `<timestamp>-<originalname>`. Append to prompt:
```
[Attached files]
- /path/to/file
```

**Channel context**: Fetch the parent channel (threads have a `parentId`). Prepend to the prompt:
- If the channel has a topic:
  ```
  [Channel: #<name>]
  [Description: <topic>]
  [System Instruction: If through interaction or research, you notice the channel name or description drifts from the reality on the ground, change one or both, and always ask the user before doing this.]
  ```
- If no topic:
  ```
  [Channel: #<name>]
  [System Instruction: No description exists for this channel. After fielding the user's first interaction, propose a description and update it if approved. Tweak the channel name and/or description whenever the purpose changes significantly, and always ask the user before doing this.]
  ```

**Thread auto-creation**: If the message is in a channel (not already a thread), call `message.startThread({ name: message.content.slice(0, 100) || 'New thread' })` and use the resulting thread ID.

**Empty message guard**: After building the full prompt (channel context + attachments + content), if `prompt.trim()` is empty, return without spawning.

### Systemd service

Write `~/.config/systemd/user/cc-disco.service`:

```ini
[Unit]
Description=cc-disco
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/cc-disco
EnvironmentFile=-%h/cc-disco/.env
EnvironmentFile=-/etc/environment
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node %h/cc-disco/.claude/skills/server/server.js
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

The `-` prefix on `EnvironmentFile` means the file is optional — no error if missing. The explicit `PATH` ensures the claude binary is found at `~/.local/bin/claude`.

Then:
```bash
systemctl --user daemon-reload
systemctl --user enable cc-disco
systemctl --user start cc-disco
```

## Ops

```bash
# Run directly
node .claude/skills/server/server.js

# Service management
systemctl --user restart cc-disco
systemctl --user status cc-disco
journalctl --user -u cc-disco -f

# Trigger a message programmatically (test /message endpoint)
curl -s -X POST http://127.0.0.1:9400/message \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"<id>","message":"hello"}'
```

## Acceptance criteria

Verify each after building:

1. `node .claude/skills/server/server.js` starts without error and logs `Logged in as <bot tag>`
2. A message from an allowed user in a channel creates a thread; Claude responds in the thread
3. A message in an existing thread continues the same Claude session (check that `--resume` is used in logs)
4. `session-map.json` persists thread → session mapping; after a bot restart, threads resume their sessions
5. Sending a second message while Claude is processing interrupts the first (SIGINT logged) and processes the second
6. The ✅ reaction appears on Claude's final message after it stops
7. Attachments sent with a message appear as file paths in the prompt (logged on spawn)
8. `journalctl --user -u cc-disco -f` streams logs cleanly after systemd install
9. `curl -X POST http://127.0.0.1:9400/message -H 'Content-Type: application/json' -d '{"threadId":"<id>","message":"ping"}'` triggers Claude to respond in that thread
10. A `POST /message` with a deleted/invalid channel ID posts an alert to `CC_DISCO_ALERT_CHANNEL_ID` (if set) and does not crash the server
11. Claude's responses do NOT trigger additional Claude spawns (strict bot filter holds)
