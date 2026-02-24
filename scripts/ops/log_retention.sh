#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="${1:-$ROOT_DIR/data}"
LOG_DIR="$ROOT_DIR/logs"
REPORT_DIR="$LOG_DIR/ops"

RAW_KEEP_DAYS="${RAW_KEEP_DAYS:-3}"
EVENT_KEEP_DAYS="${EVENT_KEEP_DAYS:-30}"
FEATURE_KEEP_DAYS="${FEATURE_KEEP_DAYS:-90}"
LOG_RAW_KEEP_DAYS="${LOG_RAW_KEEP_DAYS:-7}"
LOG_RAW_COLD_KEEP_DAYS="${LOG_RAW_COLD_KEEP_DAYS:-90}"
COMPRESS_LEVEL="${COMPRESS_LEVEL:-1}"

mkdir -p "$REPORT_DIR"

utc_now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
utc_today() { date -u +"%Y%m%d"; }

date_to_epoch() {
  local ymd="$1"
  date -u -d "${ymd:0:4}-${ymd:4:2}-${ymd:6:2} 00:00:00" +%s
}

days_old_from_ymd() {
  local ymd="$1"
  local now_s today_s
  now_s="$(date -u +%s)"
  today_s="$(date_to_epoch "$ymd")"
  echo $(( (now_s - today_s) / 86400 ))
}

compress_jsonl_in_dir() {
  local target_dir="$1"
  [ -d "$target_dir" ] || return 0
  find "$target_dir" -maxdepth 1 -type f -name '*.jsonl' -print0 | while IFS= read -r -d '' f; do
    gzip -"$COMPRESS_LEVEL" "$f"
  done
}

remove_by_days_pattern() {
  local target_dir="$1"
  local keep_days="$2"
  local file_prefix="$3"
  local removed=0

  [ -d "$target_dir" ] || { echo 0; return 0; }

  while IFS= read -r -d '' f; do
    local base ymd age
    base="$(basename "$f")"
    ymd="$(echo "$base" | sed -nE "s/^${file_prefix}([0-9]{8})\.jsonl(\.gz)?$/\1/p")"
    if [ -n "$ymd" ]; then
      age="$(days_old_from_ymd "$ymd")"
      if [ "$age" -gt "$keep_days" ]; then
        rm -f "$f"
        removed=$((removed + 1))
      fi
    fi
  done < <(find "$target_dir" -maxdepth 1 -type f \( -name "${file_prefix}*.jsonl" -o -name "${file_prefix}*.jsonl.gz" \) -print0)

  echo "$removed"
}

remove_by_mtime_days() {
  local target_dir="$1"
  local keep_days="$2"
  local removed=0
  [ -d "$target_dir" ] || { echo 0; return 0; }

  while IFS= read -r -d '' f; do
    rm -f "$f"
    removed=$((removed + 1))
  done < <(find "$target_dir" -maxdepth 1 -type f -mtime +"$keep_days" -print0)

  echo "$removed"
}

remove_by_mtime_pattern() {
  local target_dir="$1"
  local keep_days="$2"
  local pattern="$3"
  local removed=0
  [ -d "$target_dir" ] || { echo 0; return 0; }

  while IFS= read -r -d '' f; do
    rm -f "$f"
    removed=$((removed + 1))
  done < <(find "$target_dir" -maxdepth 1 -type f -name "$pattern" -mtime +"$keep_days" -print0)

  echo "$removed"
}

archive_log_raw_to_cold() {
  local hot_dir="$1"
  local cold_dir="$2"
  local hot_keep_days="$3"
  local moved=0
  [ -d "$hot_dir" ] || { echo 0; return 0; }
  mkdir -p "$cold_dir"

  while IFS= read -r -d '' f; do
    local base ymd age out
    base="$(basename "$f")"
    ymd="$(echo "$base" | sed -nE 's/^raw-([0-9]{8})\.jsonl$/\1/p')"
    [ -n "$ymd" ] || continue
    age="$(days_old_from_ymd "$ymd")"
    if [ "$age" -le "$hot_keep_days" ]; then
      continue
    fi
    out="$cold_dir/${base}.gz"
    if [ ! -f "$out" ]; then
      gzip -"$COMPRESS_LEVEL" -c "$f" > "$out"
    fi
    rm -f "$f"
    moved=$((moved + 1))
  done < <(find "$hot_dir" -maxdepth 1 -type f -name 'raw-*.jsonl' -print0)

  echo "$moved"
}

RAW_DIR="$DATA_DIR/raw_ws"
EVENT_DIR="$DATA_DIR/events"
FEATURE_DIR="$DATA_DIR/features"
LOG_RAW_DIR="$LOG_DIR"
LOG_RAW_COLD_DIR="$DATA_DIR/raw_ws_cold"

compress_jsonl_in_dir "$RAW_DIR"
compress_jsonl_in_dir "$EVENT_DIR"
compress_jsonl_in_dir "$FEATURE_DIR"

removed_raw="$(remove_by_days_pattern "$RAW_DIR" "$RAW_KEEP_DAYS" 'raw-')"
removed_events="$(remove_by_days_pattern "$EVENT_DIR" "$EVENT_KEEP_DAYS" 'events-')"
removed_features="$(remove_by_days_pattern "$FEATURE_DIR" "$FEATURE_KEEP_DAYS" 'features-')"
archived_log_raw="$(archive_log_raw_to_cold "$LOG_RAW_DIR" "$LOG_RAW_COLD_DIR" "$LOG_RAW_KEEP_DAYS")"
removed_log_raw_cold="$(remove_by_days_pattern "$LOG_RAW_COLD_DIR" "$LOG_RAW_COLD_KEEP_DAYS" 'raw-')"

# Safety fallback only for non-standard filenames: mtime-based prune.
removed_raw_mtime="$(remove_by_mtime_days "$RAW_DIR" "$RAW_KEEP_DAYS")"
removed_events_mtime="$(remove_by_mtime_days "$EVENT_DIR" "$EVENT_KEEP_DAYS")"
removed_features_mtime="$(remove_by_mtime_days "$FEATURE_DIR" "$FEATURE_KEEP_DAYS")"
removed_log_raw_mtime="$(remove_by_mtime_pattern "$LOG_RAW_DIR" "$LOG_RAW_KEEP_DAYS" 'raw-*.jsonl')"
removed_log_raw_cold_mtime="$(remove_by_mtime_pattern "$LOG_RAW_COLD_DIR" "$LOG_RAW_COLD_KEEP_DAYS" 'raw-*.jsonl.gz')"

summary_json="$(printf '%s' \
  "{\"ts\":\"$(utc_now_iso)\",\"dataDir\":\"$DATA_DIR\",\"logDir\":\"$LOG_DIR\",\"retentionDays\":{\"raw\":$RAW_KEEP_DAYS,\"events\":$EVENT_KEEP_DAYS,\"features\":$FEATURE_KEEP_DAYS,\"logRawHot\":$LOG_RAW_KEEP_DAYS,\"logRawCold\":$LOG_RAW_COLD_KEEP_DAYS},\"coldDir\":{\"logRaw\":\"$LOG_RAW_COLD_DIR\"},\"removed\":{\"rawByDate\":$removed_raw,\"eventsByDate\":$removed_events,\"featuresByDate\":$removed_features,\"logRawColdByDate\":$removed_log_raw_cold,\"rawByMtime\":$removed_raw_mtime,\"eventsByMtime\":$removed_events_mtime,\"featuresByMtime\":$removed_features_mtime,\"logRawByMtime\":$removed_log_raw_mtime,\"logRawColdByMtime\":$removed_log_raw_cold_mtime},\"archived\":{\"logRawToCold\":$archived_log_raw}}")"

echo "$summary_json" | tee -a "$REPORT_DIR/retention_history.jsonl"
