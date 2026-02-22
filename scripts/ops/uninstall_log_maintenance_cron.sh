#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CMD="bash $ROOT_DIR/scripts/ops/log_maintenance.sh >> $ROOT_DIR/logs/maintenance.log 2>&1"
( crontab -l 2>/dev/null | grep -Fv "$CMD" ) | crontab -
echo "[OK] removed log-maintenance cron"
