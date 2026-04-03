# Digital PD Team

A simulated AI sales workforce for Pipedrive, playing out NordLight Solar Solutions' sales operations with three AI bots running in OpenShell sandboxes.

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
├── restore-bot.sh                         ← Shared restore script (all bots delegate to this)
├── NordLight_Solar_Company_Profile.docx   ← Source company profile
├── docs/
│   ├── nordlight-solar-profile.md         ← Company profile (markdown, loaded into bots)
│   └── pipedrive-ids.md                   ← All PD IDs: users, stages, fields, labels
├── bots/
│   ├── zeno/                              ← Sales Director / Router
│   │   ├── IDENTITY.md
│   │   ├── openclaw.json
│   │   ├── policy.yaml
│   │   ├── auth-profiles.json
│   │   ├── restore.sh                     ← Thin wrapper → ../restore-bot.sh
│   │   ├── credentials/
│   │   │   └── telegram-default-allowFrom.json
│   │   └── skills/
│   │       └── pipedrive-router/SKILL.md
│   ├── lux/                               ← SDR / Lead Qualification
│   │   ├── (same structure)
│   │   └── skills/
│   │       └── pipedrive-sdr/SKILL.md
│   └── taro/                              ← Account Executive / Closer
│       ├── (same structure)
│       └── skills/
│           └── pipedrive-ae/SKILL.md
├── webhook-server/
│   ├── server.js                          ← Express relay: PD webhook → Zeno DM
│   ├── package.json
│   ├── .env                               ← Tokens (gitignored)
│   └── .env.example
└── scripts/                               ← (future automation scripts)
```

## Operating the Bots

### Start/Restart a bot
```bash
./bots/zeno/restore.sh    # Creates sandbox if needed, uploads all config, starts gateway
./bots/lux/restore.sh
./bots/taro/restore.sh
```

### Check bot status
```bash
openshell sandbox list                    # All sandboxes
openshell logs <bot> --since 5m           # Proxy logs
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

### Update a bot's skill without restart
```bash
cat bots/<bot>/skills/<skill>/SKILL.md | ssh -o "ProxyCommand=openshell ssh-proxy --gateway-name openshell --name <bot>" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    sandbox@openshell-<bot> "cat > ~/.agents/skills/<skill>/SKILL.md"
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
- Zeno must mention other bots by name when delegating ("Lux, qualify this lead" or "@lux_pd_bot")
- Each bot's `mentionPatterns` match: `@username`, `Name Bot`, and just `Name`
- This way bots chain naturally: Zeno → Lux → Taro, each only responding when addressed

### Gateway Restart
- Always kill old processes before starting new ones — zombie node processes hold port 18789
- Use separate SSH commands for kill and start (don't chain with `;` or `&&` in one command)
- Pattern: kill → sleep 5 → clean locks → start

### Pipedrive Webhooks
- PD v2 webhooks use `{ meta, data, previous }` not `{ event, current, previous }`
- Event type is in `meta.action` (create/update/delete) and `meta.entity` (deal/person/etc)
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
