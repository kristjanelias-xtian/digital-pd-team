# Architecture: Digital PD Team

A deep technical reference for the Digital PD Team -- a multi-agent AI system that simulates a B2B sales team operating a Pipedrive CRM instance for a fictional Estonian solar company (NordLight Solar Solutions).

---

## 1. System Overview

Digital PD Team is three LLM-powered bots running in isolated sandboxes, collaborating through a shared Telegram group to operate a real Pipedrive CRM instance. Each bot plays a distinct sales role: director, SDR, and account executive. Together they simulate the full lifecycle of B2B solar sales -- from inbound lead to signed contract.

The system demonstrates autonomous multi-agent CRM operations: bots qualify leads, score prospects against an ideal customer profile, convert leads to deals, write proposals, generate mock sales call transcripts, and progress deals through a 7-stage pipeline. A human operator oversees the system through the same Telegram group and Pipedrive dashboard the bots use.

```
                        Pipedrive CRM
                    (xtian.pipedrive.com)
                            |
                            | v2 webhooks
                            v
  Tailscale Funnel --> webhook-server (Express, port 3000)
  (public HTTPS)            |
                            |--- DM to Zeno (event notifications)
                            |--- /trigger endpoint (bot-to-bot relay)
                            v
                  +--- Zeno Bot ---+
                  | Sales Director |
                  |  Routes work   |
                  +---+-------+----+
                      |       |
             @mention |       | @mention
             + relay  |       | + relay
                      v       v
                +-------+ +-------+
                |Lux Bot| |Taro Bot|
                |  SDR  | |  AE   |
                +-------+ +-------+

  All bots share a Telegram group ("NordLight Sales").
  All bots read/write Pipedrive via REST API with individual tokens.
  Each bot runs in an isolated OpenShell sandbox (Linux VM).
```

### The Team

| Bot       | Role                       | Owns                                    |
|-----------|----------------------------|------------------------------------------|
| Zeno Bot  | Sales Director / Router    | Webhook routing, pipeline oversight, escalation |
| Lux Bot   | SDR / Lead Qualification   | Leads Inbox, ICP scoring, lead-to-deal conversion |
| Taro Bot  | Account Executive / Closer | Pipeline deals, proposals, calls, closing |

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

Bots are not programmed with code. They are instructed with markdown documents (SKILL.md files) that teach them what to do, how to think, and when to act. Skills are the primary mechanism for shaping bot behavior -- they contain decision trees, scoring rubrics, communication examples, API patterns, and coordination protocols.

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
Bot = Identity + Skills + Shared Knowledge + Credentials + Network Policy

Identity (IDENTITY.md)
  Role description, personality, team context, decision logic overview

Skills (skills/<name>/SKILL.md)
  Detailed operational instructions -- scoring rubrics, API patterns,
  communication examples, handoff protocols

Shared Knowledge (shared/pipedrive.md)
  Mental model of Pipedrive, account anchors (pipeline IDs, stage IDs,
  label UUIDs, team user IDs), API conventions

Company Profile (nordlight-solar-profile.md)
  Product details, pricing, service area, value propositions

Credentials (openclaw.json, auth-profiles.json)
  Telegram bot token, Pipedrive API token, group chat ID
```

### Heartbeat cycle

Bots operate on 15-minute heartbeat cycles. Each heartbeat, a bot:

1. Checks for pending work (event queue, relay messages, stalled items)
2. Processes any assigned tasks
3. Monitors its domain for anomalies (stalled deals, overdue activities)
4. Reports status to the group when relevant

This is not a cron job -- it is a feature of the OpenClaw gateway runtime. Between heartbeats, bots wake instantly when triggered via Telegram DM or the trigger relay.

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

All three bots and the human operator share a single Telegram group ("NordLight Sales"). This is the observable workspace -- every assignment, qualification result, deal update, and celebration happens here.

### Selective triggering with mentionPatterns

Without controls, all three bots would respond to every message. The system uses two mechanisms to prevent this:

1. **requireMention: true** -- bots only process group messages that mention them
2. **mentionPatterns** -- regex patterns that define what counts as a mention

```
Zeno responds to: @zeno_pd_bot, "Zeno Bot", "Zeno", \bzeno\b
Lux responds to:  @lux_pd_bot, "Lux Bot", "Lux", \blux\b
Taro responds to: @taro_pd_bot, "Taro Bot", "Taro", \btaro\b
```

This creates a natural delegation chain: Zeno mentions Lux by name when assigning a lead, Lux mentions Taro when handing off a qualified deal, and each bot only activates when addressed.

### The bot-to-bot visibility problem

Telegram bots cannot see messages sent by other bots in a group chat (a platform restriction, even with privacy mode disabled). This means when Zeno posts "@lux_pd_bot, qualify this lead" to the group, Lux never receives that message through Telegram.

### Trigger relay

The trigger relay solves this. It is an HTTP endpoint on the webhook server that delivers messages directly to a bot's OpenClaw gateway:

```
POST http://192.168.5.2:3000/trigger
{
  "to": "lux",
  "from": "zeno",
  "message": "Hey @lux_pd_bot -- new lead: Eva Pirita, residential in Pirita..."
}
```

The relay:
1. Looks up the target bot's SSH tunnel port
2. POSTs the message to the bot's gateway `/v1/responses` endpoint
3. Waits for the bot's response
4. Posts the response back to the Telegram group using the target bot's token

Every bot-to-bot communication requires both actions:
- Post to the Telegram group (for human visibility)
- Call the trigger relay (for actual bot delivery)

### Handoff protocol

All bot-to-bot interactions follow a 3-step pattern:

```
1. TRIGGER  -- @mention the target bot with a clear task and all context
               (self-contained -- receiver should not need to look anything up)
2. ACK      -- Receiver confirms they are on it
3. RESULT   -- Receiver posts the outcome, tags whoever needs to know
```

### Timeout escalation

During each heartbeat, Zeno scans recent group conversation for triggers that have no acknowledgment. Unacked triggers get a follow-up ping. Persistent silence escalates to the human operator.

---

## 5. Pipedrive Integration

### Two-layer skill architecture

Pipedrive knowledge is split into two layers:

```
Layer 1: Shared Mental Model (bots/shared/pipedrive.md)
  - How Pipedrive thinks (deal-centric, activity-based)
  - Entity relationships (deal-as-hub pattern)
  - API conventions (auth, pagination, rate limits)
  - Account anchors (pipeline ID, stage IDs, user IDs, label UUIDs)

Layer 2: Role-Specific Skills (bots/<bot>/skills/<skill>/SKILL.md)
  - What endpoints this bot uses
  - Decision trees for this role
  - Read-only vs read-write access boundaries
  - Communication examples for this role's domain
```

Every bot loads the shared layer. This ensures consistent understanding of Pipedrive's data model across the team, while role-specific skills constrain what each bot actually does.

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

Pipedrive events flow through a multi-hop chain:

```
Step 1: Pipedrive fires a webhook (v2 format: { meta, data, previous })
        |
Step 2: HTTPS hits Tailscale Funnel (public endpoint)
        |
Step 3: Proxied to webhook-server (Express, port 3000 on host)
        |
Step 4: server.js normalizes the payload:
        - Extracts action (added/updated/deleted) and entity type
        - Formats a concise summary (human-readable, includes entity IDs)
        - Filters noise (skips notes to prevent loops)
        |
Step 5: Summary is DM'd to Zeno via Telegram Bot API
        |
Step 6: Zeno wakes up, reads the summary, decides what to do
        |
Step 7: Zeno posts to the group in natural language, triggering other bots
```

The relay only forwards actionable events: new deals, stage changes, deal won/lost, new leads, new contacts, completed activities. Notes are explicitly filtered to prevent feedback loops (bots create notes, which would trigger webhooks, which would notify bots).

### API access model

Each bot has its own Pipedrive API token with role-appropriate access:

| Bot  | Access Level | Can Do                                      |
|------|-------------|----------------------------------------------|
| Zeno | Read-only   | Read deals, leads, persons, pipeline status  |
| Lux  | Read-write  | Create/update leads, persons, orgs, notes    |
| Taro | Read-write  | Update deals, create activities, notes        |

Zeno is intentionally read-only -- he routes and monitors but never modifies CRM data. This prevents the director bot from doing the team's work.

---

## 6. The Sales Process

The system simulates NordLight Solar's complete B2B sales pipeline:

### Lead intake

Leads enter the Pipedrive Leads Inbox (manually or via the test dataset of 20 Estonian prospects). Pipedrive fires a webhook. The relay notifies Zeno. Zeno assigns the lead to Lux in the group.

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

### Deployment script (restore-bot.sh)

The shared `restore-bot.sh` script handles full bot deployment:

```
restore-bot.sh <bot-config-dir>
  |
  1. Back up credentials from existing sandbox (if running)
  2. Create sandbox if it doesn't exist (pulls ~1.3GB image)
  3. Upload openclaw.json (gateway config)
  4. Upload auth-profiles.json (API auth)
  5. Upload IDENTITY.md (bot personality and role)
  6. Upload shared knowledge (company profile, Pipedrive IDs)
  7. Upload shared skills (pipedrive.md)
  8. Upload role-specific skills (SKILL.md files)
  9. Upload credentials (Telegram allowFrom)
  10. Configure Anthropic provider and model
  11. Start the gateway process
  12. Verify gateway is running and Telegram is reachable
```

Each bot has a thin `restore.sh` wrapper that calls the shared script with its config directory:

```bash
./bots/zeno/restore.sh   # Equivalent to: ./restore-bot.sh ./bots/zeno
```

### Live updates

Skills and policies can be updated without restarting the bot:

```bash
# Update a skill
cat bots/lux/skills/pipedrive-sdr/SKILL.md | ssh sandbox@openshell-lux \
  "cat > ~/.agents/skills/pipedrive-sdr/SKILL.md"

# Update network policy
openshell policy set --policy bots/zeno/policy.yaml zeno
```

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
  - xtian.pipedrive.com:443     (Pipedrive instance)
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

Each bot has only the API access its role requires:

- Zeno (director): Read-only Pipedrive access. Cannot create or modify any CRM records.
- Lux (SDR): Read-write access to leads, persons, organizations, and notes. Cannot modify deals.
- Taro (AE): Read-write access to deals, activities, and notes. Does not work with raw leads.

This ensures a routing mistake or confused LLM reasoning cannot cause a bot to modify data outside its domain.

### Feedback loop prevention

The webhook relay explicitly filters note events to prevent infinite loops. Without this, the cycle would be: bot creates a note -> Pipedrive fires webhook -> relay notifies Zeno -> Zeno routes -> bot creates another note.

---

## Appendix: Directory Structure

```
digital-pd-team/
|-- CLAUDE.md                                 Project overview and conventions
|-- SETUP.md                                  Step-by-step setup guide
|-- restore-bot.sh                            Shared bot deployment script
|-- docs/
|   |-- architecture.md                       This document
|   |-- nordlight-solar-profile.md            Company profile (loaded into bots)
|   +-- pipedrive-ids.md                      Account IDs reference (gitignored)
|-- bots/
|   |-- shared/
|   |   +-- pipedrive.md                      Shared Pipedrive mental model
|   |-- zeno/
|   |   |-- IDENTITY.md                       Bot personality and role
|   |   |-- openclaw.json                     Gateway config (gitignored)
|   |   |-- policy.yaml                       Network policy
|   |   |-- auth-profiles.json                API auth config (gitignored)
|   |   |-- restore.sh                        Thin wrapper -> restore-bot.sh
|   |   |-- credentials/                      Telegram auth (gitignored)
|   |   +-- skills/
|   |       +-- pipedrive-router/SKILL.md     Routing and oversight instructions
|   |-- lux/
|   |   +-- skills/
|   |       +-- pipedrive-sdr/SKILL.md        Lead qualification instructions
|   +-- taro/
|       +-- skills/
|           +-- pipedrive-ae/SKILL.md         Deal progression instructions
+-- webhook-server/
    |-- server.js                             Express relay server
    |-- package.json
    |-- .env                                  Credentials (gitignored)
    +-- .env.example                          Template for required variables
```
