#!/usr/bin/env python3
"""nova-calendar-sync.py — Populate Pipedrive contacts + deals from calendar activities.

Reads calendar-synced activities from Pipedrive (next 24h), creates a PD person
for the meeting contact and a deal in the "Nova Dogfood" pipeline, then links
the activity to both. This enables Nova (meeting intelligence) to activate on
those meetings.

Isolation: Nova Dogfood is a separate pipeline from NordLight Solar (pipeline 3),
so the sales bots (Zeno, Lux, Taro) naturally ignore these deals.

Usage:
  PD_ADMIN_TOKEN=<token> python3 scripts/nova-calendar-sync.py [--dry-run] [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import requests

KRISTJAN_USER_ID = 980093
KRISTJAN_EMAIL = "kristjan.elias@pipedrive.com"
NOVA_PIPELINE_NAME = "Nova Dogfood"
NOVA_PIPELINE_ID = 4
STAGE_UPCOMING = 18
STAGE_IN_PROGRESS = 19
STAGE_DONE = 20


def pd_get(path: str, token: str) -> dict:
    sep = "&" if "?" in path else "?"
    url = f"https://api.pipedrive.com/v1{path}{sep}api_token={token}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def pd_post(path: str, body: dict, token: str) -> dict:
    url = f"https://api.pipedrive.com/v1{path}?api_token={token}"
    r = requests.post(url, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def pd_put(path: str, body: dict, token: str) -> dict:
    url = f"https://api.pipedrive.com/v1{path}?api_token={token}"
    r = requests.put(url, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def advance_past_deals(token: str, dry_run: bool) -> int:
    """Move deals whose meetings are today to 'In Progress', past meetings to 'Done'.

    Returns the number of deals advanced.
    """
    today = date.today()
    advanced = 0
    start = 0
    while True:
        resp = pd_get(
            f"/deals?pipeline_id={NOVA_PIPELINE_ID}&status=open&limit=100&start={start}",
            token,
        )
        batch = resp.get("data") or []
        if not batch:
            break
        for deal in batch:
            # PD API pipeline_id filter can leak — double-check
            if deal.get("pipeline_id") != NOVA_PIPELINE_ID:
                continue
            deal_id = deal["id"]
            current_stage = deal.get("stage_id")

            # Find the earliest upcoming activity linked to this deal
            acts_resp = pd_get(f"/deals/{deal_id}/activities?done=0&limit=1", token)
            activities = acts_resp.get("data") or []

            if not activities:
                # No upcoming activities — move to Done if not already
                if current_stage != STAGE_DONE:
                    if dry_run:
                        print(f"  [dry-run] Deal {deal_id} '{deal['title']}' → Done (no upcoming activities)")
                    else:
                        pd_put(f"/deals/{deal_id}", {"stage_id": STAGE_DONE}, token)
                        print(f"  Deal {deal_id} '{deal['title']}' → Done")
                    advanced += 1
                continue

            next_due = activities[0].get("due_date")
            if not next_due:
                continue
            next_date = date.fromisoformat(next_due)

            if next_date < today and current_stage != STAGE_DONE:
                if dry_run:
                    print(f"  [dry-run] Deal {deal_id} '{deal['title']}' → Done (meeting was {next_due})")
                else:
                    pd_put(f"/deals/{deal_id}", {"stage_id": STAGE_DONE}, token)
                    print(f"  Deal {deal_id} '{deal['title']}' → Done (meeting was {next_due})")
                advanced += 1
            elif next_date == today and current_stage == STAGE_UPCOMING:
                if dry_run:
                    print(f"  [dry-run] Deal {deal_id} '{deal['title']}' → In Progress (meeting today)")
                else:
                    pd_put(f"/deals/{deal_id}", {"stage_id": STAGE_IN_PROGRESS}, token)
                    print(f"  Deal {deal_id} '{deal['title']}' → In Progress (meeting today)")
                advanced += 1

        more = resp.get("additional_data", {}).get("pagination", {}).get("more_items_in_collection")
        if not more:
            break
        start += 100
    return advanced


def fetch_upcoming_activities(token: str, hours: int = 24) -> list[dict]:
    """Fetch undone meeting activities due within the next N hours."""
    activities = []
    now = datetime.now()
    window_end = now + timedelta(hours=hours)
    # Add a day buffer for timezone edge cases
    cutoff_date = (window_end + timedelta(days=1)).date()

    start = 0
    while True:
        resp = pd_get(
            f"/activities?user_id={KRISTJAN_USER_ID}&done=0&sort=due_date&limit=100&start={start}",
            token,
        )
        batch = resp.get("data") or []
        if not batch:
            break
        for a in batch:
            due = a.get("due_date")
            if not due:
                continue
            due_date = date.fromisoformat(due)
            if due_date > cutoff_date:
                return activities  # sorted ascending, past window
            if due_date >= now.date() and due_date <= window_end.date():
                # Only include meetings (calendar-synced events have type=meeting)
                if a.get("type") == "meeting":
                    activities.append(a)
        more = resp.get("additional_data", {}).get("pagination", {}).get("more_items_in_collection")
        if not more:
            break
        start += 100
    return activities


def get_activity_attendees(activity_id: int, token: str) -> list[dict]:
    """Fetch attendees for a single activity."""
    resp = pd_get(f"/activities/{activity_id}?include_fields=attendees", token)
    return resp.get("data", {}).get("attendees") or []


def filter_attendees(attendees: list[dict]) -> list[dict]:
    """Remove resource calendars and Kristjan from attendee list."""
    filtered = []
    for a in attendees:
        # v1 API uses email_address, MCP uses email
        email = (a.get("email_address") or a.get("email") or "").lower()
        if not email:
            continue
        if "resource.calendar.google.com" in email:
            continue
        if email == KRISTJAN_EMAIL:
            continue
        if a.get("user_id") == KRISTJAN_USER_ID:
            continue
        filtered.append(a)
    return filtered


def pick_contact(attendees: list[dict]) -> dict | None:
    """Pick the deal contact: organizer first, then first attendee."""
    if not attendees:
        return None
    for a in attendees:
        # v1 API: is_organizer is 1/0; MCP: true/false
        if a.get("is_organizer") in (True, 1):
            return a
    return attendees[0]


def attendee_email(attendee: dict) -> str:
    """Extract email from attendee (v1 uses email_address, MCP uses email)."""
    return (attendee.get("email_address") or attendee.get("email") or "").lower()


def find_person_by_email(email: str, token: str) -> int | None:
    """Search PD persons by email, return person_id if found."""
    resp = pd_get(f"/persons/search?term={requests.utils.quote(email)}&limit=5&fields=email", token)
    items = resp.get("data", {}).get("items") or []
    for item in items:
        person = item.get("item", {})
        for e in person.get("emails") or []:
            if (e or "").lower() == email.lower():
                return person["id"]
    return None


def create_person(email: str, name: str | None, token: str) -> int:
    """Create a PD person from email, return person_id."""
    display_name = name or email.split("@")[0].replace(".", " ").title()
    body = {
        "name": display_name,
        "email": [{"value": email, "primary": True}],
    }
    resp = pd_post("/persons", body, token)
    return resp["data"]["id"]


def find_deal_by_title(title: str, pipeline_id: int, token: str) -> int | None:
    """Find an open deal in the Nova pipeline with exact title match."""
    resp = pd_get(
        f"/deals/search?term={requests.utils.quote(title)}&limit=20&status=open",
        token,
    )
    items = resp.get("data", {}).get("items") or []
    for item in items:
        deal = item.get("item", {})
        if deal.get("title") == title and deal.get("pipeline", {}).get("id") == pipeline_id:
            return deal["id"]
    return None


def create_deal(title: str, person_id: int, pipeline_id: int, stage_id: int, token: str) -> int:
    """Create a deal in the Nova Dogfood pipeline."""
    body = {
        "title": title,
        "person_id": person_id,
        "pipeline_id": pipeline_id,
        "stage_id": stage_id,
    }
    resp = pd_post("/deals", body, token)
    return resp["data"]["id"]


def link_activity(activity_id: int, deal_id: int, person_id: int, token: str) -> None:
    """Link an activity to a deal and person."""
    pd_put(f"/activities/{activity_id}", {"deal_id": deal_id, "person_id": person_id}, token)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen without making changes")
    parser.add_argument("--json", action="store_true", help="Output structured JSON summary")
    parser.add_argument("--hours", type=int, default=24, help="Lookahead window in hours (default: 24)")
    args = parser.parse_args()

    token = os.environ.get("PD_ADMIN_TOKEN")
    if not token:
        print("error: PD_ADMIN_TOKEN environment variable is required", file=sys.stderr)
        sys.exit(1)

    stats = {"processed": 0, "skipped": 0, "deals_created": 0, "persons_created": 0, "activities_linked": 0, "deals_advanced": 0}

    print(f"Nova Calendar Sync — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")

    # Step 1: Advance deals whose meetings are today or past
    print("  Advancing deal stages...")
    stats["deals_advanced"] = advance_past_deals(token, args.dry_run)
    pipeline_id = NOVA_PIPELINE_ID
    stage_id = STAGE_UPCOMING

    # Step 2: Fetch upcoming meeting activities
    activities = fetch_upcoming_activities(token, args.hours)
    print(f"  Found {len(activities)} meeting activities in next {args.hours}h")

    # Step 3: Process each activity
    for act in activities:
        act_id = act["id"]
        subject = act.get("subject") or "(no title)"
        due = act.get("due_date", "")
        due_time = act.get("due_time", "")

        # Skip if already linked to a deal
        if act.get("deal_id"):
            stats["skipped"] += 1
            continue

        # Fetch attendees
        attendees = get_activity_attendees(act_id, token)
        filtered = filter_attendees(attendees)

        if not filtered:
            stats["skipped"] += 1
            continue

        contact = pick_contact(filtered)
        contact_email = attendee_email(contact)
        contact_name = contact.get("name")

        stats["processed"] += 1
        label = f"  [{due} {due_time}] {subject}"

        if args.dry_run:
            print(f"{label}")
            print(f"    Contact: {contact_name or contact_email} ({contact_email})")
            print(f"    Attendees: {len(filtered)} (excl. you + rooms)")
            print(f"    Would: find/create person, find/create deal, link activity")
            continue

        # Find or create person
        person_id = find_person_by_email(contact_email, token)
        if person_id:
            print(f"{label} → person {person_id} (found)")
        else:
            person_id = create_person(contact_email, contact_name, token)
            stats["persons_created"] += 1
            print(f"{label} → person {person_id} (created: {contact_name or contact_email})")

        # Find or create deal
        deal_id = find_deal_by_title(subject, pipeline_id, token)
        if deal_id:
            print(f"    Deal {deal_id} (found: '{subject}')")
        else:
            deal_id = create_deal(subject, person_id, pipeline_id, stage_id, token)
            stats["deals_created"] += 1
            print(f"    Deal {deal_id} (created: '{subject}')")

        # Link activity to deal + person
        link_activity(act_id, deal_id, person_id, token)
        stats["activities_linked"] += 1
        print(f"    Activity {act_id} linked")

    # Summary
    print(f"\nDone: {stats['processed']} processed, {stats['skipped']} skipped, "
          f"{stats['deals_created']} deals created, {stats['persons_created']} persons created, "
          f"{stats['activities_linked']} activities linked, {stats['deals_advanced']} deals advanced")

    if args.json:
        print(json.dumps({"status": "ok", **stats}))


if __name__ == "__main__":
    main()
