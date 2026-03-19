import { Client, GatewayIntentBits, Events } from 'discord.js';
import { v5 as uuidv5 } from 'uuid';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
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
mkdirSync(DOCS_DIR, { recursive: true });

if (!DISCORD_TOKEN || !DISCORD_ALLOW_USER_IDS || !DISCORD_GUILD_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_ALLOW_USER_IDS, DISCORD_GUILD_ID');
  process.exit(1);
}

const allowedUsers = new Set(DISCORD_ALLOW_USER_IDS.split(',').map(s => s.trim()));
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const threadSessionId = (threadId) => uuidv5(threadId, UUID_NAMESPACE);

// --- State ---
// Maps session ID → { threadId, proc, typingInterval, lastFlushedLine, lastMsgRef }
const sessions = new Map();

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Transcript flushing ---
function flushTranscript(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];

  try {
    const lines = readFileSync(session.transcriptPath, 'utf-8').trim().split('\n');
    const texts = [];
    for (let i = session.lastFlushedLine; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      // assistant entries nest content under .message.content
      const content = entry.message?.content ?? entry.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
      }
    }
    session.lastFlushedLine = lines.length;
    return texts;
  } catch (e) {
    console.error(`[flush] error reading transcript: ${e.message}`);
    return [];
  }
}

async function sendToDiscord(threadId, texts) {
  const channel = await client.channels.fetch(threadId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  let lastMsg = null;
  for (const text of texts) {
    if (!text.trim()) continue;
    // chunk to 2000 chars
    for (let i = 0; i < text.length; i += 2000) {
      try {
        lastMsg = await channel.send(text.slice(i, i + 2000));
      } catch (e) {
        console.error(`[send] error: ${e.message}`);
      }
    }
  }
  return lastMsg;
}

// --- Hook HTTP server ---
const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const event = data.hook_event_name;
      const hookSessionId = data.session_id;
      console.log(`[hook] ${event} session=${hookSessionId} tool=${data.tool_name || '-'}`);
      console.log(`[hook] known sessions: ${[...sessions.keys()].join(', ') || 'none'}`);

      // Find our session by claude's session_id
      let session = null;
      for (const [sid, s] of sessions) {
        if (sid === hookSessionId) { session = s; break; }
      }
      if (!session) console.log(`[hook] no matching session found for ${hookSessionId}`);

      // Store transcript path on first hook — skip existing content
      if (session && data.transcript_path && !session.transcriptPath) {
        session.transcriptPath = data.transcript_path;
        // Initialize lastFlushedLine to current end of transcript
        // so we only flush NEW assistant text from this turn
        try {
          const existingLines = readFileSync(data.transcript_path, 'utf-8').trim().split('\n');
          session.lastFlushedLine = existingLines.length;
          console.log(`[hook] transcript initialized, skipping ${existingLines.length} existing lines`);
        } catch { session.lastFlushedLine = 0; }
      }

      if ((event === 'PostToolUse' || event === 'PreToolUse') && session) {
        // Flush any assistant text from transcript
        const texts = flushTranscript(hookSessionId);
        if (texts.length > 0) {
          const lastMsg = await sendToDiscord(session.threadId, texts);
          if (lastMsg) session.lastMsgRef = lastMsg;
        }
      }

      if (event === 'Stop' && session) {
        // Final flush: use last_assistant_message as authoritative
        const finalText = data.last_assistant_message || '';
        if (finalText.trim()) {
          const lastMsg = await sendToDiscord(session.threadId, [finalText]);
          if (lastMsg) {
            session.lastMsgRef = lastMsg;
            await lastMsg.react('✅').catch(() => {});
          }
        } else if (session.lastMsgRef) {
          // No new text but we sent intermediaries — mark the last one done
          await session.lastMsgRef.react('✅').catch(() => {});
        }

        // Stop typing
        if (session.typingInterval) clearInterval(session.typingInterval);
        sessions.delete(hookSessionId);
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
function spawnClaude(sessionId, threadId, message) {
  // Try resume first; on error, retry with --session-id
  const doSpawn = (useResume) => {
    const sessionFlag = useResume ? '--resume' : '--session-id';
    const args = [
      '-p',
      sessionFlag, sessionId,
      '--dangerously-skip-permissions',
      '--model', CLAUDE_MODEL,
      message,
    ];

    console.log(`[spawn] ${sessionFlag} ${sessionId} for thread ${threadId}`);
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track session
    const channel = client.channels.cache.get(threadId);
    const typingInterval = setInterval(() => {
      client.channels.fetch(threadId)
        .then(ch => ch.sendTyping())
        .catch(() => {});
    }, 8000);

    // Send initial typing
    if (channel) channel.sendTyping().catch(() => {});

    sessions.set(sessionId, {
      threadId,
      proc,
      typingInterval,
      lastFlushedLine: 0,
      transcriptPath: null,
      lastMsgRef: null,
    });

    // Drain stdout/stderr
    let stdoutBuf = '';
    proc.stdout.on('data', () => {}); // hooks handle output, not stdout
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      // Detect resume failure
      if (useResume && msg.includes('No conversation found')) {
        console.log(`[spawn] resume failed, retrying with --session-id`);
        clearInterval(typingInterval);
        sessions.delete(sessionId);
        proc.kill('SIGKILL');
        doSpawn(false);
        return;
      }
      if (useResume && msg.includes('already in use')) {
        console.log(`[spawn] session-id conflict, retrying with --resume`);
        // Already using resume, this shouldn't happen, but handle gracefully
      }
      console.error(`[stderr] ${msg.trim()}`);
    });

    proc.on('exit', (code) => {
      console.log(`[exit] session ${sessionId} exited with code ${code}`);
      // Clean up if hooks didn't fire (e.g., immediate error)
      const s = sessions.get(sessionId);
      if (s) {
        if (s.typingInterval) clearInterval(s.typingInterval);
        sessions.delete(sessionId);
      }
    });
  };

  doSpawn(true);
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

// --- Message handling ---
async function handleMessage(threadId, content) {
  const sessionId = threadSessionId(threadId);
  console.log(`[msg] thread=${threadId} session=${sessionId} "${content.slice(0, 50)}"`);

  // Interrupt if busy
  for (const [sid, s] of sessions) {
    if (s.threadId === threadId) {
      console.log(`[interrupt] killing session ${sid} for thread ${threadId}`);
      s.proc.kill('SIGINT');
      await new Promise(resolve => {
        const timeout = setTimeout(() => { s.proc.kill('SIGKILL'); resolve(); }, 5000);
        s.proc.on('exit', () => { clearTimeout(timeout); resolve(); });
      });
      if (s.typingInterval) clearInterval(s.typingInterval);
      sessions.delete(sid);
      break;
    }
  }

  spawnClaude(sessionId, threadId, content);
}

// --- Discord events ---
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!allowedUsers.has(message.author.id)) return;
  if (message.guildId !== DISCORD_GUILD_ID) return;

  // Download attachments
  let prompt = message.content || '';
  if (message.attachments.size > 0) {
    const paths = await downloadAttachments(message.attachments);
    if (paths.length > 0) {
      prompt += '\n\n[Attached files]\n' + paths.map(p => `- ${p}`).join('\n');
    }
  }

  if (!prompt.trim()) return; // skip empty messages with no attachments

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
