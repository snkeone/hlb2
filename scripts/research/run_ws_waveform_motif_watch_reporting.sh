#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-scheduled}"
ALERT_CONSECUTIVE_DECLINES="${WS_WAVEFORM_MOTIF_ALERT_DECLINES:-2}"
MAX_RUNS="${WS_WAVEFORM_MOTIF_MAX_RUNS:-30}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="$ROOT_DIR/logs/ops/ws_waveform_motif_watch_pipeline"
RUN_DIR="$BASE_DIR/runs/$RUN_ID"
LATEST_DIR="$BASE_DIR/latest"
mkdir -p "$RUN_DIR"

DIGEST_TXT="$RUN_DIR/ws_waveform_motif_watch_digest_${MODE}.txt"
DIGEST_JSON="$RUN_DIR/ws_waveform_motif_watch_digest_${MODE}.json"
STATUS_PATH="$RUN_DIR/status.json"

node -e "const fs=require('fs');const p=process.argv[1];const j={ok:false,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6],notificationOk:false};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"

if ! (cd "$ROOT_DIR" && node scripts/research/ws_waveform_motif_watch_digest.js \
  --runs-dir logs/ops/ws_waveform_pipeline/runs \
  --out "$DIGEST_TXT" \
  --json-out "$DIGEST_JSON" \
  --alert-consecutive-declines "$ALERT_CONSECUTIVE_DECLINES" \
  --max-runs "$MAX_RUNS" >/tmp/ws_wave_motif_digest.log 2>&1); then
  cat /tmp/ws_wave_motif_digest.log || true
  exit 1
fi

mkdir -p "$LATEST_DIR"
find "$LATEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$RUN_DIR/." "$LATEST_DIR/"

if ! "$ROOT_DIR/scripts/research/send_ws_waveform_motif_watch_digest_discord.sh" "$MODE" "$DIGEST_TXT" >/tmp/ws_wave_motif_discord.log 2>&1; then
  cat /tmp/ws_wave_motif_discord.log || true
  exit 1
fi

node -e "const fs=require('fs');const p=process.argv[1];const j={ok:true,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6],notificationOk:true};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"
cp -a "$STATUS_PATH" "$LATEST_DIR/status.json"

echo "[OK] ws waveform motif watch ${MODE} reporting completed: $RUN_DIR"
