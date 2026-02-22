#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"
exec node scripts/ops/auto_tune_from_logs.js --apply --adaptive "$@"
