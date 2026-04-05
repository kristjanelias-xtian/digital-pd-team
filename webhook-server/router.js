// Router — YAML-driven event → bot resolution.
//
// Exports:
//   loadRouting(path) → { routes: [...] }
//   resolveRoute(event, payload, routing) → { targets: [botName], reason: string|null }
//   appendEventLog(logPath, entry) → void
//
// The router decides, for each incoming PD event, which bot(s) should
// receive it. Decisions are logged to a JSONL file regardless of outcome.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function loadRouting(yamlPath) {
  const contents = fs.readFileSync(yamlPath, 'utf8');
  const parsed = yaml.load(contents);
  if (!parsed || !Array.isArray(parsed.routes)) {
    throw new Error(`routing.yaml at ${yamlPath} must have a top-level "routes" array`);
  }
  return parsed;
}

function resolveRoute(eventKey, normalized, previous, isBotEvent, routing) {
  // eventKey is e.g. "added.lead", "updated.deal"
  for (const route of routing.routes) {
    if (route.event !== eventKey) continue;

    if (route.skip_if_bot_creator && isBotEvent) {
      return { targets: [], reason: 'skip_if_bot_creator' };
    }

    if (route.only_on_change && Array.isArray(route.only_on_change)) {
      if (!previous) {
        return { targets: [], reason: 'only_on_change_no_previous' };
      }
      const changed = route.only_on_change.some((field) => {
        return previous[field] !== undefined && previous[field] !== normalized.data?.[field];
      });
      if (!changed) {
        return { targets: [], reason: 'only_on_change_no_match' };
      }
    }

    const targets = [route.to];
    if (route.cc) targets.push(route.cc);
    return { targets, reason: null, route };
  }
  return { targets: [], reason: 'no_route' };
}

function appendEventLog(logDir, entry) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logDir, `events-${day}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function readRecentEvents(logDir, sinceDays) {
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'));
  files.sort();
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const events = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.ts).getTime() >= cutoff) events.push(entry);
      } catch (_) { /* skip malformed */ }
    }
  }
  return events;
}

module.exports = { loadRouting, resolveRoute, appendEventLog, readRecentEvents };
