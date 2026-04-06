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
// Two layers:
//
// 1. EXACT dedupe on (eventKey + entity_id): catches PD's habit of re-firing
//    the same webhook for a single entity create (~15s apart). Short window.
//
// 2. ROLLUP dedupe on (target_bot + rollup_key): when a user creates a person
//    and a lead together, PD fires added.person AND added.lead within ~250ms.
//    Both get routed to the same bot, spawning parallel cold sessions that
//    race each other and produce duplicate group messages, duplicate notes,
//    and duplicate deals. The rollup key is the *subject of the action* — for
//    person/lead/deal events it's the person_id (if we can extract it). If
//    the same bot got a rollup-key trigger within 90s, skip.
const DEDUP_WINDOW_MS = 15_000;
const ROLLUP_WINDOW_MS = 90_000;
const recentEvents = new Map();   // `${eventKey}:${id}` → ts(ms)
const recentRollups = new Map();  // `${bot}:${rollup_key}` → ts(ms)

function isDuplicate(eventKey, entityId) {
  if (!entityId) return false;
  const key = `${eventKey}:${entityId}`;
  const now = Date.now();
  const prev = recentEvents.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return true;
  recentEvents.set(key, now);
  return false;
}

// Compute a rollup key for an event — the underlying "subject" that parallel
// webhook events for the same action can share. Returns null if we can't
// extract one, meaning the event will NOT be rollup-deduped.
function computeRollupKey(normalized) {
  const d = normalized.data || {};
  const obj = normalized.object;
  if (obj === 'person') return `person:${d.id}`;
  if (obj === 'organization') return `org:${d.id}`;
  if (obj === 'lead') {
    // Lead events roll up to the linked person if we have one, otherwise the lead itself.
    if (d.person_id) return `person:${d.person_id}`;
    return `lead:${d.id}`;
  }
  if (obj === 'deal') {
    if (d.person_id) return `person:${d.person_id}`;
    return `deal:${d.id}`;
  }
  return null;
}

function isRolledUp(botName, rollupKey) {
  if (!rollupKey) return false;
  const key = `${botName}:${rollupKey}`;
  const now = Date.now();
  const prev = recentRollups.get(key);
  if (prev && now - prev < ROLLUP_WINDOW_MS) return true;
  recentRollups.set(key, now);
  return false;
}

// Prune stale entries every minute to keep the maps bounded
setInterval(() => {
  const cutoffExact = Date.now() - DEDUP_WINDOW_MS;
  const cutoffRollup = Date.now() - ROLLUP_WINDOW_MS;
  for (const [k, ts] of recentEvents) if (ts < cutoffExact) recentEvents.delete(k);
  for (const [k, ts] of recentRollups) if (ts < cutoffRollup) recentRollups.delete(k);
}, 60_000).unref();

// Trust Tailscale Funnel's X-Forwarded-For header so req.ip is the real client IP
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// --- IP allowlist for Pipedrive webhooks
// Resolves the PD webhook origin hostname on startup and every 5 minutes.
// Only applied to POST /pd-webhook — local endpoints (health, trigger, tunnel-status) are unrestricted.
const { resolve: dnsResolve } = require('dns');
const PD_WEBHOOK_HOST = process.env.PD_WEBHOOK_HOST || 'qc8m7z2q.pipedrive.blue';
const LOCAL_PREFIXES = ['127.', '::1', '::ffff:127.', '192.168.', '10.', '100.'];
let allowedIPs = new Set();

function refreshAllowedIPs() {
  dnsResolve(PD_WEBHOOK_HOST, (err, addresses) => {
    if (err) {
      console.error(`[ip-allow] DNS resolve failed for ${PD_WEBHOOK_HOST}: ${err.message}`);
      return; // keep previous set
    }
    allowedIPs = new Set(addresses);
    console.log(`[ip-allow] Refreshed ${allowedIPs.size} IPs from ${PD_WEBHOOK_HOST}`);
  });
}
refreshAllowedIPs();
setInterval(refreshAllowedIPs, 24 * 60 * 60_000).unref();

function isAllowedIP(ip) {
  if (!ip) return false;
  // Strip ::ffff: IPv4-mapped prefix
  const clean = ip.replace(/^::ffff:/, '');
  if (allowedIPs.has(clean)) return true;
  // Always allow local/private IPs (trigger relay, health checks, Tailscale)
  for (const prefix of LOCAL_PREFIXES) {
    if (ip.startsWith(prefix)) return true;
  }
  return false;
}

app.use('/pd-webhook', (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (isAllowedIP(ip)) return next();
  console.warn(`[ip-allow] Blocked ${req.method} /pd-webhook from ${ip}`);
  res.status(403).json({ error: 'forbidden', ip });
});

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

// --- Dispatch to a bot's gateway (fire-and-forget)
// The bot's full pipeline (read → score → act → post) can easily take 2-5
// minutes of wall time. Blocking the webhook handler that long causes PD to
// think delivery failed and re-fire the webhook, which is why we saw the
// dedupe storm. Instead: return immediately from /pd-webhook and let the
// dispatch run in the background. The bot's final text output is posted to
// the group whenever it actually completes.
function dispatchToBot(botName, message) {
  const bot = BOTS[botName];
  if (!bot || !GATEWAY_TOKEN) {
    console.error(`  → dispatch(${botName}) skipped: bot or gateway not configured`);
    return;
  }
  // Fire-and-forget: no await, errors logged but don't propagate
  (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${bot.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({ model: 'openclaw', input: message }),
        signal: AbortSignal.timeout(600_000), // 10 minutes
      });
      if (!response.ok) {
        const body = await response.text();
        console.error(`  → dispatch(${botName}) gateway ${response.status}: ${body}`);
        return;
      }
      await postResponseToGroup(response, botName);
    } catch (err) {
      console.error(`  → dispatch(${botName}) failed: ${err.message}`);
    }
  })();
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

    // Filter out null-response sentinel text that openclaw sometimes returns.
    // These are diagnostic placeholders, not something to broadcast to the group.
    if (output) {
      const trimmed = output.trim();
      const SENTINELS = [
        'No response from OpenClaw.',
        'No response from OpenClaw',
      ];
      if (SENTINELS.includes(trimmed) || trimmed.length === 0) output = null;
    }

    // Server-side enforcement of THE HARD LIMIT (rulebook rule 0): group
    // messages must be ≤ 8 lines, plain prose, no emoji/bold/markdown tables.
    // The rulebook tells bots this, but LLMs drift on verbose reasoning
    // sessions. If the bot produces a compliant summary line at the end of a
    // wall of thinking, we keep only that line.
    if (output) {
      // Strip bold markers, markdown headers (inline), and table pipes.
      let cleaned = output
        .replace(/\*\*(.+?)\*\*/g, '$1')          // **bold** → bold
        .replace(/^#{1,6}\s+/gm, '')              // # headers → plain
        .replace(/^\s*\|.*\|\s*$/gm, '')          // table rows → empty
        .replace(/^\s*\|[-: ]+\|\s*$/gm, '')      // table dividers → empty
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/gu, '') // emoji
        .replace(/\n{3,}/g, '\n\n');              // collapse runs of blank lines
      const lines = cleaned.split('\n');
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      if (nonEmpty.length > 8) {
        // Too long — keep only the last non-empty line as the message.
        // This is where Lux/Taro naturally put their summary sentence.
        cleaned = nonEmpty[nonEmpty.length - 1];
        console.log(`  → [${botName}] truncated ${nonEmpty.length}-line output to last line`);
      }
      output = cleaned.trim();
      if (output.length === 0) output = null;
    }

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

  // Rollup dedupe: skip targets that already got a trigger for this rollup key
  // within the last 90 seconds. This prevents added.person + added.lead (fired
  // ~250ms apart by PD) from spawning two parallel sessions on the same bot.
  const rollupKey = computeRollupKey(normalized);
  const dispatched = [];
  const rolledUp = [];
  for (const t of route.targets) {
    if (isRolledUp(t, rollupKey)) {
      rolledUp.push(t);
      continue;
    }
    dispatched.push(t);
  }
  if (rolledUp.length > 0) {
    console.log(`[${entry.ts}]   rolled-up (key=${rollupKey}): ${rolledUp.join(',')}`);
  }

  // Build a concise message for each remaining target. Dispatch is fire-and-forget —
  // we ack PD immediately and let the bot work in the background.
  const message = `[Pipedrive webhook] ${eventKey}: "${normalized.label}"`;
  for (const t of dispatched) dispatchToBot(t, message);
  res.status(200).json({ received: true, routed_to: entry.routed_to, cc: entry.cc, rolled_up: rolledUp });
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
  // Fire-and-forget. The relay acks immediately; the target bot's response
  // will be posted to the group when it completes.
  dispatchToBot(to, message);
  res.json({ delivered: true, mode: 'async' });
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
