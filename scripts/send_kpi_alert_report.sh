#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RAW_FILE="${1:-$ROOT_DIR/logs/raw-$(date +%Y%m%d).jsonl.gz}"
TRADES_FILE="${2:-$ROOT_DIR/logs/trades.jsonl}"
STATUS_FILE="$ROOT_DIR/logs/ops/validation_status.json"

if [ -f "$ROOT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
fi

RAW_SIZE="0"
[ -f "$RAW_FILE" ] && RAW_SIZE="$(du -h "$RAW_FILE" | awk '{print $1}')"
TRADE_LINES="0"
[ -f "$TRADES_FILE" ] && TRADE_LINES="$(wc -l < "$TRADES_FILE" | tr -d ' ')"
STATE="unknown"
OUT_DIR="-"
if [ -f "$STATUS_FILE" ]; then
  STATE="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.state||'unknown'));}catch{process.stdout.write('unknown');}" "$STATUS_FILE")"
  OUT_DIR="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.outDir||'-'));}catch{process.stdout.write('-');}" "$STATUS_FILE")"
fi

MSG="HLB2 KPI REPORT
Time(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)
Raw: $RAW_FILE ($RAW_SIZE)
Trades lines: $TRADE_LINES
Validation state: $STATE
Validation out: $OUT_DIR"

echo "$MSG"

if [ -n "${DISCORD_WEBHOOK_URL:-}" ] && [ "${KPI_MAIL_DRY_RUN:-0}" != "1" ]; then
  PAYLOAD="$(node -e "const s=process.argv[1];process.stdout.write(JSON.stringify({content:s}));" "$MSG")"
  curl -sS -X POST "$DISCORD_WEBHOOK_URL" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null
  echo "[OK] sent KPI report to webhook"
fi
