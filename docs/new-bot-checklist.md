# New Bot Checklist

Add a new sales role to the digital PD team. Ten phases, roughly an hour end-to-end once you've done it before. Work top to bottom.

## Phase 0 — Decide the role

- [ ] Pick the role name (industry-standard sales title: SDR, AE, CSM, AM, SE, RevOps, etc.).
- [ ] Pick the bot's first name (digital/synthetic — e.g. Nyx, Vera, Orin). Last name is always "Bot".
- [ ] Draft the row in `bots/ROLES.md` before writing any code. If you can't write a clean one-line job description, the role isn't clear enough to build.

## Phase 1 — Email (for the Pipedrive user account)

- [ ] In Cloudflare → Email Routing → Routes, add a custom address `<botname>@<yourdomain>` → forward to Kristjan's real inbox.
- [ ] Verify the route is active by sending a test mail from another account.

## Phase 2 — Pipedrive user

- [ ] PD → Settings → Manage Users → Add User. Name e.g. "Nyx Bot", email `<botname>@<yourdomain>`, role Regular User.
- [ ] Click the invite link in Kristjan's inbox, set a password, verify login.
- [ ] Personal Preferences → API → copy the API token.
- [ ] Note the user ID from the URL when viewing the user profile.
- [ ] Add to `docs/pipedrive-ids.md`: name, role, user ID, API token.

## Phase 3 — Telegram bot

- [ ] Open Telegram, message @BotFather.
- [ ] `/newbot` → name e.g. "Nyx Bot", username `nyx_pd_bot`.
- [ ] Copy the bot token.
- [ ] `/setprivacy` → select the new bot → **Disable**. Critical — bots with privacy mode on cannot see group messages.
- [ ] `/setdescription` → short description.
- [ ] Add @nyx_pd_bot to the NordLight Sales Telegram group, promote to admin.

## Phase 4 — Secrets & env

- [ ] In `webhook-server/.env`, add:
  ```
  NYX_TELEGRAM_BOT_TOKEN=<from BotFather>
  NYX_GATEWAY_PORT=18804   # next unused port
  ```
- [ ] In `docs/pipedrive-ids.md` (gitignored), add the PD token and user ID.
- [ ] Anthropic credits: no action needed — all bots share the same key.

## Phase 5 — Repo scaffolding

- [ ] `cp -r bots/TEMPLATE bots/nyx`
- [ ] Edit `bots/nyx/IDENTITY.md` — write the personality. Keep under 30 lines.
- [ ] Edit `bots/nyx/SKILL.md` — fill in role, scope, what-to-do-when-triggered, hard rules, references. Keep under 80 lines.
- [ ] Edit `bots/nyx/openclaw.json` — replace every REPLACE_WITH_* placeholder and the `{botfirstname}` mention patterns with real values.
- [ ] Create `bots/nyx/auth-profiles.json` from the `.example` file with the real API key reference.
- [ ] Edit `bots/nyx/restore.sh` — replace `{botname}` with `nyx`.
- [ ] `chmod +x bots/nyx/restore.sh`
- [ ] Update `bots/ROLES.md` with the finalized row.
- [ ] Update `CLAUDE.md` — add the bot to the Team table.

## Phase 6 — Webhook routing

- [ ] Decide which PD events should trigger this bot. For RevOps: maybe `deleted.*` and `updated.person` dedup signals. For CSM: `updated.deal` with stage transition to `won`.
- [ ] Add routes to `webhook-server/routing.yaml` pointing `to: nyx`. Use `cc:` if Zeno should still see things.
- [ ] Edit `webhook-server/server.js` — add `nyx` to the `BOTS` map with the port from Phase 4, and add the PD user ID to `BOT_USER_IDS`.
- [ ] Restart webhook server: `kill $(lsof -ti:3000) && cd webhook-server && nohup node server.js > server.log 2>&1 &`.

## Phase 7 — Sandbox creation

- [ ] `./bots/nyx/restore.sh` — creates the sandbox, uploads config, starts the gateway.
- [ ] `openshell sandbox list` — verify running.
- [ ] `curl -s http://localhost:3000/tunnel-status | python3 -m json.tool` — expect `nyx: up: true`.
- [ ] `deploy-skill.sh nyx` — pushes SKILL.md, shared references, and pd-* helpers.

## Phase 8 — Smoke test

- [ ] DM the bot: "introduce yourself in one sentence". Expect a short, in-character reply.
- [ ] Mention in the group: "@nyx_pd_bot what's in your inbox?" — expect a role-appropriate reply.
- [ ] Verify PD access: ask it to search for a known record. Expect a clean prose answer, not JSON.
- [ ] Trigger a routed event by creating a test record in PD. Watch `webhook-server/logs/events-<date>.jsonl` and the group — confirm it flowed.
- [ ] Verify loop prevention: the bot's own actions should show `is_bot: true` in the event log.
- [ ] `backup-bot.sh nyx` — baseline snapshot.

## Phase 9 — Document

- [ ] Commit everything under `bots/nyx/`, the `routing.yaml` changes, the `server.js` changes, the `CLAUDE.md` update, and the `ROLES.md` update as one commit: `Add <Role Name> bot: <bot name>`.
- [ ] If this bot introduces a new role type not previously in ROLES.md (e.g. first CSM), also add a short general description of the role for future CSMs.

## What's explicitly NOT in this checklist

- Writing the bot's personality and rulebook — creative work, separate brainstorming session.
- Testing the pd-* helpers — done once during the Phase A rollout, not per bot.
- Installing helpers — automatic via `deploy-skill.sh`.
