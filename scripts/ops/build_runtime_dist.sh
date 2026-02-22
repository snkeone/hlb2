#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-runtime"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
for d in ws engine io logic config core executor debug scripts; do
  [ -d "$ROOT_DIR/$d" ] && rsync -a "$ROOT_DIR/$d/" "$OUT_DIR/$d/"
done
for f in index.js package.json; do
  [ -f "$ROOT_DIR/$f" ] && cp -f "$ROOT_DIR/$f" "$OUT_DIR/$f"
done

echo "[OK] runtime dist prepared: $OUT_DIR"
