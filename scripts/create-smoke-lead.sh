#!/bin/bash
# create-smoke-lead.sh — create the Task 22 smoke-test lead via PD API
#
# Uses the admin token from docs/pipedrive-ids.md to create:
#   1. Person "Mari Tamm" (mari.tamm@example.ee, +372 5555 0142)
#   2. Lead "Pirita residential — 8 kW rooftop install" (€12,000) linked to Mari
#   3. Note on the lead with the qualification signals
#
# Creator is the admin user (25474697), NOT a bot, so routing.yaml's
# skip_if_bot_creator filter does NOT apply and the events WILL route to Lux.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN=$(grep "Joonas (Admin)" "$REPO_ROOT/docs/pipedrive-ids.md" | head -1 | awk -F'|' '{print $3}' | tr -d ' \n\r\t')
if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not extract admin token from docs/pipedrive-ids.md" >&2
  exit 1
fi

API="https://api.pipedrive.com/v1"

pd_post() {
  # $1 = path, $2 = json body
  curl -sS -X POST "$API$1?api_token=$TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2"
}

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "Creating person Mari Tamm..."
PERSON_JSON=$(pd_post "/persons" '{"name":"Mari Tamm","email":[{"value":"mari.tamm@example.ee","primary":true}],"phone":[{"value":"+372 5555 0142","primary":true}]}')
PERSON_ID=$(echo "$PERSON_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
log "  person_id=$PERSON_ID"

log "Creating lead Pirita residential — 8 kW rooftop install..."
LEAD_JSON=$(pd_post "/leads" "$(cat <<JSON
{
  "title": "Pirita residential — 8 kW rooftop install",
  "person_id": $PERSON_ID,
  "value": { "amount": 12000, "currency": "EUR" }
}
JSON
)")
LEAD_ID=$(echo "$LEAD_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
log "  lead_id=$LEAD_ID"

log "Adding qualification note to lead..."
export LEAD_ID
export NOTE_CONTENT="Spoke with Mari, the homeowner in Pirita. 180 m² detached house, south-facing gable roof, wants an 8 kW system. Budget ~€12K, wants installation before June. Decision-maker is present (her and her husband together). Current electricity bill ~€240/month."
NOTE_BODY=$(python3 -c 'import json,os; print(json.dumps({"lead_id":os.environ["LEAD_ID"],"content":os.environ["NOTE_CONTENT"]}))')
NOTE_JSON=$(pd_post "/notes" "$NOTE_BODY")
NOTE_ID=$(echo "$NOTE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
log "  note_id=$NOTE_ID"

log "Done."
echo ""
echo "Summary:"
echo "  person_id = $PERSON_ID"
echo "  lead_id   = $LEAD_ID"
echo "  note_id   = $NOTE_ID"
