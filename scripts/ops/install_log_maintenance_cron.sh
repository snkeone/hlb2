#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
EVERY_MIN=60

while [ "$#" -gt 0 ]; do
  case "$1" in
    --every-min) EVERY_MIN="${2:-60}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

CMD="bash $ROOT_DIR/scripts/ops/log_maintenance.sh >> $ROOT_DIR/logs/maintenance.log 2>&1"
SCHED="*/$EVERY_MIN * * * * $CMD"
( crontab -l 2>/dev/null | grep -Fv "$CMD"; echo "$SCHED" ) | crontab -
echo "[OK] installed log-maintenance cron: every ${EVERY_MIN}m"
