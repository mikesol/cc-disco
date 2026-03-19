import { Client, GatewayIntentBits, Events } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_ALLOW_USER_IDS = process.env.DISCORD_ALLOW_USER_IDS;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const HOOK_PORT = parseInt(process.env.CC_DISCO_HOOK_PORT ?? '9400', 10);
const DOCS_DIR = process.env.CC_DISCO_DOCS_DIR ?? join(process.env.HOME ?? '.', 'cc-disco-docs');
const SESSION_MAP_FILE = join(process.cwd(), 'session-map.json');
mkdirSync(DOCS_DIR, { recursive: true });

if (!DISCORD_TOKEN || !DISCORD_ALLOW_USER_IDS || !DISCORD_GUILD_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_ALLOW_USER_IDS, DISCORD_GUILD_ID');
  process.exit(1);
}

const allowedUsers = new Set(DISCORD_ALLOW_USER_IDS.split(',').map(s => s.trim()));

// --- Session map (thread ID → claude session ID, persisted to disk) ---
let sessionMap = {};
try { sessionMap = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8')); } catch {}

function saveSessionMap() {
  try { writeFileSync(SESSION_MAP_FILE, JSON.stringify(sessionMap, null, 2)); } catch {}
}

// --- In-flight state (keyed by thread ID) ---
// { proc, typingInterval, lastFlushedLine, transcriptPath, lastMsgRef, exited, hookDone }
const inflight = new Map();

function cleanup(threadId) {
  const state = inflight.get(threadId);
  if (!state) return;
  console.log(`[cleanup] thread ${threadId}`);
  if (state.typingInterval) clearInterval(state.typingInterval);
  inflight.delete(threadId);
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Transcript flushing ---
function flushTranscript(threadId) {
  const state = inflight.get(threadId);
  if (!state?.transcriptPath) return [];

  try {
    const lines = readFileSync(state.transcriptPath, 'utf-8').trim().split('\n');
    const texts = [];
    for (let i = state.lastFlushedLine; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      const content = entry.message?.content ?? entry.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
      }
    }
    state.lastFlushedLine = lines.length;
    return texts;
  } catch (e) {
    console.error(`[flush] error: ${e.message}`);
    return [];
  }
}

async function sendToDiscord(threadId, texts) {
  const channel = await client.channels.fetch(threadId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  let lastMsg = null;
  for (const text of texts) {
    if (!text.trim()) continue;
    for (let i = 0; i < text.length; i += 2000) {
      try { lastMsg = await channel.send(text.slice(i, i + 2000)); } catch (e) {
        console.error(`[send] error: ${e.message}`);
      }
    }
  }
  return lastMsg;
}

// --- Hook HTTP server ---
// Hooks are keyed by Claude's session_id. We need to find the thread ID.
// Reverse lookup: claude session ID → thread ID
function threadForClaudeSession(claudeSessionId) {
  for (const [threadId, sid] of Object.entries(sessionMap)) {
    if (sid === claudeSessionId) return threadId;
  }
  return null;
}

const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    console.log(`[http] received ${body.length} bytes`);
    try {
      const data = JSON.parse(body);
      const event = data.hook_event_name;
      const claudeSessionId = data.session_id;
      console.log(`[hook] ${event} session=${claudeSessionId} thread=${threadForClaudeSession(claudeSessionId) || 'unknown'}`);

      // Find thread by session ID — we always know the mapping because
      // we save it to sessionMap BEFORE spawning
      const threadId = threadForClaudeSession(claudeSessionId);
      const state = threadId ? inflight.get(threadId) : null;
      if (!state) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      // Store transcript path on first hook — skip existing content
      if (data.transcript_path && !state.transcriptPath) {
        state.transcriptPath = data.transcript_path;
        try {
          const existingLines = readFileSync(data.transcript_path, 'utf-8').trim().split('\n');
          state.lastFlushedLine = existingLines.length;
        } catch { state.lastFlushedLine = 0; }
      }

      if (event === 'PostToolUse' || event === 'PreToolUse') {
        const texts = flushTranscript(threadId);
        if (texts.length > 0) {
          const lastMsg = await sendToDiscord(threadId, texts);
          if (lastMsg) state.lastMsgRef = lastMsg;
        }
      }

      if (event === 'Stop') {
        const finalText = data.last_assistant_message || '';
        if (finalText.trim()) {
          const lastMsg = await sendToDiscord(threadId, [finalText]);
          if (lastMsg) {
            state.lastMsgRef = lastMsg;
            await lastMsg.react('✅').catch(() => {});
          }
        } else if (state.lastMsgRef) {
          await state.lastMsgRef.react('✅').catch(() => {});
        }

        state.hookDone = true;
        if (state.exited) cleanup(threadId);
      }
    } catch (e) {
      console.error(`[hook] error: ${e.message}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

hookServer.listen(HOOK_PORT, '127.0.0.1', () => {
  console.log(`Hook server on :${HOOK_PORT}`);
});

// --- Spawn Claude ---
function spawnClaude(threadId, message) {
  const existingSessionId = sessionMap[threadId];
  const args = ['-p', '--dangerously-skip-permissions', '--model', CLAUDE_MODEL];

  if (existingSessionId) {
    args.push('--resume', existingSessionId);
    console.log(`[spawn] --resume ${existingSessionId} for thread ${threadId}`);
  } else {
    const newSessionId = randomUUID();
    sessionMap[threadId] = newSessionId;
    saveSessionMap();
    args.push('--session-id', newSessionId);
    console.log(`[spawn] --session-id ${newSessionId} for thread ${threadId}`);
  }

  args.push(message);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const typingInterval = setInterval(() => {
    client.channels.fetch(threadId).then(ch => ch.sendTyping()).catch(() => {});
  }, 8000);
  client.channels.fetch(threadId).then(ch => ch.sendTyping()).catch(() => {});

  inflight.set(threadId, {
    proc,
    typingInterval,
    lastFlushedLine: 0,
    transcriptPath: null,
    lastMsgRef: null,
    exited: false,
    hookDone: false,
  });

  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (chunk) => console.error(`[stderr] ${chunk.toString().trim()}`));
  proc.on('exit', (code) => {
    console.log(`[exit] thread ${threadId} code=${code}`);
    const state = inflight.get(threadId);
    if (state) {
      state.exited = true;
      if (state.hookDone) cleanup(threadId);
    }
  });
}

// --- Attachment handling ---
async function downloadAttachments(attachments) {
  const paths = [];
  for (const [, att] of attachments) {
    const filename = `${Date.now()}-${att.name}`;
    const filepath = join(DOCS_DIR, filename);
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(res.body, createWriteStream(filepath));
      paths.push(filepath);
      console.log(`[attach] saved ${att.name} → ${filepath}`);
    } catch (e) {
      console.error(`[attach] failed to download ${att.name}: ${e.message}`);
    }
  }
  return paths;
}

// --- Channel context ---
async function getChannelContext(channel) {
  let parent = channel;
  if (channel.isThread()) {
    try { parent = await client.channels.fetch(channel.parentId); } catch { return null; }
  }
  if (!parent?.name) return null;

  const name = parent.name;
  const topic = parent.topic?.trim();

  if (topic) {
    return `[Channel: #${name}]\n[Description: ${topic}]\n[System Instruction: If through interaction or research, you notice the channel name or description drifts from the reality on the ground, change one or both, and always ask the user before doing this.]`;
  }
  return `[Channel: #${name}]\n[System Instruction: No description exists for this channel. After fielding the user's first interaction, propose a description and update it if approved. Tweak the channel name and/or description whenever the purpose changes significantly, and always ask the user before doing this.]`;
}

// --- Message handling ---
async function handleMessage(threadId, content) {
  console.log(`[msg] thread=${threadId} "${content.slice(0, 50)}"`);

  // Interrupt if busy
  const existing = inflight.get(threadId);
  if (existing) {
    console.log(`[interrupt] killing thread ${threadId}`);
    existing.proc.kill('SIGINT');
    await new Promise(resolve => {
      const timeout = setTimeout(() => { existing.proc.kill('SIGKILL'); resolve(); }, 5000);
      existing.proc.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    if (existing.typingInterval) clearInterval(existing.typingInterval);
    inflight.delete(threadId);
  }

  spawnClaude(threadId, content);
}

// --- Discord events ---
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!allowedUsers.has(message.author.id)) return;
  if (message.guildId !== DISCORD_GUILD_ID) return;

  let prompt = message.content || '';
  if (message.attachments.size > 0) {
    const paths = await downloadAttachments(message.attachments);
    if (paths.length > 0) {
      prompt += '\n\n[Attached files]\n' + paths.map(p => `- ${p}`).join('\n');
    }
  }

  if (!prompt.trim()) return;

  const channelContext = await getChannelContext(message.channel);
  if (channelContext) prompt = channelContext + '\n\n' + prompt;

  if (!message.channel.isThread()) {
    try {
      const thread = await message.startThread({
        name: message.content.slice(0, 100) || 'New thread',
      });
      await handleMessage(thread.id, prompt);
    } catch (e) {
      console.error(`[thread] failed to create thread: ${e.message}`);
    }
    return;
  }

  await handleMessage(message.channel.id, prompt);
});

client.login(DISCORD_TOKEN);
