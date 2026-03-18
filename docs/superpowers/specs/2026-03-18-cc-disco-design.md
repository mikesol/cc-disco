# cc-disco — Design Spec

A minimal Discord-to-Claude-Code router. One file. No state management.

## Architecture

```
Discord ←→ server.ts ←→ Claude Code processes
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
- That's it. No persistent state. Session persistence is Claude Code's job.

### Post-restart behavior

After a server restart, the process map is empty. When a message arrives in an existing thread, the server always uses `--resume <session-id>`. Since the session ID is deterministically derived from the thread ID, no persistent mapping is needed. Claude Code handles the case where no prior session exists — it starts a new one with that ID.

### What the server does NOT do

- Memory management (Claude Code handles via `--resume`)
- Compaction (Claude Code handles natively)
- Prompt assembly (CLAUDE.md in the repo is the system prompt)
- Task tracking (the fork's CLAUDE.md defines conventions)
- Tool management (Claude Code has built-in tools)
- Rolling summaries (Claude Code compacts automatically)

## Thread-to-session mapping

Discord thread IDs (snowflakes) are mapped to Claude Code session IDs (UUIDs) via a deterministic transform: UUID v5 with a fixed namespace and the thread ID as the name. This means:

- The same thread always maps to the same session ID
- No mapping file, no database, no persistent state
- Survives server restarts

When a message arrives in a channel (not a thread), the server auto-creates a thread and uses that thread's ID for the session mapping.

## Interruption model

There is no queueing. There is no introspection. There is only interruption.

When a message arrives in a thread that has a running Claude Code process:

1. Send SIGINT to the process
2. Wait for graceful exit (up to 5 seconds — Claude Code saves session state on SIGINT)
3. If the process hasn't exited after 5 seconds, send SIGKILL (session state may be stale but not corrupted — Claude Code's session transcript is append-only)
4. Resume the session with the new user message
5. Stream the response

This works because Claude Code's session persistence means no work is lost — the session transcript includes everything up to the interruption point. When Claude resumes, it sees the full history plus the new message.

## Streaming progress

When Claude Code is working, the server:

1. Sends an initial Discord reply (placeholder)
2. Parses Claude Code's stream-json stdout events
3. Every ~1.5 seconds, edits the reply message with the accumulated output (within Discord's rate limit of ~5 edits per 5 seconds)
4. On completion, makes a final edit with the complete response
5. If the response exceeds Discord's 2000-char limit, splits into multiple messages

Edit failures (rate limits, deleted messages) are silently ignored. The final edit is retried once on failure.

Event types from stream-json to display:
- `text_delta` — Claude's response text, accumulated
- Tool use events — show what tool is being called (e.g., "Running: `git status`")
- Thinking/reasoning — optionally show Claude's chain of thought

## Process lifecycle

### Spawning

All invocations use `--resume` with a deterministic session ID. Claude Code creates a new session if none exists for that ID, or resumes the existing one.

```
claude -p \
  --resume <uuid-from-thread-id> \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  "<user message>"
```

The user message is passed via `child_process.spawn()` args array (not shell), avoiding shell injection. Discord messages can contain arbitrary characters — the args array handles this safely.

### Environment survival

Claude Code processes are ephemeral — they start, do work, and exit. But the environment they operate on (files, browser sessions, databases, running services) persists on the host. This means:

- A killed process doesn't lose file changes already written
- Browser sessions (Playwright) survive process restarts if managed externally
- Git state, running services, etc. are unaffected by process lifecycle

The instruction to maintain durable state lives in CLAUDE.md, not in the server.

### Concurrent threads

Multiple threads can have active Claude Code processes simultaneously. Since all processes share the same filesystem and working directory, concurrent file operations could conflict. This is a known limitation — CLAUDE.md should instruct Claude to use per-thread working directories for file-heavy operations if needed.

## Cron

The server reads a `cron.json` file from the repo on startup. Each entry defines a schedule, a target thread, and a message:

```json
[
  { "schedule": "0 7 * * *", "threadId": "123456", "message": "Morning vibe check — scan X trends and report" },
  { "schedule": "0 17 * * *", "threadId": "789012", "message": "Evening vibe check — reflective digest" }
]
```

Schedules are parsed using `croner`. When a job fires, the server sends the message to the target thread using the same code path as a user message — SIGINT any running process, resume the session, stream the response.

If the thread has a running process when the cron fires, the message is prefixed with: `[Scheduled task — if you're mid-task, finish your current work first, then handle this] `. This lets Claude prioritize naturally without the server needing to understand task state.

The `cron.json` file is fork-specific — different forks have different schedules. The server re-reads it on SIGHUP for live reloading without restart.

## Configuration

### `.env`
```
DISCORD_TOKEN=           # Bot token (required)
DISCORD_ALLOW_USER_IDS=  # Comma-separated allowed user IDs (required; if unset or empty, reject all messages)
DISCORD_GUILD_ID=        # Server ID (required)
CLAUDE_MODEL=sonnet      # Default model
CLAUDE_BIN=claude        # Path to Claude Code binary
```

All three required variables must be set and non-empty for the server to start. The server exits with an error if any are missing.

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
- `package.json` — discord.js dependency
- `tsconfig.json` — TypeScript config
- `.gitignore`
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

## Build

TypeScript with a single `tsc` invocation. The template includes `tsconfig.json` so users get type safety out of the box. `pnpm build` compiles to `dist/server.js`.

## Dependencies

- `discord.js` — Discord client
- `uuid` — UUID v5 generation for thread-to-session mapping
- `croner` — Cron schedule parsing and execution
- Node.js built-in `child_process` — spawning Claude Code

## File structure

```
cc-disco/
├── server.ts          # The entire application
├── CLAUDE.md          # System prompt / fork personality
├── cron.json          # Scheduled jobs (fork-specific)
├── .env.example       # Configuration template
├── .env               # Actual config (gitignored)
├── package.json       # Dependencies
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
