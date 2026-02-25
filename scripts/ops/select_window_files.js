#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';

function ymdFromUtcMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function utcStartOfDayMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function buildDateRange(fromMs, toMs) {
  const out = [];
  let cur = utcStartOfDayMs(fromMs);
  const end = utcStartOfDayMs(toMs);
  while (cur <= end) {
    out.push(ymdFromUtcMs(cur));
    cur += 86400000;
  }
  return out;
}

function findExistingByDate(dir, prefix, ymd) {
  const jsonl = path.join(dir, `${prefix}${ymd}.jsonl`);
  const gz = `${jsonl}.gz`;
  if (fs.existsSync(jsonl)) return jsonl;
  if (fs.existsSync(gz)) return gz;
  return null;
}

function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['dir', 'prefix', 'out'],
    boolean: ['allow-empty'],
    default: {
      dir: '../ws_collector/logs',
      prefix: 'raw-',
      'pad-before-ms': 120000,
      'pad-after-ms': 120000,
      'allow-empty': false
    }
  });

  const fromMs = Number(argv['from-ms']);
  const toMs = Number(argv['to-ms']);
  const padBeforeMs = Number(argv['pad-before-ms']);
  const padAfterMs = Number(argv['pad-after-ms']);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    console.error('[ERR] invalid window: require --from-ms and --to-ms (UTC epoch ms)');
    process.exit(1);
  }

  const dir = path.resolve(String(argv.dir));
  const prefix = String(argv.prefix);
  const fromWithPad = fromMs - Math.max(0, padBeforeMs);
  const toWithPad = toMs + Math.max(0, padAfterMs);

  const ymds = buildDateRange(fromWithPad, toWithPad);
  const files = ymds
    .map((ymd) => findExistingByDate(dir, prefix, ymd))
    .filter(Boolean);

  if (!argv['allow-empty'] && files.length === 0) {
    console.error('[ERR] no files found for window');
    process.exit(2);
  }

  const result = {
    window: {
      fromMs,
      toMs,
      padBeforeMs,
      padAfterMs,
      fromWithPad,
      toWithPad
    },
    dir,
    prefix,
    ymds,
    files,
    generatedAt: new Date().toISOString()
  };

  if (argv.out) {
    const outPath = path.resolve(String(argv.out));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
