# HLB2

V2 experimental workspace for data-first trading validation.

## Goal
- Keep V1 (`hlws-bot`) untouched.
- Build and validate WS-driven logic with reproducible metrics.
- Use data to decide adoption/rejection of signals.

## Current Scope
- Reused from V1: `ws/`, `io/`, `engine/`, `executor/`, `logic/`, `config/`, `core/`.
- UI is intentionally excluded for now.
- Focus is: WS ingest, feature extraction, event validation, paper execution behavior.

## Immediate Next Steps
1. Add `v2` validation pipeline (events/labels/kpi) in this workspace.
2. Freeze KPI before experiments.
3. Compare hypothesis events vs placebo in the same run window.

## WS Pressure Visualization
Use this to generate data-first features from raw WS logs (orderbook/trades) without fallback logic.

Command:
```bash
npm run v2:ws:viz -- \
  --input /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz \
  --out-dir /home/hlws/hlb2/data/ws-visual \
  --sample-ms 250
```

Outputs:
- `feature_timeseries.csv`: distance-bucket pressure, imbalance, burst, trend angle, IN/OUT hint columns
- `summary.json`: run parameters and aggregate counters

Key columns:
- `bid_pressure_total_usd`, `ask_pressure_total_usd`
- `strongest_bid_dist_usd`, `strongest_ask_dist_usd`
- `trend_bps_per_sec`, `trend_angle_deg`
- `target_ok_long/short`, `pressure_ok_long/short`, `in_long_hint`, `in_short_hint`

## UTC Window Safety (Day-Boundary)
Always select analysis files by UTC epoch ms window, not calendar text.

Command:
```bash
npm run v2:window:files -- \
  --dir /home/hlws/hlb2/data/raw_ws \
  --from-ms 1771599600000 \
  --to-ms 1771603200000 \
  --pad-before-ms 120000 \
  --pad-after-ms 120000 \
  --out /home/hlws/hlb2/data/runs/window_files.json
```

This ensures cross-day windows include adjacent files when needed.

## Log Retention
Use tiered retention to avoid V1-style log explosion.

Command:
```bash
RAW_KEEP_DAYS=3 EVENT_KEEP_DAYS=30 FEATURE_KEEP_DAYS=90 \
npm run v2:logs:retention -- /home/hlws/hlb2/data
```

Expected folders:
- `data/raw_ws` (short retention)
- `data/events` (mid retention)
- `data/features` (long retention)

## Truth Validation Batch (Data-only)
This batch is for validation only, separate from strategy runtime.

Command:
```bash
npm run v2:eval:truth -- \
  --input /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz \
  --out-dir /home/hlws/hlb2/data/validation/run-latest \
  --sample-ms 250
```

Outputs:
- `events_labeled.csv`: event-level forward labels and fee-aware net labels
- `event_stats.csv`: aggregated stats by event type/side with placebo comparison
- `candles_1s.csv`: reconstructed 1s candles for reality check
- `summary.json`: params and counters

## Completion Signal (Easy Check)
Run one validation cycle with status files:

```bash
npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

Completion is confirmed by:
- `logs/ops/validation_status.json` with `"state":"done"`
- `logs/ops/VALIDATION_DONE` marker file exists
- output folder generated under `data/validation/runs/<UTC_RUN_ID>/`

If you may miss completion timing, use notification:
```bash
cd /home/hlws/hlb2
V2_NOTIFY_CMD='notify-send "HLB2 Validation"' npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

Arguments passed to `V2_NOTIFY_CMD`:
1. status (`done` or `failed`)
2. message
3. run id
4. output directory

Email (reuses V1 msmtp style):
```bash
cd /home/hlws/hlb2
REPORT_EMAIL=your@mail.example npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

Notes:
- Uses `/usr/bin/msmtp` by default.
- Sends compact report with `summary.json` and top lines of `event_stats.csv`.
- For local test without sending, use:
```bash
V2_MAIL_DRY_RUN=1 npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

## Notes
- This folder is independent from `/home/hlws/hlws-bot`.
- Keep all experiment outputs under local `logs/` or `data/` in this folder.
