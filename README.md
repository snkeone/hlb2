# HLB2

V2 repository for data-first WS validation and execution-reality checks.

## Scope
- V1 (`/home/hlws/hlws-bot`) is frozen.
- V2 (`/home/hlws/hlb2`) is independent and can evolve freely.
- Focus: ingest WS data, extract features, run placebo-aware validation, decide by KPI.

## Repo Setup
```bash
cd /home/hlws/hlb2
npm ci
cp .env.example .env
```

Push to remote:
```bash
git remote add origin git@github.com:<you>/<hlb2-repo>.git
git push -u origin main
```

## Data Policy
- Do not commit raw logs or generated validation outputs.
- Git-tracked code/config only.
- Runtime artifacts go to local `data/` and `logs/`.

## Core Commands
WS feature extraction:
```bash
npm run v2:ws:viz -- \
  --input /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz \
  --out-dir /home/hlws/hlb2/data/ws-visual \
  --sample-ms 250
```

Truth validation (events + placebo):
```bash
npm run v2:eval:truth -- \
  --input /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz \
  --out-dir /home/hlws/hlb2/data/validation/run-latest \
  --sample-ms 250
```

Judgement:
```bash
npm run v2:eval:judge -- --out-dir /home/hlws/hlb2/data/validation/run-latest
```

Split validation (Train / Validate / Forward):
```bash
npm run v2:eval:split -- \
  --train /home/hlws/hlws-bot/logs/raw-20260220.jsonl.gz,/home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz \
  --validate /home/hlws/hlws-bot/logs/raw-20260222.jsonl.gz \
  --forward /home/hlws/hlws-bot/logs/raw-20260223.jsonl.gz
```

Full cycle (status + Discord report):
```bash
npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

Manual progress notification to Discord:
```bash
npm run v2:notify -- progress "Step 3 dual-sync integrated"
npm run v2:notify -- done "Validation batch completed"
npm run v2:notify -- failed "Run aborted due to missing input"
```

WS lead research (short + mid horizon) daily/weekly automation:
```bash
# Webhook selection (priority):
# 1) WS_LEAD_DISCORD_WEBHOOK_URL (optional dedicated channel)
# 2) DISCORD_WEBHOOK_URL (existing V2 default hook)

# Build short/mid metrics + stability + relation
npm run research:lead:daily

# Create digest text/json
npm run research:lead:digest:daily
npm run research:lead:digest:weekly

# Send digest to Discord
npm run research:lead:discord:daily
npm run research:lead:discord:weekly

# One-shot automation (run + verify + digest + discord notify)
npm run research:lead:report:daily
npm run research:lead:report:weekly
```

WS state edge evaluation (X -> Y conditional probability + walk-forward):
```bash
# Evaluate all logs/raw-YYYYMMDD.jsonl files
npm run research:edge:eval -- \
  --logs-dir logs \
  --out-dir logs/ops/ws_edge_eval \
  --x-spec "avgSpreadBps:0.90:ge,tradeRate:0.85:ge,wallStrengthP90:0.80:ge" \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --move-bps 5 \
  --direction abs \
  --sample-sec 5 \
  --train-days 20 \
  --test-days 5

# Evaluate a single raw day file
npm run research:edge:eval -- \
  --raw logs/raw-20260223.jsonl \
  --out-dir logs/ops/ws_edge_eval_20260223
```

WS edge candidate compare (3 fixed X candidates, 4-axis scoring, winner direction check):
```bash
npm run research:edge:compare -- \
  --logs-dir logs \
  --out-dir logs/ops/ws_edge_compare \
  --lead-window-sec 20 \
  --horizon-sec 10 \
  --move-bps 5 \
  --train-days 20 \
  --test-days 5 \
  --fee-bps 0.8 \
  --slippage-bps 1.2
```

## Outputs
- `events_labeled.csv`: event labels with pessimistic columns (`dynSlipBps`, `net30Pes`, `makerFilled`)
- `event_stats.csv`: aggregated KPI per cohort/type/side
- `event_stats_regime.csv`: KPI per regime bucket (`vol/spread/liquidity`)
- `candles_1s.csv`: reconstructed 1s candle view
- `summary.json`: run parameters and counters

WS edge evaluation outputs (`--out-dir`):
- `summary.json`: in-sample `P(Y)`, `P(Y|X)`, uplift, CI, and OOS walk-forward aggregates
- `events_all.csv`: timestamp-level rows with `xHit`, `yHit`, return, and WS features
- `walkforward.csv`: fold-level OOS metrics (`py`, `pyx`, uplift, ratio, coverage, thresholds)

WS edge compare outputs (`--out-dir`):
- `compare_summary.json`: 3候補の横比較、4軸スコア、勝者、up/down方向チェック
- `compare_table.csv`: スクリーニング向けの一覧テーブル
- `<candidate>/summary.json`: 各候補の個別評価結果（`ws_state_edge_eval`出力）

## Live Shadow Test
Enable pseudo-execution logging on runtime (no real order impact):
```bash
V2_SHADOW_ENABLED=1 V2_SHADOW_HOLD_MS=30000 V2_SHADOW_NOTIONAL_USD=1000 node ws/server.js
```

Shadow logs are written via runtime logger as:
- `type=shadow_open`
- `type=shadow_close`

Summarize shadow performance:
```bash
npm run v2:shadow:summary -- --input /home/hlws/hlb2/logs/raw-YYYYMMDD.jsonl --out /home/hlws/hlb2/data/validation/shadow_summary.json
```

## Done Signal
Validation completion is confirmed by:
- `logs/ops/validation_status.json` with `state=done`
- `logs/ops/VALIDATION_DONE`
- run folder in `data/validation/runs/<UTC_RUN_ID>/`
