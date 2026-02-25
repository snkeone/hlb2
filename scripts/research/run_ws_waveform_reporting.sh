#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-scheduled}"
COLLECTOR_LOG_DIR="${V2_COLLECTOR_LOG_DIR:-$ROOT_DIR/../ws_collector/logs}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="$ROOT_DIR/logs/ops/ws_waveform_pipeline"
RUN_DIR="$BASE_DIR/runs/$RUN_ID"
LATEST_DIR="$BASE_DIR/latest"

SOURCE_DIR="$RUN_DIR/source"
WAVE_DIR="$RUN_DIR/waveform"
LIQ_DIR="$RUN_DIR/liquidation"
LIQ_KEEP_DIR="$RUN_DIR/liquidation_keep"
mkdir -p "$SOURCE_DIR" "$WAVE_DIR" "$LIQ_DIR" "$LIQ_KEEP_DIR"

if ! (cd "$ROOT_DIR" && node scripts/research/ws_state_edge_eval.js \
  --logs-dir "$COLLECTOR_LOG_DIR" \
  --out-dir "$SOURCE_DIR" \
  --x-spec "avgSpreadBps:0.90:ge,tradeRate:0.85:ge" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --sample-sec 5 \
  --move-bps 5 \
  --direction abs \
  --train-days 1 \
  --test-days 1 \
  --max-samples-per-day 0 >/tmp/ws_wave_source.log 2>&1); then
  cat /tmp/ws_wave_source.log || true
  exit 1
fi

EVENTS_CSV="$SOURCE_DIR/events_all.csv"
if [ ! -f "$EVENTS_CSV" ]; then
  echo "[ERROR] events file not found: $EVENTS_CSV"
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_waveform_pattern_extract.js \
  --events-csv "$EVENTS_CSV" \
  --out-dir "$WAVE_DIR" \
  --event-move-bps 5 \
  --pre-sec 90 \
  --post-sec 10 \
  --cluster-pre-sec 60 \
  --wave-type rolling_delta \
  --clusters 6 \
  --min-pattern-samples 30 >/tmp/ws_wave_extract.log 2>&1); then
  cat /tmp/ws_wave_extract.log || true
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_liq_monitor.js \
  --logs-dir "$COLLECTOR_LOG_DIR" \
  --out-dir "$LIQ_DIR" \
  --max-days 3 \
  --window-sec 10 \
  --burst-usd 100000 \
  --horizons-sec 30,60,180 \
  --cooldown-sec 20 >/tmp/ws_wave_liq_monitor.log 2>&1); then
  cat /tmp/ws_wave_liq_monitor.log || true
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_liq_wave_join.js \
  --liq-events-csv "$LIQ_DIR/liq_events.csv" \
  --wave-events-csv "$EVENTS_CSV" \
  --out-dir "$LIQ_DIR" \
  --match-window-sec 30 \
  --move-bps 5 >/tmp/ws_wave_liq_join.log 2>&1); then
  cat /tmp/ws_wave_liq_join.log || true
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_liq_wave_join.js \
  --liq-events-csv "$LIQ_DIR/liq_events.csv" \
  --wave-events-csv "$EVENTS_CSV" \
  --wave-assignments-csv "$WAVE_DIR/waveform_assignments.csv" \
  --pattern-status keep \
  --out-dir "$LIQ_KEEP_DIR" \
  --match-window-sec 30 \
  --move-bps 5 >/tmp/ws_wave_liq_join_keep.log 2>&1); then
  cat /tmp/ws_wave_liq_join_keep.log || true
  exit 1
fi

DIGEST_TXT="$RUN_DIR/ws_waveform_digest_${MODE}.txt"
DIGEST_JSON="$RUN_DIR/ws_waveform_digest_${MODE}.json"
if ! (cd "$ROOT_DIR" && node scripts/research/ws_waveform_digest.js \
  --run-dir "$RUN_DIR" \
  --out "$DIGEST_TXT" \
  --json-out "$DIGEST_JSON" >/tmp/ws_wave_digest.log 2>&1); then
  cat /tmp/ws_wave_digest.log || true
  exit 1
fi

STATUS_PATH="$RUN_DIR/status.json"
node -e "const fs=require('fs');const p=process.argv[1];const j={ok:false,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6],notificationOk:false};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"

mkdir -p "$LATEST_DIR"
find "$LATEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$RUN_DIR/." "$LATEST_DIR/"

if ! "$ROOT_DIR/scripts/research/send_ws_waveform_digest_discord.sh" "$MODE" "$DIGEST_TXT" >/tmp/ws_wave_discord.log 2>&1; then
  cat /tmp/ws_wave_discord.log || true
  exit 1
fi

node -e "const fs=require('fs');const p=process.argv[1];const j={ok:true,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6],notificationOk:true};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"
cp -a "$STATUS_PATH" "$LATEST_DIR/status.json"

echo "[OK] ws waveform ${MODE} reporting completed: $RUN_DIR"
