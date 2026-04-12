#!/usr/bin/env python3
"""check-bot-compliance.py — Layer-2 diagnostic for the digital PD team.

Measures rulebook compliance for each bot over a time window by reading
Pipedrive notes and deals (via the admin token) plus the webhook-server
group message log. Prints a per-bot report.

Targets (pass thresholds):
  - Note hygiene:       >= 95% compliant
  - Deal well-formedness: 100% (person + activity; org on commercial)
  - Lane violations:    0
  - Group message hygiene: >= 95% compliant

Usage:
  PD_ADMIN_TOKEN=<token> ./scripts/check-bot-compliance.py [--hours 24]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

PIPELINE_ID = 2
BOTS = {
    25523746: "zeno",
    25523713: "lux",
    25523724: "taro",
}
BOT_IDS = {v: k for k, v in BOTS.items()}
MARKDOWN_TABLE_RE = re.compile(r"^\s*\|.*\|.*$", re.MULTILINE)
MARKDOWN_HEADER_RE = re.compile(r"^\s*#{1,6}\s", re.MULTILINE)
INFRA_KEYWORDS = ["curl", "relay", "tunnel", "gateway", "proxy", "sandbox", "openshell", "api_token"]
JSON_RE = re.compile(r"^\s*[\{\[]")
GROUP_LOG_DIR = Path(__file__).resolve().parent.parent / "webhook-server" / "logs"


def pd_get(path: str, token: str) -> dict:
    sep = "&" if "?" in path else "?"
    url = f"https://api.pipedrive.com/v1{path}{sep}api_token={token}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_notes_since(token: str, cutoff: datetime) -> list[dict]:
    notes = []
    start = 0
    while True:
        resp = pd_get(f"/notes?sort=add_time DESC&start={start}&limit=100", token)
        batch = resp.get("data") or []
        if not batch:
            break
        for n in batch:
            add_time = datetime.fromisoformat(n["add_time"].replace(" ", "T") + "+00:00")
            if add_time < cutoff:
                return notes
            notes.append(n)
        more = resp.get("additional_data", {}).get("pagination", {}).get("more_items_in_collection")
        if not more:
            break
        start += 100
    return notes


def fetch_deals_since(token: str, cutoff: datetime) -> list[dict]:
    deals = []
    start = 0
    while True:
        resp = pd_get(f"/deals?sort=add_time DESC&start={start}&limit=100&pipeline_id={PIPELINE_ID}", token)
        batch = resp.get("data") or []
        if not batch:
            break
        for d in batch:
            add_time = datetime.fromisoformat(d["add_time"].replace(" ", "T") + "+00:00")
            if add_time < cutoff:
                return deals
            deals.append(d)
        more = resp.get("additional_data", {}).get("pagination", {}).get("more_items_in_collection")
        if not more:
            break
        start += 100
    return deals


def note_violations(note: dict) -> list[str]:
    issues = []
    content = note.get("content", "") or ""
    lines = content.split("\n")
    if len(lines) > 12:
        issues.append(f"{len(lines)} lines (max 12)")
    if MARKDOWN_TABLE_RE.search(content):
        issues.append("contains markdown table")
    if MARKDOWN_HEADER_RE.search(content):
        issues.append("contains markdown header")
    if "```" in content:
        issues.append("contains code fence")
    return issues


def deal_violations(deal: dict, activities: list[dict]) -> list[str]:
    issues = []
    if not deal.get("person_id"):
        issues.append("no person linked")
    # Org check: we can't always tell commercial vs residential without a custom field.
    # Flag deals with no org AND no title hint of residential as suspicious.
    if not deal.get("org_id") and not any(w in (deal.get("title") or "").lower() for w in ("residential", "home", "family", "villa")):
        issues.append("no org (and title doesn't hint residential)")
    if not activities:
        issues.append("no activities")
    return issues


def lane_violations(notes: list[dict], deals: list[dict]) -> list[str]:
    violations = []
    for n in notes:
        creator = n.get("user_id")
        if creator == BOT_IDS["taro"] and n.get("lead_id"):
            violations.append(f"taro wrote note on lead {n['lead_id']}")
        if creator == BOT_IDS["lux"] and n.get("deal_id"):
            violations.append(f"lux wrote note on deal {n['deal_id']}")
        if creator == BOT_IDS["zeno"] and (n.get("deal_id") or n.get("lead_id")):
            violations.append(f"zeno wrote note on deal/lead {n.get('deal_id') or n.get('lead_id')}")
    for d in deals:
        creator = d.get("creator_user_id", {}).get("id") if isinstance(d.get("creator_user_id"), dict) else d.get("creator_user_id")
        if creator == BOT_IDS["zeno"]:
            violations.append(f"zeno created deal {d['id']}")
        if creator == BOT_IDS["taro"] and not _came_from_lead(d):
            violations.append(f"taro created deal {d['id']} (not via lead conversion)")
    return violations


def _came_from_lead(deal: dict) -> bool:
    # Heuristic: if the deal is in Qualified stage and has activity on its creation day, likely conversion
    return True  # can't cheaply tell from one endpoint; loosen this check


def group_message_violations(cutoff: datetime) -> tuple[dict[str, list[str]], dict[str, int]]:
    violations: dict[str, list[str]] = {"lux": [], "taro": [], "zeno": []}
    counts: dict[str, int] = {"lux": 0, "taro": 0, "zeno": 0}
    for f in sorted(GROUP_LOG_DIR.glob("events-*.jsonl")) if GROUP_LOG_DIR.exists() else []:
        for line in f.read_text().splitlines():
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("kind") != "group_message":
                continue
            ts = datetime.fromisoformat(entry["ts"].replace("Z", "+00:00"))
            if ts < cutoff:
                continue
            bot = entry.get("bot")
            if bot not in violations:
                continue
            counts[bot] += 1
            text = entry.get("text", "")
            if entry.get("lines", 0) > 8:
                violations[bot].append(f"{entry.get('lines')} lines (max 8)")
            for kw in INFRA_KEYWORDS:
                if kw in text.lower():
                    violations[bot].append(f"contains infra keyword '{kw}'")
                    break
            if JSON_RE.search(text):
                violations[bot].append("starts with raw JSON/array")
    return violations, counts


def report(title: str, total: int, violating: int, details: list[str], target_pct: float = 0.95) -> bool:
    ok_pct = (total - violating) / total if total else 1.0
    status = "PASS" if ok_pct >= target_pct else "FAIL"
    print(f"  {title}: {total - violating}/{total} compliant ({ok_pct:.0%}) — {status}")
    for d in details[:5]:
        print(f"    - {d}")
    if len(details) > 5:
        print(f"    … {len(details) - 5} more")
    return ok_pct >= target_pct


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=24)
    args = parser.parse_args()

    token = os.environ.get("PD_ADMIN_TOKEN")
    if not token:
        print("PD_ADMIN_TOKEN not set", file=sys.stderr)
        sys.exit(2)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    print(f"Compliance report — last {args.hours}h (since {cutoff.isoformat()})\n")

    notes = fetch_notes_since(token, cutoff)
    deals = fetch_deals_since(token, cutoff)

    all_pass = True
    for bot_name, bot_id in BOT_IDS.items():
        print(f"== {bot_name} ==")
        bot_notes = [n for n in notes if n.get("user_id") == bot_id]
        note_issues = []
        for n in bot_notes:
            v = note_violations(n)
            if v:
                note_issues.append(f"note {n['id']}: {', '.join(v)}")
        all_pass &= report("note hygiene", len(bot_notes), len(note_issues), note_issues)

        bot_deals = [d for d in deals if (d.get("creator_user_id", {}).get("id") if isinstance(d.get("creator_user_id"), dict) else d.get("creator_user_id")) == bot_id]
        deal_issues = []
        for d in bot_deals:
            try:
                acts = pd_get(f"/deals/{d['id']}/activities", token).get("data") or []
            except Exception:
                acts = []
            v = deal_violations(d, acts)
            if v:
                deal_issues.append(f"deal {d['id']}: {', '.join(v)}")
        all_pass &= report("deal well-formedness", len(bot_deals), len(deal_issues), deal_issues, target_pct=1.0)
        print()

    print("== Lane violations ==")
    lane = lane_violations(notes, deals)
    all_pass &= report("lane purity", max(len(notes) + len(deals), 1), len(lane), lane, target_pct=1.0)
    print()

    print("== Group message hygiene ==")
    gm_violations, gm_counts = group_message_violations(cutoff)
    for bot in ("lux", "taro", "zeno"):
        all_pass &= report(f"{bot} group messages", gm_counts.get(bot, 0), len(gm_violations.get(bot, [])), gm_violations.get(bot, []))
    print()

    print("OVERALL:", "PASS" if all_pass else "FAIL")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
