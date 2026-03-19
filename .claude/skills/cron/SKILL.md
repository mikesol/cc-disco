---
name: cron
description: Set up scheduled tasks that send messages to Discord threads or channels on a schedule
---

# Cron

Scheduled tasks post messages to Discord threads (or channels) on a cron schedule by calling the server's internal `POST /message` endpoint. The server picks them up and routes them to Claude Code like any other message.

There is no pre-built code — this skill describes exactly what to build. When asked to set up or rebuild the cron runner, generate the files described here.

## Files to generate

| Path | Purpose |
|------|---------|
| `.claude/skills/cron/cron-runner.js` | Cron runner (Node.js ESM) |

Install the dependency: `npm install croner`

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CC_DISCO_HOOK_PORT` | no | `9400` | Port of the server's hook/message HTTP server |

No Discord token needed — the cron runner talks to the server locally, not to Discord directly.

## Behavioral spec

The cron runner is a single Node.js ESM script. It:

1. Reads `cron.json` from the repo root (parse failure → log and schedule nothing, don't crash)
2. Schedules each job using `croner`'s `Cron` class
3. On each fire, POSTs to the server's `/message` endpoint:
   - `POST http://127.0.0.1:${CC_DISCO_HOOK_PORT}/message`
   - Body: `{ "threadId": job.threadId, "message": job.message }`
   - Log errors but don't crash
4. On `SIGHUP`: stop all active crons, reload `cron.json`, reschedule

## cron.json format

```json
[
  { "schedule": "0 7 * * *", "threadId": "123456789012345678", "message": "⏰ Morning check-in" },
  { "schedule": "0 17 * * *", "threadId": "987654321098765432", "message": "⏰ Evening digest" }
]
```

- `schedule` — standard 5-field cron expression
- `threadId` — Discord thread **or** channel ID. If a channel ID is given, the server creates a new thread for each invocation. Use a thread ID to continue the same ongoing conversation.
- `message` — the prompt sent to Claude. Prefix it with context (e.g. `⏰ scheduled:`) so Claude's response doesn't appear out of the blue in the thread.

## How to get a thread or channel ID

Enable Developer Mode: User Settings → Advanced → Developer Mode, then right-click any thread or channel → Copy ID.

## How it works with the server

The cron runner POSTs directly to the server's local HTTP endpoint — no Discord API calls, no bot token. The server resolves the target (creating a thread if needed), then spawns Claude exactly as it would for a user message. All bot message filtering is bypassed cleanly since the trigger never touches Discord.

## Systemd service (optional)

Write `~/.config/systemd/user/cc-disco-cron.service`:

```ini
[Unit]
Description=cc-disco cron runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/cc-disco
EnvironmentFile=-%h/cc-disco/.env
EnvironmentFile=-/etc/environment
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node %h/cc-disco/.claude/skills/cron/cron-runner.js
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

Then:
```bash
systemctl --user daemon-reload
systemctl --user enable cc-disco-cron
systemctl --user start cc-disco-cron
```

To reload jobs without restarting: `kill -HUP $(systemctl --user show -p MainPID --value cc-disco-cron)`

## Ops

```bash
systemctl --user restart cc-disco-cron
systemctl --user status cc-disco-cron
journalctl --user -u cc-disco-cron -f
```

## Acceptance criteria

1. `node .claude/skills/cron/cron-runner.js` starts without error, logs loaded job count
2. A job fires at its scheduled time, POSTs to `localhost:9400/message`, and Claude responds in the target thread
3. Sending `SIGHUP` reloads `cron.json` without restarting the process (logged)
4. Missing or malformed `cron.json` logs a warning but doesn't crash the runner
5. A job targeting a channel ID (not a thread) causes the server to create a new thread and respond there
6. Claude's response to a cron-triggered message does NOT itself trigger another Claude spawn (no feedback loop)
