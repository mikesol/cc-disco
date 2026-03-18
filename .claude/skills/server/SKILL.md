---
name: server
description: Manage the cc-disco Discord server — build, start, restart, check status
disable-model-invocation: true
---

# Server

The Discord router lives at `.claude/skills/server/server.ts`.

## Build
pnpm build

## Required env vars
- `DISCORD_TOKEN` — bot token
- `DISCORD_ALLOW_USER_IDS` — comma-separated allowed user IDs
- `DISCORD_GUILD_ID` — server ID
- `CLAUDE_MODEL` — model name (default: `sonnet`)
- `CLAUDE_BIN` — path to claude binary (default: `claude`)

Set via systemd `EnvironmentFile`, `op`, or pass directly. If you must, you can also set them in `.env` and use `dotenv` to load.

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
