# V2 Operation Spec (Validation-Only)

## Scope
- V2 is used for:
  - WS data ingestion
  - validation logic execution
  - periodic validation cycle
- V2 is **not** used for live order execution in current operation.

## Mode Policy
- Default operation route: `TEST` (live feed + test logic route).
- Effective env for validation runtime:
  - `MODE=live`
  - `TEST_MODE=1`
  - `HL_ENABLE=1`
- Route meaning:
  - `MODE=live` + `TEST_MODE=1` => test route behavior for logic/decision validation.

## Runtime Start (Validation Logic)
- Current verified runtime command:
```bash
MODE=live TEST_MODE=1 HL_ENABLE=1 WS_PORT=8798 LOG_TRADES_PATH=test-logs/trades.jsonl node ws/server.js
```
- Notes:
  - `WS_PORT=8798` is used to avoid conflict with V1 (`8788`).
  - Runtime PID file for ops: `.v2.verify.pid`

## Periodic Validation Start
- Current verified periodic loop:
```bash
bash scripts/ops/run_until_target.sh
```
- Runtime behavior:
  - Picks latest collector raw log from:
    - `../ws_collector/logs/raw-*.jsonl*`
  - Runs validation cycle repeatedly until target is reached.
- PID file for ops: `.v2.validation.pid`

## Log and Output Paths
- V2 runtime logs:
  - `logs/stdout.log`
  - `logs/error.log`
  - `logs/markers.jsonl`
  - `logs/fatal.jsonl`
  - `logs/crash.log`
  - `logs/trades.jsonl`
- V2 test trade log:
  - `test-logs/trades.jsonl`
- Periodic validation loop logs:
  - `logs/ops/until_target.stdout.log`
  - `logs/ops/until_target.stderr.log`
  - `logs/ops/until_target.log`
- Validation run outputs:
  - `data/validation/runs/<run_id>/...`

## Raw Log Ownership
- Raw WS logs are owned by collector side.
- Collector paths:
  - Active: `../ws_collector/logs/raw-YYYYMMDD.jsonl`
  - V2 archive: `../ws_collector/logs/v2-raw-archive/`

## Start/Stop Quick Ops
- Check runtime:
```bash
ps -fp $(cat .v2.verify.pid)
```
- Check periodic validation:
```bash
ps -fp $(cat .v2.validation.pid)
```
- Stop runtime:
```bash
kill $(cat .v2.verify.pid)
```
- Stop periodic validation:
```bash
kill $(cat .v2.validation.pid)
```

## Current Cleanup Policy
- Keep only files required for validation operation.
- Remove broken references to non-existent `tests/` scripts.
- Move generated `raw-*.jsonl` from V2 to collector archive.
