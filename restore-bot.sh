#!/bin/bash
set -e

# Usage: ./restore-bot.sh <bot-config-dir>
# Unified restore script for all PD team bots. Each bot's restore.sh calls this.

CONFIG_DIR="${1:?Usage: $0 <bot-config-dir>}"
CONFIG_DIR="$(cd "$CONFIG_DIR" && pwd)"
BOT_NAME="$(basename "$CONFIG_DIR")"

ssh_bot() {
  ssh -o "ProxyCommand=openshell ssh-proxy --gateway-name openshell --name $BOT_NAME" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      sandbox@openshell-$BOT_NAME "$@"
}

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "=== Restoring ${BOT_NAME} ==="

# --- Back up credentials from existing sandbox (if running) ---
if openshell sandbox list 2>/dev/null | grep -q "$BOT_NAME"; then
  log "Backing up credentials..."
  ssh_bot "cat ~/.openclaw/credentials/telegram-default-allowFrom.json 2>/dev/null" \
    > /tmp/${BOT_NAME}-allowFrom.json 2>/dev/null || true
  if [ -s /tmp/${BOT_NAME}-allowFrom.json ]; then
    mkdir -p "${CONFIG_DIR}/credentials"
    cp /tmp/${BOT_NAME}-allowFrom.json "${CONFIG_DIR}/credentials/telegram-default-allowFrom.json"
    log "  Credentials backed up"
  else
    log "  (no existing credentials)"
  fi
fi

# --- Create sandbox if it doesn't exist ---
if ! openshell sandbox list 2>/dev/null | grep -q "$BOT_NAME"; then
  log "Creating sandbox (this pulls ~1.3GB image, may take a few minutes)..."
  openshell sandbox create --from openclaw --name "$BOT_NAME" --policy "${CONFIG_DIR}/policy.yaml" --no-tty -- true

  log "Waiting for sandbox to be ready..."
  for i in $(seq 1 120); do
    STATE=$(openshell sandbox list 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep "$BOT_NAME" | awk '{print $NF}')
    if [ "$STATE" = "Ready" ]; then
      log "  Sandbox ready"
      break
    fi
    if [ "$((i % 6))" -eq 0 ]; then
      log "  Still waiting... (${STATE:-unknown}, ${i}s)"
    fi
    if [ "$i" -eq 120 ]; then
      log "  Sandbox not ready after 120s — aborting"
      exit 1
    fi
    sleep 1
  done
else
  log "Sandbox already exists"
fi

# --- Upload config files ---
log "Uploading openclaw.json..."
cat "${CONFIG_DIR}/openclaw.json" | ssh_bot "cat > ~/.openclaw/openclaw.json"

log "Uploading auth-profiles.json..."
cat "${CONFIG_DIR}/auth-profiles.json" | ssh_bot "mkdir -p ~/.openclaw/agents/main/agent && cat > ~/.openclaw/agents/main/agent/auth-profiles.json"

log "Uploading IDENTITY.md..."
cat "${CONFIG_DIR}/IDENTITY.md" | ssh_bot "cat > ~/.openclaw/agents/main/agent/IDENTITY.md"
cat "${CONFIG_DIR}/IDENTITY.md" | ssh_bot "mkdir -p ~/.openclaw/workspace && cat > ~/.openclaw/workspace/IDENTITY.md"

# --- Upload company profile ---
PROFILE="${CONFIG_DIR}/../../docs/nordlight-solar-profile.md"
if [ -f "$PROFILE" ]; then
  log "Uploading NordLight company profile..."
  cat "$PROFILE" | ssh_bot "cat > ~/.openclaw/workspace/nordlight-solar-profile.md"
fi

# --- Upload PD IDs reference ---
PD_IDS="${CONFIG_DIR}/../../docs/pipedrive-ids.md"
if [ -f "$PD_IDS" ]; then
  log "Uploading Pipedrive IDs reference..."
  cat "$PD_IDS" | ssh_bot "cat > ~/.openclaw/workspace/pipedrive-ids.md"
fi

# --- Upload shared skill files ---
SHARED_DIR="${CONFIG_DIR}/../shared"
if [ -d "$SHARED_DIR" ]; then
  for shared_file in "$SHARED_DIR"/*.md; do
    [ -f "$shared_file" ] || continue
    fname=$(basename "$shared_file")
    ssh_bot "mkdir -p ~/.agents/skills/shared"
    cat "$shared_file" | ssh_bot "cat > ~/.agents/skills/shared/${fname}"
    log "  Uploaded shared: ${fname}"
  done
fi

# --- Upload skills ---
SKILLS_UPLOADED=0
if [ -d "${CONFIG_DIR}/skills" ]; then
  for skill_dir in "${CONFIG_DIR}/skills"/*/; do
    [ -f "${skill_dir}/SKILL.md" ] || continue
    skill_name=$(basename "$skill_dir")
    ssh_bot "mkdir -p ~/.agents/skills/${skill_name}"
    cat "${skill_dir}/SKILL.md" | ssh_bot "cat > ~/.agents/skills/${skill_name}/SKILL.md"
    log "  Uploaded skill: ${skill_name}"
    SKILLS_UPLOADED=$((SKILLS_UPLOADED + 1))
  done
fi
if [ "$SKILLS_UPLOADED" -eq 0 ]; then
  log "  (no skills to upload)"
fi

# --- Upload credentials ---
log "Uploading credentials..."
ssh_bot "mkdir -p ~/.openclaw/credentials"
if [ -f "${CONFIG_DIR}/credentials/telegram-default-allowFrom.json" ]; then
  cat "${CONFIG_DIR}/credentials/telegram-default-allowFrom.json" | ssh_bot "cat > ~/.openclaw/credentials/telegram-default-allowFrom.json"
else
  log "  (no allowFrom file)"
fi

# --- Providers (idempotent) ---
log "Configuring providers..."
openshell provider create --name anthropic --type anthropic --credential ANTHROPIC_API_KEY 2>/dev/null || true
openshell inference set --provider anthropic --model claude-sonnet-4-6 2>/dev/null

# --- Start gateway ---
log "Starting gateway..."
ssh_bot "rm -f ~/.openclaw/gateway.lock ~/.openclaw/.gateway.lock && nohup openclaw gateway run > ~/.openclaw/gateway.log 2>&1 &"
sleep 5

# --- Verify ---
log "Verifying..."
if ssh_bot "pgrep -f openclaw-gateway" > /dev/null 2>&1; then
  log "  Gateway running"
else
  log "  WARNING: Gateway not running — check: openshell logs $BOT_NAME"
fi

if ssh_bot "curl -sf https://api.telegram.org/bot\$(grep botToken ~/.openclaw/openclaw.json | head -1 | grep -oE '[0-9]+:[A-Za-z0-9_-]+')/getMe" > /dev/null 2>&1; then
  log "  Telegram API reachable"
else
  log "  WARNING: Telegram not reachable — check policy.yaml"
fi

log "=== ${BOT_NAME} done ==="
