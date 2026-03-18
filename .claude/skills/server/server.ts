import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import { v5 as uuidv5 } from 'uuid';
import { spawn, type ChildProcess } from 'node:child_process';

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_ALLOW_USER_IDS = process.env.DISCORD_ALLOW_USER_IDS;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

if (!DISCORD_TOKEN || !DISCORD_ALLOW_USER_IDS || !DISCORD_GUILD_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_ALLOW_USER_IDS, DISCORD_GUILD_ID');
  process.exit(1);
}

const allowedUsers = new Set(DISCORD_ALLOW_USER_IDS.split(',').map(s => s.trim()));

// --- Session mapping ---
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function threadSessionId(threadId: string): string {
  return uuidv5(threadId, UUID_NAMESPACE);
}

// --- Process management ---
const processes = new Map<string, ChildProcess>();

const knownSessions = new Set<string>();

function spawnClaude(sessionId: string, message: string): ChildProcess {
  const sessionFlag = knownSessions.has(sessionId)
    ? ['--resume', sessionId]
    : ['--session-id', sessionId];
  knownSessions.add(sessionId);
  const args = [
    '-p',
    ...sessionFlag,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', CLAUDE_MODEL,
    message,
  ];
  console.log(`[spawn] ${sessionFlag[0]} ${sessionId}`);
  return spawn(CLAUDE_BIN, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// --- Stream parser ---
function parseStreamEvents(
  proc: ChildProcess,
  onDelta: (delta: string) => void,
  onDone: (result: string) => void,
): void {
  let buffer = '';
  let done = false;
  const callDone = (result: string) => { if (!done) { done = true; onDone(result); } };
  proc.stderr!.on('data', (chunk: Buffer) => {
    console.error('[stderr]', chunk.toString().trim());
  });
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        console.log(`[stream] type=${evt.type} subtype=${evt.subtype ?? ''} keys=${Object.keys(evt).join(',')}`);
        if (evt.type === 'result' && evt.subtype === 'error_during_execution') {
          console.log(`[stream] ERROR: ${JSON.stringify(evt.errors ?? evt, null, 2)}`);
        }
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === 'text' && block.text) {
              console.log(`[stream] text: ${block.text.slice(0, 80)}`);
              onDelta(block.text);
            }
          }
        } else if (evt.type === 'result') {
          console.log(`[stream] result: ${(evt.result ?? '').slice(0, 80)}`);
          callDone(evt.result ?? '');
        }
      } catch { /* skip unparseable lines */ }
    }
  });
  proc.on('exit', () => callDone(''));
}

// --- Message handler ---
async function handleMessage(threadId: string, content: string): Promise<void> {
  const sessionId = threadSessionId(threadId);
  console.log(`[handleMessage] thread=${threadId} session=${sessionId} msg=${content.slice(0, 50)}`);
  const channel = await client.channels.fetch(threadId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    console.log(`[handleMessage] channel not text-based or no send, aborting`);
    return;
  }

  // Interrupt if busy
  const existing = processes.get(threadId);
  if (existing) {
    existing.kill('SIGINT');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { existing.kill('SIGKILL'); resolve(); }, 5000);
      existing.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    processes.delete(threadId);
  }

  // Send placeholder
  const reply = await channel.send('...');

  // Spawn Claude
  const proc = spawnClaude(sessionId, content);
  processes.set(threadId, proc);

  let accumulated = '';
  let lastEdit = 0;
  const EDIT_INTERVAL = 1500;

  const editReply = async (final: boolean) => {
    const now = Date.now();
    if (!final && now - lastEdit < EDIT_INTERVAL) return;
    lastEdit = now;
    const text = accumulated.slice(0, 2000) || '...';
    try { await reply.edit(text); } catch { /* ignore edit failures */ }
  };

  parseStreamEvents(
    proc,
    (text) => { accumulated = text; void editReply(false); },
    async (result) => {
      processes.delete(threadId);
      const final = result || accumulated || '(no output)';
      if (final.length <= 2000) {
        try { await reply.edit(final); } catch {}
      } else {
        try { await reply.edit(final.slice(0, 2000)); } catch {}
        for (let i = 2000; i < final.length; i += 2000) {
          try { await channel.send(final.slice(i, i + 2000)); } catch {}
        }
      }
    },
  );
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!allowedUsers.has(message.author.id)) return;

  if (!message.channel.isThread()) {
    const thread = await message.startThread({
      name: message.content.slice(0, 100) || 'New thread',
    });
    await handleMessage(thread.id, message.content);
    return;
  }

  await handleMessage(message.channel.id, message.content);
});

client.login(DISCORD_TOKEN);
