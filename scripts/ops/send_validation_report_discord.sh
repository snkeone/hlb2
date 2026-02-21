#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS="${1:-unknown}"
MESSAGE="${2:-validation status update}"
RUN_ID="${3:-unknown}"
OUT_DIR="${4:-$ROOT_DIR/data/validation/runs/$RUN_ID}"

WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
DRY_RUN="${V2_DISCORD_DRY_RUN:-0}"

if [ -z "$WEBHOOK_URL" ] && [ "$DRY_RUN" != "1" ]; then
  echo "[INFO] DISCORD_WEBHOOK_URL is not set, skip discord notify"
  exit 0
fi

NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
UP_STATUS="$(echo "$STATUS" | tr '[:lower:]' '[:upper:]')"

REAL_ROWS="n/a"
PLACEBO_ROWS="n/a"
if [ -f "$OUT_DIR/summary.json" ]; then
  REAL_ROWS="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.counts?.labeledReal ?? 'n/a'));}catch{process.stdout.write('n/a');}" "$OUT_DIR/summary.json")"
  PLACEBO_ROWS="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.counts?.labeledPlacebo ?? 'n/a'));}catch{process.stdout.write('n/a');}" "$OUT_DIR/summary.json")"
fi

CONTENT="HLB2 Validation ${UP_STATUS}
Time(UTC): ${NOW_UTC}
Run: ${RUN_ID}
Status: ${STATUS}
Message: ${MESSAGE}
Real/Placebo: ${REAL_ROWS}/${PLACEBO_ROWS}
Out: ${OUT_DIR}"

PAYLOAD="$(node -e "const s=process.argv[1];process.stdout.write(JSON.stringify({content:s}));" "$CONTENT")"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY-RUN] discord payload:"
  echo "$PAYLOAD"
  exit 0
fi

curl -sS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null

echo "[OK] discord notification sent"

