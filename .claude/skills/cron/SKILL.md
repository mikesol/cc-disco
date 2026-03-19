---
name: cron
description: Set up scheduled tasks that send messages to Discord threads on a schedule
---

# Cron

Scheduled tasks post messages to Discord threads on a cron schedule. The server picks them up and routes them to Claude Code like any other message.

There is no pre-built code — this skill describes exactly what to build. When asked to set up or rebuild the cron runner, generate the files described here.

## Files to generate

| Path | Purpose |
|------|---------|
| `.claude/skills/cron/cron-runner.js` | Cron runner (Node.js ESM) |

Install the dependency: `npm install croner`

## Behavioral spec

The cron runner is a single Node.js ESM script. It:

1. Reads `cron.json` from the repo root (parse failure → log and schedule nothing, don't crash)
2. Schedules each job using `croner`'s `Cron` class
3. On each fire, POSTs the message to the Discord thread via the REST API:
   - `POST https://discord.com/api/v10/channels/<threadId>/messages`
   - Headers: `Authorization: Bot <DISCORD_TOKEN>`, `Content-Type: application/json`
   - Body: `{ content: job.message }`
   - Log errors but don't crash
4. On `SIGHUP`: stop all active crons, reload `cron.json`, reschedule

Env var: `DISCORD_TOKEN` — required, exit with error if missing.

> **How this works with the server**: The server whitelists messages from its own bot user ID, so cron-posted messages are processed as normal prompts. Claude's responses are tracked by message ID and skipped in `MessageCreate`, preventing a feedback loop.

## cron.json format

```json
[
  { "schedule": "0 7 * * *", "threadId": "123456789", "message": "Morning check-in" },
  { "schedule": "0 17 * * *", "threadId": "987654321", "message": "Evening digest" }
]
```

- `schedule` — standard 5-field cron expression
- `threadId` — Discord thread ID (enable Developer Mode in Discord, right-click thread → Copy Thread ID)
- `message` — the prompt text posted to the thread

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
2. A job fires at its scheduled time and the message appears in the target Discord thread
3. Sending `SIGHUP` reloads `cron.json` without restarting the process (logged)
4. Missing or malformed `cron.json` logs a warning but doesn't crash the runner
5. Claude's response to a cron-triggered message does NOT itself trigger another Claude spawn (no feedback loop)
