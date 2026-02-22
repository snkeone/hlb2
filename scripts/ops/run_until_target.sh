#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS_DIR="$ROOT_DIR/logs/ops"
mkdir -p "$STATUS_DIR"

if [ -f "$ROOT_DIR/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env.local"
  set +a
fi

INPUT_DIR="${V2_INPUT_DIR:-$ROOT_DIR/data/raw_ws}"
INPUT_GLOB="${V2_INPUT_GLOB:-raw-*.jsonl.gz}"
INTERVAL_SEC="${V2_LOOP_INTERVAL_SEC:-900}"
TARGET_ADOPT="${V2_TARGET_ADOPT:-1}"
TARGET_REAL_ROWS="${V2_TARGET_REAL_ROWS:-1000}"
MAX_LINES="${MAX_LINES:-0}"
SAMPLE_MS="${SAMPLE_MS:-250}"
MONITOR_LOG="$STATUS_DIR/until_target.log"

pick_latest_input() {
  ls -1t "$INPUT_DIR"/$INPUT_GLOB 2>/dev/null | head -n 1
}

notify_progress() {
  local level="$1"
  local msg="$2"
  "$ROOT_DIR/scripts/ops/notify_discord.sh" "$level" "$msg" || true
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start run_until_target" | tee -a "$MONITOR_LOG"
echo "input_dir=$INPUT_DIR glob=$INPUT_GLOB interval=${INTERVAL_SEC}s target_adopt=$TARGET_ADOPT target_real_rows=$TARGET_REAL_ROWS" | tee -a "$MONITOR_LOG"
notify_progress "progress" "run_until_target started (target_adopt=$TARGET_ADOPT target_real_rows=$TARGET_REAL_ROWS)"

while true; do
  INPUT_FILE="$(pick_latest_input)"
  if [ -z "${INPUT_FILE:-}" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] no input found" | tee -a "$MONITOR_LOG"
    sleep "$INTERVAL_SEC"
    continue
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] running cycle input=$INPUT_FILE" | tee -a "$MONITOR_LOG"
  (
    cd "$ROOT_DIR"
    V2_NOTIFY_ENABLED=0 MAX_LINES="$MAX_LINES" SAMPLE_MS="$SAMPLE_MS" \
      bash "$ROOT_DIR/scripts/ops/run_validation_cycle.sh" "$INPUT_FILE"
  ) >>"$MONITOR_LOG" 2>&1 || true

  STATUS_FILE="$ROOT_DIR/logs/ops/validation_status.json"
  OUT_DIR="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.outDir||''));}catch{process.stdout.write('');}" "$STATUS_FILE")"
  if [ -z "$OUT_DIR" ] || [ ! -f "$OUT_DIR/validation_judgement.json" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] missing judgement output" | tee -a "$MONITOR_LOG"
    sleep "$INTERVAL_SEC"
    continue
  fi

  ADOPT="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.summary?.totals?.adoptCandidates ?? 0));}catch{process.stdout.write('0');}" "$OUT_DIR/validation_judgement.json")"
  REAL_ROWS="$(node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.summary?.totals?.realRows ?? 0));}catch{process.stdout.write('0');}" "$OUT_DIR/validation_judgement.json")"

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] adopt=$ADOPT realRows=$REAL_ROWS out=$OUT_DIR" | tee -a "$MONITOR_LOG"

  if [ "$ADOPT" -ge "$TARGET_ADOPT" ] && [ "$REAL_ROWS" -ge "$TARGET_REAL_ROWS" ]; then
    notify_progress "done" "Target reached: adopt=$ADOPT realRows=$REAL_ROWS out=$OUT_DIR"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] target reached" | tee -a "$MONITOR_LOG"
    exit 0
  fi

  sleep "$INTERVAL_SEC"
done
