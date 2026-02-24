#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -f "$ROOT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
fi

MODE="${1:-daily}"
DIGEST_FILE="${2:-$ROOT_DIR/logs/ops/ws_edge_digest_${MODE}.txt}"
WEBHOOK_URL="${WS_EDGE_DISCORD_WEBHOOK_URL:-${DISCORD_WEBHOOK_URL:-}}"
DRY_RUN="${V2_DISCORD_DRY_RUN:-0}"

if [ ! -f "$DIGEST_FILE" ]; then
  echo "[ERROR] digest file not found: $DIGEST_FILE"
  exit 1
fi

if [ -z "$WEBHOOK_URL" ] && [ "$DRY_RUN" != "1" ]; then
  echo "[INFO] webhook is not set (WS_EDGE_DISCORD_WEBHOOK_URL or DISCORD_WEBHOOK_URL), skip notify"
  exit 0
fi

NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TITLE="HLB2 WS Edge ${MODE^^} Report"
BODY="$(cat "$DIGEST_FILE")"
CONTENT="${TITLE}\nTime(UTC): ${NOW_UTC}\n\n${BODY}"

MAX_LEN=1800
if [ "${#CONTENT}" -gt "$MAX_LEN" ]; then
  CONTENT="${CONTENT:0:$MAX_LEN}\n... (truncated)"
fi

PAYLOAD="$(node -e "const s=process.argv[1];process.stdout.write(JSON.stringify({content:s}));" "$CONTENT")"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY-RUN] discord payload:"
  echo "$PAYLOAD"
  exit 0
fi

curl -sS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null

echo "[OK] discord edge digest sent"
