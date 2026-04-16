# Architecture: Digital PD Team

A deep technical reference for the Digital PD Team — a multi-agent AI system that simulates a B2B sales team operating a Pipedrive CRM instance for a fictional Estonian solar company (NordLight Solar Solutions).

> **Scope note:** this doc is the deep reference. For day-to-day operations, see `CLAUDE.md`. For adding a new bot, see `docs/new-bot-checklist.md`. For tuning bot behavior, see `docs/iteration-playbook.md`. For showing the system to colleagues, see `docs/demo-scenario.md`.

---

## 1. System Overview

Digital PD Team is three LLM-powered bots running in isolated sandboxes, collaborating through a shared Telegram group and a webhook relay to operate a real Pipedrive CRM instance. Each bot plays a distinct sales role: sales manager, SDR, and account executive. Together they simulate the full lifecycle of B2B solar sales — from inbound lead to signed contract.

The system demonstrates autonomous multi-agent CRM operations: bots qualify leads, score prospects against an ideal customer profile, convert leads to deals, write proposals, generate mock sales call transcripts, and progress deals through a 7-stage pipeline. A human operator oversees the system through the same Telegram group and Pipedrive dashboard the bots use.

```
                        Pipedrive CRM
                    (nordlight-digital-pd-team.pipedrive.com)
                            |
                            | v2 webhooks
                            v
  Tailscale Funnel --> webhook-server (Express, port 3000)
  (public HTTPS)            |
                            |-- routing.yaml (YAML event → bot table)
                            |-- dedupe (eventKey+id, 15s)
                            |-- rollup dedupe (bot+person_id, 90s)
                            |-- is_bot filter (skip self-triggered events)
                            |-- fire-and-forget dispatch to bot gateways
                            |-- /trigger endpoint (bot-to-bot relay)
                            |-- server-side group-message sanitizer
                            v
                +-------+  +-------+  +-------+
                |Lux Bot|  |Taro   |  |Zeno   |
                |  SDR  |  |Bot AE |  |Bot Mgr|
                +-------+  +-------+  +-------+

  All bots share a Telegram group ("NordLight Sales").
  All bots read/write Pipedrive via REST API with individual tokens.
  Each bot runs in an isolated OpenShell sandbox (Linux VM).
  Lux hands off to Taro via /trigger. Zeno observes; he does not route.
```

### The Team

| Bot       | Role                | Owns                                                    |
|-----------|---------------------|---------------------------------------------------------|
| Lux Bot   | SDR                 | Leads Inbox, ICP scoring, lead→deal conversion, first-contact outreach |
| Taro Bot  | Account Executive   | Deals from Qualified through Contract Signed, discovery, proposals, closing |
| Zeno Bot  | Sales Manager       | Pipeline oversight, team coordination, stuck-deal nudges, escalation (no record creation, no stage moves) |

> **Historical note:** in the original architecture, Zeno was a "Sales Director / Router" who received every webhook event first and delegated to Lux or Taro in the group chat. This created latency, blurred ownership, and made Zeno a single point of failure. The 2026-04 refactor moved routing into a declarative YAML table (`webhook-server/routing.yaml`) that dispatches events directly to the owning role. Zeno became a pure manager: he only sees deal updates (as cc), deal/lead deletes, and direct group mentions. See `bots/ROLES.md` for the current role registry.

### The Company

NordLight Solar Solutions OU is a fictional Estonian solar installer. 15 employees, EUR 1.8M revenue, based in Tallinn. Residential installs (EUR 7K-18K) and commercial (EUR 20K-80K). Service area: Tallinn, Tartu, Parnu, and surrounding counties. A company profile document is loaded into each bot's context.

---

## 2. Design Philosophy

### Deal-centric mental model

The system's Pipedrive integration is built on the mental model from Pipedrive's own `llm.txt`: the deal is the unit of value and the unit of work. Everything else -- persons, organizations, activities, notes -- exists to support deal execution. The pipeline board (a visual Kanban of deals moving through stages) is the primary workspace.

This shapes how bots think about their work. They don't manage contacts for their own sake. They manage deals and the actions that move deals forward.

### Activity-based selling

Pipedrive's core philosophy is that salespeople should focus on actions within their control -- calls, meetings, follow-ups -- rather than obsessing over outcomes. The bots follow this: every stage transition creates follow-up activities. Activities are the operational heartbeat.

### Natural language communication

All bot communication is conversational. Bots talk like real salespeople in a team chat:

- "Hey Lux -- new lead just came in. Eva Pirita, interested in residential in Pirita."
- "Looked into the lead -- south-facing roof, motivated buyer, scored 82. Moving to Qualified."
- "Just got off the phone with Eva -- she's in! EUR 9,500 in the bag."

Bots never forward raw JSON, webhook payloads, entity IDs, or structured data to the group. The webhook relay is the only component that speaks in structured data, and only in a private DM to Zeno.

### Ownership boundaries

Each bot owns a domain and never does another bot's job:

- Zeno never qualifies leads (even if the answer is obvious)
- Lux never writes proposals or progresses deals in the pipeline
- Taro never scores or labels leads

This prevents the "eager AI" problem where every agent tries to do everything. Violations of ownership boundaries are treated as bugs, not features.

### Skill-based architecture

Bots are not programmed with code. They are instructed with markdown documents that teach them what to do, how to think, and when to act. Three layers shape each bot's behavior:

- **`bots/<bot>/IDENTITY.md`** — personality, voice, tone. ~20 lines. "You are Lux Bot, an SDR at NordLight Solar…"
- **`bots/shared/rulebook-base.md`** — the non-negotiable rules every bot inherits. Format limits, infrastructure blackout, idempotency, helper-first discipline. ~35 lines.
- **`bots/<bot>/SKILL.md`** — the role-specific playbook. Decision trees, scoring rubric references, helper invocation patterns, handoff protocols. ~45 lines.

> **Deployment quirk worth knowing:** openclaw only loads `~/.openclaw/agents/main/agent/IDENTITY.md` as the bot's always-on system prompt. Files dropped under `~/.agents/skills/*/SKILL.md` are treated as invokable capabilities, not injected instructions. So any rulebook or SKILL change has to be *concatenated into IDENTITY.md* at deploy time. The current `bots/<bot>/restore.sh` flow does this via a temporary local-file merge: the repo source stays split (clean for editing), but what lands on the sandbox is the merged file. See `docs/iteration-playbook.md` step 3 for the exact deployment dance.

### Helpers enforce rules by construction

Rather than trusting the LLM to follow every CRM rule perfectly, the team uses Python CLI helpers that enforce invariants at the API boundary. Bots invoke them by name on PATH (`pd-search`, `pd-note`, `pd-new-lead`, `pd-convert-lead`, etc.) instead of calling Pipedrive REST directly. See `bots/shared/helpers/` for the eight helpers and their test suite.

Example: `pd-convert-lead` refuses to convert an already-archived lead (idempotency), refuses to create a second deal for a person who already has one in the last 5 minutes (race guard), and atomically archives the source lead after creating the deal. The LLM's prompt only has to say "run `pd-convert-lead --lead-id X`" — the helper guarantees the data stays consistent regardless of what the LLM tries to do.

---

## 3. Bot Architecture

### Runtime environment

Each bot runs inside an OpenShell sandbox -- an isolated Linux VM with controlled network access. Inside the sandbox, an OpenClaw gateway process serves as the bot runtime:

```
+--------------------------------------------------+
|  OpenShell Sandbox (e.g., "zeno")                |
|                                                  |
|  openclaw-gateway (port 18789)                   |
|    |-- Claude Sonnet (via Anthropic API)         |
|    |-- Telegram bot integration                  |
|    |-- Tool execution (curl, etc.)               |
|    |-- Skill files (~/.agents/skills/)            |
|    |-- Identity (IDENTITY.md)                    |
|                                                  |
|  Network policy: only approved endpoints         |
+--------------------------------------------------+
```

### Bot composition

Each bot is assembled from several configuration layers:

```
Bot = Personality + Rulebook + Role Playbook + Reference Docs + Helpers + Credentials + Policy

Personality (bots/<bot>/IDENTITY.md)
  Name, role, voice, what-they-never-do. ~20 lines.

Rulebook (bots/shared/rulebook-base.md)
  THE HARD LIMIT (≤8 lines, no emoji/bold/tables), idempotency,
  infrastructure blackout, helper-first, stay-in-lane. ~35 lines.

Role Playbook (bots/<bot>/SKILL.md)
  What to do when triggered, hard rules just for you, references.
  ~45 lines.

(Deploy merges the three above into ~/.openclaw/agents/main/agent/IDENTITY.md
which is the single file openclaw loads as the bot's always-on prompt.)

Reference Docs (bots/shared/pipedrive/*.md)
  README, mental-model, notes-guide, lead-lifecycle, deal-lifecycle,
  custom-fields, account-anchors, api-conventions. Pushed to
  /sandbox/.agents/skills/shared/pipedrive/ for on-demand reads by the bot.

Helpers (bots/shared/helpers/pd-*)
  Python CLIs on the bot's PATH at /sandbox/.local/bin/. The bot invokes
  them as tools.

Company Profile (docs/nordlight-solar-profile.md)
  Product details, pricing, service area, value propositions. Uploaded
  into the bot's workspace.

Credentials (openclaw.json, auth-profiles.json)
  Telegram bot token, Pipedrive API token, group chat ID. Gitignored.

Network Policy (bots/<bot>/policy.yaml)
  Allowlist of outbound hosts enforced at the sandbox level.
```

### Heartbeat cycle

Bots operate on 20-minute heartbeat cycles. Each heartbeat, a bot:

1. Checks for pending work (event queue, relay messages, stalled items)
2. Processes any assigned tasks
3. Monitors its domain for anomalies (stalled deals, overdue activities)
4. Reports status to the group only when something changed

Rule 9 of the base rulebook is explicit: heartbeats are silent unless there's news. A bot that checks its inbox and finds nothing says nothing. This avoids "HEARTBEAT_OK"-style noise in the group.

Between heartbeats, bots wake instantly when triggered via the `/trigger` relay (from another bot or the webhook server) or via a direct Telegram DM.

### Model and inference

All bots use Claude Sonnet (via the Anthropic API) as their reasoning engine. The model is configured at the OpenShell provider level:

```
openshell provider create --name anthropic --type anthropic --credential ANTHROPIC_API_KEY
openshell inference set --provider anthropic --model claude-sonnet-4-6
```

Bots can also use Anthropic's built-in `web_search` tool for research tasks (no separate API key required).

---

## 4. Communication Architecture

### Telegram group as shared workspace

All three bots and the human operator share a single Telegram group ("NordLight Sales"). This is the observable workspace — every assignment, qualification result, deal update, and celebration happens here. The human can DM bots individually for direct queries that don't need team visibility.

### Selective triggering with mentionPatterns

Without controls, all three bots would respond to every message. The system uses two mechanisms:

1. **`requireMention: true`** — bots only process group messages that mention them.
2. **`mentionPatterns`** — regex patterns that define what counts as a mention.

```
Lux responds to:  @lux_pd_bot, "Lux Bot", "Lux", \blux\b
Taro responds to: @taro_pd_bot, "Taro Bot", "Taro", \btaro\b
Zeno responds to: @zeno_pd_bot, "Zeno Bot", "Zeno", \bzeno\b
```

### Declarative event routing — `webhook-server/routing.yaml`

Webhook events from Pipedrive do not pass through any bot. The webhook server reads `routing.yaml` and dispatches each event directly to the owning role. The file is the single source of truth for which bot handles which event type:

```yaml
routes:
  - event: added.lead
    to: lux
  - event: updated.lead
    to: lux
    skip_if_bot_creator: true
  - event: added.person
    to: lux
    skip_if_bot_creator: true
  - event: added.deal
    to: taro
    skip_if_bot_creator: true
  - event: updated.deal
    to: taro
    cc: zeno
    skip_if_bot_creator: true
    only_on_change: [stage_id, status, value]
  - event: deleted.deal
    to: zeno
  - event: deleted.lead
    to: zeno
```

Key directives:

- **`to`** — the bot that owns the event.
- **`cc`** — additional bots that should be notified (used for Zeno's oversight on material deal changes).
- **`skip_if_bot_creator: true`** — skip the event if the creator was one of the bots. Prevents self-trigger loops when a bot's own PD writes fire webhooks back to itself.
- **`only_on_change: [...]`** — only dispatch if the listed fields changed. Prevents noise on trivial updates.

Editing `routing.yaml` and restarting the webhook server is all it takes to re-wire event handling. No code changes needed.

### Webhook server responsibilities

The Express server (`webhook-server/server.js`, ~350 lines) does four things:

1. **Receive** PD webhooks at `/pd-webhook`, normalize the payload into a common `{action, object, data, previous, label}` shape.
2. **Dedupe** duplicate webhook deliveries at two levels:
   - *Exact dedupe* on `(eventKey, entity_id)` within a 15-second window — catches PD's occasional replay of the same event.
   - *Rollup dedupe* on `(target_bot, rollup_key)` within a 90-second window, where `rollup_key` is the underlying `person_id` extracted from person/lead/deal events. This is critical: when a user creates a person and a lead together via one API call, PD fires `added.person` and `added.lead` ~250ms apart. Without rollup, both trigger parallel cold sessions of the same bot that race each other, produce duplicate group messages, and try to create duplicate deals. The rollup blocks the second trigger at the routing layer.
3. **Route** using `routing.yaml` + the `is_bot` creator filter. The filter compares `creator_user_id` (stringified) against a set of known bot user IDs — this must be a string comparison, because PD serializes user IDs as strings in webhook payloads and a numeric comparison silently fails.
4. **Dispatch** to bot gateways as fire-and-forget. The server responds 200 OK to PD in under 50 ms, then kicks off the bot's work in the background with a 10-minute fetch timeout. This avoids PD's "delivery failed, retry the webhook" behavior (which itself caused the duplicate-event storm that we now dedupe).

### Bot-to-bot visibility and the trigger relay

Telegram bots cannot see messages sent by other bots in a group chat (platform restriction, even with privacy mode disabled). The webhook server exposes a second endpoint, `POST /trigger`, that bots call to deliver a message directly to another bot's gateway:

```
POST http://192.168.5.2:3000/trigger
{
  "to": "taro",
  "from": "lux",
  "message": "Mari Tamm, Pirita — Hot 88, deal #100, over to Taro."
}
```

The relay looks up the target bot's SSH tunnel port, POSTs the message to the bot's `/v1/responses` endpoint, and the bot's resulting text is auto-posted to the group via the sanitizer (below). This is the ONLY mechanism by which bots coordinate work — the group messages are for human visibility.

The handoff that Lux does after a successful `pd-convert-lead` is a concrete `curl` to `/trigger`, inlined in her SKILL.md. Earlier versions said "Hand off via `handoffs.md`" and Lux treated that as a comment she could skip; the inline command ensures the handoff actually happens.

### Server-side group-message sanitizer

Bot outputs are not posted verbatim to the group. `postResponseToGroup` passes them through a sanitizer that enforces rulebook rule 0 mechanically:

- Strips `**bold**` markers.
- Strips markdown headers (`#`, `##`, etc.).
- Removes table rows (`| cell | cell |`) and dividers.
- Removes emoji from the Unicode ranges `\u{1F300}-\u{1FAFF}` and the miscellaneous-symbols blocks.
- If the cleaned output has more than 8 non-empty lines, **keeps only the last non-empty line** — which is where bots naturally put their summary sentence.
- Also filters sentinel strings like "No response from OpenClaw." that openclaw sometimes returns on empty completions.

The sanitizer is a belt-and-braces guardrail. On a well-tuned run the bots produce compliant output on their own and the sanitizer does nothing. On a drift-prone run (verbose reasoning with rubric breakdowns), the sanitizer collapses the wall of thinking to the one-line summary and logs `truncated N-line output to last line` in `server.log`.

### Handoff protocol

All bot-to-bot interactions follow a 3-step pattern:

```
1. TRIGGER  — calling /trigger with a self-contained message. The receiver
              should not need to look anything up that isn't in the message
              or the PD record being handed off.
2. ACK      — receiver's response is auto-posted to the group by the webhook
              server. The ack is visible to humans even though bot-to-bot
              messages are not.
3. RESULT   — receiver posts a completion line (also via /trigger-induced
              group post) when the handoff work is done.
```

See `bots/shared/handoffs.md` for the full protocol.

---

## 5. Pipedrive Integration

### Layered Pipedrive knowledge

Pipedrive knowledge is split across eight on-demand reference docs that bots read as needed plus the per-bot SKILL.md that tells each role which ones apply to it:

```
bots/shared/pipedrive/
├── README.md               — index / when-to-read-what
├── mental-model.md         — deal-centric thinking, activity-based selling
├── notes-guide.md          — how to write PD notes (format, length, voice)
├── lead-lifecycle.md       — ICP scoring rubric, Hot/Warm/Cold thresholds
├── deal-lifecycle.md       — 7-stage pipeline, per-stage entry criteria
├── custom-fields.md        — discovery pattern for custom fields
├── account-anchors.md      — pipeline ID, stage IDs, user IDs, label UUIDs
└── api-conventions.md      — auth, pagination, rate limits, v1 vs v2
```

Deployed to `/sandbox/.agents/skills/shared/pipedrive/` on each bot. Each bot's SKILL.md lists which references are relevant to their role (Lux reads lead-lifecycle, Taro reads deal-lifecycle, etc.) so they can pull them on demand rather than having everything in context all the time.

Why on-demand? Openclaw doesn't auto-inject these — they're plain markdown files readable via the bot's Read tool. When Lux's SKILL.md says *"read lead-lifecycle.md before scoring"*, the LLM makes a tool call to read the file, pulls the rubric into context for that turn, and uses it. Keeps the always-on prompt small (personality + rulebook + SKILL ≈ 100 lines) while providing deep reference material when needed.

### Hybrid discovery model

The system uses a pragmatic split between hardcoded and discovered configuration:

**Hardcoded (stable anchors):** Pipeline ID, stage IDs, team user IDs, lead label UUIDs. These rarely change and are documented in the shared Pipedrive file.

**Discovered at runtime:** Custom field keys (40-character hashes unique per account), activity types, person/organization lookups. Bots call `GET /dealFields`, `GET /personFields`, etc. before writing to custom fields.

This avoids both extremes: fully hardcoded (brittle) and fully discovered (slow, error-prone).

### Deal-as-hub entity model

All Pipedrive operations follow the deal-as-hub pattern:

```
Organization
    |
    +-- Person (belongs to org)
          |
          +-- Deal (primary person + primary org)
                |
                +-- Activities (calls, meetings, site visits)
                +-- Notes (qualification briefs, call transcripts, proposals)
                +-- Products (line items with pricing)
```

A well-formed deal always has: a primary person, a primary organization, a pipeline stage, a monetary value, and a follow-up activity. Bots are instructed never to create orphan deals.

### Webhook flow

Pipedrive events flow through a straight pipeline — no bot is on the event path except the ultimate target:

```
Step 1: Pipedrive fires a webhook (v2 format: { meta, data, previous })
        |
Step 2: HTTPS hits Tailscale Funnel (public endpoint)
        |
Step 3: Proxied to webhook-server (Express, port 3000 on host)
        |
Step 4: server.js normalizes the payload into {action, object, data, previous, label}
        |
Step 5: Exact dedupe check on (eventKey + entity_id), 15s window
        |
Step 6: Look up route in routing.yaml (to / cc / skip_if_bot_creator / only_on_change)
        |
Step 7: If creator is a bot and skip_if_bot_creator is set → skip (log as is_bot)
        |
Step 8: Rollup dedupe check on (target_bot + rollup_key=person_id), 90s window
        |
Step 9: Fire-and-forget dispatch to each target bot's /v1/responses endpoint
        (server returns 200 OK to PD in <50ms at this point)
        |
Step 10: When the bot's response comes back, sanitize it (strip markdown,
         truncate to 8 lines if needed, drop sentinels) and post to the
         Telegram group under the bot's own Telegram identity.
```

Every step logs a line to `webhook-server/logs/events-<date>.jsonl` with routing decision and skip reason, so `GET /events/unrouted?since=Nd` gives you a count of event types that are flowing through but not yet routed anywhere — useful for discovering new event types to wire up.

### Helper-first CRM access

Rather than having bots call Pipedrive REST directly, the system provides eight Python CLI helpers (`bots/shared/helpers/pd-*`) that enforce CRM rules at the API boundary:

| Helper                   | What it enforces                                                |
|--------------------------|-----------------------------------------------------------------|
| `pd-search`              | Unified search across leads, deals, persons, orgs               |
| `pd-find-or-create-person` | Deduplication by email/phone before creating                  |
| `pd-find-or-create-org`  | Deduplication by name/domain before creating                    |
| `pd-note`                | Note length limits, format rules, no-markdown enforcement       |
| `pd-new-lead`            | Required fields, person linkage                                 |
| `pd-new-deal`            | Person + org linkage, pipeline/stage validation, activity creation |
| `pd-advance-stage`       | Stage-entry criteria, activity closure, transition notes         |
| `pd-convert-lead`        | Hot-label required, is_archived idempotency guard, person-level race guard (5 min window), atomic archive on success |

Bots invoke these as shell commands on their PATH. They're installed into `/sandbox/.local/bin/` by `deploy-skill.sh`. The helpers have an integration test suite (`bots/shared/helpers/tests/`, 25 tests against a real PD account) run via `pytest` with `PD_ADMIN_TOKEN` set — this is "Layer 1" of the three-layer testing strategy (see section 10).

### API access model

Each bot has its own Pipedrive API token. Tokens are not scoped to specific resources (Pipedrive doesn't support that), but the bots' behavior is constrained by their SKILL.md rules and by which helpers they invoke:

| Bot  | Writes (in practice)                                              |
|------|-------------------------------------------------------------------|
| Lux  | Leads, persons, organizations, notes on leads. Converts leads to deals (one-time, via pd-convert-lead, no direct deal creation). |
| Taro | Deals, notes on deals, activities on deals, stage advancements. Never touches leads. |
| Zeno | Reads everything. Writes nothing in normal operation. Escalates via group messages and relay triggers. |

The rulebook enforces lane discipline: Taro writing a note on a lead is a "lane violation" detected by the compliance script (`scripts/check-bot-compliance.py`). See section 10.

---

## 6. The Sales Process

The system simulates NordLight Solar's complete B2B sales pipeline:

### Lead intake

Leads enter the Pipedrive Leads Inbox (manually, via the test dataset of 20 Estonian prospects, via `scripts/create-smoke-lead.sh`, or via outbound work from Lux herself). Pipedrive fires `added.lead` and `added.person` webhooks. The webhook server looks them up in `routing.yaml` and dispatches directly to Lux. The rollup dedupe ensures both events for the same person don't spawn parallel Lux sessions.

### Qualification (Lux)

Lux pulls the full lead record from Pipedrive and scores it against 6 ICP criteria:

| Criterion              | Weight | Evaluation                                    |
|------------------------|--------|-----------------------------------------------|
| Property Suitability   | 25     | Ownership, roof orientation, shading, area    |
| Energy Need/Motivation | 20     | Cost savings, green values, EU mandates       |
| Budget & Financing     | 20     | Affordability (EUR 7K-80K range)              |
| Decision Authority     | 15     | Owner vs tenant, board approval needed?       |
| Service Area           | 10     | Within Tallinn/Tartu/Parnu coverage?          |
| Timeline & Readiness   | 10     | Install within 6 months?                      |

Scoring produces a 0-100 score with three outcomes:

- **Hot (70+):** Label as Hot, convert lead to deal, hand off to Taro
- **Warm (40-69):** Label as Warm, schedule follow-up, note what is missing
- **Cold (<40):** Label as Cold, archive, explain why

Qualification notes are written as natural prose, not data tables:

> "Smarten Logistics looks like a strong fit. They own multiple warehouse buildings
> in Rae with huge flat roofs -- perfect for commercial solar. I'd score this around
> 78 -- moving to Qualified."

### Lead-to-deal conversion

When Lux converts a hot lead, the process involves multiple Pipedrive operations:

1. Label the lead as Hot (PATCH with label UUID)
2. Create a deal in the NordLight Solar pipeline at the Qualified stage
3. Link the deal to the primary person and organization
4. Set a monetary value and follow-up activity
5. Archive (delete) the lead from the inbox
6. Post handoff message to the group, trigger relay to Taro

### Deal progression (Taro)

Taro drives deals through 7 pipeline stages:

```
New Lead --> Qualified --> Site Visit Scheduled --> Proposal Sent
        --> Negotiation --> Verbal Agreement --> Contract Signed
```

At each stage, Taro generates realistic artifacts:

- **Discovery calls:** Mock transcripts with Estonian cultural references, real solar questions, objections about price/aesthetics/permits
- **Site assessments:** Roof measurements, panel layout, electrical panel status, shading analysis
- **Proposals:** System specs (kW, panel count), pricing breakdown, ROI calculations (7-12 year payback residential, 5-8 commercial), installation timeline, warranty terms
- **Negotiations:** Scope adjustments, discount discussions, objection handling

### Deal closure or loss

Won deals are celebrated in the group with value noted. Lost deals get honest post-mortems with documented reasons, learning points, and team notification.

### Escalation

Deals over EUR 40K reaching Negotiation stage trigger automatic escalation to both Zeno and the human operator for senior visibility.

---

## 7. Deployment Architecture

### Host environment

The system runs on a Mac Mini serving as the infrastructure host:

```
Mac Mini (macOS)
  |
  +-- Tailscale (VPN + Funnel for public HTTPS)
  |     |
  |     +-- Public endpoint: https://<hostname>.ts.net/pd-webhook
  |
  +-- webhook-server (Node.js, port 3000)
  |     |
  |     +-- Pipedrive webhook receiver (/pd-webhook)
  |     +-- Bot-to-bot trigger relay (/trigger)
  |     +-- SSH tunnels to each bot's gateway
  |
  +-- OpenShell (sandbox manager)
        |
        +-- zeno (sandbox, gateway port 18789 -> tunnel 18801)
        +-- lux  (sandbox, gateway port 18789 -> tunnel 18802)
        +-- taro (sandbox, gateway port 18789 -> tunnel 18803)
```

### Tailscale Funnel

Tailscale Funnel provides a public HTTPS endpoint without port forwarding, static IPs, or certificate management. Pipedrive webhooks POST to this endpoint, which proxies to the local Express server.

```bash
tailscale serve --bg 3000      # Proxy HTTPS to local port 3000
tailscale funnel --bg 3000     # Make it publicly accessible
```

### SSH tunnels

The webhook server maintains persistent SSH tunnels to each bot's sandbox. Each bot's OpenClaw gateway listens on port 18789 inside its sandbox. The tunnels map these to distinct local ports (18801, 18802, 18803) so the relay can address each bot independently.

Tunnels auto-reconnect on failure with a 5-second backoff.

### Deployment tooling

Shared scripts live in the `openshell-tools` sibling repo (on PATH). See `CLAUDE.md` for the full matrix of which tool to reach for when. The most-used three:

**`restore-bot.sh <bot-config-dir>`** — full sandbox deployment. Called via each bot's thin `restore.sh` wrapper. On an existing sandbox it kills the old gateway, re-uploads config, and starts a new gateway. On a non-existent sandbox it creates one first (this is where the OpenShell CLI `-- true` hang bug lives — see the memory file at `.claude/projects/-Users-kristjanelias-git-digital-pd-team/memory/project_openshell_cli_create_hang.md` for the workaround).

```
restore-bot.sh <bot-config-dir>
  1. Back up existing sandbox state (safety snapshot, if running)
  2. Kill existing gateway process
  3. Create sandbox if missing (pulls ~1.3GB image)
  4. Upload openclaw.json, auth-profiles.json
  5. Upload IDENTITY.md → ~/.openclaw/agents/main/agent/IDENTITY.md
     (this is the concatenated personality + rulebook + SKILL file —
     deploy-skill.sh's push to ~/.agents/skills/ is separate and not
     loaded as the always-on prompt)
  6. Upload company profile and Pipedrive IDs to workspace
  7. Configure Anthropic provider and model
  8. Start the gateway process
  9. Verify gateway is running and Telegram is reachable
```

**`deploy-skill.sh <bot|all>`** — pushes SKILL.md, shared/rulebook-base, shared/pipedrive/*.md reference docs, and the `pd-*` helpers to running sandboxes WITHOUT restarting anything. Fast (~10 seconds per bot) and memory-safe. Use for skill tweaks, reference doc updates, and helper fixes. **Note:** `deploy-skill.sh` does NOT update the always-on system prompt — for rulebook or per-bot SKILL changes, use the concat + restore.sh flow documented in `docs/iteration-playbook.md`.

**`backup-bot.sh <bot>`** — snapshots full workspace state (SOUL.md, USER.md, sessions, telegram offsets, cron jobs) to `backups/<bot>/<timestamp>/`. Pair with `restore-state.sh` to bring memory back after a sandbox destroy. Runs daily at 03:00 via a launchd agent in `openshell-tools/launchd/`.

### The IDENTITY concat trick

This is the non-obvious part of the deploy pipeline, and worth calling out explicitly. Openclaw only loads `~/.openclaw/agents/main/agent/IDENTITY.md` as the bot's always-on system prompt. It does NOT auto-include files from `~/.agents/skills/*/SKILL.md` in every turn — those are invokable skills, loaded only on demand.

The team architecture wants clean separation between personality (IDENTITY), team rules (rulebook-base), and role playbook (SKILL). The deploy flow squares the circle by concatenating all three into a temporary local `IDENTITY.md`, calling `restore.sh` (which uploads it + restarts the gateway), then rolling the local file back from a `/tmp` backup. The repo source stays clean; the sandbox gets the merged file.

```bash
# Build concat locally
for bot in lux taro zeno; do
  cp bots/$bot/IDENTITY.md /tmp/$bot-identity-orig.md
  { cat bots/$bot/IDENTITY.md; echo; echo "---"; echo; \
    cat bots/shared/rulebook-base.md; echo; echo "---"; echo; \
    cat bots/$bot/SKILL.md; } > bots/$bot/IDENTITY.md.new
  mv bots/$bot/IDENTITY.md.new bots/$bot/IDENTITY.md
done

# Deploy via restore.sh for each bot
for bot in lux taro zeno; do ./bots/$bot/restore.sh; done

# Roll local back
for bot in lux taro zeno; do cp /tmp/$bot-identity-orig.md bots/$bot/IDENTITY.md; done
```

Future work: teach `restore-bot.sh` to do the concat server-side so no local files ever get touched. Tracked as cleanup.

### Live skill updates (no restart needed)

For helper updates, reference doc updates, and skill-as-tool registration changes, `deploy-skill.sh` is the fast path:

```bash
deploy-skill.sh lux        # Push ~22 files to lux only
deploy-skill.sh all        # Push to all running bots
```

It pushes the per-bot SKILL.md, `bots/shared/rulebook-base.md`, `bots/shared/handoffs.md`, all `bots/shared/pipedrive/*.md` references, all `pd-*` helpers, and the `lib/*.py` helper dependencies. These land in `~/.agents/skills/<bot>/`, `~/.agents/skills/shared/`, and `~/.local/bin/`. The bot picks up the changes on its next interaction for on-demand reads; helpers are immediately invokable.

**Gotcha:** bots use `/sandbox/.agents/skills/...` as absolute paths in references, not `~/.agents/skills/...`. LLMs resolve `~` to `/root` by default (standard Linux assumption), but the OpenShell sandbox home is `/sandbox`. Writing the absolute path in rulebook/SKILL text makes the reference resolution unambiguous. See the memory file `.claude/projects/.../memory/project_llm_tilde_resolution.md`.

### Network policy updates

```bash
openshell policy set --policy bots/<bot>/policy.yaml <bot>
```

Live policy change, no restart.

---

## 8. Security Model

### Sandbox isolation

Each bot runs in an OpenShell sandbox -- an isolated Linux VM. Sandboxes provide:

- Process isolation (run as unprivileged `sandbox` user)
- Filesystem restrictions (read-only system paths, read-write only in /sandbox and /tmp)
- Network policy enforcement (only approved endpoints are reachable)

Bots cannot affect the host system, access other bots' sandboxes, or reach arbitrary internet endpoints.

### Network policies

Each bot's `policy.yaml` defines an explicit allowlist of outbound network destinations:

```
Allowed endpoints (all bots):
  - api.anthropic.com:443       (LLM inference)
  - api.telegram.org:443        (Telegram bot API)
  - api.pipedrive.com:443       (Pipedrive REST API)
  - nordlight-digital-pd-team.pipedrive.com:443     (Pipedrive instance)
  - 192.168.5.2:3000            (webhook relay on host)

All other outbound connections are blocked.
```

Policies are enforced at the sandbox level, not by the bot code. Even if a bot's LLM reasoning produced a `curl` to an unauthorized endpoint, the network layer would block it.

Policies restrict which binaries can make network calls (only `/usr/bin/node` and `/usr/bin/curl`).

### Credential management

Credentials are stored in gitignored files and injected during deployment:

- **Pipedrive API tokens:** Per-bot tokens in `openclaw.json` (gitignored). Each token is scoped to a specific Pipedrive user account.
- **Telegram bot tokens:** In `openclaw.json` (gitignored). Each bot has its own Telegram bot identity.
- **Gateway token:** In `webhook-server/.env` (gitignored). Used to authenticate relay requests to bot gateways.

No secrets are committed to the repository. Template files (`.env.example`) document required variables without values.

### Principle of least privilege

Pipedrive API tokens cannot be scoped to specific resources (a PD limitation), but in practice each bot only touches the parts of Pipedrive its role requires. This is enforced by three layers:

1. **Rulebook-base "stay in your lane" rule** — every bot's always-on prompt tells it which entities it owns and which to hand off.
2. **Helper invocation patterns** — Lux's SKILL invokes `pd-convert-lead`, `pd-note` on leads, etc. Taro's SKILL invokes `pd-advance-stage`, `pd-note` on deals, etc. Zeno's SKILL never invokes any write helper.
3. **Compliance detection** — the Layer-2 diagnostic (`scripts/check-bot-compliance.py`) flags lane violations post-hoc: Taro writing a note on a lead, Lux writing on a deal, Zeno creating any record. Run after go-live and periodically thereafter.

### Feedback loop prevention

Three layers of loop prevention:

1. **`skip_if_bot_creator: true`** on `updated.*` and `added.deal` routes in `routing.yaml`. Events whose creator is one of the bot user IDs are logged but not dispatched.
2. **`is_bot` creator filter** — the webhook server compares stringified `creator_user_id` against a set of known bot user IDs (stored as strings, since PD serializes user IDs as strings in webhook payloads — an earlier version used numeric IDs and silently failed every check).
3. **Rollup dedupe** on `(target_bot, person_id)` — prevents `added.person` + `added.lead` from spawning two parallel sessions for the same person within 90 seconds.

Together these mean a bot's own writes never trigger itself, and parallel events for the same subject don't spawn racing sessions.

---

## 10. Three-layer testing

The system has three testing layers, each catching a different class of failure:

### Layer 1 — Helper unit + integration tests

`bots/shared/helpers/tests/` contains 25 pytest tests covering all eight `pd-*` helpers against a real Pipedrive account (using the admin token). Each test creates a fresh isolated record, exercises the helper, asserts the result, and cleans up. Runs in ~25 seconds.

```bash
cd bots/shared/helpers
PD_ADMIN_TOKEN=<admin> python3 -m pytest tests/ -q
```

Catches: helper bugs, PD API drift, race guards, idempotency, custom field handling. If Layer 1 is green, the helpers are trustworthy.

### Layer 2 — Compliance diagnostic

`scripts/check-bot-compliance.py` is a manual-run diagnostic that audits each bot's recent PD activity and group messages against the rulebook. It measures four categories per bot:

- **Note hygiene** (≥95% threshold): length, tables, headers, code fences.
- **Deal well-formedness** (100%): person linkage, activity linkage, org heuristic.
- **Lane violations** (0 allowed): Taro writing on leads, Lux on deals, Zeno creating.
- **Group message hygiene** (≥95%): ≤8 lines, no infra keywords, no raw JSON prefix.

```bash
PD_ADMIN_TOKEN=<admin> ./scripts/check-bot-compliance.py --hours 24
```

Catches: LLM format drift, rulebook violations, lane confusion, multi-bot duplicate work. Runs in seconds. Exits 0 on pass, 1 on fail.

### Layer 3 — End-to-end smoke test

`scripts/create-smoke-lead.sh` creates a canonical test fixture (person Mari Tamm + "Pirita residential — 8 kW rooftop install" lead + qualification note with hot signals) via the admin token. The team then processes it end to end: Lux scores, converts, hands off to Taro, Taro schedules discovery.

The smoke test is the "did the architecture change break anything real" check. It's the fixture used during tuning iterations (see `docs/iteration-playbook.md`) and during demo preparation (see `docs/demo-scenario.md`). Target state: 2 compliant group messages (1 Lux verdict + 1 Taro ack), 1 deal, 0 format violations.

Layer 3 catches integration failures that Layers 1 and 2 miss — webhook routing gaps, bot memory contamination, gateway timeouts, handoff failures, sanitizer regressions.

---

## Appendix: Directory Structure

```
digital-pd-team/
├── CLAUDE.md                              ← Project overview, day-to-day runbook
├── workspace-files.txt
├── hooks/
│   └── post-restart.sh                    ← Called after restart-all.sh
├── docs/
│   ├── architecture.md                    ← This document
│   ├── nordlight-solar-profile.md         ← Company profile (loaded into bots)
│   ├── iteration-playbook.md              ← Tuning cycle methodology
│   ├── demo-scenario.md                   ← 10-min team demo runbook
│   ├── new-bot-checklist.md               ← 10-phase new-bot setup
│   ├── two-ways-to-build-crm-agents.md    ← Essay comparing this vs pipeagent
│   └── pipedrive-ids.md                   ← Account IDs reference (gitignored)
├── bots/
│   ├── ROLES.md                           ← Role registry (source of truth)
│   ├── TEMPLATE/                          ← Copy to add a new bot
│   ├── shared/
│   │   ├── rulebook-base.md               ← Non-negotiables every bot inherits
│   │   ├── handoffs.md                    ← Handoff protocol
│   │   ├── pipedrive/                     ← On-demand reference docs
│   │   │   ├── README.md
│   │   │   ├── mental-model.md
│   │   │   ├── notes-guide.md
│   │   │   ├── lead-lifecycle.md
│   │   │   ├── deal-lifecycle.md
│   │   │   ├── custom-fields.md
│   │   │   ├── account-anchors.md
│   │   │   └── api-conventions.md
│   │   └── helpers/                       ← Python pd-* CLIs
│   │       ├── pd-search
│   │       ├── pd-find-or-create-person
│   │       ├── pd-find-or-create-org
│   │       ├── pd-new-lead
│   │       ├── pd-new-deal
│   │       ├── pd-note
│   │       ├── pd-advance-stage
│   │       ├── pd-convert-lead
│   │       ├── lib/                       ← pd_client, validators, output
│   │       └── tests/                     ← 25 pytest integration tests
│   ├── lux/                               ← SDR
│   │   ├── IDENTITY.md                    ← Personality (~20 lines, source)
│   │   ├── SKILL.md                       ← Role rulebook (~45 lines, source)
│   │   ├── openclaw.json                  ← Gateway config (gitignored)
│   │   ├── policy.yaml                    ← Network policy
│   │   ├── auth-profiles.json             (gitignored)
│   │   ├── restore.sh                     ← Thin wrapper → restore-bot.sh
│   │   └── credentials/                   (gitignored)
│   ├── taro/                              ← Account Executive (same shape)
│   └── zeno/                              ← Sales Manager (same shape)
├── backups/                               (gitignored)
├── webhook-server/
│   ├── server.js                          ← YAML-driven router + sanitizer (~400 lines)
│   ├── router.js                          ← routing.yaml loader + resolveRoute
│   ├── routing.yaml                       ← Event → bot route table
│   ├── logs/                              (gitignored)
│   │   └── events-<date>.jsonl            ← Event audit log, compliance input
│   ├── package.json
│   └── .env                               (gitignored)
└── scripts/
    ├── check-bot-compliance.py            ← Layer-2 diagnostic
    ├── create-smoke-lead.sh               ← Layer-3 smoke test fixture
    └── wipe-pipedrive.sh                  ← Nuclear reset (all PD data)
```
