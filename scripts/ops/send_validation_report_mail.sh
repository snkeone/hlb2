#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS="${1:-unknown}"
MESSAGE="${2:-validation status update}"
RUN_ID="${3:-unknown}"
OUT_DIR="${4:-$ROOT_DIR/data/validation/runs/$RUN_ID}"

REPORT_EMAIL="${REPORT_EMAIL:-snkeone@icloud.com}"
MSMTP_BIN="${MSMTP_BIN:-/usr/bin/msmtp}"
DRY_RUN="${V2_MAIL_DRY_RUN:-0}"

if [ ! -x "$MSMTP_BIN" ] && [ "$DRY_RUN" != "1" ]; then
  echo "[WARN] msmtp not found: $MSMTP_BIN"
  exit 0
fi

UP_STATUS="$(echo "$STATUS" | tr '[:lower:]' '[:upper:]')"
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SUBJECT="HLB2 Validation ${UP_STATUS} ${RUN_ID}"

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

{
  echo "HLB2 Validation ${UP_STATUS}"
  echo
  echo "Time (UTC): $NOW_UTC"
  echo "Run ID    : $RUN_ID"
  echo "Status    : $STATUS"
  echo "Message   : $MESSAGE"
  echo "Out Dir   : $OUT_DIR"
  echo

  if [ -f "$OUT_DIR/summary.json" ]; then
    echo "[summary.json]"
    cat "$OUT_DIR/summary.json"
    echo
  else
    echo "[summary.json] not found"
    echo
  fi

  if [ -f "$OUT_DIR/event_stats.csv" ]; then
    echo "[event_stats.csv top]"
    head -n 12 "$OUT_DIR/event_stats.csv"
    echo
  else
    echo "[event_stats.csv] not found"
    echo
  fi

  if [ -f "$OUT_DIR/validation_summary.txt" ]; then
    echo "[validation_summary.txt]"
    cat "$OUT_DIR/validation_summary.txt"
    echo
  else
    echo "[validation_summary.txt] not found"
    echo
  fi

  if [ -f "$ROOT_DIR/logs/ops/validation_status.json" ]; then
    echo "[validation_status.json]"
    cat "$ROOT_DIR/logs/ops/validation_status.json"
    echo
  fi
} > "$TMP_BODY"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY-RUN] subject: $SUBJECT"
  cat "$TMP_BODY"
  exit 0
fi

{
  echo "Subject: $SUBJECT"
  echo
  cat "$TMP_BODY"
} | "$MSMTP_BIN" "$REPORT_EMAIL"

echo "[OK] validation mail sent to $REPORT_EMAIL"
