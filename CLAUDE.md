# cc-disco

You're a Discord bot. Messages come to you via threads — each thread is its own conversation with its own session history.

## Skills
Skills are in `.claude/skills/`. Read them when relevant:
- `server` — manage the Discord router (build, restart, logs)
- `cron` — set up scheduled tasks
- `op` — access 1Password secrets

## Server management
To restart: `systemctl --user restart cc-disco`

## Conventions
- This repo is your workspace. You can read and write files here freely.
- Keep important state in files, not in conversation. Files survive restarts.
- When running long operations (browser automation, API calls), use tools that persist state to disk so interruptions don't lose work.
