# Digital PD Team

A simulated AI sales workforce for Pipedrive — three Claude-powered bots operating as a coordinated sales team.

## What Is This?

Digital PD Team is a multi-agent system where three AI bots run a complete sales operation inside Pipedrive CRM. Each bot has a distinct role — Sales Manager, SDR, and Account Executive — and they coordinate through a shared Telegram group and a lightweight webhook relay, just like a real sales team would. The bots qualify leads, progress deals through pipeline stages, write proposals and discovery notes, and hand off work to each other in natural language.

The system operates against a fictional company, NordLight Solar Solutions, an Estonian solar installer. This gives the bots a realistic product catalog, customer personas, pricing structure, and sales cycle to work with.

This is a reference implementation for anyone exploring multi-agent CRM automation — how to decompose sales workflows into agent responsibilities, how to enforce CRM data quality with helper scripts, how to route real-time events declaratively, and how to keep LLM agents grounded in a real system of record.

## The Team

| Bot | Role | What They Do |
|-----|------|--------------|
| **Lux Bot** | SDR | Qualifies inbound leads against ICP (0–100 score), labels Hot/Warm/Cold, converts Hot leads to deals, hands off to Taro |
| **Taro Bot** | Account Executive | Drives deals from Qualified through Contract Signed — discovery calls, site visits, proposals, negotiation, closing |
| **Zeno Bot** | Sales Manager | Oversees pipeline health, nudges stuck deals, celebrates wins, escalates big deals. Never creates records or moves stages himself. |

Each bot runs in its own sandboxed Linux VM with a dedicated Pipedrive API token, Telegram bot identity, and an explicit network egress policy. See [`bots/ROLES.md`](bots/ROLES.md) for the full role registry including reserved slots for future roles (RevOps, CSM, AM, SE).

## Architecture

```
                    Pipedrive CRM
                         |
                         | webhooks (v2 format)
                         v
Tailscale Funnel -> webhook-server (Express, port 3000)
  (public HTTPS)       |
                       |-- routing.yaml (declarative event -> bot table)
                       |-- dedupe (eventKey+id, 15s)
                       |-- rollup dedupe (bot+person_id, 90s)
                       |-- is_bot filter (drops self-triggered events)
                       |-- fire-and-forget dispatch
                       |-- /trigger endpoint (bot-to-bot relay)
                       |-- server-side sanitizer (strips bold/tables/emoji,
                       |   truncates >8-line messages to last line)
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

Pipedrive fires webhooks on every CRM event. A lightweight Express router (`webhook-server/server.js`) normalizes each payload, deduplicates exact repeats and parallel events keyed on the same underlying person, looks up the owning role in `routing.yaml`, and dispatches directly to that bot's gateway. The bot reads the record, reasons about it, calls `pd-*` helper CLIs to mutate the CRM, and produces a one-line summary that the router sanitizes and posts to the Telegram group. Bot-to-bot handoffs go through the same relay via `POST /trigger`. Telegram is for human visibility; the relay is the actual delivery mechanism.

## Key Design Principles

- **Declarative routing.** Webhook → bot mapping lives in [`webhook-server/routing.yaml`](webhook-server/routing.yaml). Adding a new routed event is a YAML edit plus a webhook server restart. No code changes.
- **Helpers enforce rules by construction.** Rather than trusting the LLM to follow every CRM rule perfectly, the system provides eight Python CLI helpers (`pd-search`, `pd-note`, `pd-new-lead`, `pd-new-deal`, `pd-note`, `pd-advance-stage`, `pd-convert-lead`, `pd-find-or-create-person`, `pd-find-or-create-org`) that validate invariants at the API boundary. `pd-convert-lead` refuses to convert an already-archived lead, refuses to create a duplicate deal on the same person within 5 minutes, and archives the source lead atomically. The LLM's job is to call the helper; the helper guarantees the result.
- **Deal-centric mental model.** Pipedrive treats the deal as the unit of value. The bots internalize this — every action ties back to moving a deal forward.
- **Natural language communication.** Bots talk like salespeople, not systems. No raw JSON, webhook payloads, or internal IDs in group messages or CRM notes. A server-side sanitizer strips markdown tables, bold, and emoji from bot outputs before posting them to the group, and truncates verbose "thinking out loud" responses to their final summary line.
- **Clear ownership boundaries.** Lux owns leads. Taro owns deals. Zeno oversees. Each bot's SKILL.md has explicit "not yours" sections that make handoff behavior deterministic. Lane violations (e.g., Taro writing a note on a lead) are detected by the Layer-2 compliance diagnostic.
- **Three-layer testing.** Layer 1: 25 pytest integration tests for the helpers, run against a real Pipedrive account. Layer 2: `scripts/check-bot-compliance.py` audits recent bot activity against the rulebook. Layer 3: `scripts/create-smoke-lead.sh` runs an end-to-end fixture that exercises the full Hot-lead pipeline.
- **Activity-based selling.** Bots focus on scheduling and completing next actions (calls, site visits, proposal reviews) rather than passively updating statuses. A deal with no open activity is a stuck deal.

## The Company

NordLight Solar Solutions OÜ is a fictional Estonian solar energy company based in Tallinn. 15 employees, €1.8M annual revenue, installs photovoltaic systems for residential homes (€7K–18K) and commercial properties (€20K–80K) across Tallinn, Tartu, Pärnu, and surrounding counties.

The company profile provides realistic customer personas, a 7-stage sales pipeline, seasonal patterns, and detailed metrics (35-day residential sales cycle, 22% lead-to-close conversion). This grounds bot behavior in plausible sales dynamics.

Full profile: [`docs/nordlight-solar-profile.md`](docs/nordlight-solar-profile.md)

## How It Works — a Hot lead end to end

1. **Lead enters Pipedrive** — via the UI, the admin API, or Lux herself when running in proactive mode.
2. **Webhooks fire** — Pipedrive emits `added.person` and `added.lead` events within ~250ms of each other.
3. **Router routes** — `routing.yaml` maps both events to Lux. The rollup dedupe blocks the second event (same `person_id` within 90s) to prevent parallel racing sessions.
4. **Lux qualifies** — reads the lead, consults `bots/shared/pipedrive/lead-lifecycle.md` for the scoring rubric, scores 0–100, labels Hot/Warm/Cold, writes a `pd-note` with the rationale.
5. **Hot path** — Lux runs `pd-convert-lead` which atomically creates a deal in Qualified, links person and activity, and archives the source lead. She posts `Mari Tamm, Pirita — Hot 88, deal #100, over to Taro.` to the group and calls `/trigger` to wake Taro.
6. **Taro picks up** — reads the deal, runs discovery, schedules a site visit activity, advances the stage to Site Visit Scheduled, posts `Deal #100 — Mari Tamm, Pirita. Site visit booked Apr 9, 10:00.`
7. **Deal progression continues** — Taro drives the deal through the remaining stages, generating proposals, handling negotiation, and eventually closing (won) or losing with documented reasons.

Zeno watches the pipeline in the background, nudges stuck deals on his 20-minute heartbeat, and escalates deals over €40K at Negotiation.

## Prerequisites

- **Pipedrive** account with API access (three bot user accounts + one admin)
- **Telegram** — 3 bot tokens via BotFather, plus a shared group
- **OpenShell** (0.0.22+) — sandboxed runtime for each bot, runs on a single Colima VM on the host
- **Tailscale** — Funnel for public HTTPS webhook ingress from Pipedrive
- **Anthropic API key** — powers the bot reasoning (Claude Sonnet)
- Mac Mini (Apple Silicon) or Linux host machine

## Quick Start

```bash
# 1. Clone
git clone https://github.com/kristjanelias-xtian/digital-pd-team.git
cd digital-pd-team

# 2. Configure credentials
cp webhook-server/.env.example webhook-server/.env
# Edit webhook-server/.env with your Telegram/gateway tokens
# Create docs/pipedrive-ids.md from any template you have with PD IDs + tokens
# Create bots/<bot>/openclaw.json and auth-profiles.json for each bot (gitignored)

# 3. Start the webhook relay
cd webhook-server && npm install && nohup node server.js > server.log 2>&1 & disown
cd ..

# 4. Deploy the bots (creates sandboxes, uploads config, starts gateways)
./bots/lux/restore.sh
./bots/taro/restore.sh
./bots/zeno/restore.sh

# 5. Push skills, reference docs, and helpers
deploy-skill.sh all
```

For the full setup walkthrough (Cloudflare email routing, PD user setup, BotFather configuration, Tailscale Funnel, OpenShell sandbox provisioning), see [`SETUP.md`](SETUP.md).

For the canonical test fixture to verify everything works end to end:

```bash
./scripts/create-smoke-lead.sh
# Watch webhook-server/logs/events-$(date +%Y-%m-%d).jsonl and the Telegram group.
# Expected: Lux posts a Hot verdict line, Taro picks up and schedules a site visit.
```

## Project Structure

```
digital-pd-team/
├── README.md                              ← This file
├── CLAUDE.md                              ← Day-to-day runbook and conventions
├── SETUP.md                               ← Initial setup walkthrough
├── bots/
│   ├── ROLES.md                           ← Role registry (source of truth)
│   ├── TEMPLATE/                          ← Copy to add a new bot
│   ├── shared/
│   │   ├── rulebook-base.md               ← Non-negotiables every bot inherits
│   │   ├── handoffs.md                    ← Handoff protocol
│   │   ├── pipedrive/                     ← On-demand reference docs
│   │   │   ├── README.md                  ← Index
│   │   │   ├── mental-model.md
│   │   │   ├── notes-guide.md
│   │   │   ├── lead-lifecycle.md          ← ICP scoring rubric
│   │   │   ├── deal-lifecycle.md          ← 7-stage pipeline
│   │   │   ├── custom-fields.md
│   │   │   ├── account-anchors.md
│   │   │   └── api-conventions.md
│   │   └── helpers/                       ← Python pd-* CLIs + tests
│   │       ├── pd-search
│   │       ├── pd-find-or-create-person
│   │       ├── pd-find-or-create-org
│   │       ├── pd-new-lead
│   │       ├── pd-new-deal
│   │       ├── pd-note
│   │       ├── pd-advance-stage
│   │       ├── pd-convert-lead
│   │       ├── lib/
│   │       └── tests/                     ← 25 pytest integration tests
│   ├── lux/                               ← SDR
│   │   ├── IDENTITY.md                    ← Personality (~20 lines)
│   │   ├── SKILL.md                       ← Role rulebook (~45 lines)
│   │   ├── openclaw.json                  ← Gateway config (gitignored)
│   │   ├── policy.yaml                    ← Network policy
│   │   ├── auth-profiles.json             (gitignored)
│   │   ├── restore.sh                     ← Thin wrapper → restore-bot.sh
│   │   └── credentials/                   (gitignored)
│   ├── taro/                              ← Account Executive (same shape)
│   └── zeno/                              ← Sales Manager (same shape)
├── webhook-server/
│   ├── server.js                          ← Router + sanitizer (~400 lines)
│   ├── router.js                          ← routing.yaml loader + resolveRoute
│   ├── routing.yaml                       ← Event → bot route table
│   ├── logs/                              ← Event audit log (gitignored)
│   ├── package.json
│   └── .env                               (gitignored)
├── docs/
│   ├── architecture.md                    ← Deep technical reference
│   ├── iteration-playbook.md              ← Bot behavior tuning cycle
│   ├── demo-scenario.md                   ← 10-min team demo runbook
│   ├── new-bot-checklist.md               ← 10-phase new-bot setup
│   ├── nordlight-solar-profile.md         ← Company profile
│   ├── two-ways-to-build-crm-agents.md    ← Essay: this vs. pipeagent
│   └── pipedrive-ids.md                   (gitignored)
├── scripts/
│   ├── check-bot-compliance.py            ← Layer-2 compliance diagnostic
│   ├── create-smoke-lead.sh               ← Layer-3 smoke test fixture
│   └── wipe-pipedrive.sh                  ← Nuclear reset (all PD data)
├── hooks/
│   └── post-restart.sh                    ← Webhook server restart hook
└── backups/                               ← Sandbox state snapshots (gitignored)
```

Shared infrastructure scripts (`restore-bot.sh`, `deploy-skill.sh`, `backup-bot.sh`, `restore-state.sh`, `restart-all.sh`, `check-services.sh`, `upgrade-openshell.sh`) live in a sibling `openshell-tools` repo and are on PATH. They manage OpenShell sandbox lifecycle and are shared with the sibling `home-ai` project that runs on the same Colima VM.

## Documentation

| Document | Description |
|----------|-------------|
| [`CLAUDE.md`](CLAUDE.md) | Day-to-day runbook: operating the bots, gotchas, Colima recovery, bot deployment matrix |
| [`docs/architecture.md`](docs/architecture.md) | Deep technical reference — system overview, design philosophy, bot architecture, communication, PD integration, deployment, security, testing strategy |
| [`docs/iteration-playbook.md`](docs/iteration-playbook.md) | Methodology for tuning bot behavior when drift appears — the fix → clean-slate → smoke → observe cycle |
| [`docs/demo-scenario.md`](docs/demo-scenario.md) | 10-minute live walkthrough script for showing the team to colleagues |
| [`docs/new-bot-checklist.md`](docs/new-bot-checklist.md) | 10-phase runbook for adding a new sales role (Cloudflare email → PD user → Telegram → sandbox → smoke) |
| [`bots/ROLES.md`](bots/ROLES.md) | Role registry — the employee handbook. One row per built or reserved role. |
| [`docs/nordlight-solar-profile.md`](docs/nordlight-solar-profile.md) | Fictional company profile (loaded into each bot's workspace) |
| [`docs/two-ways-to-build-crm-agents.md`](docs/two-ways-to-build-crm-agents.md) | Companion essay comparing this repo to the LangGraph-based sibling `pipeagent` |
| [`SETUP.md`](SETUP.md) | Step-by-step initial setup (infrastructure, credentials, first deploy) |

## Built With

- [Claude](https://www.anthropic.com/claude) (Anthropic) — bot reasoning engine (Sonnet 4.5/4.6)
- [OpenShell](https://openshell.sh) / OpenClaw — sandboxed agent runtime, network policy enforcement
- [Pipedrive](https://www.pipedrive.com) — CRM platform
- [Telegram Bot API](https://core.telegram.org/bots/api) — shared team chat + human visibility
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) — public HTTPS webhook ingress
- [Node.js](https://nodejs.org) / [Express](https://expressjs.com) — webhook router and relay (`webhook-server/`)
- Python 3.10+ — `pd-*` helper CLIs and the Layer-2 compliance diagnostic

## Related Projects

- **`pipeagent`** — sibling repo, same problem with a LangGraph/Hono architecture. Sees Claude as a function inside a compiled pipeline; this repo sees Claude as an employee inside a runtime. See [`docs/two-ways-to-build-crm-agents.md`](docs/two-ways-to-build-crm-agents.md) for the comparison.
- **`home-ai`** — sibling repo, personal home assistants running on the same shared OpenShell gateway as this project.
- **`openshell-tools`** — sibling repo providing the shared sandbox management scripts (`restore-bot.sh`, `deploy-skill.sh`, etc.) used by both `digital-pd-team` and `home-ai`.

## License

MIT
