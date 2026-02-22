#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CMD="bash $ROOT_DIR/scripts/send_kpi_alert_report.sh >> $ROOT_DIR/logs/kpi-mail.log 2>&1"
( crontab -l 2>/dev/null | grep -Fv "$CMD" ) | crontab -
echo "[OK] removed kpi-mail cron"
