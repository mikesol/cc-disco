# cc-disco — Design Spec

A minimal Discord-to-Claude-Code router. One file. No state management.

## Problem

Existing Discord bot frameworks for AI (OpenClaw, DiscoClaw) reimplement memory, task tracking, cron scheduling, prompt assembly, and session management — all things Claude Code already handles natively. The result is tens of thousands of lines of code with subtle bugs, state sync issues, and fragile abstractions layered on top of a runtime that doesn't need them.

## Insight

Claude Code already has: session resumption, compaction, memory (via files), tool use, web search, file I/O, and arbitrary code execution. The only thing it doesn't have is a Discord interface.

cc-disco is that interface. Nothing more.

## Architecture

```
Discord ←→ server.ts ←→ Claude Code processes
              │
              └── One process per thread, resumed by session ID
```

### Core loop

1. **Message in channel** → create Discord thread → spawn `claude -p --session-id <thread-id> --dangerously-skip-permissions --output-format stream-json --verbose` → stream response back via message edits
2. **Message in thread, Claude idle** → resume session with `--resume <session-id>` → stream response
3. **Message in thread, Claude busy** → SIGINT the running process → wait for exit → resume session with the new message → stream response
4. **Streaming** → a single Discord reply message is edited every ~1s with Claude's current output (text deltas, tool activity, thinking)

### What the server tracks (in memory only)

- `Map<threadId, ChildProcess>` — which threads have a running Claude Code process
- That's it. No persistent state. Session persistence is Claude Code's job.

### What the server does NOT do

- Memory management (Claude Code handles via `--resume`)
- Compaction (Claude Code handles natively)
- Prompt assembly (CLAUDE.md in the repo is the system prompt)
- Task tracking (the fork's CLAUDE.md defines conventions)
- Cron/scheduling (the fork's CLAUDE.md defines conventions)
- Tool management (Claude Code has built-in tools)
- Rolling summaries (Claude Code compacts automatically)

## Thread-to-session mapping

Discord thread ID = Claude Code session ID. No indirection, no mapping file, no database.

When a message arrives in a channel (not a thread), the server auto-creates a thread and uses that thread's ID as the session ID going forward.

## Interruption model

There is no queueing. There is no introspection. There is only interruption.

When a message arrives in a thread that has a running Claude Code process:

1. Send SIGINT to the process
2. Wait for graceful exit (Claude Code saves session state on SIGINT)
3. Resume the session with the new user message
4. Stream the response

This works because Claude Code's session persistence means no work is lost — the session transcript includes everything up to the interruption point. When Claude resumes, it sees the full history plus the new message.

### Why no queueing

Queueing creates invisible state: what's queued, why, in what order, what if the queue grows. It's a source of bugs and confusion. Interruption is stateless and immediate — every message gets a response as fast as possible.

### Why no introspection

The streaming progress display eliminates the need for "what are you doing?" queries. The user can see Claude's current output (text, tool calls, thinking) in real-time via the auto-updating Discord message. If they don't like what they see, they interrupt.

## Streaming progress

When Claude Code is working, the server:

1. Sends an initial Discord reply (placeholder)
2. Parses Claude Code's stream-json stdout events
3. Every ~1 second, edits the reply message with the accumulated output
4. On completion, makes a final edit with the complete response
5. If the response exceeds Discord's 2000-char limit, splits into multiple messages

Event types from stream-json to display:
- `text_delta` — Claude's response text, accumulated
- Tool use events — show what tool is being called (e.g., "Running: `git status`")
- Thinking/reasoning — optionally show Claude's chain of thought

## Process lifecycle

### Spawning

```
claude -p \
  --session-id <thread-id> \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  --model sonnet \
  "<user message>"
```

For resumed sessions:
```
claude -p \
  --resume <session-id> \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  "<user message>"
```

### Environment survival

Claude Code processes are ephemeral — they start, do work, and exit. But the environment they operate on (files, browser sessions, databases, running services) persists on the host. This means:

- A killed process doesn't lose file changes already written
- Browser sessions (Playwright) survive process restarts if managed externally
- Git state, running services, etc. are unaffected by process lifecycle

The instruction to maintain durable state lives in CLAUDE.md, not in the server.

## Configuration

### `.env`
```
DISCORD_TOKEN=           # Bot token
DISCORD_ALLOW_USER_IDS=  # Comma-separated allowed user IDs (fail-closed if empty)
DISCORD_GUILD_ID=        # Server ID
CLAUDE_MODEL=sonnet      # Default model
CLAUDE_BIN=claude        # Path to Claude Code binary
```

### `CLAUDE.md`
The repo's CLAUDE.md is the system prompt for every session. It defines:
- Bot personality and behavior
- Conventions for task tracking, memory, scheduling
- Available tools and integrations
- Any fork-specific instructions

This is the only customization point. Different forks of cc-disco have different CLAUDE.md files.

## Template repo model

cc-disco is a GitHub template repository. Users click "Use this template" to create a private repo, then customize CLAUDE.md for their use case.

### Public template repo contains:
- `server.ts` — the router (~150-200 lines)
- `CLAUDE.md` — generic starting point
- `.env.example` — configuration template
- `package.json` — discord.js + minimal deps
- `README.md` — setup instructions
- `systemd/` — service file template

### Private forks contain:
- Customized `CLAUDE.md` with personal conventions
- `.env` with secrets (gitignored)
- Any files Claude should have access to (scripts, data, etc.)

### Pulling upstream changes:
```bash
git remote add upstream https://github.com/<org>/cc-disco
git fetch upstream
git merge upstream/main
```

Conflicts only happen if the user edited `server.ts` (unlikely).

## Dependencies

- `discord.js` — Discord client
- Node.js built-in `child_process` — spawning Claude Code
- That's it.

No build step. No TypeScript compilation needed if we keep it as plain JS with JSDoc types, or a single `tsc` invocation if we want type safety.

## File structure

```
cc-disco/
├── server.ts          # The entire application
├── CLAUDE.md          # System prompt / fork personality
├── .env.example       # Configuration template
├── .env               # Actual config (gitignored)
├── package.json       # discord.js dependency
├── tsconfig.json      # TypeScript config
├── .gitignore
├── README.md
└── systemd/
    └── cc-disco.service  # Systemd unit template
```

## Non-goals

- Web UI / dashboard
- Multi-user / multi-server support
- Plugin system
- Voice support
- Rate limiting (single user, trust boundary is the Discord allowlist)
- Graceful degradation (if Claude Code is down, the bot is down)

## Open questions

1. **Message splitting** — When Claude's response exceeds 2000 chars, should we split into multiple messages or use Discord's embed/file upload for long responses?
2. **Thread naming** — Should the server auto-name threads based on the first message or Claude's response?
3. **Heartbeat** — Should the server have a simple periodic "check CLAUDE.md for scheduled tasks" mechanism, or is that entirely the fork's responsibility via external cron?
