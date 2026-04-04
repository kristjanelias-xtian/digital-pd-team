# Digital PD Team

A simulated AI sales workforce for Pipedrive, playing out NordLight Solar Solutions' sales operations with three AI bots running in OpenShell sandboxes.

> **Shared tooling**: Common scripts (`backup-bot.sh`, `restore-bot.sh`, `restore-state.sh`, `deploy-skill.sh`, `restart-all.sh`) live in the [openshell-tools](~/git/openshell-tools/) repo and are on PATH. Commands are called without `./` prefix.

## Architecture

```
                     Pipedrive (xtian.pipedrive.com)
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
```

## The Team

| Bot | Role | Telegram | PD User ID |
|-----|------|----------|------------|
| **Zeno Bot** | Sales Director / Router | @zeno_pd_bot | 25475093 |
| **Lux Bot** | SDR / Lead Qualification | @lux_pd_bot | 25475071 |
| **Taro Bot** | Account Executive / Closer | @taro_pd_bot | 25475082 |

> API tokens, Telegram bot tokens, and other credentials are stored in `docs/pipedrive-ids.md` (gitignored) and each bot's `openclaw.json` (gitignored).

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
1. Pipedrive event fires → webhook hits Tailscale Funnel → relay server on port 3000
2. Relay formats a concise message → DMs Zeno via Telegram (you can mute this chat)
3. Zeno wakes up, processes the event, posts to the group in natural language
4. Other bots see group messages and act on their responsibilities

## Directory Structure

```
digital-pd-team/
├── CLAUDE.md                              ← This file
├── SETUP.md                               ← Step-by-step setup guide
├── workspace-files.txt                    ← Extra docs pushed into sandbox workspace
├── hooks/
│   └── post-restart.sh                    ← Post-restart hook: restart webhook server
├── NordLight_Solar_Company_Profile.docx   ← Source company profile
├── docs/
│   ├── nordlight-solar-profile.md         ← Company profile (markdown, loaded into bots)
│   └── pipedrive-ids.md                   ← All PD IDs: users, stages, fields, labels
├── bots/
│   ├── shared/                            ← Shared skill files pushed to all bots
│   │   └── pipedrive.md                   ← PD mental model, API conventions
│   ├── zeno/                              ← Sales Director / Router
│   │   ├── IDENTITY.md                    ← Config: personality (pushed by restore.sh)
│   │   ├── openclaw.json                  ← Config: model, channels (gitignored)
│   │   ├── policy.yaml                    ← Config: network egress rules
│   │   ├── auth-profiles.json             ← Config: API key refs (gitignored)
│   │   ├── restore.sh                     ← Thin wrapper → shared restore-bot.sh (on PATH)
│   │   ├── credentials/                   ← Config: Telegram allowFrom (gitignored)
│   │   └── skills/
│   │       └── pipedrive-router/SKILL.md  ← Config: pushed by deploy-skill.sh
│   ├── lux/                               ← SDR / Lead Qualification
│   │   ├── (same structure)
│   │   └── skills/
│   │       └── pipedrive-sdr/SKILL.md
│   └── taro/                              ← Account Executive / Closer
│       ├── (same structure)
│       └── skills/
│           └── pipedrive-ae/SKILL.md
├── backups/                               ← Sandbox state snapshots (gitignored)
│   └── <bot>/<timestamp>/.openclaw/       ← Full state: workspace, sessions, offsets
├── webhook-server/
│   ├── server.js                          ← Express relay: PD webhook → Zeno DM + trigger relay
│   ├── package.json
│   ├── .env                               ← Tokens (gitignored)
│   └── .env.example
└── scripts/                               ← (future automation scripts)
```

## Config vs State — The Deployment Model

Bots have two categories of files. Understanding this is critical for safe deployments.

**Config (you push, lives in this repo):**
| File | Location in sandbox | What it does |
|------|-------------------|-------------|
| `openclaw.json` | `~/.openclaw/openclaw.json` | Model, channels, heartbeat, plugins |
| `IDENTITY.md` | `~/.openclaw/agents/main/agent/IDENTITY.md` | Personality and instructions |
| `auth-profiles.json` | `~/.openclaw/agents/main/agent/auth-profiles.json` | API key references |
| `policy.yaml` | Set at sandbox creation | Network egress rules |
| `credentials/` | `~/.openclaw/credentials/` | Telegram allowFrom |
| `skills/*/SKILL.md` | `~/.agents/skills/*/SKILL.md` | Bot capabilities |

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
| Push a skill change | `deploy-skill.sh taro pipedrive-ae` | No | Yes |
| Push all skills to one bot | `deploy-skill.sh taro` | No | Yes |
| Push all skills to all bots | `deploy-skill.sh all` | No | Yes |
| Full restore (config change) | `./bots/taro/restore.sh` | Yes | Yes* |
| Back up full sandbox state | `backup-bot.sh taro` | No | N/A |
| Restore memory from backup | `restore-state.sh taro` | No | Yes |
| Restart everything | `restart-all.sh` | Yes | Yes* |
| Restart everything + gateway | `restart-all.sh --gateway` | Yes (destroys sandboxes) | Yes** |

\* Gateway restart is safe — workspace files persist on disk. `restore-bot.sh` (from openshell-tools) auto-backs up before restoring.

\** When `--gateway` destroys sandboxes, `restart-all.sh` automatically restores state from the backup it just made. The `hooks/post-restart.sh` hook is called to restart the webhook server.

### Typical workflow: editing a skill

```bash
# 1. Edit the skill locally
vim bots/taro/skills/pipedrive-ae/SKILL.md

# 2. Push it (no restart, no memory loss, takes ~2 seconds)
deploy-skill.sh taro pipedrive-ae

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

## Operating the Bots

### Deploy skills (safe — no restart, no memory loss)
```bash
deploy-skill.sh taro                    # Push all skills for taro
deploy-skill.sh taro pipedrive-ae       # Push only one skill
deploy-skill.sh all                     # Push all skills for all bots
```

### Back up a bot's full state
```bash
backup-bot.sh taro                      # → backups/taro/<timestamp>/
backup-bot.sh taro ./my-backups         # Custom backup dir
# Keeps timestamped snapshots, symlinks `latest`
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
- Both `api.pipedrive.com` and `xtian.pipedrive.com` must be in policy.yaml
- All HTTPS endpoints need `tls: skip`
- Policies can be updated live with `openshell policy set`
- Local services (on host) are reachable at `192.168.5.2` from inside sandboxes

### Web Search
- Bots can use Anthropic's built-in `web_search` tool — no Brave API key needed
- Works natively with Claude Sonnet 4.6 through the Anthropic API
- If a bot claims it needs a Brave key, it's wrong — just tell it to use Anthropic web search

## Pipedrive Instance

- **URL**: xtian.pipedrive.com
- **Pipeline**: NordLight Solar (ID: 3) with 7 stages
- **Admin token**: See `docs/pipedrive-ids.md` (gitignored)
- **Webhook**: All events → `https://<your-tailscale-hostname>/pd-webhook`
- See `docs/pipedrive-ids.md` for full ID reference (gitignored — create from template)

## Company Profile

NordLight Solar Solutions OÜ — fictional Estonian solar installer. Full profile in `docs/nordlight-solar-profile.md`. Key points:
- 15 employees, €1.8M revenue, based in Tallinn
- Residential (€7K–€18K) and commercial (€20K–€80K) installs
- Service area: Tallinn, Tartu, Pärnu, surrounding counties
- 20 test leads loaded in Leads Inbox with mixed qualification signals
