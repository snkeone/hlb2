#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
FORCE=0
NO_BACKUP=0
REASON="manual"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --reason) REASON="${2:-manual}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ "$FORCE" -ne 1 ]; then
  echo "use --force to reset logs" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
if [ "$NO_BACKUP" -ne 1 ]; then
  mkdir -p "$LOG_DIR/reset-backups"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  tar -czf "$LOG_DIR/reset-backups/logs-$TS.tgz" -C "$ROOT_DIR" logs || true
fi

find "$LOG_DIR" -maxdepth 1 -type f \( -name '*.log' -o -name '*.jsonl' -o -name 'stdout.log*' -o -name 'error.log*' \) -exec truncate -s 0 {} \; || true
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) reason=$REASON" > "$LOG_DIR/maintenance/reset.marker"
echo "[OK] logs reset"
