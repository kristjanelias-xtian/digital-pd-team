#!/bin/bash
# Post-restart hook: restart webhook server
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*"; }

kill $(lsof -ti:3000) 2>/dev/null || true
sleep 2
cd "${SCRIPT_DIR}/webhook-server"
nohup node server.js > server.log 2>&1 &
sleep 5
if lsof -ti:3000 > /dev/null 2>&1; then
  log "  Webhook server running on port 3000"
  HEALTH=$(curl -s http://localhost:3000/tunnel-status 2>/dev/null)
  if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  {k}: {\"UP\" if v[\"up\"] else \"DOWN\"}') for k,v in d['tunnels'].items()]" 2>/dev/null; then
    true
  else
    log "  WARNING: Could not check tunnel status"
  fi
else
  log "  WARNING: Webhook server failed to start"
fi
