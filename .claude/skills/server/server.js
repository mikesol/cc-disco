import { Client, GatewayIntentBits } from 'discord.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

// --- Environment ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_ALLOW_USER_IDS = process.env.DISCORD_ALLOW_USER_IDS;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }
if (!DISCORD_ALLOW_USER_IDS) { console.error('Missing DISCORD_ALLOW_USER_IDS'); process.exit(1); }
if (!DISCORD_GUILD_ID) { console.error('Missing DISCORD_GUILD_ID'); process.exit(1); }

const allowedUsers = new Set(DISCORD_ALLOW_USER_IDS.split(',').map(s => s.trim()));
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const HOOK_PORT = parseInt(process.env.CC_DISCO_HOOK_PORT || '9400', 10);
const DOCS_DIR = process.env.CC_DISCO_DOCS_DIR || join(process.env.HOME, 'cc-disco-docs');
const ALERT_CHANNEL_ID = process.env.CC_DISCO_ALERT_CHANNEL_ID || '';

if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

// --- Session map ---
const SESSION_MAP_PATH = join(process.cwd(), 'session-map.json');

function loadSessionMap() {
  try { return JSON.parse(readFileSync(SESSION_MAP_PATH, 'utf8')); } catch { return {}; }
}
function saveSessionMap(map) {
  writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
}

let sessionMap = loadSessionMap();

// --- In-flight state ---
const inflight = new Map();

function cleanup(threadId) {
  const state = inflight.get(threadId);
  if (!state) return;
  if (state.exited && state.hookDone) {
    clearInterval(state.typingInterval);
    inflight.delete(threadId);
  }
}

async function killInflight(threadId) {
  const state = inflight.get(threadId);
  if (!state) return;
  state.proc.kill('SIGINT');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (!state.exited) state.proc.kill('SIGKILL');
      resolve();
    }, 5000);
    const check = setInterval(() => {
      if (state.exited) { clearTimeout(timeout); clearInterval(check); resolve(); }
    }, 100);
  });
  clearInterval(state.typingInterval);
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

// --- Spawn Claude ---
function spawnClaude(threadId, prompt) {
  const isResume = sessionMap[threadId];
  let sessionId;
  if (isResume) {
    sessionId = sessionMap[threadId];
  } else {
    sessionId = randomUUID();
    sessionMap[threadId] = sessionId;
    saveSessionMap(sessionMap);
  }

  const args = ['-p', '--dangerously-skip-permissions', '--model', CLAUDE_MODEL];
  if (isResume) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', sessionId);
  }
  args.push(prompt);

  console.log(`Spawning claude for thread ${threadId}: ${isResume ? '--resume' : '--session-id'} ${sessionId}`);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', () => {}); // drain
  proc.stderr.on('data', (data) => {
    const text = data.toString();
    console.error(`[claude stderr] ${text}`);
    if (text.includes('No conversation found with session ID')) {
      console.log(`[server] Clearing dead session for thread ${threadId} (${sessionId})`);
      delete sessionMap[threadId];
      saveSessionMap(sessionMap);
    }
  });

  const state = {
    proc,
    typingInterval: null,
    lastFlushedLine: 0,
    transcriptPath: null,
    lastMsgRef: null,
    exited: false,
    hookDone: false,
  };

  inflight.set(threadId, state);

  // Typing indicator
  (async () => {
    try {
      const channel = await client.channels.fetch(threadId);
      if (channel) {
        channel.sendTyping();
        state.typingInterval = setInterval(() => {
          channel.sendTyping().catch(() => {});
        }, 8000);
      }
    } catch (e) {
      console.error(`Failed to send typing for ${threadId}:`, e.message);
    }
  })();

  proc.on('exit', (code, signal) => {
    console.log(`Claude exited for thread ${threadId}: code=${code} signal=${signal}`);
    state.exited = true;
    cleanup(threadId);
  });
}

// --- handleMessage ---
async function handleMessage(threadId, prompt) {
  if (inflight.has(threadId)) {
    await killInflight(threadId);
  }
  spawnClaude(threadId, prompt);
}

// --- Transcript flushing ---
async function flushTranscript(threadId) {
  const state = inflight.get(threadId);
  if (!state || !state.transcriptPath) return;

  let lines;
  try {
    const content = readFileSync(state.transcriptPath, 'utf8');
    lines = content.split('\n').filter(l => l.trim());
  } catch { return; }

  const newLines = lines.slice(state.lastFlushedLine);
  state.lastFlushedLine = lines.length;

  for (const line of newLines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const role = entry.message?.role || entry.role;
    if (role !== 'assistant') continue;

    const content = entry.message?.content || entry.content;
    if (!content) continue;

    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      const text = typeof block === 'string' ? block : (block.type === 'text' ? block.text : null);
      if (!text) continue;

      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) continue;

        // Split into 2000-char chunks
        for (let i = 0; i < text.length; i += 2000) {
          const chunk = text.slice(i, i + 2000);
          const msg = await channel.send(chunk);
          state.lastMsgRef = msg;
        }
      } catch (e) {
        console.error(`Failed to send transcript to ${threadId}:`, e.message);
      }
    }
  }
}

// --- Hook HTTP server ---
const httpServer = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  // POST /message — internal dispatch
  if (req.url === '/message') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');

    const { threadId, message } = payload;
    if (!threadId || !message) return;

    try {
      let target;
      try {
        target = await client.channels.fetch(threadId);
      } catch (e) {
        console.error(`/message: could not fetch channel/thread ${threadId}:`, e.message);
        if (ALERT_CHANNEL_ID) {
          try {
            const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
            if (alertChannel) {
              await alertChannel.send(`⚠️ \`/message\` failed: could not fetch channel/thread \`${threadId}\`. Message was: \`"${message}"\``);
            }
          } catch (ae) {
            console.error('Failed to send alert:', ae.message);
          }
        }
        return;
      }

      let resolvedThreadId = threadId;
      // If target is a channel (not a thread), create a new thread
      if (!target.isThread()) {
        const thread = await target.threads.create({
          name: message.slice(0, 100) || 'Scheduled',
        });
        resolvedThreadId = thread.id;
      }

      await handleMessage(resolvedThreadId, message);
    } catch (e) {
      console.error(`/message error:`, e.message);
    }
    return;
  }

  // POST /hooks — Claude Code hooks
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');

  const { hook_event_name, session_id, transcript_path, last_assistant_message } = payload;
  if (!session_id) return;

  // Reverse-lookup thread ID from session ID
  const threadId = Object.keys(sessionMap).find(tid => sessionMap[tid] === session_id);
  if (!threadId) return;

  const state = inflight.get(threadId);
  if (!state) return;

  // Store transcript path on first hook that provides it
  if (transcript_path && !state.transcriptPath) {
    state.transcriptPath = transcript_path;
    // Set lastFlushedLine to current line count to skip history
    try {
      const content = readFileSync(transcript_path, 'utf8');
      state.lastFlushedLine = content.split('\n').filter(l => l.trim()).length;
    } catch {
      state.lastFlushedLine = 0;
    }
  }

  if (hook_event_name === 'PreToolUse' || hook_event_name === 'PostToolUse') {
    await flushTranscript(threadId);
  }

  if (hook_event_name === 'Stop') {
    // Clear typing immediately
    clearInterval(state.typingInterval);
    state.typingInterval = null;

    if (last_assistant_message && last_assistant_message.trim()) {
      try {
        const channel = await client.channels.fetch(threadId);
        if (channel) {
          // Split into 2000-char chunks
          let lastMsg = null;
          for (let i = 0; i < last_assistant_message.length; i += 2000) {
            const chunk = last_assistant_message.slice(i, i + 2000);
            lastMsg = await channel.send(chunk);
          }
          if (lastMsg) {
            await lastMsg.react('✅');
          }
        }
      } catch (e) {
        console.error(`Failed to send final message to ${threadId}:`, e.message);
      }
    } else if (state.lastMsgRef) {
      try {
        await state.lastMsgRef.react('✅');
      } catch (e) {
        console.error(`Failed to react on lastMsgRef for ${threadId}:`, e.message);
      }
    }

    state.hookDone = true;
    cleanup(threadId);
  }
});

httpServer.listen(HOOK_PORT, '127.0.0.1', () => {
  console.log(`Hook server listening on 127.0.0.1:${HOOK_PORT}`);
});

// --- Discord message handler ---
client.on('messageCreate', async (message) => {
  // Message filter
  if (message.guildId !== DISCORD_GUILD_ID) return;
  if (message.author.bot) return;
  if (!allowedUsers.has(message.author.id)) return;

  let prompt = '';

  // Channel context
  let threadId;
  if (message.channel.isThread()) {
    threadId = message.channel.id;
    try {
      const parent = await client.channels.fetch(message.channel.parentId);
      if (parent) {
        if (parent.topic) {
          prompt += `[Channel: #${parent.name}]\n[Description: ${parent.topic}]\n[System Instruction: If through interaction or research, you notice the channel name or description drifts from the reality on the ground, change one or both, and always ask the user before doing this.]\n`;
        } else {
          prompt += `[Channel: #${parent.name}]\n[System Instruction: No description exists for this channel. After fielding the user's first interaction, propose a description and update it if approved. Tweak the channel name and/or description whenever the purpose changes significantly, and always ask the user before doing this.]\n`;
        }
      }
    } catch (e) {
      console.error(`Failed to fetch parent channel:`, e.message);
    }
  } else {
    // Not a thread — create one
    try {
      const thread = await message.startThread({
        name: message.content.slice(0, 100) || 'New thread',
      });
      threadId = thread.id;

      if (message.channel.topic) {
        prompt += `[Channel: #${message.channel.name}]\n[Description: ${message.channel.topic}]\n[System Instruction: If through interaction or research, you notice the channel name or description drifts from the reality on the ground, change one or both, and always ask the user before doing this.]\n`;
      } else {
        prompt += `[Channel: #${message.channel.name}]\n[System Instruction: No description exists for this channel. After fielding the user's first interaction, propose a description and update it if approved. Tweak the channel name and/or description whenever the purpose changes significantly, and always ask the user before doing this.]\n`;
      }
    } catch (e) {
      console.error(`Failed to create thread:`, e.message);
      return;
    }
  }

  // Attachments
  if (message.attachments.size > 0) {
    const filePaths = [];
    for (const [, attachment] of message.attachments) {
      const filename = `${Date.now()}-${attachment.name}`;
      const filepath = join(DOCS_DIR, filename);
      try {
        const response = await fetch(attachment.url);
        await pipeline(response.body, createWriteStream(filepath));
        filePaths.push(filepath);
      } catch (e) {
        console.error(`Failed to download attachment ${attachment.name}:`, e.message);
      }
    }
    if (filePaths.length > 0) {
      prompt += `[Attached files]\n`;
      for (const fp of filePaths) {
        prompt += `- ${fp}\n`;
      }
    }
  }

  prompt += message.content;

  // Empty message guard
  if (!prompt.trim()) return;

  await handleMessage(threadId, prompt);
});

// --- Start ---
client.once('clientReady', (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);
