#!/usr/bin/env bash
#
# wipe-pipedrive.sh — Delete all sales data from the Pipedrive account
#
# Deletes: deals, leads, activities, notes, organizations, persons
# Uses admin token so bot tokens aren't involved.
# Batches deletions to stay within API rate limits.
#
# Usage:
#   ./scripts/wipe-pipedrive.sh                  # Wipe everything
#   ./scripts/wipe-pipedrive.sh --notify-bots    # Wipe + tell bots to forget
#   ./scripts/wipe-pipedrive.sh --dry-run        # Show what would be deleted
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config ---
API_TOKEN="dbff6464d92162e5ed721ac7885dae7b22de96cd"  # Joonas (Admin)
BASE_URL="https://api.pipedrive.com/v1"
BATCH_SIZE=100       # PD returns max 100 per page
RATE_LIMIT_MS=250    # ms between API calls (avoid 429s)

# Telegram config for bot notifications
TELEGRAM_GROUP_ID="-5253446483"
ZENO_TOKEN="8741645726:AAG5JuH_DkHiRAEwJZbtXXuOcwww8ptgkL0"

# Webhook server (for trigger relay)
WEBHOOK_SERVER="http://localhost:3000"
GATEWAY_TOKEN="ebb941ed0a28eb977fdb9479d2cad93f7d3e8ea77152b0d3"

# --- Parse args ---
DRY_RUN=false
NOTIFY_BOTS=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --notify-bots) NOTIFY_BOTS=true ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [--notify-bots]"
      echo "  --dry-run       Show what would be deleted without deleting"
      echo "  --notify-bots   Send 'fresh start' message to all bots after wipe"
      exit 0
      ;;
  esac
done

# --- Helpers ---
sleep_ms() {
  # macOS-compatible ms sleep
  perl -e "select(undef,undef,undef,$1/1000)" "$1" 2>/dev/null || sleep 0.25
}

api_get() {
  local endpoint="$1"
  local start="${2:-0}"
  curl -sS "${BASE_URL}${endpoint}?api_token=${API_TOKEN}&start=${start}&limit=${BATCH_SIZE}" \
    -H "Accept: application/json"
}

api_delete() {
  local endpoint="$1"
  curl -sS -X DELETE "${BASE_URL}${endpoint}?api_token=${API_TOKEN}" \
    -H "Accept: application/json"
}

api_delete_bulk() {
  local endpoint="$1"
  local ids="$2"
  curl -sS -X DELETE "${BASE_URL}${endpoint}?api_token=${API_TOKEN}&ids=${ids}" \
    -H "Accept: application/json"
}

# Count and delete all items for an entity type
wipe_entity() {
  local entity="$1"        # e.g., "deals", "persons", "organizations"
  local display="$2"       # e.g., "Deals", "People", "Organizations"
  local bulk_support="$3"  # "bulk" or "single"

  echo ""
  echo "=== ${display} ==="

  local total_deleted=0
  local page=0

  while true; do
    local response
    response=$(api_get "/${entity}" 0)

    # Check for API error
    local success
    success=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null || echo "")
    if [ "$success" != "True" ]; then
      echo "  API error or no data. Response: $(echo "$response" | head -c 200)"
      break
    fi

    # Extract IDs
    local ids
    ids=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('data') or []
print('\n'.join(str(item['id']) for item in items if item and 'id' in item))
" 2>/dev/null)

    if [ -z "$ids" ]; then
      break
    fi

    local count
    count=$(echo "$ids" | wc -l | tr -d ' ')

    if $DRY_RUN; then
      echo "  Would delete ${count} ${display,,}"
      total_deleted=$((total_deleted + count))
      # In dry-run, check if there are more pages
      local more
      more=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
info = data.get('additional_data', {}).get('pagination', {})
print('yes' if info.get('more_items_in_collection') else 'no')
" 2>/dev/null || echo "no")
      if [ "$more" = "yes" ]; then
        echo "  ... and more pages"
      fi
      break
    fi

    if [ "$bulk_support" = "bulk" ]; then
      # Bulk delete (up to 100 IDs comma-separated)
      local id_list
      id_list=$(echo "$ids" | tr '\n' ',' | sed 's/,$//')
      echo "  Deleting ${count} ${display,,} in bulk..."
      api_delete_bulk "/${entity}" "$id_list" > /dev/null
      total_deleted=$((total_deleted + count))
    else
      # Single delete
      while IFS= read -r id; do
        [ -z "$id" ] && continue
        echo "  Deleting ${entity} #${id}..."
        api_delete "/${entity}/${id}" > /dev/null
        total_deleted=$((total_deleted + 1))
        sleep_ms "$RATE_LIMIT_MS"
      done <<< "$ids"
    fi

    sleep_ms "$RATE_LIMIT_MS"
    echo "  Progress: ${total_deleted} ${display,,} deleted so far..."
  done

  if [ "$total_deleted" -gt 0 ]; then
    echo "  ✓ ${total_deleted} ${display,,} ${DRY_RUN:+would be }deleted"
  else
    echo "  (none found)"
  fi
}

# Leads use a different API
wipe_leads() {
  echo ""
  echo "=== Leads ==="

  local total_deleted=0

  while true; do
    local response
    response=$(curl -sS "${BASE_URL}/leads?api_token=${API_TOKEN}&limit=${BATCH_SIZE}&archived_status=all" \
      -H "Accept: application/json")

    local ids
    ids=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('data') or []
print('\n'.join(str(item['id']) for item in items if item and 'id' in item))
" 2>/dev/null)

    if [ -z "$ids" ]; then
      break
    fi

    local count
    count=$(echo "$ids" | wc -l | tr -d ' ')

    if $DRY_RUN; then
      echo "  Would delete ${count} leads"
      break
    fi

    # Leads must be deleted one by one
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      echo "  Deleting lead ${id}..."
      curl -sS -X DELETE "${BASE_URL}/leads/${id}?api_token=${API_TOKEN}" > /dev/null
      total_deleted=$((total_deleted + 1))
      sleep_ms "$RATE_LIMIT_MS"
    done <<< "$ids"

    echo "  Progress: ${total_deleted} leads deleted so far..."
    sleep_ms "$RATE_LIMIT_MS"
  done

  if [ "$total_deleted" -gt 0 ]; then
    echo "  ✓ ${total_deleted} leads deleted"
  else
    echo "  (none found)"
  fi
}

# Notes use a different listing endpoint
wipe_notes() {
  echo ""
  echo "=== Notes ==="

  local total_deleted=0

  while true; do
    local response
    response=$(api_get "/notes" 0)

    local success
    success=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null || echo "")
    if [ "$success" != "True" ]; then
      break
    fi

    local ids
    ids=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('data') or []
print('\n'.join(str(item['id']) for item in items if item and 'id' in item))
" 2>/dev/null)

    if [ -z "$ids" ]; then
      break
    fi

    local count
    count=$(echo "$ids" | wc -l | tr -d ' ')

    if $DRY_RUN; then
      echo "  Would delete ${count} notes"
      break
    fi

    while IFS= read -r id; do
      [ -z "$id" ] && continue
      echo "  Deleting note #${id}..."
      api_delete "/notes/${id}" > /dev/null
      total_deleted=$((total_deleted + 1))
      sleep_ms "$RATE_LIMIT_MS"
    done <<< "$ids"

    echo "  Progress: ${total_deleted} notes deleted so far..."
    sleep_ms "$RATE_LIMIT_MS"
  done

  if [ "$total_deleted" -gt 0 ]; then
    echo "  ✓ ${total_deleted} notes deleted"
  else
    echo "  (none found)"
  fi
}

# --- Notify bots ---
notify_bots() {
  echo ""
  echo "=== Notifying Bots ==="

  local message="🔄 FRESH START — All Pipedrive data has been wiped clean. The CRM is empty now — no deals, no leads, no contacts, no activities, no notes. Forget everything you knew about specific leads, deals, contacts, or sales conversations. Your skills and processes stay the same, but all the sales content is gone. Treat the next interaction as day one with a blank CRM."

  # Post to the Telegram group so Kristjan can see
  echo "  Posting to Telegram group..."
  curl -sS -X POST "https://api.telegram.org/bot${ZENO_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"${TELEGRAM_GROUP_ID}\", \"text\": $(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" > /dev/null 2>&1 || true

  # Trigger each bot directly via the relay
  for bot in zeno lux taro; do
    echo "  Triggering ${bot}..."
    curl -sS -X POST "${WEBHOOK_SERVER}/trigger" \
      -H "Content-Type: application/json" \
      -d "{\"to\": \"${bot}\", \"from\": \"admin\", \"message\": \"${message}\"}" \
      --connect-timeout 5 \
      --max-time 130 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    status = 'delivered' if d.get('delivered') else 'failed'
    print(f'    → {status}')
except:
    print('    → no response')
" 2>/dev/null || echo "    → relay unreachable (bot may be offline)"
  done

  echo "  ✓ All bots notified"
}

# --- Main ---
echo "╔══════════════════════════════════════════╗"
echo "║     Pipedrive Account Wipe Script        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Account: xtian.pipedrive.com"
echo "Token:   Joonas (Admin)"
$DRY_RUN && echo "Mode:    DRY RUN (nothing will be deleted)"
$DRY_RUN || echo "Mode:    LIVE — data will be permanently deleted"
echo ""

if ! $DRY_RUN; then
  read -p "⚠️  This will permanently delete ALL sales data. Type 'yes' to confirm: " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# Order matters: delete dependent entities first
# Notes → Activities → Deals → Leads → Persons → Organizations
wipe_notes
wipe_entity "activities" "Activities" "bulk"
wipe_entity "deals" "Deals" "bulk"
wipe_leads
wipe_entity "persons" "People" "bulk"
wipe_entity "organizations" "Organizations" "bulk"

echo ""
echo "════════════════════════════════════════════"
$DRY_RUN && echo "Dry run complete. No data was deleted."
$DRY_RUN || echo "✓ Pipedrive account wiped clean."

if $NOTIFY_BOTS && ! $DRY_RUN; then
  notify_bots
fi

echo ""
echo "Done."
