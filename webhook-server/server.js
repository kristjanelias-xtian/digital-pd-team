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

// Bot user IDs in Pipedrive — events from these users are bot-generated, not external
const BOT_USER_IDS = new Set([25475093, 25475071, 25475082]); // Zeno, Lux, Taro

// --- Event debouncing ---
// Batch PD events over a window before triggering Zeno (reduces LLM calls by ~70%)
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS) || 30_000; // 30 seconds
let pendingEvents = [];
let debounceTimer = null;

app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pd-webhook-relay' });
});

// --- Pipedrive Webhook Receiver ---
// Events are debounced, filtered, and batched before triggering Zeno.
// This reduces LLM calls dramatically — multiple PD changes become one Zeno wake-up.

// High-value events that warrant triggering Zeno
const TRIGGER_EVENTS = new Set([
  'added.deal', 'added.lead', 'added.person', 'added.organization',
  'updated.deal', 'updated.lead',   // stage changes, status changes, value changes
  'deleted.deal', 'deleted.lead',
]);

app.post('/pd-webhook', async (req, res) => {
  const payload = req.body;
  const normalized = normalizePayload(payload);
  const eventKey = `${normalized.action}.${normalized.object}`;

  // Check if this event was created by one of our bots (loop prevention)
  const creatorId = payload.meta?.user_id || payload.data?.creator_user_id || payload.data?.user_id;
  const isBotEvent = BOT_USER_IDS.has(creatorId);

  console.log(`[${new Date().toISOString()}] ${eventKey} — ${normalized.label}${isBotEvent ? ' (bot)' : ''}`);

  // Bot-generated events: log only
  if (isBotEvent) {
    return res.status(200).json({ received: true, skipped: 'bot-generated' });
  }

  // Low-value events (activity updates, org changes, etc.): log only
  if (!TRIGGER_EVENTS.has(eventKey)) {
    console.log(`  → Logged (not a trigger event)`);
    return res.status(200).json({ received: true, logged: true });
  }

  // Format and add to batch
  const message = formatForZeno(normalized);
  if (!message) {
    return res.status(200).json({ received: true });
  }

  pendingEvents.push(message);
  console.log(`  → Queued (${pendingEvents.length} pending, flushing in ${DEBOUNCE_MS / 1000}s)`);

  // Reset debounce timer
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushEvents, DEBOUNCE_MS);

  res.status(200).json({ received: true, queued: true });
});

// --- Flush batched events to Zeno ---
async function flushEvents() {
  debounceTimer = null;
  if (pendingEvents.length === 0) return;

  const events = pendingEvents.splice(0);
  const batchMessage = events.length === 1
    ? events[0]
    : `${events.length} Pipedrive events:\n${events.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;

  console.log(`[${new Date().toISOString()}] Flushing ${events.length} event(s) to Zeno`);

  // DM Kristjan
  try {
    await dmZeno(batchMessage);
  } catch (err) {
    console.error(`  → DM failed: ${err.message}`);
  }

  // Trigger Zeno
  const zenoBot = BOTS['zeno'];
  if (!GATEWAY_TOKEN || !zenoBot) return;

  try {
    const response = await fetch(`http://127.0.0.1:${zenoBot.port}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'openclaw',
        input: `[Pipedrive webhook] ${batchMessage}`,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`  → Zeno gateway error: ${response.status} — ${body}`);
      return;
    }

    // Post Zeno's response to the group
    const data = await response.json();
    let output = null;
    if (Array.isArray(data.output)) {
      const texts = [];
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if ((block.type === 'output_text' || block.type === 'text') && block.text) texts.push(block.text);
          }
        }
      }
      if (texts.length > 0) output = texts.join('\n');
    } else if (typeof data.output === 'string') {
      output = data.output;
    }

    if (output && output.length > 0) {
      const text = output.length > 4000 ? output.slice(0, 4000) + '...' : output;
      const zenoToken = process.env.ZENO_TELEGRAM_BOT_TOKEN;
      if (zenoToken) {
        await fetch(`https://api.telegram.org/bot${zenoToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text }),
        });
        console.log(`  → Zeno posted to group`);
      }
    }
    console.log(`  → Zeno processed ${events.length} event(s)`);
  } catch (err) {
    console.error(`  → Zeno trigger failed: ${err.message}`);
  }
}

// --- Bot-to-Bot Trigger Relay ---
// Bots can't see each other's Telegram messages (platform restriction).
// This endpoint delivers messages via the OpenClaw gateway HTTP API.
//
// Two modes:
//   ?async=true  — fire-and-forget, returns immediately (for when caller doesn't need to wait)
//   default      — waits for gateway to accept the message, returns real delivery status
//
// The gateway /v1/responses runs the full agent (LLM + tools) which can take 60s+.
// We wait only for the HTTP connection to succeed (gateway accepted the request),
// then post the bot's response to the Telegram group in the background.
app.post('/trigger', async (req, res) => {
  const { to, from, message } = req.body;
  const fireAndForget = req.query.async === 'true';

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

  console.log(`[${new Date().toISOString()}] trigger: ${from || '?'} → ${to}${fireAndForget ? ' (async)' : ''}`);

  const url = `http://127.0.0.1:${bot.port}/v1/responses`;
  const fetchOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: 'openclaw',
      input: message,
    }),
    signal: AbortSignal.timeout(120_000), // 2 min timeout
  };

  // Helper: post bot's response to the Telegram group
  async function postToGroup(response) {
    try {
      const data = await response.json();
      // OpenClaw gateway returns Responses API format:
      // { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
      let output = null;
      if (Array.isArray(data.output)) {
        // Responses API: extract text from message content blocks
        const texts = [];
        for (const item of data.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const block of item.content) {
              if (block.type === 'output_text' && block.text) texts.push(block.text);
              else if (block.type === 'text' && block.text) texts.push(block.text);
            }
          }
        }
        if (texts.length > 0) output = texts.join('\n');
      } else if (typeof data.output === 'string') {
        output = data.output;
      }
      // Fallback formats
      if (!output) output = data.choices?.[0]?.message?.content || null;

      if (output && typeof output === 'string' && output.length > 0) {
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
  }

  if (fireAndForget) {
    // Legacy async mode — respond immediately, deliver in background
    fetch(url, fetchOpts).then(async (response) => {
      if (!response.ok) {
        const body = await response.text();
        console.error(`  → Gateway error for ${to}: ${response.status} — ${body}`);
      } else {
        await postToGroup(response);
        console.log(`  → ${to} finished processing`);
      }
    }).catch((err) => {
      console.error(`  → Trigger delivery to ${to} failed: ${err.message}`);
    });
    return res.json({ delivered: true, mode: 'async' });
  }

  // Default: wait for real delivery
  try {
    const response = await fetch(url, fetchOpts);
    if (!response.ok) {
      const body = await response.text();
      console.error(`  → Gateway error for ${to}: ${response.status} — ${body}`);
      return res.status(502).json({ delivered: false, error: `Gateway returned ${response.status}`, detail: body });
    }
    // Gateway accepted — post response to group in background
    postToGroup(response).catch(() => {});
    console.log(`  → ${to} accepted the trigger`);
    return res.json({ delivered: true, mode: 'sync' });
  } catch (err) {
    console.error(`  → Trigger delivery to ${to} failed: ${err.message}`);
    return res.status(502).json({ delivered: false, error: err.message });
  }
});

// --- Tunnel Health Check ---
// Quick connectivity test: can we reach each bot's gateway?
app.get('/tunnel-status', async (req, res) => {
  const results = {};
  for (const [name, bot] of Object.entries(BOTS)) {
    try {
      const response = await fetch(`http://127.0.0.1:${bot.port}/v1/models`, {
        headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN || ''}` },
        signal: AbortSignal.timeout(5000),
      });
      results[name] = { up: response.ok, port: bot.port, status: response.status };
    } catch (err) {
      results[name] = { up: false, port: bot.port, error: err.message };
    }
  }
  const allUp = Object.values(results).every(r => r.up);
  res.status(allUp ? 200 : 503).json({ tunnels: results, healthy: allUp });
});

// --- Normalize PD webhook payload ---
function normalizePayload(payload) {
  if (payload.meta && payload.data) {
    const actionMap = { create: 'added', update: 'updated', change: 'updated', delete: 'deleted', merge: 'merged' };
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

// --- Format event summary for Zeno ---
// Pass everything through — Zeno is the router, he decides what matters.
// Only skip notes (bots create notes, relaying would loop).
function formatForZeno(ev) {
  const { action, object, data, previous } = ev;

  const label = data.title || data.name || data.subject || data.content?.slice(0, 60) || `ID ${data.id}`;
  const id = data.id ? `${object.charAt(0).toUpperCase() + object.slice(1)} ID: ${data.id}` : '';

  // Build a concise summary with whatever we have
  const parts = [`${action} ${object}: "${label}"`];

  // Add useful context based on what's in the payload
  if (data.value) parts.push(`€${Number(data.value).toLocaleString()}`);
  if (data.stage_id) parts.push(`Stage: ${data.stage_id}`);
  if (data.status && data.status !== 'open') parts.push(`Status: ${data.status}`);
  if (data.lost_reason) parts.push(`Reason: ${data.lost_reason}`);
  if (data.done !== undefined) parts.push(data.done ? 'Done' : 'Pending');
  if (data.type) parts.push(`Type: ${data.type}`);
  if (data.deal_id) parts.push(`Deal ID: ${data.deal_id}`);

  // Contact info
  const personName = typeof data.person_id === 'object' ? data.person_id?.name : null;
  const orgName = typeof data.org_id === 'object' ? data.org_id?.name : null;
  if (personName) parts.push(`Contact: ${personName}`);
  if (orgName) parts.push(`Org: ${orgName}`);

  // Highlight what changed (for updates)
  if (previous) {
    if (previous.stage_id !== undefined && previous.stage_id !== data.stage_id) {
      parts.push(`(moved from stage ${previous.stage_id})`);
    }
    if (previous.status !== undefined && previous.status !== data.status) {
      parts.push(`(was: ${previous.status})`);
    }
  }

  if (id) parts.push(id);

  return parts.join(', ');
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
