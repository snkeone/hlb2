#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return 0;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
  return (a / b) * 100;
}

function resolveDefaultRawFile(rootDir) {
  const logsDir = path.join(rootDir, 'logs');
  if (!fs.existsSync(logsDir)) return null;
  const files = fs.readdirSync(logsDir)
    .filter(name => /^raw-\d{8}\.jsonl$/.test(name))
    .map(name => path.join(logsDir, name))
    .sort();
  return files.length > 0 ? files[files.length - 1] : null;
}

function scan(file, windowHours = 12) {
  const now = Date.now();
  const fromTs = now - Math.max(1, windowHours) * 3600 * 1000;

  let totalDecisionTrace = 0;
  let bNone = 0;
  let bEntryAllowed = 0;
  let noStructuralTp = 0;
  let noTpAvailable = 0;
  let noStructuralPath = 0;
  const reasonMap = new Map();
  const rejectedTpSourceMap = new Map();
  const tpSourceMap = new Map();

  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (_) {
      continue;
    }
    if (obj?.type !== 'decision_trace') continue;
    const ts = toNum(obj.ts, 0);
    if (ts < fromTs) continue;
    totalDecisionTrace += 1;

    const reason = String(obj?.payload?.decision?.reason ?? 'unknown');
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
    if (reason.includes('entry allowed')) bEntryAllowed += 1;
    if (reason === 'B: no structural tp') noStructuralTp += 1;
    if (reason === 'B: no tp available') noTpAvailable += 1;
    if (reason === 'B: no structural path') noStructuralPath += 1;
    if (String(obj?.payload?.decision?.side ?? '') === 'none') bNone += 1;

    const rejectedTpSource = String(obj?.payload?.decision?.phase4?.rejectedTpSource ?? '');
    if (rejectedTpSource) {
      rejectedTpSourceMap.set(rejectedTpSource, (rejectedTpSourceMap.get(rejectedTpSource) ?? 0) + 1);
    }

    const tpSource = String(obj?.payload?.context?.bResult?.tpSource ?? '');
    if (tpSource) {
      tpSourceMap.set(tpSource, (tpSourceMap.get(tpSource) ?? 0) + 1);
    }
  }

  const reasons = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count, rate: round(pct(count, totalDecisionTrace), 2) }))
    .sort((a, b) => b.count - a.count);

  const rejectedTpSources = [...rejectedTpSourceMap.entries()]
    .map(([source, count]) => ({ source, count, rate: round(pct(count, totalDecisionTrace), 2) }))
    .sort((a, b) => b.count - a.count);

  const tpSources = [...tpSourceMap.entries()]
    .map(([source, count]) => ({ source, count, rate: round(pct(count, totalDecisionTrace), 2) }))
    .sort((a, b) => b.count - a.count);

  return {
    file,
    windowHours,
    summary: {
      totalDecisionTrace,
      noneRate: round(pct(bNone, totalDecisionTrace), 2),
      entryAllowedRate: round(pct(bEntryAllowed, totalDecisionTrace), 2),
      noStructuralTpRate: round(pct(noStructuralTp, totalDecisionTrace), 2),
      noTpAvailableRate: round(pct(noTpAvailable, totalDecisionTrace), 2),
      noStructuralPathRate: round(pct(noStructuralPath, totalDecisionTrace), 2)
    },
    rejectedTpSources,
    tpSources,
    reasonsTop: reasons.slice(0, 10)
  };
}

function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['file'],
    boolean: ['json'],
    default: {
      windowHours: 12,
      json: false
    }
  });
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const file = argv.file ? path.resolve(String(argv.file)) : resolveDefaultRawFile(rootDir);
  if (!file || !fs.existsSync(file)) {
    console.error('[decision_reason_scan] raw file not found');
    process.exit(1);
  }
  const report = scan(file, Number(argv.windowHours));
  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('== Decision Reason Scan ==');
  console.log(`file: ${report.file}`);
  console.log(`windowHours: ${report.windowHours}`);
  console.log('');
  console.log('[summary]');
  console.log(`decisionTrace=${report.summary.totalDecisionTrace} entryAllowedRate=${report.summary.entryAllowedRate}% noneRate=${report.summary.noneRate}%`);
  console.log(`noStructuralTpRate=${report.summary.noStructuralTpRate}% noTpAvailableRate=${report.summary.noTpAvailableRate}% noStructuralPathRate=${report.summary.noStructuralPathRate}%`);
  console.log('');
  console.log('[rejectedTpSources]');
  if (report.rejectedTpSources.length === 0) {
    console.log('none');
  } else {
    for (const row of report.rejectedTpSources) {
      console.log(`source=${row.source} count=${row.count} rate=${row.rate}%`);
    }
  }
  console.log('');
  console.log('[tpSources]');
  if (report.tpSources.length === 0) {
    console.log('none');
  } else {
    for (const row of report.tpSources.slice(0, 8)) {
      console.log(`source=${row.source} count=${row.count} rate=${row.rate}%`);
    }
  }
  console.log('');
  console.log('[reasonsTop]');
  for (const row of report.reasonsTop) {
    console.log(`reason=${row.reason} count=${row.count} rate=${row.rate}%`);
  }
}

main();
