const { readFileSync } = require('fs');
const { resolve } = require('path');

// Load .env file
try {
  const envFile = readFileSync(resolve(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* no .env file, rely on environment */ }

const express = require('express');
const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const ZENO_TELEGRAM_BOT_TOKEN = process.env.ZENO_TELEGRAM_BOT_TOKEN;
const ZENO_DM_CHAT_ID = process.env.ZENO_DM_CHAT_ID;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

const BOTS = {
  zeno: { port: parseInt(process.env.ZENO_GATEWAY_PORT) || 18801 },
  lux:  { port: parseInt(process.env.LUX_GATEWAY_PORT) || 18802 },
  taro: { port: parseInt(process.env.TARO_GATEWAY_PORT) || 18803 },
};

app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pd-webhook-relay' });
});

// --- Pipedrive Webhook Receiver ---
// DMs Zeno with a concise event summary. He wakes up, processes it,
// and posts to the group in natural language.
app.post('/pd-webhook', async (req, res) => {
  const payload = req.body;
  const normalized = normalizePayload(payload);

  console.log(`[${new Date().toISOString()}] ${normalized.action}.${normalized.object} — ${normalized.label}`);

  try {
    const message = formatForZeno(normalized);
    if (message) {
      await dmZeno(message);
      console.log(`  → DM'd Zeno`);
    } else {
      console.log(`  → Skipped`);
    }
  } catch (err) {
    console.error(`  → Error:`, err.message);
  }

  res.status(200).json({ received: true });
});

// --- Bot-to-Bot Trigger Relay ---
// Bots can't see each other's Telegram messages (platform restriction).
// This endpoint delivers messages via the OpenClaw gateway HTTP API.
app.post('/trigger', async (req, res) => {
  const { to, from, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing required fields: to, message' });
  }

  const bot = BOTS[to];
  if (!bot) {
    return res.status(400).json({ error: `Unknown bot: ${to}. Valid: ${Object.keys(BOTS).join(', ')}` });
  }

  if (!GATEWAY_TOKEN) {
    return res.status(503).json({ error: 'GATEWAY_TOKEN not configured' });
  }

  console.log(`[${new Date().toISOString()}] trigger: ${from || '?'} → ${to}`);

  // Fire-and-forget: respond immediately, deliver in background.
  // The gateway /v1/responses runs the full agent (LLM + tools) which can take 60s+.
  const url = `http://127.0.0.1:${bot.port}/v1/responses`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: 'openclaw',
      input: message,
    }),
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.text();
      console.error(`  → Gateway error for ${to}: ${response.status} — ${body}`);
    } else {
      // Extract the bot's response and post it to the Telegram group
      try {
        const data = await response.json();
        const output = data.output || data.choices?.[0]?.message?.content;
        if (output && typeof output === 'string' && output.length > 0) {
          // Telegram messages max 4096 chars — truncate if needed
          const text = output.length > 4000 ? output.slice(0, 4000) + '...' : output;
          const botTokens = {
            zeno: process.env.ZENO_TELEGRAM_BOT_TOKEN,
            lux: process.env.LUX_TELEGRAM_BOT_TOKEN,
            taro: process.env.TARO_TELEGRAM_BOT_TOKEN,
          };
          const botToken = botTokens[to];
          if (botToken) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text }),
            });
            console.log(`  → ${to} response posted to group`);
          }
        }
      } catch (e) {
        console.error(`  → Failed to post ${to}'s response to group: ${e.message}`);
      }
      console.log(`  → ${to} finished processing`);
    }
  }).catch((err) => {
    console.error(`  → Trigger delivery to ${to} failed: ${err.message}`);
  });

  res.json({ delivered: true });
});

// --- Normalize PD webhook payload ---
function normalizePayload(payload) {
  if (payload.meta && payload.data) {
    const actionMap = { create: 'added', update: 'updated', delete: 'deleted', merge: 'merged' };
    const action = actionMap[payload.meta.action] || payload.meta.action;
    const object = payload.meta.entity || payload.meta.object;
    const data = payload.data;
    const previous = payload.previous || null;
    const label = data.title || data.name || data.subject || 'unknown';
    return { action, object, data, previous, label };
  }

  if (payload.event) {
    const [action, object] = payload.event.split('.');
    const data = payload.current || {};
    const previous = payload.previous || null;
    const label = data.title || data.name || data.subject || 'unknown';
    return { action, object, data, previous, label };
  }

  return { action: 'unknown', object: 'unknown', data: payload, previous: null, label: 'unknown' };
}

// --- Format concise event summary for Zeno ---
// Short enough to process quickly, has the IDs he needs to fetch details from PD API.
function formatForZeno(ev) {
  const { action, object, data, previous } = ev;

  // Skip notes — bots create notes, relaying would loop
  if (object === 'note') return null;

  const value = data.value ? `€${Number(data.value).toLocaleString()}` : null;
  const personName = typeof data.person_id === 'object' ? data.person_id?.name : null;
  const orgName = typeof data.org_id === 'object' ? data.org_id?.name : null;

  switch (object) {
    case 'deal': {
      if (action === 'added') {
        const parts = [`New deal created: "${data.title || 'Untitled'}"`, value, personName ? `contact: ${personName}` : null, `Deal ID: ${data.id}`, `Stage: ${data.stage_id}`].filter(Boolean);
        return parts.join(', ');
      }
      if (action === 'updated') {
        if (previous && previous.stage_id !== data.stage_id) {
          return `Deal "${data.title}" moved from stage ${previous.stage_id} to ${data.stage_id}. Deal ID: ${data.id}`;
        }
        if (data.status === 'won') return `Deal won! "${data.title}" — ${value || 'unknown value'}. Deal ID: ${data.id}`;
        if (data.status === 'lost') return `Deal lost: "${data.title}" — reason: ${data.lost_reason || 'not given'}. Deal ID: ${data.id}`;
        return null;
      }
      if (action === 'deleted') return `Deal deleted: "${data.title}". Deal ID: ${data.id}`;
      return null;
    }

    case 'person': {
      if (action !== 'added') return null;
      const email = (data.emails || data.email || [])[0]?.value;
      return `New contact added: ${data.name}${email ? ` (${email})` : ''}. Person ID: ${data.id}`;
    }

    case 'organization': {
      if (action !== 'added') return null;
      return `New organization added: ${data.name}. Org ID: ${data.id}`;
    }

    case 'activity': {
      if (action === 'updated' && data.done) {
        return `Activity completed: ${data.type} — "${data.subject}"${data.deal_id ? `, Deal ID: ${data.deal_id}` : ''}`;
      }
      return null;
    }

    case 'lead': {
      if (action === 'added') return `New lead in inbox: "${data.title}". Lead ID: ${data.id}`;
      if (action === 'updated') return `Lead updated: "${data.title}". Lead ID: ${data.id}`;
      return null;
    }

    default:
      return null;
  }
}

// --- Telegram: DM Zeno ---
async function dmZeno(text) {
  if (!ZENO_TELEGRAM_BOT_TOKEN || !ZENO_DM_CHAT_ID) {
    console.warn('  ⚠ Zeno DM not configured — logging only');
    console.log(`  ${text}`);
    return;
  }

  const url = `https://api.telegram.org/bot${ZENO_TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ZENO_DM_CHAT_ID,
      text: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

// --- SSH Tunnels to Bot Gateways ---
const { spawn } = require('child_process');
const tunnels = {};

function openTunnel(botName) {
  const bot = BOTS[botName];
  if (!bot) return;

  console.log(`  Opening tunnel to ${botName} on localhost:${bot.port}...`);

  const proc = spawn('ssh', [
    '-N',
    '-L', `${bot.port}:127.0.0.1:18789`,
    '-o', `ProxyCommand=openshell ssh-proxy --gateway-name openshell --name ${botName}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    `sandbox@openshell-${botName}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('Warning: Permanently added')) {
      console.error(`  [tunnel/${botName}] ${msg}`);
    }
  });

  proc.on('close', (code) => {
    console.log(`  [tunnel/${botName}] closed (code ${code})`);
    tunnels[botName] = null;
    // Reconnect after 5 seconds
    setTimeout(() => {
      console.log(`  [tunnel/${botName}] reconnecting...`);
      openTunnel(botName);
    }, 5000);
  });

  tunnels[botName] = proc;
}

function openAllTunnels() {
  for (const botName of Object.keys(BOTS)) {
    openTunnel(botName);
  }
}

function closeTunnels() {
  for (const [name, proc] of Object.entries(tunnels)) {
    if (proc) {
      proc.removeAllListeners('close');
      proc.kill();
      tunnels[name] = null;
    }
  }
}

process.on('SIGINT', () => { closeTunnels(); process.exit(0); });
process.on('SIGTERM', () => { closeTunnels(); process.exit(0); });

// --- Start ---
app.listen(PORT, () => {
  console.log(`PD Webhook Relay listening on port ${PORT}`);
  console.log(`  Events → Zeno DM (instant wake-up)`);
  console.log(`  Configured: ${!!(ZENO_TELEGRAM_BOT_TOKEN && ZENO_DM_CHAT_ID)}`);

  if (GATEWAY_TOKEN) {
    console.log(`  Opening SSH tunnels to bot gateways...`);
    openAllTunnels();
  } else {
    console.warn(`  ⚠ GATEWAY_TOKEN not set — /trigger endpoint disabled`);
  }
});
