# cc-disco — Design Spec

A minimal Discord-to-Claude-Code router. One file. Everything else is skills.

## Architecture

```
Discord ←→ .claude/skills/server/server.ts ←→ Claude Code processes
                    │
                    └── One process per thread, resumed by session ID
```

### Core loop

1. **Message in channel** → create Discord thread → spawn Claude Code with a deterministic session ID derived from the thread ID → stream response back via message edits
2. **Message in thread, Claude idle** → resume session → stream response
3. **Message in thread, Claude busy** → SIGINT the running process → wait for exit (5s timeout, then SIGKILL) → resume session with the new message → stream response
4. **Streaming** → a single Discord reply message is edited every ~1.5s with Claude's current output (text deltas, tool activity, thinking). Edit failures are silently dropped; the final edit is retried once.

### What the server tracks (in memory only)

- `Map<threadId, ChildProcess>` — which threads have a running Claude Code process

## Thread-to-session mapping

Discord thread IDs (snowflakes) are mapped to Claude Code session IDs (UUIDs) via UUID v5 with a fixed namespace and the thread ID as the name. Deterministic — the same thread always produces the same session ID. No mapping file, no database, no persistent state, survives server restarts.

When a message arrives in a channel (not a thread), the server auto-creates a thread and uses that thread's ID for the session mapping. All invocations use `--resume` — Claude Code creates a new session if none exists for that ID, or resumes the existing one.

## Interruption model

When a message arrives in a thread that has a running Claude Code process:

1. Send SIGINT to the process
2. Wait for graceful exit (up to 5 seconds — Claude Code saves session state on SIGINT)
3. If the process hasn't exited after 5 seconds, send SIGKILL (session state may be stale but not corrupted — Claude Code's session transcript is append-only)
4. Resume the session with the new user message
5. Stream the response

## Streaming progress

When Claude Code is working, the server:

1. Sends an initial Discord reply (placeholder)
2. Parses Claude Code's stream-json stdout events
3. Every ~1.5 seconds, edits the reply message with the accumulated output
4. On completion, makes a final edit with the complete response
5. If the response exceeds Discord's 2000-char limit, splits into multiple messages

Event types from stream-json to display:
- `text_delta` — Claude's response text, accumulated
- Tool use events — show what tool is being called
- Thinking/reasoning — optionally show Claude's chain of thought

## Process spawning

All invocations use `--resume` with a deterministic session ID.

```
claude -p \
  --resume <uuid-from-thread-id> \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  "<user message>"
```

The user message is passed via `child_process.spawn()` args array (not shell), avoiding injection.

## Skills

Skills are markdown files that Claude reads when relevant. The server itself is a skill.

### `.claude/skills/server/`
- `SKILL.md` — what the server does, how to build and restart it
- `server.ts` — the router implementation

### `.claude/skills/cron/`
- `SKILL.md` — how to set up scheduled tasks. Recommends `croner` with a `cron.json` checked into version control. Cron is not built into the server — Claude sets it up as a separate process or system crontab when the user asks for scheduled tasks.

### `.claude/skills/op/`
- `SKILL.md` — how to use 1Password CLI (`op`) for credential management. Secrets vault, service account token, `op read` patterns.

## Configuration

### `.env`
```
DISCORD_TOKEN=           # Bot token (required)
DISCORD_ALLOW_USER_IDS=  # Comma-separated allowed user IDs (required; if unset or empty, reject all messages)
DISCORD_GUILD_ID=        # Server ID (required)
CLAUDE_MODEL=sonnet      # Default model
CLAUDE_BIN=claude        # Path to Claude Code binary
```

All three required variables must be set and non-empty for the server to start.

### `CLAUDE.md`
- You're a Discord bot. Messages come to you via threads.
- Skills are in `.claude/skills/`. Read them when relevant.
- To restart the server: `systemctl --user restart cc-disco`
- Conventions for the fork (personality, integrations, task tracking — whatever the user wants)

## Concurrent threads

Multiple threads can have active Claude Code processes simultaneously. Since all processes share the same filesystem, concurrent file operations could conflict. CLAUDE.md should instruct Claude to use per-thread working directories for file-heavy operations if needed.

## Template repo model

cc-disco is a GitHub template repository. Users click "Use this template" to create a private repo, then customize CLAUDE.md.

### Public template contains:
- `.claude/skills/server/server.ts` — the router
- `.claude/skills/server/SKILL.md` — server management
- `.claude/skills/cron/SKILL.md` — cron setup with croner
- `.claude/skills/op/SKILL.md` — 1Password integration
- `CLAUDE.md` — generic starting point
- `.env.example` — configuration template
- `package.json` — dependencies
- `tsconfig.json` — TypeScript config
- `.gitignore`
- `README.md`
- `systemd/cc-disco.service` — systemd unit template

### Private forks add:
- Customized `CLAUDE.md`
- `.env` with secrets (gitignored)
- Any files Claude should have access to

### Pulling upstream:
```bash
git remote add upstream https://github.com/<org>/cc-disco
git fetch upstream
git merge upstream/main
```

## Build

TypeScript. `pnpm build` compiles to `dist/`.

## Dependencies

- `discord.js` — Discord client
- `uuid` — UUID v5 generation for thread-to-session mapping
- Node.js built-in `child_process` — spawning Claude Code

## File structure

```
cc-disco/
├── CLAUDE.md
├── .claude/skills/
│   ├── server/
│   │   ├── SKILL.md
│   │   └── server.ts
│   ├── cron/
│   │   └── SKILL.md
│   └── op/
│       └── SKILL.md
├── .env.example
├── .env               # gitignored
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
└── systemd/
    └── cc-disco.service
```

## Non-goals

- Web UI / dashboard
- Multi-user / multi-server support
- Plugin system
- Voice support
- Rate limiting (trust boundary is the Discord allowlist)
- Graceful degradation (if Claude Code is down, the bot is down)
