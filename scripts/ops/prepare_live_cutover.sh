#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[INFO] running strict live preflight"
node "$ROOT_DIR/scripts/ops/live_preflight.js" --strict

echo "[OK] live preflight passed"
echo "[INFO] ready for live cutover"
