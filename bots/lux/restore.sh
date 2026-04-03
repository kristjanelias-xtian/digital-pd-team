#!/bin/bash
# Restore Lux Bot — delegates to shared restore-bot.sh
exec "$(cd "$(dirname "$0")/../.." && pwd)/restore-bot.sh" "$(dirname "$0")"
