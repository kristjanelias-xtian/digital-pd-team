#!/bin/bash
# Restore Taro — delegates to shared openshell-tools
cd "$(cd "$(dirname "$0")/../.." && pwd)"
restore-bot.sh "bots/taro"
