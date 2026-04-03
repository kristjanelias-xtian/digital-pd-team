# Digital PD Team

A simulated AI sales workforce for Pipedrive -- three Claude-powered bots operating as a coordinated sales team.

## What Is This?

Digital PD Team is a multi-agent system where three AI bots run a complete sales operation inside Pipedrive CRM. Each bot has a distinct role -- Sales Director, SDR, and Account Executive -- and they communicate through a shared Telegram group, just like a real sales team would. The bots qualify leads, progress deals through pipeline stages, generate proposals, and coordinate handoffs, all in natural language.

The system operates against a fictional company, NordLight Solar Solutions, an Estonian solar installer. This gives the bots a realistic product catalog, customer personas, pricing structure, and sales cycle to work with. Twenty test leads with mixed qualification signals are loaded into the Pipedrive Leads Inbox, providing immediate material for the bots to process.

This is a reference implementation for anyone exploring multi-agent CRM automation -- how to decompose sales workflows into agent responsibilities, how to handle inter-agent communication, and how to keep AI agents grounded in a real system of record.

## The Team

| Bot | Role | What They Do |
|-----|------|--------------|
| **Zeno Bot** | Sales Director | Routes webhook events, oversees pipeline health, coordinates the team, escalates large deals |
| **Lux Bot** | SDR | Qualifies inbound leads against ICP, scores 0-100, researches prospects, hands off to Taro |
| **Taro Bot** | Account Executive | Drives deals from Qualified to Contract Signed -- site visits, proposals, negotiation, closing |

Each bot runs in its own sandboxed environment with a dedicated Pipedrive API token and Telegram identity.

## Architecture

```
                     Pipedrive CRM
                          |
                          | webhooks (v2 format)
                          v
Tailscale Funnel --> webhook-server (Express, port 3000)
(<your-tailscale-hostname>)
                          |
                          | Telegram DM (instant wake-up)
                          v
                  +--- Zeno Bot ---+
                  | Sales Director  |
                  | Routes & Decides|
                  +---+--------+---+
                      |        |
             group messages   group messages
                      |        |
                 +----v--+ +--v----+
                 |Lux Bot| |Taro Bot|
                 |  SDR  | |  AE    |
                 +-------+ +--------+
```

Pipedrive fires webhooks on every CRM event. A lightweight Express relay server receives them via Tailscale Funnel and sends a formatted summary to Zeno's Telegram DM. Zeno wakes up, interprets the event, and posts a natural-language directive to the shared Telegram group -- mentioning the appropriate bot by name. That bot picks up the task and acts on it.

All three bots read and write Pipedrive directly via the REST API. Telegram is for coordination, not data transfer.

## Key Design Principles

- **Deal-centric mental model.** Pipedrive treats the deal as the unit of value. The bots internalize this -- every action ties back to moving a deal forward.
- **Natural language communication.** Bots talk like salespeople, not systems. No raw JSON, webhook payloads, or internal IDs in group messages or CRM notes.
- **Clear ownership boundaries.** Lux owns leads. Taro owns deals. Zeno owns routing and oversight. No overlapping responsibilities.
- **Skill-based architecture.** Domain knowledge lives in SKILL.md files that can be updated without restarting a bot. Identity, skills, and configuration are cleanly separated.
- **Activity-based selling.** Bots focus on scheduling and completing next actions (calls, site visits, proposal reviews) rather than passively updating statuses.
- **Mention-based triggering.** Bots only respond to group messages that mention them by name, preventing all three from reacting to every message.

## The Company

NordLight Solar Solutions OU is a fictional Estonian solar energy company based in Tallinn, founded in 2019. It has 15 employees, generates EUR 1.8M in annual revenue, and installs photovoltaic systems for residential homes (EUR 7K-18K) and commercial properties (EUR 20K-80K) across Tallinn, Tartu, Parnu, and surrounding counties.

The company profile provides realistic customer personas (homeowners, property managers, small businesses, municipalities), a 7-stage sales pipeline, seasonal patterns (peak selling March-September), and detailed metrics (35-day residential sales cycle, 22% lead-to-close conversion rate). This grounding keeps the bots' behavior realistic and testable.

Full profile: [docs/nordlight-solar-profile.md](docs/nordlight-solar-profile.md)

## How It Works

1. **Leads enter Pipedrive** -- inbound inquiries land in the Leads Inbox
2. **Webhook fires** -- the relay server notifies Zeno via Telegram DM
3. **Zeno routes** -- posts to the group: "Lux, new lead from Tartu -- qualify this one"
4. **Lux qualifies** -- researches the prospect, scores against ICP (budget, authority, need, timeline, property), labels Hot/Warm/Cold
5. **Hot leads convert** -- Lux converts to a deal in the pipeline, hands off to Taro
6. **Taro drives the deal** -- schedules site visits, drafts proposals, handles negotiation
7. **Deal closes** -- moved to Contract Signed (won) or marked lost with documented reasons

## Prerequisites

- **Pipedrive** account with API access
- **Telegram** -- 3 bot tokens via BotFather, plus a shared group
- **OpenShell** account -- sandboxed runtime for each bot
- **Tailscale** -- Funnel for webhook ingress from Pipedrive
- **Anthropic API key** -- powers the bot intelligence
- Mac or Linux host machine

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-username/digital-pd-team.git
cd digital-pd-team

# 2. Configure credentials
cp webhook-server/.env.example webhook-server/.env
# Edit .env with your tokens (see SETUP.md for details)

# 3. Start the webhook relay
cd webhook-server && npm install && node server.js

# 4. Deploy the bots
./bots/zeno/restore.sh
./bots/lux/restore.sh
./bots/taro/restore.sh
```

For detailed setup including Pipedrive configuration, Telegram group setup, Tailscale Funnel, and OpenShell sandbox provisioning, see [SETUP.md](SETUP.md).

## Project Structure

```
digital-pd-team/
├── README.md                          # This file
├── CLAUDE.md                          # Development conventions and gotchas
├── SETUP.md                           # Step-by-step setup guide
├── restore-bot.sh                     # Shared bot restore/deploy script
├── bots/
│   ├── shared/
│   │   └── pipedrive.md               # Pipedrive mental model (loaded into all bots)
│   ├── zeno/                          # Sales Director
│   │   ├── IDENTITY.md                # Bot identity and role definition
│   │   ├── openclaw.json              # Runtime configuration
│   │   ├── policy.yaml                # Network access policy
│   │   ├── auth-profiles.json         # API authentication profiles
│   │   ├── restore.sh                 # Deploy script
│   │   ├── credentials/               # Telegram auth (gitignored)
│   │   └── skills/
│   │       └── pipedrive-router/      # Routing skill definition
│   ├── lux/                           # SDR (same structure)
│   │   └── skills/
│   │       └── pipedrive-sdr/         # Lead qualification skill
│   └── taro/                          # Account Executive (same structure)
│       └── skills/
│           └── pipedrive-ae/          # Deal progression skill
├── webhook-server/
│   ├── server.js                      # Express relay: Pipedrive -> Telegram
│   ├── package.json
│   ├── .env.example                   # Credential template
│   └── .env                           # Actual credentials (gitignored)
├── docs/
│   ├── nordlight-solar-profile.md     # Fictional company profile
│   └── pipedrive-ids.md               # CRM field/stage ID reference
└── scripts/                           # Automation scripts
```

## Documentation

| Document | Description |
|----------|-------------|
| [SETUP.md](SETUP.md) | Step-by-step setup and deployment guide |
| [CLAUDE.md](CLAUDE.md) | Development conventions, gotchas, and operational reference |
| [docs/nordlight-solar-profile.md](docs/nordlight-solar-profile.md) | NordLight Solar company profile and test data |
| [docs/pipedrive-ids.md](docs/pipedrive-ids.md) | Pipedrive field IDs, stage IDs, and label references |

## Built With

- [Claude](https://www.anthropic.com/claude) (Anthropic) -- bot intelligence
- [OpenShell](https://openshell.sh) / OpenClaw -- sandboxed agent runtime
- [Pipedrive](https://www.pipedrive.com) -- CRM platform
- [Telegram Bot API](https://core.telegram.org/bots/api) -- inter-agent communication
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) -- webhook ingress
- [Node.js](https://nodejs.org) / [Express](https://expressjs.com) -- webhook relay server

## License

MIT
