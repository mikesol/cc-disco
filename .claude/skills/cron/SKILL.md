---
name: cron
description: Set up scheduled tasks that send messages to Discord threads on a schedule
---

# Cron

Scheduled tasks post messages to Discord threads on a cron schedule. The server picks them up and routes them to Claude Code like any other message.

## Setup

1. Install croner: `npm install croner` (in the cc-disco repo)
2. Create `cron.json` in the repo root (see format below)
3. Run the cron runner: `node .claude/skills/cron/cron-runner.js`
4. Optionally install as a systemd service alongside the main server

## cron.json format

```json
[
  { "schedule": "0 7 * * *", "threadId": "123456789", "message": "Morning vibe check" },
  { "schedule": "0 17 * * *", "threadId": "987654321", "message": "Evening digest" }
]
```

- `schedule` — standard 5-field cron expression
- `threadId` — Discord thread ID (enable Developer Mode in Discord, right-click thread → Copy Thread ID)
- `message` — the prompt sent to Claude Code via that thread

## How it works

The cron runner posts messages to Discord threads using the bot token. The cc-disco server sees the message arrive in the thread and spawns Claude Code to handle it — same as a user message.

**Important:** The server ignores bot messages by default (`message.author.bot` check). The cron runner uses a webhook to post messages so they appear as a user, OR you can modify the server to accept messages from the bot's own user ID for cron purposes.

## Turnkey cron runner

A ready-to-use cron runner is at `.claude/skills/cron/cron-runner.js`. It:
- Reads `cron.json` from the repo root
- Uses croner to schedule jobs
- Posts messages to Discord threads via the bot token
- Reloads `cron.json` on SIGHUP

## Getting a thread ID

1. Enable Developer Mode: User Settings → Advanced → Developer Mode
2. Right-click a thread → Copy Thread ID

## systemd service (optional)

Create `~/.config/systemd/user/cc-disco-cron.service`:

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
ExecStart=/usr/bin/node %h/cc-disco/.claude/skills/cron/cron-runner.js
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```
