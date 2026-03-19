---
name: server
description: Manage the cc-disco Discord server — build, start, restart, check status
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

The Discord router is `.claude/skills/server/server.js`.

## Required env vars
- `DISCORD_TOKEN` — bot token
- `DISCORD_ALLOW_USER_IDS` — comma-separated allowed user IDs
- `DISCORD_GUILD_ID` — server ID
- `CLAUDE_MODEL` — model name (default: `sonnet`)
- `CLAUDE_BIN` — path to claude binary (default: `claude`)
- `CC_DISCO_HOOK_PORT` — hook HTTP port (default: `9400`)
- `CC_DISCO_DOCS_DIR` — directory for downloaded attachments (default: `~/cc-disco-docs`)

Set via systemd `EnvironmentFile`, `op`, or pass directly. If you must, you can also set them in `.env` and use `dotenv` to load.

## Run
node .claude/skills/server/server.js

## Install as systemd service
Copy `.claude/skills/server/cc-disco.service` to `~/.config/systemd/user/`, edit paths, then:
```bash
systemctl --user daemon-reload
systemctl --user enable cc-disco
systemctl --user start cc-disco
```

## Restart
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
- Hooks (PreToolUse, PostToolUse, Stop) POST to the server's HTTP endpoint
- On each hook, the server flushes assistant text from the transcript to Discord
- On Stop, the final message gets a ✅ reaction
- Typing indicator runs throughout
- New message while busy → SIGINT current process → resume with new message

## Architecture
The server has two roles:
1. **Discord listener** — receives messages, spawns Claude Code processes
2. **Hook endpoint** — receives HTTP POSTs from Claude Code hooks, flushes transcript text to Discord

No stream-json parsing. Claude Code writes to its transcript, hooks notify the server, server reads transcript and posts to Discord.
