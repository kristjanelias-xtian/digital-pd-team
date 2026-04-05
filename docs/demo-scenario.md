# Demo Scenario — Showing the Digital PD Team to Colleagues

A ~10-minute live walkthrough of the AI sales team. Designed to be watchable in a single screen-share session with a handful of observers.

**Audience:** technical colleagues curious about multi-agent systems, sales-ops people interested in CRM automation, or anyone who wants to see "three LLMs collaborating on a real CRM" in practice.

**Goal:** the audience leaves understanding (a) what each bot does, (b) how they coordinate, and (c) what the architecture looks like well enough to have a follow-up conversation. Not a sales pitch. A demonstration.

---

## Before the demo — 5-minute preflight

Run this 5 minutes before the audience joins. It's the same cycle from `docs/iteration-playbook.md`, condensed into a preflight.

```bash
cd ~/git/digital-pd-team

# 1. Verify infrastructure
openshell sandbox list          # expect alfred, luna, lux, taro, zeno all Ready
curl -s http://localhost:3000/tunnel-status | python3 -m json.tool  # expect healthy=true

# 2. Wipe any stale data from prior demos
kill $(lsof -ti:3000) 2>/dev/null; sleep 1
echo "yes" | ./scripts/wipe-pipedrive.sh | tail -3
cd webhook-server && nohup node server.js > server.log 2>&1 & disown
sleep 4
cd ..

# 3. Wipe bot workspace memories so the demo starts cold
for bot in lux taro zeno; do
  ssh -o "ProxyCommand=openshell ssh-proxy --gateway-name openshell --name $bot" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      sandbox@openshell-$bot bash << 'REMOTE' 2>&1 | grep -v Warning
pkill -f openclaw-gateway 2>/dev/null || true
sleep 3
rm -f ~/.openclaw/workspace/{SOUL,USER,AGENTS,HEARTBEAT,TOOLS}.md
rm -rf ~/.openclaw/workspace/memory
find ~/.openclaw/agents/main/sessions/ -type f -delete 2>/dev/null
rm -f ~/.openclaw/gateway.lock ~/.openclaw/.gateway.lock
nohup openclaw gateway run > ~/.openclaw/gateway.log 2>&1 &
disown
sleep 5
REMOTE
done
```

Open these windows and keep them visible during the demo:

1. **Telegram** — the "NordLight Sales" group chat, full screen on its own virtual desktop or second monitor. This is the *main stage*.
2. **Pipedrive web UI** — logged in as the admin (Joonas), with the Leads Inbox AND the NordLight Solar pipeline view both bookmarked. You'll switch between these mid-demo.
3. **Terminal** — running `tail -f webhook-server/logs/events-$(date +%Y-%m-%d).jsonl | jq .` for live event visibility. Keep it on a side monitor; it's the "peek behind the curtain" window for technical questions.

---

## Act 1 — Introduce the team (2 minutes)

Open with the story, not the architecture. This is NordLight Solar, a small Estonian solar installer. They have three AI "employees": Lux the SDR, Taro the Account Executive, Zeno the Sales Manager. They all share one Telegram group and one Pipedrive CRM. The humans in the room (Kristjan, you, your colleagues) can message them and watch them work.

**Show:** switch to the Telegram group. Say: "I'll DM each bot to introduce themselves."

DM each bot in turn (in Telegram private chats, not the group — this is a sanity check AND a warm-up):

> `introduce yourself in one sentence`

Expected replies (examples, they'll vary):
- **Lux:** *"Hi — Lux Bot, SDR at NordLight Solar. I qualify inbound leads and convert the hot ones into deals for Taro."*
- **Taro:** *"Taro Bot, Account Executive at NordLight. I take qualified deals through discovery, site visits, proposals, and closing."*
- **Zeno:** *"Zeno Bot, Sales Manager. I oversee the pipeline, coach the team, and escalate big or stuck deals to Kristjan."*

**Talking points while the messages come in:**

- Each bot is an LLM (Claude Sonnet) running in an isolated Linux sandbox. They don't share memory; they coordinate entirely through this Telegram group and a trigger relay.
- Roles are enforced by markdown instruction files (SKILL.md), not code. Zeno physically cannot create a deal because his rulebook forbids it and his tools aren't wired for it.
- The "Bot" surname is on purpose — like "Sherpa" for Nepali people, it's a cultural signal, not an apology. Lux is proud to be Lux Bot.

Show `bots/ROLES.md` briefly as the "employee handbook" if the audience is technical.

---

## Act 2 — A hot lead comes in (4 minutes)

This is the main demo. A realistic prospect shows up in Pipedrive. We watch all three bots react without touching anything else.

**Switch to Pipedrive UI.** Open the Leads Inbox.

Option A — **manual creation (most dramatic):** create the person and lead by hand in the UI while the audience watches. The CRM feels real, the webhook path feels real. Takes ~90 seconds of clicks.

Option B — **scripted creation (faster, identical result):** run `./scripts/create-smoke-lead.sh` in the terminal window. Same fixture, same outcome, ~5 seconds. Good if you want more time for talking.

Either way, create this fixture:

**Person:** Mari Tamm · `mari.tamm@example.ee` · `+372 5555 0142`

**Lead:** "Pirita residential — 8 kW rooftop install" · €12,000 · linked to Mari

**Note on the lead** (the qualification signals — this is what Lux reads to score):
> *"Spoke with Mari, the homeowner in Pirita. 180 m² detached house, south-facing gable roof, wants an 8 kW system. Budget ~€12K, wants installation before June. Decision-maker is present (her and her husband together). Current electricity bill ~€240/month."*

**Switch to Telegram.** Nothing happens for 30-60 seconds. This is expected — the bots are reading the lead, consulting their scoring rubric, writing a qualification note, labeling the lead Hot, running `pd-convert-lead`, and waking Taro via the trigger relay. All silently.

**Talking points to fill the silence:**

- The bots aren't polling. Pipedrive fires a webhook; the webhook server looks up the route in `routing.yaml` and wakes Lux. Lux was idle until that moment.
- There's a deliberate deduplication layer: Pipedrive fires both `added.person` and `added.lead` events within 250ms of the API call, and without deduping we'd spawn two parallel Lux sessions that race each other. One of the first iterations of the team produced 2 deals per lead. Took ~3 tuning cycles to fix.
- Each bot only has read/write access to the parts of Pipedrive its role needs. Lux touches leads and persons; Taro touches deals; Zeno is read-only on the whole pipeline. Guardrails in the API access, not just in the prompt.

**When Lux posts**, it should look like one line:

> *"Mari Tamm, Pirita — Hot 88, deal #100, over to Taro."*

Read it out loud to the audience. Point out: one sentence, no emoji, no markdown formatting, no "let me think out loud about the scoring rubric". That's the result of enforcing `≤8 lines, plain prose, zero emoji` as rule 0 in the base rulebook — combined with a server-side guardrail that truncates verbose responses if a bot drifts.

Switch to the Pipedrive pipeline view. Show the new deal (#100) in the **Qualified** stage with Lux as the creator. Click into it — there's a qualification note, a linked person, and an activity scheduled.

**30-60 seconds later, Taro posts.** Something like:

> *"Deal #100 — Mari Tamm, Pirita. Site visit booked Apr 9, 10:00."*

**Switch back to Pipedrive.** Click into the deal. Show that:
- Stage is now **Site Visit Scheduled** (Taro advanced it).
- There's a new activity: "Site visit — Mari Tamm, Pirita" scheduled for Apr 9.
- There's a note from Taro with his discovery read: budget math, roof considerations, timeline risk, anything concrete that came out of his "thinking".

Point out: Lux's handoff was a *sentence* in the group, but behind that sentence was a tool call to the trigger relay that woke Taro with Lux's context. Taro didn't see Lux's Telegram message directly (Telegram bots can't see each other's messages) — the relay is how they actually coordinate.

---

## Act 3 — Peek behind the curtain (3 minutes)

This is for the technical portion of the audience. Optional if your viewers are non-technical or short on time.

**Switch to the terminal** running `tail -f` on the event log.

Show the event stream. Each line is a Pipedrive webhook the router saw, with routing decision. Look for:

- `added.person` and `added.lead` both arriving within ~250ms, one routed to lux and one marked `skip_reason: dedupe` or `rolled_up`.
- `updated.lead` events where Lux labeled the lead, all showing `is_bot: true, skip_reason: skip_if_bot_creator` — preventing Lux from re-triggering herself on her own writes.
- `added.deal` with Lux as creator, also filtered as bot.
- `group_message` entries from Lux and Taro with line counts.

Pull up `webhook-server/routing.yaml` in an editor or paste it into chat. Show: the routing is declarative. No code. Adding a new bot or a new event handler is a YAML edit plus a webhook server restart.

**Quick architecture points:**

- Three bots, three sandboxes, one shared webhook server on the host, one Tailscale Funnel for public HTTPS without port forwarding.
- Each bot's behavior is defined in three markdown files: `IDENTITY.md` (personality), `bots/shared/rulebook-base.md` (team-wide non-negotiables), and `bots/<bot>/SKILL.md` (role-specific playbook). At deploy time these three files are concatenated into the single file openclaw loads as the agent's system prompt. Prompt engineering, not code engineering.
- The CRM mutations all go through `pd-*` helpers (`pd-search`, `pd-note`, `pd-new-lead`, `pd-new-deal`, `pd-advance-stage`, `pd-convert-lead`, `pd-find-or-create-person`, `pd-find-or-create-org`). Helpers enforce data quality by construction — `pd-convert-lead` refuses to convert a lead that doesn't have a linked person, refuses to create a second deal for a person who already has one in the last 5 minutes, and archives the source lead atomically with creating the deal.
- The whole system is ~1500 lines of non-boilerplate code: the webhook router (~300 lines), the 8 pd-helpers (~100 lines each), and the markdown rulebook and SKILL files that shape LLM behavior. The rest is sandbox plumbing.

---

## Act 4 — Questions (1-2 minutes)

Questions you'll probably get, with short answers:

**Q: How do the bots decide what to do?**
Every message triggers a fresh LLM call with the bot's system prompt + the event context. The prompt is `IDENTITY.md + rulebook-base.md + SKILL.md` concatenated. The bot reads PD, thinks, calls shell commands (the `pd-*` helpers), writes PD, posts to the group. It's not a state machine; it's a prompted assistant with a tight playbook.

**Q: What stops them from going off the rails?**
Three layers. (1) Network policy — each sandbox can only reach `api.anthropic.com`, `api.telegram.org`, Pipedrive, and the local webhook server. They can't exfiltrate data or hit random APIs. (2) Helpers enforce data rules at the API boundary — you can't create a deal without a linked person; you can't convert a lead twice. (3) The webhook server's rollup dedupe and `is_bot` filters prevent bots from triggering themselves or each other into infinite loops.

**Q: Does it scale?**
Each bot uses the same Anthropic API key and costs roughly the same as any other LLM app. The bottleneck is the Anthropic rate limit, not the architecture. Adding a fourth or fifth bot is `cp -r bots/TEMPLATE bots/<new>`, edit the SKILL, add a webhook route, restore the sandbox. See `docs/new-bot-checklist.md` — 10 phases, ~1 hour for someone who's done it before.

**Q: Why not LangGraph or AutoGPT?**
There's a companion essay about this at `docs/two-ways-to-build-crm-agents.md`. Short version: LangGraph treats Claude as a function inside a compiled pipeline. This repo treats Claude as an employee — the LLM is the runtime, not a component. Different trade-offs. Both are valid. The sibling repo `pipeagent` is the LangGraph version of the same problem.

**Q: Can I try it with my own CRM?**
Not yet, but the architecture is generic. The pd-* helpers and the Pipedrive reference docs would need to be rewritten for a different CRM, and the sales process would need to be adapted, but the sandbox+relay+YAML-routing skeleton is reusable. `docs/architecture.md` has the full technical breakdown.

---

## After the demo

Reset the state so the next demo starts clean:

```bash
kill $(lsof -ti:3000) 2>/dev/null; sleep 1
echo "yes" | ./scripts/wipe-pipedrive.sh | tail -3
cd webhook-server && nohup node server.js > server.log 2>&1 & disown
```

The bots' workspace memories from this demo can stay — they'll be wiped on the next preflight cycle.

---

## Troubleshooting the demo live

If something goes wrong while the audience is watching, say so. The bots are experimental and the system is imperfect. That's part of the honest story.

Common failure modes:

- **Bot posts nothing for 2+ minutes.** Check `tail -5 webhook-server/server.log` for dispatch errors. If you see timeouts, the gateway may be hung — `ssh` into the bot sandbox and `pgrep -f openclaw-gateway`. If empty, restart with `./bots/<bot>/restore.sh`.

- **Bot posts a wall of text with bold and tables.** The server-side truncation guardrail should have caught this — check `webhook-server/server.log` for a "truncated N-line output" line. If it's NOT there, the sanitizer has a regression. Not fixable live; explain it as "ongoing tuning work" and move on.

- **Two deals get created for one lead.** The race guard in `pd-convert-lead` should have prevented this. Check the deal creator_user_id — if both are Lux, the rollup dedupe or the race guard has a regression. Explain as "one of the exact bugs we hit during tuning — the fix is in place but real data sometimes finds new corner cases".

- **Pipedrive itself is slow or the webhook takes 30+ seconds to arrive.** Not much you can do live. Talk about the architecture (Tailscale Funnel, webhook delivery) while waiting.

- **Colima VM died between the preflight and the demo.** See `CLAUDE.md` "Colima VM Crash Recovery". Recovery takes 60-90 seconds if you catch it early: `colima stop --force && colima start && docker start openshell-cluster-openshell`.
