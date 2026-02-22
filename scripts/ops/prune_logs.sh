#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
KEEP_RESET=10
KEEP_BASELINE=10
KEEP_KPI_DAYS=30

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-reset) KEEP_RESET="${2:-10}"; shift 2 ;;
    --keep-baseline) KEEP_BASELINE="${2:-10}"; shift 2 ;;
    --keep-kpi-days) KEEP_KPI_DAYS="${2:-30}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR/reset-backups" "$LOG_DIR/baseline-backups"
ls -1t "$LOG_DIR/reset-backups"/*.tgz 2>/dev/null | tail -n +$((KEEP_RESET+1)) | xargs -r rm -f
ls -1t "$LOG_DIR/baseline-backups"/*.json 2>/dev/null | tail -n +$((KEEP_BASELINE+1)) | xargs -r rm -f
find "$LOG_DIR" -maxdepth 1 -type f -name 'kpi-mail.log*' -mtime +"$KEEP_KPI_DAYS" -delete || true

echo "[OK] prune complete"
