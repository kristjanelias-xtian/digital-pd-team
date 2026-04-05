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
} catch (e) { /* no .env file */ }

const express = require('express');
const { spawn } = require('child_process');
const { loadRouting, resolveRoute, appendEventLog, readRecentEvents } = require('./router');

const app = express();
const PORT = process.env.PORT || 3000;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const LOG_DIR = resolve(__dirname, 'logs');

const BOTS = {
  zeno: { port: parseInt(process.env.ZENO_GATEWAY_PORT) || 18801 },
  lux:  { port: parseInt(process.env.LUX_GATEWAY_PORT) || 18802 },
  taro: { port: parseInt(process.env.TARO_GATEWAY_PORT) || 18803 },
};

// PD user IDs for loop prevention — events created by these users are bot-generated.
// Stored as strings because Pipedrive serializes user_id as a string in webhook payloads;
// comparing with numeric IDs silently missed every bot-creator check.
const BOT_USER_IDS = new Set(['25475093', '25475071', '25475082']); // Zeno, Lux, Taro

const BOT_TOKENS = {
  zeno: process.env.ZENO_TELEGRAM_BOT_TOKEN,
  lux:  process.env.LUX_TELEGRAM_BOT_TOKEN,
  taro: process.env.TARO_TELEGRAM_BOT_TOKEN,
};

const routing = loadRouting(resolve(__dirname, 'routing.yaml'));
console.log(`Loaded ${routing.routes.length} routes from routing.yaml`);

// --- Webhook deduplication
// Pipedrive occasionally re-fires the same webhook for a single entity create
// (observed: creating a person + lead via API in one script produces duplicate
// added.person + added.lead events ~15s apart). Dedupe on (eventKey + id) within
// a short window so the bots don't process the same event multiple times.
const DEDUP_WINDOW_MS = 15_000;
const recentEvents = new Map(); // key: `${eventKey}:${id}` → ts(ms)
function isDuplicate(eventKey, entityId) {
  if (!entityId) return false;
  const key = `${eventKey}:${entityId}`;
  const now = Date.now();
  const prev = recentEvents.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return true;
  recentEvents.set(key, now);
  return false;
}
// Prune old entries every minute to keep the map bounded
setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [k, ts] of recentEvents) if (ts < cutoff) recentEvents.delete(k);
}, 60_000).unref();

app.use(express.json({ limit: '1mb' }));

// --- Health
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'pd-webhook-relay' }));

// --- Normalize PD webhook payload
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
    return { action, object, data: payload.current || {}, previous: payload.previous || null, label: (payload.current || {}).title || 'unknown' };
  }
  return { action: 'unknown', object: 'unknown', data: payload, previous: null, label: 'unknown' };
}

// --- Dispatch to a bot's gateway
async function dispatchToBot(botName, message) {
  const bot = BOTS[botName];
  if (!bot || !GATEWAY_TOKEN) return { ok: false, error: 'bot or gateway not configured' };
  try {
    const response = await fetch(`http://127.0.0.1:${bot.port}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ model: 'openclaw', input: message }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `gateway ${response.status}: ${body}` };
    }
    await postResponseToGroup(response, botName);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Extract bot response text and post to the group
async function postResponseToGroup(response, botName) {
  try {
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
    if (!output) output = data.choices?.[0]?.message?.content || null;

    if (output && output.length > 0) {
      const text = output.length > 4000 ? output.slice(0, 4000) + '...' : output;
      const token = BOT_TOKENS[botName];
      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text }),
        });
        // Log the group message for Layer 2 compliance analysis
        appendEventLog(LOG_DIR, {
          ts: new Date().toISOString(),
          kind: 'group_message',
          bot: botName,
          text,
          lines: text.split('\n').length,
        });
      }
    }
  } catch (e) {
    console.error(`  → postResponseToGroup(${botName}) failed: ${e.message}`);
  }
}

// --- Pipedrive webhook receiver
app.post('/pd-webhook', async (req, res) => {
  const payload = req.body;
  const normalized = normalizePayload(payload);
  const eventKey = `${normalized.action}.${normalized.object}`;
  const creatorIdRaw = payload.meta?.user_id || payload.data?.creator_user_id || payload.data?.user_id;
  const creatorId = creatorIdRaw != null ? String(creatorIdRaw) : null;
  const isBotEvent = creatorId != null && BOT_USER_IDS.has(creatorId);
  const entityId = normalized.data?.id || payload.meta?.id;

  // Dedupe duplicate webhooks within DEDUP_WINDOW_MS
  if (isDuplicate(eventKey, entityId)) {
    const dedupEntry = {
      ts: new Date().toISOString(),
      event: eventKey,
      label: normalized.label,
      creator_id: creatorId || null,
      is_bot: isBotEvent,
      routed_to: null,
      cc: [],
      skip_reason: 'dedupe',
    };
    appendEventLog(LOG_DIR, dedupEntry);
    console.log(`[${dedupEntry.ts}] ${eventKey} "${normalized.label}" → skip (dedupe, id=${entityId})`);
    return res.status(200).json({ received: true, routed_to: null, reason: 'dedupe' });
  }

  const route = resolveRoute(eventKey, normalized, normalized.previous, isBotEvent, routing);

  const entry = {
    ts: new Date().toISOString(),
    event: eventKey,
    label: normalized.label,
    creator_id: creatorId || null,
    is_bot: isBotEvent,
    routed_to: route.targets[0] || null,
    cc: route.targets.slice(1),
    skip_reason: route.reason || null,
  };
  appendEventLog(LOG_DIR, entry);
  console.log(`[${entry.ts}] ${eventKey} "${normalized.label}" → ${entry.routed_to || 'none'}${entry.skip_reason ? ` (${entry.skip_reason})` : ''}`);

  if (route.targets.length === 0) {
    return res.status(200).json({ received: true, routed_to: null, reason: route.reason });
  }

  // Build a concise message for each target
  const message = `[Pipedrive webhook] ${eventKey}: "${normalized.label}"`;
  const dispatches = route.targets.map((t) => dispatchToBot(t, message));
  await Promise.all(dispatches);
  res.status(200).json({ received: true, routed_to: entry.routed_to, cc: entry.cc });
});

// --- /events/unrouted — which event types are flowing past us?
app.get('/events/unrouted', (req, res) => {
  const sinceDays = parseInt(req.query.since) || 7;
  const events = readRecentEvents(LOG_DIR, sinceDays);
  const unrouted = events.filter((e) => e.kind !== 'group_message' && !e.routed_to && e.skip_reason !== 'skip_if_bot_creator');
  const summary = {};
  for (const e of unrouted) {
    if (!summary[e.event]) summary[e.event] = { count: 0, samples: [] };
    summary[e.event].count += 1;
    if (summary[e.event].samples.length < 3) summary[e.event].samples.push(e.label);
  }
  const types = Object.entries(summary)
    .map(([event, info]) => ({ event, count: info.count, samples: info.samples }))
    .sort((a, b) => b.count - a.count);
  res.json({ since_days: sinceDays, unrouted_types: types });
});

// --- Bot-to-bot trigger relay (unchanged from previous behavior)
app.post('/trigger', async (req, res) => {
  const { to, from, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing required fields: to, message' });
  const bot = BOTS[to];
  if (!bot) return res.status(400).json({ error: `Unknown bot: ${to}` });
  if (!GATEWAY_TOKEN) return res.status(503).json({ error: 'GATEWAY_TOKEN not configured' });

  console.log(`[${new Date().toISOString()}] trigger: ${from || '?'} → ${to}`);
  const result = await dispatchToBot(to, message);
  if (result.ok) return res.json({ delivered: true });
  return res.status(502).json({ delivered: false, error: result.error });
});

// --- Tunnel health
app.get('/tunnel-status', async (req, res) => {
  const results = {};
  for (const [name, bot] of Object.entries(BOTS)) {
    try {
      const r = await fetch(`http://127.0.0.1:${bot.port}/v1/models`, {
        headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN || ''}` },
        signal: AbortSignal.timeout(5000),
      });
      results[name] = { up: r.ok, port: bot.port, status: r.status };
    } catch (err) {
      results[name] = { up: false, port: bot.port, error: err.message };
    }
  }
  const allUp = Object.values(results).every((r) => r.up);
  res.status(allUp ? 200 : 503).json({ tunnels: results, healthy: allUp });
});

// --- SSH tunnels (unchanged)
const tunnels = {};
function openTunnel(botName) {
  const bot = BOTS[botName];
  if (!bot) return;
  console.log(`  Opening tunnel to ${botName} on localhost:${bot.port}...`);
  const proc = spawn('ssh', [
    '-N', '-L', `${bot.port}:127.0.0.1:18789`,
    '-o', `ProxyCommand=openshell ssh-proxy --gateway-name openshell --name ${botName}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    `sandbox@openshell-${botName}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('Warning: Permanently added')) console.error(`  [tunnel/${botName}] ${msg}`);
  });
  proc.on('close', (code) => {
    console.log(`  [tunnel/${botName}] closed (code ${code})`);
    tunnels[botName] = null;
    setTimeout(() => openTunnel(botName), 5000);
  });
  tunnels[botName] = proc;
}
function closeTunnels() {
  for (const [name, proc] of Object.entries(tunnels)) {
    if (proc) { proc.removeAllListeners('close'); proc.kill(); tunnels[name] = null; }
  }
}
process.on('SIGINT', () => { closeTunnels(); process.exit(0); });
process.on('SIGTERM', () => { closeTunnels(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`PD Webhook Relay listening on port ${PORT}`);
  console.log(`  Routes loaded: ${routing.routes.length}`);
  console.log(`  Event log dir: ${LOG_DIR}`);
  if (GATEWAY_TOKEN) {
    console.log(`  Opening SSH tunnels to bot gateways...`);
    for (const name of Object.keys(BOTS)) openTunnel(name);
  } else {
    console.warn(`  ⚠ GATEWAY_TOKEN not set — /trigger and dispatch disabled`);
  }
});
