#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-daily}" # daily | weekly | scheduled

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="$ROOT_DIR/logs/ops/ws_pattern_pipeline"
RUN_DIR="$BASE_DIR/runs/$RUN_ID"
LATEST_DIR="$BASE_DIR/latest"

SOURCE_DIR="$RUN_DIR/source"
TRAIN_DIR="$RUN_DIR/train"
REFRESH_DIR="$RUN_DIR/refresh"
APPLY_DIR="$RUN_DIR/apply"

mkdir -p "$SOURCE_DIR" "$TRAIN_DIR" "$REFRESH_DIR" "$APPLY_DIR"

if ! (cd "$ROOT_DIR" && node scripts/research/ws_state_edge_eval.js \
  --logs-dir logs \
  --out-dir "$SOURCE_DIR" \
  --x-spec "avgSpreadBps:0.90:ge,tradeRate:0.85:ge" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --sample-sec 5 \
  --move-bps 5 \
  --direction abs \
  --train-days 1 \
  --test-days 1 \
  --max-samples-per-day 0 >/tmp/ws_pattern_source.log 2>&1); then
  cat /tmp/ws_pattern_source.log || true
  exit 1
fi

EVENTS_CSV="$SOURCE_DIR/events_all.csv"
if [ ! -f "$EVENTS_CSV" ]; then
  echo "[ERROR] events file not found: $EVENTS_CSV"
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_pattern_discovery.js \
  --mode train \
  --events-csv "$EVENTS_CSV" \
  --out-dir "$TRAIN_DIR" \
  --clusters 6 \
  --test-days 1 \
  --event-move-bps 5 \
  --min-pattern-samples 30 >/tmp/ws_pattern_train.log 2>&1); then
  cat /tmp/ws_pattern_train.log || true
  exit 1
fi

MODEL_PATH="$TRAIN_DIR/pattern_model.json"
if [ ! -f "$MODEL_PATH" ]; then
  echo "[ERROR] model not found: $MODEL_PATH"
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_pattern_discovery.js \
  --mode refresh \
  --events-csv "$EVENTS_CSV" \
  --model-path "$MODEL_PATH" \
  --out-dir "$REFRESH_DIR" \
  --test-days 1 \
  --min-pattern-samples 30 \
  --refresh-min-fit-rate 0.03 >/tmp/ws_pattern_refresh.log 2>&1); then
  cat /tmp/ws_pattern_refresh.log || true
  exit 1
fi

REFRESH_MODEL="$REFRESH_DIR/pattern_model_refreshed.json"
if [ ! -f "$REFRESH_MODEL" ]; then
  echo "[ERROR] refreshed model not found: $REFRESH_MODEL"
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_pattern_discovery.js \
  --mode apply \
  --events-csv "$EVENTS_CSV" \
  --model-path "$REFRESH_MODEL" \
  --out-dir "$APPLY_DIR" >/tmp/ws_pattern_apply.log 2>&1); then
  cat /tmp/ws_pattern_apply.log || true
  exit 1
fi

DIGEST_TXT="$RUN_DIR/ws_pattern_digest_${MODE}.txt"
DIGEST_JSON="$RUN_DIR/ws_pattern_digest_${MODE}.json"
if ! (cd "$ROOT_DIR" && node scripts/research/ws_pattern_digest.js \
  --run-dir "$RUN_DIR" \
  --out "$DIGEST_TXT" \
  --json-out "$DIGEST_JSON" >/tmp/ws_pattern_digest.log 2>&1); then
  cat /tmp/ws_pattern_digest.log || true
  exit 1
fi

mkdir -p "$LATEST_DIR"
find "$LATEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$RUN_DIR/." "$LATEST_DIR/"

if ! "$ROOT_DIR/scripts/research/send_ws_pattern_digest_discord.sh" "$MODE" "$DIGEST_TXT" >/tmp/ws_pattern_discord.log 2>&1; then
  cat /tmp/ws_pattern_discord.log || true
  exit 1
fi

STATUS_PATH="$RUN_DIR/status.json"
node -e "const fs=require('fs');const p=process.argv[1];const j={ok:true,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6]};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"

echo "[OK] ws pattern ${MODE} reporting completed: $RUN_DIR"
