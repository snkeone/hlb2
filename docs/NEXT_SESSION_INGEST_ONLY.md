# Next Session: ingest-only 分離

## Goal
- WS収集を strategy/executor から分離して、`ingest-only` を独立稼働できるようにする。
- まずは最小版（運用開始可能ライン）まで実装する。

## Scope (next session)
1. `ingest-only` 起動エントリ作成（WS購読 + normalize + raw保存のみ）
2. `hlb` から `up/down` 可能にする（既存起動と競合しない）
3. ポート競合・ログ競合の最低対策
4. 1本rawで動作確認

## Current baseline (done)
- raw backtest base:
  - `npm run ops:raw-backtest`
  - `npm run ops:raw-backtest:grid`
  - `npm run ops:sim-from-events`
- smoke output:
  - `data/validation/run-v1-20260221-trade-smoke/simulated_summary.json`
  - `data/validation/run-v1-20260221-trade-smoke/simulated_trades.csv`

## First commands
```bash
cd /home/snkeone/projects/hlws-v2
git status --short
```

## Candidate implementation points
- `ws/server.js`
- `ws/runtime.js`
- `bin/hlb`
- `ws/utils/logger.js`

## Guard rails
- デフォルト `8788` 競合を避ける（ingest側を別ポート or status接続先を分離）
- ingest-only は decision/executor/notify を呼ばない
- rawログは専用パスを切る（同時書き込み回避）

## Definition of done (minimum)
- `ingest-only up` でWS購読開始
- rawログへ継続追記
- `ingest-only down` で確実停止
- 既存 strategy 側と同時に落ちずに起動できる
