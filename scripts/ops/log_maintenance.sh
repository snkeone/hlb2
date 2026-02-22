#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
MAX_LOG_MB=200
KEEP_MARKER_LINES=50000

ARGS=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-log-mb) MAX_LOG_MB="${2:-200}"; shift 2 ;;
    --keep-marker-lines) KEEP_MARKER_LINES="${2:-50000}"; shift 2 ;;
    --keep-reset|--keep-baseline|--keep-kpi-days) shift 2 ;;
    *) shift ;;
  esac
done

mkdir -p "$LOG_DIR/maintenance"
# shellcheck disable=SC2068
bash "$ROOT_DIR/scripts/ops/prune_logs.sh" ${ARGS[@]} || true

for f in "$LOG_DIR"/*.log "$LOG_DIR"/*.jsonl; do
  [ -f "$f" ] || continue
  SIZE_MB=$(du -m "$f" | awk '{print $1}')
  if [ "$SIZE_MB" -gt "$MAX_LOG_MB" ]; then
    tail -n 20000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done

if [ -f "$LOG_DIR/markers.jsonl" ]; then
  tail -n "$KEEP_MARKER_LINES" "$LOG_DIR/markers.jsonl" > "$LOG_DIR/markers.jsonl.tmp" && mv "$LOG_DIR/markers.jsonl.tmp" "$LOG_DIR/markers.jsonl"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) maintenance done" >> "$LOG_DIR/maintenance/maintenance.log"
echo "[OK] log maintenance complete"
