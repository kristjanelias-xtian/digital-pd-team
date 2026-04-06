#!/usr/bin/env bash
#
# nova-calendar-sync-standalone.sh
#
# Creates Pipedrive contacts + deals from your calendar-synced activities,
# so Nova (meeting intelligence) can activate on them.
#
# What it does:
#   1. Creates a "Nova Dogfood" pipeline with Upcoming / In Progress / Done stages
#   2. Finds meeting activities in your PD calendar (next N hours)
#   3. For each meeting with attendees:
#      - Creates a PD person for the organizer (or first attendee)
#      - Creates a deal in the Nova Dogfood pipeline
#      - Links the activity to both
#   4. Advances deals whose meetings are today or past
#
# Usage:
#   ./nova-calendar-sync-standalone.sh                        # Prompts for token
#   PD_API_TOKEN=xxx ./nova-calendar-sync-standalone.sh       # 24h lookahead
#   PD_API_TOKEN=xxx ./nova-calendar-sync-standalone.sh --hours 72
#   PD_API_TOKEN=xxx ./nova-calendar-sync-standalone.sh --dry-run
#
# Requirements: bash, curl, python3
#

set -euo pipefail

BASE_URL="https://api.pipedrive.com/v1"
PIPELINE_NAME="Nova Dogfood"
HOURS=24
DRY_RUN=false

# --- Parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --hours) HOURS="$2"; shift 2 ;;
    --hours=*) HOURS="${1#*=}"; shift ;;
    -h|--help)
      sed -n '3,17p' "$0"; exit 0 ;;
    *) shift ;;
  esac
done

# --- Token ---
if [ -z "${PD_API_TOKEN:-}" ]; then
  printf "Pipedrive API token (Settings → Personal preferences → API): "
  read -rs PD_API_TOKEN; echo
fi
[ -z "$PD_API_TOKEN" ] && { echo "ERROR: No token." >&2; exit 1; }

# --- API helpers ---
pd_get() { curl -sS "${BASE_URL}${1}$( [[ "$1" == *"?"* ]] && echo "&" || echo "?" )api_token=${PD_API_TOKEN}"; }
pd_post() { curl -sS -X POST "${BASE_URL}${1}?api_token=${PD_API_TOKEN}" -H "Content-Type: application/json" -d "$2"; }
pd_put() { curl -sS -X PUT "${BASE_URL}${1}?api_token=${PD_API_TOKEN}" -H "Content-Type: application/json" -d "$2"; }

echo "Nova Calendar Sync — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo ""

# --- Who am I? ---
read -r MY_USER_ID MY_EMAIL MY_NAME < <(pd_get "/users/me" | python3 -c "
import sys, json; u = json.load(sys.stdin).get('data',{})
print(u.get('id',''), u.get('email',''), u.get('name',''))
")
[ -z "$MY_USER_ID" ] && { echo "ERROR: Auth failed." >&2; exit 1; }
export MY_USER_ID MY_EMAIL MY_NAME
echo "  User: $MY_NAME ($MY_EMAIL)"

# --- Find or create pipeline ---
PIPELINE_ID=$(pd_get "/pipelines" | python3 -c "
import sys, json
for p in json.load(sys.stdin).get('data') or []:
    if p['name'] == '$PIPELINE_NAME': print(p['id']); sys.exit(0)
print('')
")

if [ -z "$PIPELINE_ID" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] Would create pipeline '$PIPELINE_NAME'"
    echo "  Cannot proceed in dry-run without existing pipeline."
    exit 0
  fi
  PIPELINE_ID=$(pd_post "/pipelines" "{\"name\":\"$PIPELINE_NAME\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  echo "  Created pipeline (id=$PIPELINE_ID)"
else
  echo "  Pipeline exists (id=$PIPELINE_ID)"
fi

# --- Find or create stages ---
read -r STAGE_UPCOMING STAGE_IN_PROGRESS STAGE_DONE < <(pd_get "/stages?pipeline_id=$PIPELINE_ID" | python3 -c "
import sys, json
stages = {s['name']: s['id'] for s in (json.load(sys.stdin).get('data') or [])}
print(stages.get('Upcoming',''), stages.get('In Progress',''), stages.get('Done',''))
")

if [ -z "$STAGE_UPCOMING" ] && [ "$DRY_RUN" = false ]; then
  # Rename default stage or create
  DEFAULT=$(pd_get "/stages?pipeline_id=$PIPELINE_ID" | python3 -c "
import sys,json; s=json.load(sys.stdin).get('data') or []; print(s[0]['id'] if s else '')
")
  if [ -n "$DEFAULT" ]; then
    pd_put "/stages/$DEFAULT" '{"name":"Upcoming"}' > /dev/null
    STAGE_UPCOMING="$DEFAULT"
  else
    STAGE_UPCOMING=$(pd_post "/stages" "{\"name\":\"Upcoming\",\"pipeline_id\":$PIPELINE_ID,\"order_nr\":1}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  fi
fi
if [ -z "$STAGE_IN_PROGRESS" ] && [ "$DRY_RUN" = false ]; then
  STAGE_IN_PROGRESS=$(pd_post "/stages" "{\"name\":\"In Progress\",\"pipeline_id\":$PIPELINE_ID,\"order_nr\":2}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
fi
if [ -z "$STAGE_DONE" ] && [ "$DRY_RUN" = false ]; then
  STAGE_DONE=$(pd_post "/stages" "{\"name\":\"Done\",\"pipeline_id\":$PIPELINE_ID,\"order_nr\":3}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
fi
echo "  Stages: Upcoming=$STAGE_UPCOMING, In Progress=$STAGE_IN_PROGRESS, Done=$STAGE_DONE"

# --- Advance past deals ---
echo "  Advancing past deals..."
TODAY=$(date '+%Y-%m-%d')

DEALS_TMP=$(mktemp)
pd_get "/deals?pipeline_id=$PIPELINE_ID&status=open&limit=100" | python3 -c "
import sys, json
for d in (json.load(sys.stdin).get('data') or []):
    if d.get('pipeline_id') == $PIPELINE_ID:
        print(f\"{d['id']}\t{d.get('stage_id','')}\t{d.get('title','')}\")
" > "$DEALS_TMP"
while IFS=$'\t' read -r deal_id stage_id title; do
  [ -z "$deal_id" ] && continue
  next_due=$(pd_get "/deals/$deal_id/activities?done=0&limit=1" | python3 -c "
import sys, json
a = json.load(sys.stdin).get('data') or []
print(a[0].get('due_date','') if a else '')
" || true)
  if [ -z "$next_due" ] && [ "$stage_id" != "$STAGE_DONE" ]; then
    [ "$DRY_RUN" = true ] && echo "  [dry-run] '$title' → Done" && continue
    pd_put "/deals/$deal_id" "{\"stage_id\":$STAGE_DONE}" > /dev/null
    echo "  '$title' → Done"
  elif [ -n "$next_due" ] && [[ "$next_due" < "$TODAY" ]] && [ "$stage_id" != "$STAGE_DONE" ]; then
    [ "$DRY_RUN" = true ] && echo "  [dry-run] '$title' → Done (was $next_due)" && continue
    pd_put "/deals/$deal_id" "{\"stage_id\":$STAGE_DONE}" > /dev/null
    echo "  '$title' → Done (was $next_due)"
  elif [ "$next_due" = "$TODAY" ] && [ "$stage_id" = "$STAGE_UPCOMING" ]; then
    [ "$DRY_RUN" = true ] && echo "  [dry-run] '$title' → In Progress" && continue
    pd_put "/deals/$deal_id" "{\"stage_id\":$STAGE_IN_PROGRESS}" > /dev/null
    echo "  '$title' → In Progress"
  fi
done < "$DEALS_TMP"
rm -f "$DEALS_TMP"

# --- Fetch and process upcoming activities ---
WINDOW_END=$(python3 -c "from datetime import datetime,timedelta; print((datetime.now()+timedelta(hours=$HOURS)).strftime('%Y-%m-%d'))")
echo "  Scanning activities ($TODAY → $WINDOW_END)..."

# Write activity list to temp file (avoids pipe subshell + set -e issues)
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

pd_get "/activities?user_id=$MY_USER_ID&done=0&sort=due_date&limit=500" | python3 -c "
import sys, json
for a in (json.load(sys.stdin).get('data') or []):
    due = a.get('due_date','')
    if due >= '$TODAY' and due <= '$WINDOW_END' and a.get('type') == 'meeting':
        deal_id = a.get('deal_id') or ''
        print(f\"{a['id']}\t{due}\t{a.get('due_time','')}\t{a.get('subject','')}\t{deal_id}\")
" > "$TMPFILE"

while IFS=$'\t' read -r act_id due due_time subject existing_deal; do
  [ -z "$act_id" ] && continue

  # Skip if already linked
  if [ -n "$existing_deal" ]; then
    continue
  fi

  # Fetch attendees and pick contact
  CONTACT=$(pd_get "/activities/$act_id?include_fields=attendees" | python3 -c "
import sys, json, os
data = json.load(sys.stdin).get('data',{})
attendees = data.get('attendees') or []
my_email = os.environ['MY_EMAIL'].lower()
my_uid = int(os.environ['MY_USER_ID'])
filtered = []
for a in attendees:
    email = (a.get('email_address') or a.get('email') or '').lower()
    if not email or 'resource.calendar.google.com' in email: continue
    if email == my_email or a.get('user_id') == my_uid: continue
    filtered.append(a)
if not filtered: sys.exit(0)
c = next((a for a in filtered if a.get('is_organizer') in (True, 1)), filtered[0])
email = (c.get('email_address') or c.get('email') or '').lower()
name = c.get('name') or email.split('@')[0].replace('.', ' ').title()
print(f'{email}\t{name}\t{len(filtered)}')
" || true)

  [ -z "$CONTACT" ] && continue
  CONTACT_EMAIL=$(echo "$CONTACT" | cut -f1)
  CONTACT_NAME=$(echo "$CONTACT" | cut -f2)
  NUM_ATTENDEES=$(echo "$CONTACT" | cut -f3)

  if [ "$DRY_RUN" = true ]; then
    echo "  [$due $due_time] $subject"
    echo "    Contact: $CONTACT_NAME ($CONTACT_EMAIL), $NUM_ATTENDEES attendees"
    continue
  fi

  export CONTACT_EMAIL CONTACT_NAME
  echo "  [$due $due_time] $subject"
  echo "    Contact: $CONTACT_NAME ($CONTACT_EMAIL)"

  # Find or create person
  ENCODED_EMAIL=$(python3 -c "import sys; from urllib.parse import quote; print(quote(sys.argv[1]))" "$CONTACT_EMAIL")
  PERSON_ID=$(pd_get "/persons/search?term=$ENCODED_EMAIL&limit=5&fields=email" | python3 -c "
import sys, json, os
target = os.environ['CONTACT_EMAIL']
for item in (json.load(sys.stdin).get('data',{}).get('items') or []):
    p = item.get('item',{})
    for e in (p.get('emails') or []):
        if (e or '').lower() == target: print(p['id']); sys.exit(0)
print('')
" || true)

  if [ -z "$PERSON_ID" ]; then
    PERSON_ID=$(python3 -c "
import sys, json, os
name = os.environ['CONTACT_NAME']
email = os.environ['CONTACT_EMAIL']
body = json.dumps({'name': name, 'email': [{'value': email, 'primary': True}]})
print(body)
" | curl -sS -X POST "${BASE_URL}/persons?api_token=${PD_API_TOKEN}" -H "Content-Type: application/json" -d @- | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
    echo "    Person $PERSON_ID (created)"
  else
    echo "    Person $PERSON_ID (found)"
  fi

  # Find or create deal
  ENCODED_TITLE=$(python3 -c "import sys; from urllib.parse import quote; print(quote(sys.argv[1]))" "$subject")
  DEAL_ID=$(pd_get "/deals/search?term=$ENCODED_TITLE&limit=20&status=open" | SUBJECT="$subject" python3 -c "
import sys, json, os
title = os.environ['SUBJECT']
pid = $PIPELINE_ID
for item in (json.load(sys.stdin).get('data',{}).get('items') or []):
    deal = item.get('item',{})
    if deal.get('title') == title and deal.get('pipeline',{}).get('id') == pid:
        print(deal['id']); sys.exit(0)
print('')
" || true)

  if [ -z "$DEAL_ID" ]; then
    DEAL_ID=$(SUBJECT="$subject" python3 -c "
import json, os
body = json.dumps({'title': os.environ['SUBJECT'], 'person_id': $PERSON_ID, 'pipeline_id': $PIPELINE_ID, 'stage_id': $STAGE_UPCOMING})
print(body)
" | curl -sS -X POST "${BASE_URL}/deals?api_token=${PD_API_TOKEN}" -H "Content-Type: application/json" -d @- | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
    echo "    Deal $DEAL_ID (created)"
  else
    echo "    Deal $DEAL_ID (found)"
  fi

  # Link activity
  pd_put "/activities/$act_id" "{\"deal_id\":$DEAL_ID,\"person_id\":$PERSON_ID}" > /dev/null
  echo "    Activity $act_id linked"
done < "$TMPFILE"

echo ""
echo "Done."
