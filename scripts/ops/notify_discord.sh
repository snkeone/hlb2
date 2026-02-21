#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -f "$ROOT_DIR/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env.local"
  set +a
fi

WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
DRY_RUN="${V2_DISCORD_DRY_RUN:-0}"

LEVEL="${1:-info}"
MESSAGE="${2:-no message}"

if [ -z "$WEBHOOK_URL" ] && [ "$DRY_RUN" != "1" ]; then
  echo "[INFO] DISCORD_WEBHOOK_URL is not set, skip discord notify"
  exit 0
fi

NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOST_NAME="$(hostname)"
UP_LEVEL="$(echo "$LEVEL" | tr '[:lower:]' '[:upper:]')"

CONTENT="HLB2 ${UP_LEVEL}
Time(UTC): ${NOW_UTC}
Host: ${HOST_NAME}
Message: ${MESSAGE}"

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

