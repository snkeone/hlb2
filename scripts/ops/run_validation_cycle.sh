#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS_DIR="$ROOT_DIR/logs/ops"
RUNS_DIR="$ROOT_DIR/data/validation/runs"
mkdir -p "$STATUS_DIR" "$RUNS_DIR"

# Load local env overrides (not tracked by git)
if [ -f "$ROOT_DIR/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env.local"
  set +a
fi

STATUS_FILE="$STATUS_DIR/validation_status.json"
LAST_OK_FILE="$STATUS_DIR/validation_last_ok.json"
DONE_MARKER="$STATUS_DIR/VALIDATION_DONE"

INPUT="${1:-/home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz}"
MAX_LINES="${MAX_LINES:-0}"
SAMPLE_MS="${SAMPLE_MS:-250}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$RUNS_DIR/$RUN_ID"
NOTIFY_CMD="${V2_NOTIFY_CMD:-}"

write_status() {
  local state="$1"
  local msg="$2"
  cat > "$STATUS_FILE" <<JSON
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","state":"$state","runId":"$RUN_ID","input":"$INPUT","outDir":"$OUT_DIR","message":"$msg"}
JSON
}

notify_user() {
  local level="$1"
  local msg="$2"
  local mail_script="$ROOT_DIR/scripts/ops/send_validation_report_mail.sh"
  local discord_script="$ROOT_DIR/scripts/ops/send_validation_report_discord.sh"
  local email_enabled="${V2_NOTIFY_EMAIL_ENABLED:-0}"

  # 1) Optional external notifier (recommended for long runs)
  # Example:
  # V2_NOTIFY_CMD='notify-send "HLB2"'
  # V2_NOTIFY_CMD='bash -lc "echo HLB2:$1:$2 | mail -s HLB2 you@example.com"'
  if [ -n "$NOTIFY_CMD" ]; then
    set +e
    bash -lc "$NOTIFY_CMD \"$level\" \"$msg\" \"$RUN_ID\" \"$OUT_DIR\""
    set -e
  fi

  # 2) Discord webhook notification (recommended)
  if [ -x "$discord_script" ]; then
    set +e
    "$discord_script" "$level" "$msg" "$RUN_ID" "$OUT_DIR"
    set -e
  fi

  # 3) Optional email notification (disabled by default)
  if [ "$email_enabled" = "1" ] && [ -x "$mail_script" ]; then
    set +e
    "$mail_script" "$level" "$msg" "$RUN_ID" "$OUT_DIR"
    set -e
  fi

  # 4) Local terminal bell fallback
  # Works when running in an attached terminal.
  printf '\a' || true
}

write_status "running" "validation cycle started"

mkdir -p "$OUT_DIR"
rm -f "$DONE_MARKER"

set +e
node "$ROOT_DIR/scripts/validation/ws_event_truth_eval.js" \
  --input "$INPUT" \
  --out-dir "$OUT_DIR" \
  --max-lines "$MAX_LINES" \
  --sample-ms "$SAMPLE_MS"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  write_status "failed" "validation cycle failed"
  notify_user "failed" "Validation failed (run=$RUN_ID)"
  exit "$RC"
fi

set +e
node "$ROOT_DIR/scripts/validation/judge_validation_results.js" --run-dir "$OUT_DIR"
JUDGE_RC=$?
set -e
if [ "$JUDGE_RC" -ne 0 ]; then
  write_status "failed" "validation judgement failed"
  notify_user "failed" "Validation judgement failed (run=$RUN_ID)"
  exit "$JUDGE_RC"
fi

cp -f "$STATUS_FILE" "$LAST_OK_FILE"
write_status "done" "validation cycle completed"
cat > "$DONE_MARKER" <<EOF2
run_id=$RUN_ID
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out_dir=$OUT_DIR
EOF2

echo "[OK] validation completed: $OUT_DIR"
echo "[OK] status: $STATUS_FILE"
echo "[OK] marker: $DONE_MARKER"
notify_user "done" "Validation completed (run=$RUN_ID)"
