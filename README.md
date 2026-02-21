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

Full cycle (status + mail report):
```bash
REPORT_EMAIL=your@mail.example npm run v2:run:cycle -- /home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz
```

## Outputs
- `events_labeled.csv`: event labels with pessimistic columns (`dynSlipBps`, `net30Pes`, `makerFilled`)
- `event_stats.csv`: aggregated KPI per cohort/type/side
- `candles_1s.csv`: reconstructed 1s candle view
- `summary.json`: run parameters and counters

## Done Signal
Validation completion is confirmed by:
- `logs/ops/validation_status.json` with `state=done`
- `logs/ops/VALIDATION_DONE`
- run folder in `data/validation/runs/<UTC_RUN_ID>/`
