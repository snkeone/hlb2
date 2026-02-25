#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VERIFY_PID_FILE="$ROOT_DIR/.v2.verify.pid"
VALIDATION_PID_FILE="$ROOT_DIR/.v2.validation.pid"
LOG_DIR="$ROOT_DIR/logs"
OPS_LOG_DIR="$ROOT_DIR/logs/ops"
VERIFY_OUT="$LOG_DIR/stdout.log"
VERIFY_ERR="$LOG_DIR/error.log"
GUARD_LOG="$OPS_LOG_DIR/guard.log"
VALIDATION_OUT="$OPS_LOG_DIR/until_target.stdout.log"
VALIDATION_ERR="$OPS_LOG_DIR/until_target.stderr.log"
SHARED_FEED_FILE="${WS_SHARED_FEED_FILE:-/tmp/hlws-shared-feed.jsonl}"

mkdir -p "$LOG_DIR" "$OPS_LOG_DIR"

is_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  printf '%s\n' "$pid"
}

start_verify() {
  (
    cd "$ROOT_DIR"
    nohup env \
      MODE=live \
      TEST_MODE=1 \
      HL_ENABLE=1 \
      WS_PORT=8798 \
      LOG_TRADES_PATH=test-logs/trades.jsonl \
      WS_SHARED_FEED_FILE="$SHARED_FEED_FILE" \
      WS_RAW_LOG_ENABLED=0 \
      node ws/server.js >>"$VERIFY_OUT" 2>>"$VERIFY_ERR" < /dev/null &
    echo $! > "$VERIFY_PID_FILE"
  )
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] verify started pid=$(cat "$VERIFY_PID_FILE")" >>"$GUARD_LOG"
}

start_validation() {
  (
    cd "$ROOT_DIR"
    nohup bash scripts/ops/run_until_target.sh >>"$VALIDATION_OUT" 2>>"$VALIDATION_ERR" < /dev/null &
    echo $! > "$VALIDATION_PID_FILE"
  )
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] validation started pid=$(cat "$VALIDATION_PID_FILE")" >>"$GUARD_LOG"
}

ensure_verify() {
  local pid=""
  pid="$(read_pid "$VERIFY_PID_FILE" || true)"
  if ! is_alive "$pid"; then
    start_verify
  fi
}

ensure_validation() {
  local pid=""
  pid="$(read_pid "$VALIDATION_PID_FILE" || true)"
  if ! is_alive "$pid"; then
    start_validation
  fi
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] guard boot" >>"$GUARD_LOG"
ensure_verify
ensure_validation

while true; do
  ensure_verify
  ensure_validation
  sleep 20
done
