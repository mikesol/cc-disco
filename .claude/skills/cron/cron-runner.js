import { Cron } from 'croner';
import { readFileSync } from 'node:fs';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN env var');
  process.exit(1);
}

let activeCrons = [];

function loadCrons() {
  for (const c of activeCrons) c.stop();
  activeCrons = [];

  let jobs;
  try {
    jobs = JSON.parse(readFileSync('cron.json', 'utf-8'));
  } catch (e) {
    console.log(`No cron.json found or invalid (${e.message}) — no jobs scheduled`);
    return;
  }

  for (const job of jobs) {
    const cron = new Cron(job.schedule, async () => {
      console.log(`[cron] firing: "${job.message.slice(0, 50)}" → thread ${job.threadId}`);
      try {
        const res = await fetch(`https://discord.com/api/v10/channels/${job.threadId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${DISCORD_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: job.message }),
        });
        if (!res.ok) {
          console.error(`[cron] Discord API error: ${res.status} ${await res.text()}`);
        }
      } catch (e) {
        console.error(`[cron] failed to send message: ${e.message}`);
      }
    });
    activeCrons.push(cron);
    console.log(`[cron] scheduled: "${job.message.slice(0, 50)}" → ${job.schedule}`);
  }

  console.log(`[cron] ${activeCrons.length} jobs loaded`);
}

loadCrons();

process.on('SIGHUP', () => {
  console.log('[cron] SIGHUP — reloading cron.json');
  loadCrons();
});

console.log('Cron runner started');
