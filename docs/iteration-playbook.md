# Iteration Playbook — tuning bot behavior safely

When a bot drifts (wrong format, duplicate work, stuck flow, rulebook violations), do NOT fix it by eyeballing the rulebook and hoping. Run a disciplined cycle: observe → fix → clean-slate → smoke → observe again. This file is the runbook for that cycle.

**Provenance:** this playbook was extracted from the 3-iteration tuning session on 2026-04-05 that took the bot flow from 5 messages / 2 deals / format violations to 2 messages / 1 deal / fully compliant. Every step in the "Per-iteration cycle" was a stumbling block at least once.

---

## When to use this playbook

- Bot is producing wrong output format (emoji, walls of text, tables in group messages).
- Duplicate records in PD (2 deals per lead, 3 notes per event).
- Bot ignores its SKILL.md (asks "what should I do?", uses wrong tool, forgets handoff).
- Multiple parallel sessions racing each other.
- A helper script (`pd-convert-lead`, etc.) misbehaves.

**Do NOT use this playbook for:**
- Adding a new bot (use `docs/new-bot-checklist.md`).
- Adding a new event route (edit `webhook-server/routing.yaml` directly).
- Infrastructure problems (Colima dead, gateway unreachable) — see `CLAUDE.md` "Colima VM Crash Recovery".

---

## Before you start

**Set an explicit target state.** Write it down. Concrete, measurable, testable. Examples from the 2026-04-05 session:

> For a single qualified lead via `scripts/create-smoke-lead.sh`:
> 1. Exactly 2 group messages (1 Lux verdict + 1 Taro ack).
> 2. Each message ≤8 lines.
> 3. Zero emoji, bold, markdown headers, or tables.
> 4. Exactly 1 deal created.
> 5. Lux's line matches `<Name>, <location> — <verdict> <score>, <next step>`.

**Set a ceiling.** Maximum 3 iterations. Prompt engineering has diminishing returns — after 3 tries, you're not learning anything new about the LLM's behavior; you're just shuffling words. If iteration 3 doesn't clear the target, the problem is architectural, not prompt-level. Stop iterating and either (a) add a structural guardrail (server-side truncation, helper-side idempotency guard, rollup dedupe) or (b) file the remaining drift for 24-hour real-data observation in Task 25.

---

## The per-iteration cycle

Each iteration is **one change → clean slate → one smoke → observe → decide**. Do not bundle multiple fixes into a single iteration — you lose the ability to attribute the result to a specific change.

### Step 1 — Read the last run's evidence

Before touching any file, gather:

- `webhook-server/logs/events-$(date +%Y-%m-%d).jsonl` — every webhook + every group message with line counts.
- Bot gateway logs inside each sandbox: `ssh ... 'tail -80 ~/.openclaw/gateway.log'`. Look for `[tools]` errors, timeouts, and the bot's actual text output.
- PD state: count deals, notes, activities for the affected person/lead.
- `webhook-server/server.log` — look for `rolled-up`, `trigger:`, dedupe lines.

Identify the single most impactful violation. Don't try to fix everything at once.

### Step 2 — Implement exactly one targeted fix

Pick one layer to edit. In order of preference:

1. **Helper script** (`bots/shared/helpers/pd-*`) — if the bug is a data correctness issue (duplicate records, missing activity). Helpers enforce rules by construction; fixing them is the highest-leverage change.
2. **Webhook server** (`webhook-server/server.js`) — if the bug is about which bot gets triggered, how many times, or with what payload. Dedupe, rollup, routing, post-processing all live here.
3. **Rulebook** (`bots/shared/rulebook-base.md`) — if the bug is a format/behavior issue that applies to all three bots.
4. **Bot SKILL.md** (`bots/<bot>/SKILL.md`) — if the bug is specific to one bot's role.

Avoid editing multiple layers in one iteration unless they're tightly coupled.

### Step 3 — Rebuild the concatenated IDENTITY for each bot

This is the step people forget. Openclaw only loads `~/.openclaw/agents/main/agent/IDENTITY.md` as the bot's always-on system prompt. Files in `~/.agents/skills/*/SKILL.md` are invokable skills, NOT always-on instructions. So any change to rulebook-base.md or per-bot SKILL.md has to be merged into the single file openclaw actually reads.

The deployment flow:

```bash
# 1. Save originals
for bot in lux taro zeno; do cp bots/$bot/IDENTITY.md /tmp/$bot-identity-orig.md; done

# 2. Build concat locally (IDENTITY + rulebook-base + SKILL)
for bot in lux taro zeno; do
  { cat bots/$bot/IDENTITY.md; echo; echo "---"; echo; \
    cat bots/shared/rulebook-base.md; echo; echo "---"; echo; \
    cat bots/$bot/SKILL.md; } > bots/$bot/IDENTITY.md.new
  mv bots/$bot/IDENTITY.md.new bots/$bot/IDENTITY.md
done

# 3. Deploy via restore.sh (it uploads the local IDENTITY.md + restarts gateway)
kill $(lsof -ti:3000) 2>/dev/null; sleep 1
for bot in lux taro zeno; do ./bots/$bot/restore.sh 2>&1 | tail -2; done

# 4. Roll local back so the repo stays clean
for bot in lux taro zeno; do cp /tmp/$bot-identity-orig.md bots/$bot/IDENTITY.md; done
```

If you only changed helpers (not prompts), skip steps 1, 2, 4 and run `deploy-skill.sh all` instead — it pushes helpers to `~/.local/bin/` on each sandbox without restarting anything.

If you only changed `webhook-server/server.js`, skip the whole concat+restore dance — just restart the webhook server at step 5.

### Step 4 — Wipe bot memories

`restore.sh` does NOT wipe workspace state (SOUL.md, USER.md, sessions/). Residual memory from the previous iteration WILL bleed into the next smoke test. You will waste 5 minutes wondering why the fix "didn't work" before realizing the bot is still reacting to last round's events.

Wipe memories explicitly via SSH:

```bash
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
echo $(hostname)=$(pgrep -f openclaw-gateway | head -1)
REMOTE
done
```

You should see `lux=<pid> taro=<pid> zeno=<pid>` — non-empty PIDs confirm the fresh gateways are running. If a PID is empty, the kill+restart failed; check `~/.openclaw/gateway.log` inside that sandbox.

### Step 5 — Wipe Pipedrive AND restart the webhook server in the right order

If you stop the webhook server BEFORE wiping PD, the delete cascade webhooks fire while nothing is listening — clean. If you wipe PD WHILE the webhook server is running, it routes hundreds of `updated.*` / `deleted.*` delete cascade events to bots that are already queued up and will process them as ghost triggers next session.

Correct order:

```bash
kill $(lsof -ti:3000) 2>/dev/null; sleep 1
echo "yes" | ./scripts/wipe-pipedrive.sh 2>&1 | tail -3

# Only after the wipe is done, start the webhook server
cd webhook-server && nohup node server.js > server.log 2>&1 & disown
sleep 4
curl -s http://localhost:3000/tunnel-status | python3 -c "import sys,json; print(json.load(sys.stdin)['healthy'])"
cd ..
```

Verify `tunnel-status` shows `healthy=True` before continuing. If any tunnel is down, the smoke test will silently produce nothing.

### Step 6 — Run the smoke test

```bash
date -u +"t0=%H:%M:%S UTC"  # Mark the start — you'll need this timestamp for log filtering
./scripts/create-smoke-lead.sh
```

The smoke script creates a canonical test lead: person Mari Tamm (`mari.tamm@example.ee`, `+372 5555 0142`), lead "Pirita residential — 8 kW rooftop install" (€12,000), and a qualification note with hot-lead signals. This exact fixture has been used across many iterations and is the baseline you compare against.

### Step 7 — Observe, DON'T go silent

The bots take 90-180 seconds to complete a full Hot-lead pipeline (read lead → read lifecycle.md → score → write note → label → convert → handoff → Taro picks up → Taro schedules discovery). **Stay active during this window.** Poll the event log every 30-60 seconds, don't block for minutes on a single long sleep.

What to watch:

```bash
# Routed events + dedupes
awk '/"ts":"<today>T<start-hour>/' webhook-server/logs/events-$(date +%Y-%m-%d).jsonl | \
  grep -v unknown.unknown | tail -20

# Group messages with line counts
awk '/"ts":"<today>T<start-hour>/' webhook-server/logs/events-$(date +%Y-%m-%d).jsonl | \
  grep group_message | python3 -c "
import sys, json
for line in sys.stdin:
    e = json.loads(line)
    mark = 'OK' if e.get('lines',0) <= 8 else 'XX'
    print(f\"{e['ts'][11:19]} {e['bot']:5} {mark} {e['lines']:2}L: {e['text'][:200]}\")
"

# Server-side dedupe/rollup/trigger activity
grep -E "rolled-up|trigger:|truncated" webhook-server/server.log | tail

# Current PD state
curl -s "https://api.pipedrive.com/v1/deals?status=all_not_deleted&api_token=$TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin).get('data') or []; print(f'deals={len(d)}')"
```

### Step 8 — Decide

Compare against the target. Three outcomes:

- **Target met.** Commit the fix, write the commit message with enough detail that a future session can reconstruct the cycle. Take a baseline backup (`backup-bot.sh lux && backup-bot.sh taro && backup-bot.sh zeno`). Stop.

- **Clear improvement but target not met AND iterations remaining.** Identify the next single most impactful remaining violation. Return to step 1.

- **No improvement OR regression OR ceiling hit.** Don't iterate further. Either add a structural guardrail (see "Structural escape hatches" below) or file the remaining drift as known tuning work for Task 25.

---

## Structural escape hatches — what to reach for when prompts plateau

After ~3 iterations of prompt-level tuning, you'll hit a plateau where the LLM produces the right thing sometimes and the wrong thing other times. Stop tuning prompts. Add a guardrail that enforces the rule mechanically:

- **Line-count / emoji / table violations in group messages** → server-side sanitizer in `postResponseToGroup` (webhook-server/server.js). Strip markdown markers, drop emoji, and if >8 lines keep only the last non-empty line. The bot can reason verbosely in its response; only the summary reaches the group.

- **Duplicate records (2 deals per lead, duplicate notes)** → idempotency check inside the relevant `pd-*` helper. Before creating, query for existing records matching some invariant (person_id + title, lead is_archived, deal age) and refuse with a clear error.

- **Parallel-session races** → rollup dedupe in the webhook server keyed on a logical subject (`person_id`, not `(eventKey, entity_id)`). Pipedrive fires `added.person` and `added.lead` ~250ms apart for one API create; rollup prevents the second from spawning a parallel session.

- **Bot skips an action it was told to do** (e.g. Lux reads "Hand off via handoffs.md" but never calls `/trigger`) → inline the concrete command in the SKILL.md instead of pointing at a file. LLMs skip indirection.

These are the four escape hatches that worked on 2026-04-05. If you find a fifth, add it here.

---

## What NOT to do

- **Don't skip bot memory wipe** between iterations. See step 4.
- **Don't edit files during a running smoke test.** Finish the observation, then iterate.
- **Don't iterate on more than one change at a time.** You lose the ability to attribute cause.
- **Don't trust `deploy-skill.sh` alone for rulebook/SKILL changes.** It pushes to `~/.agents/skills/` which openclaw does NOT load as the always-on prompt. Only the concat-into-IDENTITY dance (step 3) + `restore.sh` actually updates behavior.
- **Don't leave bots/<bot>/IDENTITY.md in its concatenated state in the repo.** Always roll back from `/tmp/<bot>-identity-orig.md` after `restore.sh` finishes. The repo's source files stay personality-only.
- **Don't commit the concatenated IDENTITY by accident.** `git status` after step 4 of the deployment flow should show no changes to `bots/<bot>/IDENTITY.md`.
- **Don't disappear from the conversation during observation.** The user is watching Telegram in real time; silent waits look like hangs.
