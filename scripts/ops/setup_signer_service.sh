#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[INFO] signer service setup helper"
echo "[INFO] this repository does not include signer_adapter runtime files."
echo "[INFO] configure your signer service separately, then set SIGNER_ADAPTER_URL in $ROOT_DIR/.env.local"
exit 1
