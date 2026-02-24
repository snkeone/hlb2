#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-daily}" # daily | weekly

if [ "$MODE" != "daily" ] && [ "$MODE" != "weekly" ]; then
  echo "Usage: $0 [daily|weekly]"
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="$ROOT_DIR/logs/ops/ws_edge_pipeline"
RUN_DIR="$BASE_DIR/runs/$RUN_ID"
LATEST_DIR="$BASE_DIR/latest"

COMPARE_DIR="$RUN_DIR/compare"
SWEEP_DIR="$RUN_DIR/sweep"
BRANCH_DIR="$RUN_DIR/branch"
mkdir -p "$COMPARE_DIR" "$SWEEP_DIR" "$BRANCH_DIR"

BRANCH_MAX_COMBOS=20
SWEEP_MOVE_LIST="5,8"
SWEEP_DIRECTION_LIST="abs,down"
if [ "$MODE" = "weekly" ]; then
  BRANCH_MAX_COMBOS=80
  SWEEP_MOVE_LIST="5,8,12"
  SWEEP_DIRECTION_LIST="abs,up,down"
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_edge_compare.js \
  --logs-dir logs \
  --out-dir "$COMPARE_DIR" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --sample-sec 5 \
  --move-bps 5 \
  --train-days 1 \
  --test-days 1 \
  --max-samples-per-day 0 >/tmp/ws_edge_compare.log 2>&1); then
  cat /tmp/ws_edge_compare.log || true
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_edge_sweep.js \
  --logs-dir logs \
  --out-dir "$SWEEP_DIR" \
  --x-spec "avgSpreadBps:0.90:ge,tradeRate:0.85:ge" \
  --move-bps-list "$SWEEP_MOVE_LIST" \
  --direction-list "$SWEEP_DIRECTION_LIST" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --post-window-sec 20 \
  --sample-sec 5 \
  --train-days 1 \
  --test-days 1 \
  --max-samples-per-day 0 \
  --min-nxy 30 >/tmp/ws_edge_sweep.log 2>&1); then
  cat /tmp/ws_edge_sweep.log || true
  exit 1
fi

if ! (cd "$ROOT_DIR" && node scripts/research/ws_branch_scan.js \
  --logs-dir logs \
  --out-dir "$BRANCH_DIR" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --post-window-sec 20 \
  --sample-sec 5 \
  --move-bps 5 \
  --direction abs \
  --train-days 1 \
  --test-days 1 \
  --min-base-a-n 200 \
  --min-group-n 50 \
  --min-dates 20 \
  --score-lambda 1 \
  --score-mu 20 \
  --top-k 20 \
  --max-combos "$BRANCH_MAX_COMBOS" >/tmp/ws_edge_branch.log 2>&1); then
  cat /tmp/ws_edge_branch.log || true
  exit 1
fi

DIGEST_TXT="$RUN_DIR/ws_edge_digest_${MODE}.txt"
DIGEST_JSON="$RUN_DIR/ws_edge_digest_${MODE}.json"
if ! (cd "$ROOT_DIR" && node scripts/research/ws_edge_digest.js \
  --mode "$MODE" \
  --run-dir "$RUN_DIR" \
  --out "$DIGEST_TXT" \
  --json-out "$DIGEST_JSON" >/tmp/ws_edge_digest.log 2>&1); then
  cat /tmp/ws_edge_digest.log || true
  exit 1
fi

mkdir -p "$LATEST_DIR"
find "$LATEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$RUN_DIR/." "$LATEST_DIR/"

if ! "$ROOT_DIR/scripts/research/send_ws_edge_digest_discord.sh" "$MODE" "$DIGEST_TXT" >/tmp/ws_edge_discord.log 2>&1; then
  cat /tmp/ws_edge_discord.log || true
  exit 1
fi

STATUS_PATH="$RUN_DIR/status.json"
node -e "const fs=require('fs');const p=process.argv[1];const j={ok:true,mode:process.argv[2],runId:process.argv[3],generatedAt:new Date().toISOString(),runDir:process.argv[4],digestTxt:process.argv[5],digestJson:process.argv[6]};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');" \
  "$STATUS_PATH" "$MODE" "$RUN_ID" "$RUN_DIR" "$DIGEST_TXT" "$DIGEST_JSON"

echo "[OK] ws edge ${MODE} reporting completed: $RUN_DIR"
