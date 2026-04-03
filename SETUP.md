# Digital PD Team — Setup Guide

A digital sales workforce for Pipedrive, simulating NordLight Solar Solutions' sales operations with AI bots.

## Architecture

```
Pipedrive (xtian.pipedrive.com)
    │
    │ webhooks (v2 format)
    ▼
Tailscale Funnel → webhook-server (Express, port 3000)
    │
    │ Telegram DM to Zeno (instant wake-up)
    ▼
Zeno Bot (Sales Director)  ──→  "NordLight Sales" Telegram Group
    │                                    │
    ├── routes to Lux Bot (SDR)          ├── Lux Bot
    └── routes to Taro Bot (AE)         ├── Taro Bot
                                         └── Kristjan (human boss)
```

Each bot runs in its own OpenShell sandbox with Pipedrive API access.

---

## Step 1: Create Telegram Bots

Talk to [@BotFather](https://t.me/BotFather) on Telegram and create 3 bots:

1. `/newbot` → Name: `Zeno Bot` → Username: e.g. `zeno_pd_bot`
2. `/newbot` → Name: `Lux Bot` → Username: e.g. `lux_pd_bot`
3. `/newbot` → Name: `Taro Bot` → Username: e.g. `taro_pd_bot`

**Important:** For each bot, disable privacy mode so they can see group messages:
- `/setprivacy` → select bot → `Disable`

Save each bot token.

### Current values

| Bot | Telegram Username | Token |
|-----|------------------|-------|
| Zeno Bot | @zeno_pd_bot | `<ZENO_TG_BOT_TOKEN>` |
| Lux Bot | @lux_pd_bot | `<LUX_TG_BOT_TOKEN>` |
| Taro Bot | @taro_pd_bot | `<TARO_TG_BOT_TOKEN>` |

### Create the Telegram Group

1. **DM each bot first** — send "hello" to each. New bots won't appear in search until you've started a conversation.
2. Create a new Telegram group (we called ours **"NordLight Sales"**)
3. Add all 3 bots + yourself
4. Send a message in the group
5. Get the group chat ID:
   - Visit `https://api.telegram.org/bot<ZENO_TOKEN>/getUpdates`
   - Find `"chat":{"id":<TG_GROUP_CHAT_ID>,...}` — the negative number is the group ID

**Current group ID:** `<TG_GROUP_CHAT_ID>`

---

## Step 2: Create Pipedrive Users

In your Pipedrive instance (xtian.pipedrive.com):

1. **Settings → Manage Users → Add User**
2. Create 3 users:

| Name | Email | PD User ID | API Token |
|------|-------|------------|-----------|
| Zeno Bot | zeno.bot@example.com | 25475093 | `<ZENO_PD_API_TOKEN>` |
| Lux Bot | lux.bot@example.com | 25475071 | `<LUX_PD_API_TOKEN>` |
| Taro Bot | taro.bot@example.com | 25475082 | `<TARO_PD_API_TOKEN>` |

**Note:** Each PD user has their own API token. Log in as each user → Settings → Personal Preferences → API to get it. The admin token (Joonas): `<ADMIN_PD_API_TOKEN>`

### Pipeline

Created via API. **NordLight Solar** (Pipeline ID: 3):

| Stage | ID | Probability |
|-------|----|-------------|
| New Lead | 11 | 0% |
| Qualified | 12 | 15% |
| Site Visit Scheduled | 13 | 30% |
| Proposal Sent | 14 | 50% |
| Negotiation | 15 | 70% |
| Verbal Agreement | 16 | 85% |
| Contract Signed | 17 | 100% |

### Lead Labels

| Label | ID | Color |
|-------|----|-------|
| Hot | 43b6da41-0a3f-49b3-8024-c09fd2708d02 | Red |
| Warm | fd40651a-b18b-4781-9ac7-de9ed226ad3b | Yellow |
| Cold | d0a616f6-603a-48e7-9620-03057cfe3648 | Blue |

### Custom Fields

See `docs/pipedrive-ids.md` for the full list of deal and person custom field keys.

---

## Step 3: Set Up Tailscale Funnel

On the **Mac Mini** (not MacBook — the webhook server runs on the Mini):

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 3000
```

**Current URL:** `https://<your-tailscale-hostname>/`

To disable:
```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
```

**Gotcha:** Tailscale Funnel works on the free Personal plan. The `tailscale` CLI is not in PATH on macOS — use the full path `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

---

## Step 4: Configure Pipedrive Webhooks

Register via API (already done):
```bash
curl -X POST "https://api.pipedrive.com/v1/webhooks?api_token=ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subscription_url": "https://<your-tailscale-hostname>/pd-webhook",
    "event_action": "*",
    "event_object": "*"
  }'
```

**Gotcha:** Pipedrive validates the URL on creation — the Funnel and webhook server must be running before you register the webhook.

**Gotcha:** PD v2 webhooks use `{ meta, data, previous }` format, not `{ event, current, previous }`. The event type is in `meta.action` (create/update/delete) and `meta.entity` (deal/person/lead/etc).

---

## Step 5: Start the Webhook Server

```bash
cd webhook-server
npm install
cp .env.example .env
# Edit .env with actual tokens

# Start (foreground)
node server.js

# Or background
nohup node server.js > server.log 2>&1 &
```

The `.env` file needs:
```
PORT=3000
ZENO_TELEGRAM_BOT_TOKEN=<ZENO_TG_BOT_TOKEN>
ZENO_DM_CHAT_ID=<KRISTJAN_TG_ID>
TELEGRAM_GROUP_ID=<TG_GROUP_CHAT_ID>
```

Test:
```bash
curl http://localhost:3000/health
```

---

## Step 6: Deploy the Bots

Make sure OpenShell gateway is running (via Colima):

```bash
./bots/zeno/restore.sh
./bots/lux/restore.sh
./bots/taro/restore.sh
```

Each `restore.sh` delegates to `restore-bot.sh` which:
- Creates the sandbox with network policy
- Uploads openclaw.json, auth-profiles, IDENTITY, skills, credentials
- Uploads NordLight company profile and PD IDs reference
- Configures the Anthropic inference provider
- Starts the OpenClaw gateway
- Verifies Telegram connectivity

### Pairing

Pre-seeded via `credentials/telegram-default-allowFrom.json` with Kristjan's Telegram ID (`<KRISTJAN_TG_ID>`). No manual pairing needed.

### Group Chat Access

The `openclaw.json` files include group configuration:
```json
"channels": {
  "telegram": {
    "groups": {
      "<TG_GROUP_CHAT_ID>": { "enabled": true, "requireMention": true }
    }
  }
},
"messages": {
  "groupChat": {
    "mentionPatterns": ["@?taro_pd_bot", "@?taro\\s*bot", "\\btaro\\b"]
  }
}
```

**Gotcha:** Must use `groups` object, NOT `groupAllowFrom`. The `groupAllowFrom` field does not work.

**Gotcha:** `requireMention: true` + `mentionPatterns` is the right combo. Without `requireMention`, all 3 bots respond to every message (chaos). Without `mentionPatterns`, bots can only detect Telegram entity mentions (which other bots can't create). The patterns let bots detect their name in plain text — so when Zeno writes "Lux, qualify this lead", Lux picks it up.

### Gateway Restart Gotcha

When restarting a bot's gateway, zombie node processes can hold port 18789. Always:
1. Kill in a separate SSH command: `pkill -9 -f openclaw; pkill -9 -f node`
2. Wait: `sleep 5`
3. Clean locks: `rm -f ~/.openclaw/gateway.lock ~/.openclaw/.gateway.lock`
4. Start in a separate SSH command: `nohup openclaw gateway run > ~/.openclaw/gateway.log 2>&1 &`

Never chain kill + start in one SSH command.

---

## Step 7: Test the Flow

1. Open the **NordLight Sales** Telegram group
2. Tell Zeno: "Hey Zeno, there are 20 leads in the inbox that need qualifying. Get Lux on it."
3. Zeno should check the PD leads inbox and start assigning to Lux
4. Lux qualifies leads (scores them 0-100 against NordLight's ICP)
5. Hot leads get converted to deals in the pipeline, assigned to Taro
6. Taro drives deals through stages with mock calls, proposals, etc.

Or create a new contact/deal in Pipedrive manually → webhook fires → Zeno gets DM'd → Zeno posts to group → team acts.

---

## File Structure

```
digital-pd-team/
├── CLAUDE.md                              ← Project guide for Claude Code
├── SETUP.md                               ← This file
├── restore-bot.sh                         ← Shared restore script
├── NordLight_Solar_Company_Profile.docx   ← Source company profile
├── NordLight_Test_Leads.csv               ← Source test leads
├── docs/
│   ├── nordlight-solar-profile.md         ← Company profile (markdown)
│   └── pipedrive-ids.md                   ← All PD IDs reference
├── bots/
│   ├── zeno/
│   │   ├── IDENTITY.md                    ← Sales Director persona
│   │   ├── openclaw.json                  ← Bot config (Telegram token, model, groups)
│   │   ├── policy.yaml                    ← Network egress rules
│   │   ├── auth-profiles.json             ← Anthropic API key
│   │   ├── restore.sh                     ← Wrapper → restore-bot.sh
│   │   ├── credentials/
│   │   │   └── telegram-default-allowFrom.json
│   │   └── skills/
│   │       └── pipedrive-router/SKILL.md
│   ├── lux/                               ← Same structure, SDR skills
│   └── taro/                              ← Same structure, AE skills
├── webhook-server/
│   ├── server.js                          ← PD webhook → Zeno DM relay
│   ├── package.json
│   ├── .env                               ← Secrets (gitignored)
│   └── .env.example
└── scripts/
```
