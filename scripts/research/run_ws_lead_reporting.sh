#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-daily}" # daily | weekly

if [ "$MODE" != "daily" ] && [ "$MODE" != "weekly" ]; then
  echo "Usage: $0 [daily|weekly]"
  exit 1
fi

if ! (cd "$ROOT_DIR" && npm run research:lead:daily >/tmp/ws_lead_daily_run.log 2>&1); then
  cat /tmp/ws_lead_daily_run.log || true
  exit 1
fi

DIGEST_TXT="$ROOT_DIR/logs/ops/ws_lead_digest_${MODE}.txt"
DIGEST_JSON="$ROOT_DIR/logs/ops/ws_lead_digest_${MODE}.json"

if ! (cd "$ROOT_DIR" && node scripts/research/ws_lead_digest.js --mode "$MODE" --in-dir logs/ops --out "logs/ops/ws_lead_digest_${MODE}.txt" --json-out "logs/ops/ws_lead_digest_${MODE}.json" >/tmp/ws_lead_digest.log 2>&1); then
  cat /tmp/ws_lead_digest.log || true
  exit 1
fi

if ! "$ROOT_DIR/scripts/research/send_ws_lead_digest_discord.sh" "$MODE" "$DIGEST_TXT" >/tmp/ws_lead_discord.log 2>&1; then
  cat /tmp/ws_lead_discord.log || true
  exit 1
fi

STATUS_PATH="$ROOT_DIR/logs/ops/ws_lead_report_status_${MODE}.json"
node -e "const fs=require('fs');const p=process.argv[1];const j={ok:true,mode:process.argv[2],generatedAt:new Date().toISOString(),digestTxt:process.argv[3],digestJson:process.argv[4]};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n','utf8');" "$STATUS_PATH" "$MODE" "$DIGEST_TXT" "$DIGEST_JSON"

echo "[OK] ws_lead ${MODE} reporting completed"
