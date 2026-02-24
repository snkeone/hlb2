#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs/ops"
DATA_DIR="$ROOT_DIR/data"
REPORT_PATH="$LOG_DIR/research_cleanup_history.jsonl"

DRY_RUN="${DRY_RUN:-0}"
VALIDATION_RUN_KEEP_DAYS="${VALIDATION_RUN_KEEP_DAYS:-7}"
PATTERN_PIPELINE_RUN_KEEP_DAYS="${PATTERN_PIPELINE_RUN_KEEP_DAYS:-7}"
EDGE_PIPELINE_RUN_KEEP_DAYS="${EDGE_PIPELINE_RUN_KEEP_DAYS:-7}"
VALIDATION_RUN_MAX_KEEP="${VALIDATION_RUN_MAX_KEEP:-40}"
PATTERN_PIPELINE_RUN_MAX_KEEP="${PATTERN_PIPELINE_RUN_MAX_KEEP:-60}"
EDGE_PIPELINE_RUN_MAX_KEEP="${EDGE_PIPELINE_RUN_MAX_KEEP:-60}"
SMOKE_KEEP_DAYS="${SMOKE_KEEP_DAYS:-3}"
BACKFILL_KEEP_DAYS="${BACKFILL_KEEP_DAYS:-3}"

mkdir -p "$LOG_DIR"

utc_now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

delete_path() {
  local p="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY] rm -rf $p" >&2
    return 0
  fi
  rm -rf "$p"
}

prune_dir_mtime() {
  local target="$1"
  local keep_days="$2"
  local removed=0
  [ -d "$target" ] || { echo 0; return 0; }
  while IFS= read -r -d '' p; do
    delete_path "$p"
    removed=$((removed + 1))
  done < <(find "$target" -mindepth 1 -maxdepth 1 -type d -mtime +"$keep_days" -print0)
  echo "$removed"
}

prune_named_dirs() {
  local base="$1"
  local keep_days="$2"
  local pattern="$3"
  local removed=0
  [ -d "$base" ] || { echo 0; return 0; }
  while IFS= read -r -d '' p; do
    delete_path "$p"
    removed=$((removed + 1))
  done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "$pattern" -mtime +"$keep_days" -print0)
  echo "$removed"
}

prune_dir_by_count() {
  local target="$1"
  local max_keep="$2"
  local removed=0
  [ -d "$target" ] || { echo 0; return 0; }
  mapfile -t dirs < <(find "$target" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -n | awk '{print $2}')
  local total="${#dirs[@]}"
  if [ "$total" -le "$max_keep" ]; then
    echo 0
    return 0
  fi
  local to_remove=$((total - max_keep))
  for ((i=0; i<to_remove; i++)); do
    delete_path "${dirs[$i]}"
    removed=$((removed + 1))
  done
  echo "$removed"
}

removed_validation_runs="$(prune_dir_mtime "$DATA_DIR/validation/runs" "$VALIDATION_RUN_KEEP_DAYS")"
removed_pattern_runs="$(prune_dir_mtime "$LOG_DIR/ws_pattern_pipeline/runs" "$PATTERN_PIPELINE_RUN_KEEP_DAYS")"
removed_edge_runs="$(prune_dir_mtime "$LOG_DIR/ws_edge_pipeline/runs" "$EDGE_PIPELINE_RUN_KEEP_DAYS")"
removed_validation_runs_count="$(prune_dir_by_count "$DATA_DIR/validation/runs" "$VALIDATION_RUN_MAX_KEEP")"
removed_pattern_runs_count="$(prune_dir_by_count "$LOG_DIR/ws_pattern_pipeline/runs" "$PATTERN_PIPELINE_RUN_MAX_KEEP")"
removed_edge_runs_count="$(prune_dir_by_count "$LOG_DIR/ws_edge_pipeline/runs" "$EDGE_PIPELINE_RUN_MAX_KEEP")"

removed_smoke1="$(prune_named_dirs "$LOG_DIR" "$SMOKE_KEEP_DAYS" "ws_*_smoke")"
removed_smoke2="$(prune_named_dirs "$LOG_DIR" "$SMOKE_KEEP_DAYS" "ws_*_smoke2")"
removed_backfill="$(prune_named_dirs "$LOG_DIR" "$BACKFILL_KEEP_DAYS" "ws_pattern_backfill_*")"

summary_json="$(printf '%s' \
  "{\"ts\":\"$(utc_now_iso)\",\"dryRun\":$DRY_RUN,\"keepDays\":{\"validationRuns\":$VALIDATION_RUN_KEEP_DAYS,\"patternPipelineRuns\":$PATTERN_PIPELINE_RUN_KEEP_DAYS,\"edgePipelineRuns\":$EDGE_PIPELINE_RUN_KEEP_DAYS,\"smoke\":$SMOKE_KEEP_DAYS,\"backfill\":$BACKFILL_KEEP_DAYS},\"maxKeep\":{\"validationRuns\":$VALIDATION_RUN_MAX_KEEP,\"patternPipelineRuns\":$PATTERN_PIPELINE_RUN_MAX_KEEP,\"edgePipelineRuns\":$EDGE_PIPELINE_RUN_MAX_KEEP},\"removed\":{\"validationRunsByDays\":$removed_validation_runs,\"patternPipelineRunsByDays\":$removed_pattern_runs,\"edgePipelineRunsByDays\":$removed_edge_runs,\"validationRunsByCount\":$removed_validation_runs_count,\"patternPipelineRunsByCount\":$removed_pattern_runs_count,\"edgePipelineRunsByCount\":$removed_edge_runs_count,\"smoke\":$((removed_smoke1+removed_smoke2)),\"backfill\":$removed_backfill}}")"

echo "$summary_json" | tee -a "$REPORT_PATH"
