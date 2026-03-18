---
name: server
description: Manage the cc-disco Discord server — build, start, restart, check status
disable-model-invocation: true
---

# Server

The Discord router lives at `.claude/skills/server/server.ts`.

## Build
pnpm build

## Run
node dist/server.js

## Restart (if installed as systemd service)
systemctl --user restart cc-disco

## Status
systemctl --user status cc-disco

## Logs
journalctl --user -u cc-disco -f

## How it works
- Listens to Discord messages from allowed users
- Messages in channels auto-create threads
- Each thread maps to a Claude Code session (UUID v5 from thread ID)
- Spawns `claude -p --resume <session-id> --dangerously-skip-permissions`
- Streams response back via Discord message edits (~1.5s interval)
- New message while busy → SIGINT current process → resume with new message
