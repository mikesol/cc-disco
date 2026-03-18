# cc-disco

Minimal Discord-to-Claude-Code router. Each Discord thread = one Claude Code session.

## Setup

1. Clone this repo (or use as GitHub template)
2. `pnpm install && pnpm build`
3. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN` — bot token from Discord Developer Portal
   - `DISCORD_ALLOW_USER_IDS` — your Discord user ID
   - `DISCORD_GUILD_ID` — your server ID
4. Ensure `claude` CLI is installed and authenticated
5. `node dist/server.js`

## Discord bot setup

1. Create an app at https://discord.com/developers/applications
2. Bot → Add Bot → enable Message Content Intent
3. OAuth2 → URL Generator → scope: `bot` → permissions: `Administrator`
4. Open the URL, add to your server

## Systemd (optional)

Copy `systemd/cc-disco.service`, edit paths, then:
```bash
systemctl --user enable cc-disco
systemctl --user start cc-disco
```

## Customization

Edit `CLAUDE.md` to change the bot's personality and conventions. This repo is a template — fork it and make it yours.
