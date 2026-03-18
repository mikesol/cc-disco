---
name: cron
description: Set up scheduled tasks that send messages to Discord threads on a schedule
---

# Cron

Set up scheduled tasks that send messages to Discord threads. Use `croner` for in-process scheduling or system crontab — your choice.

## Recommended approach: croner

1. Install: `pnpm add croner`
2. Create a `cron-runner.ts` in the repo that reads `cron.json` and sends messages to Discord threads via the bot token
3. Run it alongside the server (or as a separate systemd service)

### cron.json format

```json
[
  { "schedule": "0 7 * * *", "threadId": "123456789", "message": "Morning vibe check" },
  { "schedule": "0 17 * * *", "threadId": "987654321", "message": "Evening digest" }
]
```

- `schedule` — standard 5-field cron expression
- `threadId` — Discord thread ID (right-click thread → Copy Thread ID with Developer Mode on)
- `message` — the prompt. The bot will process it like any user message in that thread.

### Sending a message to a thread

```typescript
const response = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
  method: 'POST',
  headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: message }),
});
```

Note: the server ignores bot messages (`message.author.bot` check). The cron runner should post messages with a webhook or use the Discord API directly so messages appear as a user, not the bot. Alternatively, modify the server to allow messages from a specific bot ID for cron purposes.

## Alternative: system crontab

Use `curl` to post to Discord. Store the token securely via `op`:

```bash
0 7 * * * TOKEN=$(op read "op://vault/Discord Bot Token/password") && curl -s -X POST "https://discord.com/api/v10/channels/THREAD_ID/messages" -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" -d '{"content":"Morning vibe check"}'
```
