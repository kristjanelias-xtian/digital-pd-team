# Digital PD Team

A simulated AI sales workforce for Pipedrive, playing out NordLight Solar Solutions' sales operations with three AI bots running in OpenShell sandboxes.

## ⚠ Outstanding work — Task 25 (24-hour Layer-2 compliance check)

The 2026-04-05 bot redesign (branch `refactor/pd-bots-redesign`, now merged to main) completed Phases A and B and the Phase C doc work, but Task 25 — the 24-hour real-data compliance observation — was **deferred** because it requires wall-clock time the tuning session could not spend. This needs to be run before the redesign is fully signed off.

**What to do (runbook):**

1. Enable Lux's proactive mode via Telegram DM:
   ```
   go proactive
   ```
   She will start auto-qualifying leads on her 20-minute heartbeat.
2. Let the team run for **24 hours**. Taro picks up any conversions; Zeno observes.
3. Run the compliance diagnostic:
   ```bash
   TOKEN=$(grep "Joonas (Admin)" docs/pipedrive-ids.md | head -1 | awk -F'|' '{print $3}' | tr -d ' \n\r\t')
   PD_ADMIN_TOKEN=$TOKEN ./scripts/check-bot-compliance.py --hours 24
   ```
4. **Pass thresholds:** note hygiene ≥ 95%, deal well-formedness 100%, lane violations 0, group message hygiene ≥ 95%. Exit code 0 = pass, 1 = fail.
5. **If FAIL:** the script prints which bot + which violation category. Tune via `docs/iteration-playbook.md` and re-run.
6. **If PASS:** the redesign is complete. Archive the branch pointer, nothing more to do.

**Context and known drift to expect:** see the session memory at `~/.claude/projects/-Users-kristjanelias-git-digital-pd-team/memory/project_task_25_deferred_tuning.md` — it lists the observed LLM drift categories from tuning iterations (scoring non-determinism, occasional verbose Taro messages) and the structural guardrails that should catch them (server-side sanitizer in `webhook-server/server.js`, race guard in `pd-convert-lead`, rollup dedupe in the webhook router).

Remove this section once Task 25 is verified passing.

> **Related repos** (all three work together on the same Mac Mini, sharing one OpenShell gateway):
> - `~/git/openshell-tools/` — Shared bash scripts for OpenShell sandbox management (on PATH). See its `CLAUDE.md` for conventions and gotchas.
> - `~/git/home-ai/` — Personal home assistants (alfred, luna) running on the same shared gateway.
> - `~/git/digital-pd-team/` — This repo (zeno, lux, taro for Pipedrive).
> - `~/git/pd-helpers/` — Shared Pipedrive data tooling (seed leads, wipe accounts, provision pipelines). Used by both this repo and `pipeagent`. Run via `pnpm dev:<cmd>` from that directory.
>
> **Shared tooling**: Common scripts (`backup-bot.sh`, `restore-bot.sh`, `restore-state.sh`, `deploy-skill.sh`, `kick-bot.sh`, `restart-all.sh`, `upgrade-openshell.sh`, `check-services.sh`) live in `~/git/openshell-tools/` and are on PATH. Commands are called without `./` prefix.
>
> **Rule — where code belongs**: New scripts for OpenShell infrastructure (sandbox management, gateway recovery, Colima/Docker operations, backup/restore, deployment) must go in `~/git/openshell-tools/`, not in this repo's `scripts/` directory. This repo's `scripts/` is only for project-specific tooling (e.g. Pipedrive data operations). After adding a script to openshell-tools, document it in that repo's `README.md` and reference it in the CLAUDE.md files of both this project and `~/git/home-ai/`.
>
> **Rule — shared gateway**: Both this project and `~/git/home-ai/` share a single OpenShell gateway. `restart-all.sh --gateway` and `upgrade-openshell.sh` destroy and recreate the shared gateway, which kills ALL sandboxes from both projects. After such an operation, you must restore bots from BOTH repos (run `restart-all.sh --skip-backup` from the second repo — no `--gateway` flag).

## Architecture

```
                     Pipedrive (nordlight-digital-pd-team.pipedrive.com)
                              │
                              │ webhooks (v2 format)
                              ▼
Tailscale Funnel ──→ webhook-server (Express, port 3000)
(<your-tailscale-hostname>)
                              │
                              │ Telegram DM to Zeno (instant wake-up)
                              ▼
                    ┌─── Zeno Bot ───┐
                    │  Sales Director │
                    │  Routes & Decides│
                    └───┬────────┬───┘
                        │        │
               group messages   group messages
                        │        │
                   ┌────▼──┐ ┌──▼────┐
                   │Lux Bot│ │Taro Bot│
                   │  SDR  │ │  AE    │
                   └───────┘ └────────┘

All bots communicate via "NordLight Sales" Telegram group.
All bots read/write Pipedrive via REST API with individual tokens.
All bots use Anthropic Claude Sonnet 4.6 for conversations, Ollama Qwen 3.5 9B for heartbeats.
```

## The Team

| Bot | Role | Telegram | PD User ID |
|-----|------|----------|------------|
| **Zeno Bot** | Sales Manager | @zeno_pd_bot | 25523746 |
| **Lux Bot** | SDR | @lux_pd_bot | 25523713 |
| **Taro Bot** | Account Executive | @taro_pd_bot | 25523724 |

> API tokens, Telegram bot tokens, and other credentials are stored in `docs/pipedrive-ids.md` (gitignored) and each bot's `openclaw.json` (gitignored).

## Documentation map

| I want to… | Read this |
|---|---|
| Understand the whole architecture | `docs/architecture.md` |
| Add a new bot (new role) | `docs/new-bot-checklist.md` |
| Tune bot behavior (fix format drift, duplicate work, stuck flows) | `docs/iteration-playbook.md` |
| Demo the team to colleagues | `docs/demo-scenario.md` |
| Understand what each bot owns | `bots/ROLES.md` |
| Understand the deal mental model | `bots/shared/pipedrive/mental-model.md` |
| See the full scoring rubric / stage criteria | `bots/shared/pipedrive/lead-lifecycle.md`, `deal-lifecycle.md` |
| Recover from a Colima crash | "Colima VM Crash Recovery" section below |
| Day-to-day operations (restart, backup, deploy skills) | "Operating the Bots" section below |

## Key Conventions

### Bot Identity
- Bots use **"Bot" as a surname** — like Sherpa for Nepali people. "Zeno Bot", "Lux Bot", "Taro Bot".
- First names should feel digital/synthetic, not human names.

### Communication
- **All bot communication must be natural language** — like real salespeople talking.
- Never forward raw data, JSON, IDs, or webhook payloads to the group or Pipedrive notes.
- The webhook relay is the only thing that speaks in structured data, and only to Zeno's DM.
- **Bots trigger each other by name** — each bot only responds to group messages that mention them (by name, @username, or "Bot" suffix). This prevents all 3 from responding to every message.

### Leads vs Deals
- **Leads** live in the Pipedrive Leads Inbox — unqualified prospects. Lux works these.
- **Deals** live in the NordLight Solar pipeline — qualified opportunities. Taro works these.
- Lux qualifies leads (scoring 0-100), labels them Hot/Warm/Cold, converts Hot to deals.

### Webhook Flow
1. Pipedrive event fires → Tailscale Funnel → `webhook-server` on port 3000
2. `server.js` normalizes the payload, runs exact dedupe (eventKey+id, 15s), then rollup dedupe (target bot + person_id, 90s), then the `is_bot` creator filter
3. Looks up `routing.yaml` to find the owning bot (leads/persons/orgs → Lux, deals → Taro with Zeno cc on stage/status/value changes, deletes → Zeno)
4. Fire-and-forget dispatch to that bot's `/v1/responses` endpoint (10-min inner timeout); server responds 200 to PD in <50ms
5. Bot processes, calls `pd-*` helpers, posts a line to the group via its final response text (sanitized server-side: strips bold/tables/emoji, truncates to last line if >8 lines)
6. For Hot leads: Lux calls `POST /trigger` to wake Taro with the handoff payload

Zeno is **not** on the event path. He only sees deal cc's, deletes, and direct group mentions.

## Directory Structure

```
digital-pd-team/
├── CLAUDE.md                              ← This file
├── workspace-files.txt
├── hooks/
│   └── post-restart.sh
├── docs/
│   ├── architecture.md                    ← Deep technical reference
│   ├── iteration-playbook.md              ← Tuning cycle methodology
│   ├── demo-scenario.md                   ← 10-min team demo runbook
│   ├── new-bot-checklist.md               ← New-bot setup (10 phases)
│   ├── nordlight-solar-profile.md         ← Company profile (loaded into bots)
│   ├── two-ways-to-build-crm-agents.md    ← Essay: this vs. pipeagent
│   └── pipedrive-ids.md                   ← PD IDs (gitignored)
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
│   │       ├── lib/
│   │       └── tests/
│   ├── lux/
│   │   ├── IDENTITY.md                    ← Personality only (~20 lines)
│   │   ├── SKILL.md                       ← Thin role rulebook (~55 lines)
│   │   ├── openclaw.json
│   │   ├── policy.yaml
│   │   ├── auth-profiles.json             (gitignored)
│   │   ├── restore.sh
│   │   └── credentials/                   (gitignored)
│   ├── taro/                              (same shape)
│   └── zeno/                              (same shape)
├── backups/                               (gitignored)
├── webhook-server/
│   ├── server.js                          ← YAML-driven router
│   ├── router.js
│   ├── routing.yaml                       ← Event → bot route table
│   ├── logs/                              (gitignored)
│   │   └── events-<date>.jsonl
│   ├── package.json
│   └── .env                               (gitignored)
└── scripts/
    └── check-bot-compliance.py            ← Layer-2 diagnostic
```

## Config vs State — The Deployment Model

Bots have two categories of files. Understanding this is critical for safe deployments.

**Config (you push, lives in this repo):**
| File | Location in sandbox | What it does |
|------|-------------------|-------------|
| `openclaw.json` | `~/.openclaw/openclaw.json` | Model, channels, heartbeat, plugins |
| `IDENTITY.md` | `~/.openclaw/agents/main/agent/IDENTITY.md` | Personality and instructions |
| `SKILL.md` | `~/.agents/skills/main/SKILL.md` | Role rulebook and capabilities |
| `auth-profiles.json` | `~/.openclaw/agents/main/agent/auth-profiles.json` | API key references |
| `policy.yaml` | Set at sandbox creation | Network egress rules |
| `credentials/` | `~/.openclaw/credentials/` | Telegram allowFrom |

**State (bot creates, never overwrite):**
| File | Location in sandbox | What it does |
|------|-------------------|-------------|
| `SOUL.md` | `~/.openclaw/workspace/` | Bot's self-model — personality evolution |
| `USER.md` | `~/.openclaw/workspace/` | What the bot knows about users it talks to |
| `AGENTS.md` | `~/.openclaw/workspace/` | Bot's understanding of the team |
| `HEARTBEAT.md` | `~/.openclaw/workspace/` | Heartbeat task state |
| `TOOLS.md` | `~/.openclaw/workspace/` | Bot's learned tool usage patterns |
| `sessions/` | `~/.openclaw/agents/main/sessions/` | Conversation history (JSONL) |
| `telegram/` | `~/.openclaw/telegram/` | Update offsets (prevents reprocessing) |

**Rule: `deploy-skill.sh` only touches config. State files are never overwritten.**

### Pick the right tool

| What you want to do | Command | Restarts gateway? | Memory safe? |
|---|---|---|---|
| Push skill change for one bot | `deploy-skill.sh taro` | No | Yes |
| Push skills for all bots | `deploy-skill.sh all` | No | Yes |
| Full restore (config change) | `./bots/taro/restore.sh` | Yes | Yes* |
| Back up full sandbox state | `backup-bot.sh taro` | No | N/A |
| Restore memory from backup | `restore-state.sh taro` | No | Yes |
| Restart everything | `restart-all.sh` | Yes | Yes* |
| Restart everything + gateway | `restart-all.sh --gateway` | Yes (destroys sandboxes) | Yes** |
| Wipe all PD data | `./scripts/wipe-pipedrive.sh` | No | Yes |
| Wipe PD data + reset bots | `./scripts/wipe-pipedrive.sh --notify-bots` | No | Yes |
| Seed a test lead | `pnpm dev:seed --target digital-pd-team` (from `~/git/pd-helpers`) | No | Yes |
| Wipe seed data only | `pnpm dev:wipe --target digital-pd-team --confirm` (from `~/git/pd-helpers`) | No | Yes |
| Provision pipeline/fields | `pnpm dev:setup --target digital-pd-team` (from `~/git/pd-helpers`) | No | Yes |

\* Gateway restart is safe — workspace files persist on disk. `restore-bot.sh` (from openshell-tools) auto-backs up before restoring.

\** When `--gateway` destroys sandboxes, `restart-all.sh` automatically restores state from the backup it just made. The `hooks/post-restart.sh` hook is called to restart the webhook server.

### Typical workflow: editing a skill

```bash
# 1. Edit the skill locally
vim bots/taro/SKILL.md

# 2. Push it (no restart, no memory loss, takes ~2 seconds)
deploy-skill.sh taro

# 3. Bot picks up the new skill on its next interaction
```

### When you need a full restore

Full restore (`restore.sh`) is only needed when:
- Creating a new sandbox from scratch
- Changing `openclaw.json` (model, channels, heartbeat config)
- Changing `IDENTITY.md`
- Changing `auth-profiles.json`

```bash
# Back up first if the bot has been running and building state
backup-bot.sh taro
./bots/taro/restore.sh
```

### When a sandbox is destroyed

If a sandbox is destroyed (openshell upgrade, manual delete), all state is gone. Use the full cycle:

```bash
# One bot:
backup-bot.sh taro
./bots/taro/restore.sh            # Creates sandbox, uploads config, starts gateway
restore-state.sh taro              # Restores memory, offsets, sessions from backup

# All bots + gateway restart:
restart-all.sh --gateway           # Does everything: backup → destroy → recreate → restore → state
```

### Wiping Pipedrive data

To delete all sales data (deals, leads, activities, notes, persons, organizations), use the wipe script — **never delete PD data manually via API or MCP tools**.

```bash
# Preview what would be deleted
./scripts/wipe-pipedrive.sh --dry-run

# Wipe everything (prompts for confirmation)
./scripts/wipe-pipedrive.sh

# Wipe + tell all bots to forget their sales knowledge
./scripts/wipe-pipedrive.sh --notify-bots
```

The script uses the admin token, deletes in dependency order, handles batching and rate limits, and loops until the account is clean. Use `--notify-bots` to send a "fresh start" message to all 3 bots via the trigger relay.

### Seeding and wiping with pd-helpers

The `~/git/pd-helpers/` repo provides shared CLI tools for managing test data across Pipedrive accounts. All commands run from that directory via `pnpm dev:<cmd>`.

```bash
cd ~/git/pd-helpers

# Seed one random lead from the 20-item Estonian company pool
pnpm dev:seed --target digital-pd-team

# Seed a specific lead by slug
pnpm dev:seed --target digital-pd-team --name mari-tamm-pirita

# List the pool and which leads are already in use
pnpm dev:seed --target digital-pd-team --list

# Preview what would be deleted (seed-pool items only)
pnpm dev:wipe --target digital-pd-team --dry-run

# Wipe seed-pool data only (safe — leaves non-seed data)
pnpm dev:wipe --target digital-pd-team --confirm

# Wipe everything (deals, leads, persons, orgs, notes, activities)
pnpm dev:wipe --target digital-pd-team --full --confirm

# Provision pipeline, stages, custom fields (idempotent)
pnpm dev:setup --target digital-pd-team
```

Configuration is in `~/git/pd-helpers/.env` (needs `PD_DIGITAL_API_TOKEN` and `PD_DIGITAL_API_DOMAIN`).

## Operating the Bots

### Deploy skills (safe — no restart, no memory loss)
```bash
deploy-skill.sh taro                    # Push SKILL.md + shared helpers for taro
deploy-skill.sh all                     # Push SKILL.md + shared for all bots
```

### Back up a bot's full state
```bash
backup-bot.sh taro                      # → backups/taro/<timestamp>/
backup-bot.sh taro ./my-backups         # Custom backup dir
# Keeps timestamped snapshots, symlinks `latest`
```

### Scheduled daily backups
All running bots (from this repo AND `home-ai`) are backed up daily at 03:00 by
a launchd agent installed from `openshell-tools/launchd/`. Because the agent
uses `~/git/home-ai` as its working directory, snapshots for `zeno`, `lux`,
`taro` land in `~/git/home-ai/backups/<bot>/<timestamp>/` — not in this repo.
Currently accumulating indefinitely (no pruning). See
`openshell-tools/README.md` "Scheduled backups" for install, logs, and the
retention TODO.
```bash
launchctl start com.kristjan.backup-all-bots    # trigger a run now
launchctl list | grep backup-all-bots           # loaded + last exit status
```

### Start/Restart a bot (full restore)
```bash
./bots/zeno/restore.sh    # Creates sandbox if needed, uploads all config, starts gateway
./bots/lux/restore.sh
./bots/taro/restore.sh
```

### Check bot status
```bash
openshell sandbox list                    # All sandboxes
openshell logs <bot> --since 5m           # Proxy logs
curl -s http://localhost:3000/tunnel-status | python3 -m json.tool  # Relay tunnel health
```

### SSH into a bot
```bash
ssh -o "ProxyCommand=openshell ssh-proxy --gateway-name openshell --name <bot>" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    sandbox@openshell-<bot>

# Inside:
tail -f ~/.openclaw/gateway.log           # Application log
cat /tmp/openclaw/openclaw-*.log          # Detailed log (JSON)
openclaw config get channels.telegram     # Check telegram config
```

### Update network policy live
```bash
openshell policy set --policy bots/<bot>/policy.yaml <bot>
```

### Local model inference (Ollama)

Heartbeats use local Ollama (Qwen 3.5 9B) via `inference.local` to save API costs.
Conversations stay on Anthropic Claude Sonnet 4.6 (direct API, not through inference.local).

The `restore-bot.sh` script auto-detects `ollama-local` in `openclaw.json` and sets up
the gateway-level Ollama provider. No manual setup needed after a restore.

For full details on the local model setup, thinking mode gotchas, and tested approaches,
see `~/git/home-ai/docs/local-model-setup.md`.

```bash
# Verify inference.local points to Ollama
openshell inference get

# Manually set (normally done by restore-bot.sh)
openshell inference set --provider ollama --model "qwen3.5:9b" --no-verify
```

### Webhook server
```bash
cd webhook-server
npm install
node server.js                            # Or: nohup node server.js > server.log 2>&1 &
kill $(lsof -ti:3000)                     # Stop
```

### Tailscale Funnel
```bash
# On the Mac Mini:
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 3000

# Disable:
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
```

### Proactive mode (polling toggle)
Bots default to passive — only act on direct triggers. Toggle via Telegram group:
```
@taro_pd_bot go proactive     ← starts checking Pipedrive for unworked deals on heartbeats
@taro_pd_bot go passive       ← back to trigger-only mode
@lux_pd_bot go proactive      ← starts checking for unqualified leads
```
Zeno can also toggle them: "@taro_pd_bot go proactive"

### Webhook routing

Event → bot routing is declared in `webhook-server/routing.yaml`. To add a new routed event type:

1. Hit `GET /events/unrouted?since=7d` to confirm the event is actually flowing.
2. Add a route to `routing.yaml`.
3. Restart the webhook server: `kill $(lsof -ti:3000) && cd webhook-server && nohup node server.js > server.log 2>&1 &`.

Zeno is **not** the router. Events go directly to the role that owns them: leads/persons/orgs → Lux, deals → Taro (with Zeno cc'd on stage/status/value changes).

## Colima VM Crash Recovery

The Colima VM (Virtualization.framework on Apple Silicon) can silently die from macOS sleep/wake cycles. When this happens:

- The Lima host agent keeps running as a zombie (stale pid/socket files)
- Docker socket exists but daemon doesn't respond
- `openshell gateway start` fails with "Docker daemon is not responding"
- `colima start` refuses because it thinks the VM is already running

**Diagnosis:** `check-services.sh` detects zombie Colima, stale Docker, and broken SSH tunnels.

**Recovery (OpenShell 0.0.22+):** Try the minimal fix first — OpenShell 0.0.22 added persistent SSH handshake secrets (#488) and sandbox state persistence across stop/start cycles (#739), so the gateway should resume cleanly after a Colima restart:

```bash
# Step 1: Fix Colima (if VM is zombie)
colima stop --force && colima start

# Step 2: Start the gateway container (if not running)
docker start openshell-cluster-openshell   # or: openshell gateway start --name openshell

# Step 3: Verify SSH tunnels with check-services.sh
check-services.sh
```

**Recovery (fallback — if SSH tunnels are still broken):** Pre-0.0.22 behavior was that k3s TLS secrets became stale and required a full gateway destroy/recreate. If the minimal fix doesn't work on your version, fall back to:

```bash
# Backups will fail if SSH is broken — use --skip-backup with existing backups
restart-all.sh --gateway --skip-backup
# or, to also upgrade OpenShell:
upgrade-openshell.sh --skip-backup
```

## Gotchas & Learnings

### Telegram Group Config
- Use the `groups` object in openclaw.json, NOT `groupAllowFrom`:
  ```json
  "groups": { "<group-chat-id>": { "enabled": true, "requireMention": true } }
  ```
- `requireMention: true` so bots only respond when mentioned — prevents all 3 replying at once
- Add `mentionPatterns` in `messages.groupChat` so bots respond to their name, @username, or just first name:
  ```json
  "messages": { "groupChat": { "mentionPatterns": ["@?taro_pd_bot", "@?taro\\s*bot", "\\btaro\\b"] } }
  ```
- Bots must have privacy mode disabled in BotFather (`/setprivacy` → Disable)

### Bot-to-Bot Triggering
- **Telegram bots cannot see messages from other bots.** The group chat is for Kristjan's visibility only.
- The trigger relay (`POST /trigger`) is the actual delivery mechanism between bots.
- The relay waits for real delivery and returns honest status — `{"delivered":false}` means it didn't arrive.
- Add `?async=true` to the URL for fire-and-forget mode (legacy, not recommended).
- Check tunnel health: `GET /tunnel-status` returns which bot gateways are reachable.
- Zeno must mention other bots by name when delegating ("Lux, qualify this lead" or "@lux_pd_bot")
- Each bot's `mentionPatterns` match: `@username`, `Name Bot`, and just `Name`
- This way bots chain naturally: Zeno → Lux → Taro, each only responding when addressed

### Gateway Restart (Bot Gateway, Inside Sandbox)
- Always kill old processes before starting new ones — zombie node processes hold port 18789
- Use separate SSH commands for kill and start (don't chain with `;` or `&&` in one command)
- Pattern: kill → sleep 5 → clean locks → start
- `restore-bot.sh` handles this automatically (kills old gateway before starting new one)

### Gateway Restart (OpenShell Gateway, Host Level)
- `openshell gateway stop` + `openshell gateway start` — sometimes `start` doesn't actually restart after `stop`
- If `openshell status` shows "Connection refused" after stop+start: `openshell gateway destroy` + `openshell gateway start --name openshell`
- **Destroying the gateway destroys all sandboxes.** Always `backup-bot.sh` all bots first.
- After recreate: `restore-bot.sh` for each bot, then `restore-state.sh` to bring back memory (both from openshell-tools, on PATH).
- Full cycle: `backup-bot.sh` all → `gateway destroy` → `gateway start` → `restore-bot.sh` each → `restore-state.sh` each

### Sandbox Networking & DNS
- Sandboxes are **network-isolated** — all HTTP goes through a proxy at `10.200.0.1:3128`
- `HTTPS_PROXY` / `HTTP_PROXY` env vars are set automatically inside sandboxes
- **curl works** (uses the proxy) but **Node.js `dns.lookup()` fails** (tries cluster DNS directly at `10.43.0.10`, which is unreachable from the sandbox network namespace)
- Node.js `fetch()` works fine because it uses the proxy (which handles DNS)
- If bots log `getaddrinfo EAI_AGAIN`: this means the bot's tool is doing a raw DNS lookup instead of going through the proxy. A gateway restart usually fixes it.
- This is an OpenShell architecture constraint, not a bug — sandboxes are not supposed to have direct DNS access

### Anthropic API Credits
- All 3 bots share the same Anthropic API key — when credits run out, all bots fail simultaneously
- Error: `LLM request rejected: Your credit balance is too low to access the Anthropic API`
- Top up at console.anthropic.com — bots resume working immediately after

### Pipedrive Webhooks
- PD v2 webhooks use `{ meta, data, previous }` not `{ event, current, previous }`
- Event type is in `meta.action` and `meta.entity` (deal/person/etc)
- **PD sends `change` not `update`** as the action for updates — the webhook server maps both to `updated`
- Actions: `create`, `update`, `change`, `delete`, `merge` — all handled in `normalizePayload()`
- PD validates the webhook URL on creation — endpoint must be reachable

### Network Policy
- Both `api.pipedrive.com` and `nordlight-digital-pd-team.pipedrive.com` must be in policy.yaml
- All HTTPS endpoints need `tls: skip`
- Policies can be updated live with `openshell policy set`
- Local services (on host) are reachable at `192.168.5.2` from inside sandboxes

### Web Search
- Bots can use Anthropic's built-in `web_search` tool — no Brave API key needed
- Works natively with Claude Sonnet 4.6 through the Anthropic API
- If a bot claims it needs a Brave key, it's wrong — just tell it to use Anthropic web search

## Pipedrive Instance

- **URL**: nordlight-digital-pd-team.pipedrive.com
- **Pipeline**: NordLight Solar (ID: 2) with 7 stages
- **Admin token**: See `docs/pipedrive-ids.md` (gitignored)
- **Webhook**: All events → `https://<your-tailscale-hostname>/pd-webhook`
- See `docs/pipedrive-ids.md` for full ID reference (gitignored — create from template)

## Company Profile

NordLight Solar Solutions OÜ — fictional Estonian solar installer. Full profile in `docs/nordlight-solar-profile.md`. Key points:
- 15 employees, €1.8M revenue, based in Tallinn
- Residential (€7K–€18K) and commercial (€20K–€80K) installs
- Service area: Tallinn, Tartu, Pärnu, surrounding counties
- 20 test leads loaded in Leads Inbox with mixed qualification signals
