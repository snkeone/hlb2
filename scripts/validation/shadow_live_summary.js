#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import minimist from 'minimist';

function openLineReader(filePath) {
  const src = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? src.pipe(zlib.createGunzip()) : src;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function toNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['input', 'out'],
    default: {
      input: '/home/hlws/hlb2/logs/raw-20260221.jsonl',
      out: '/home/hlws/hlb2/data/validation/shadow_summary.json'
    }
  });

  const inputPath = path.resolve(String(argv.input));
  const outPath = path.resolve(String(argv.out));
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(inputPath)) {
    console.error(`[ERR] input not found: ${inputPath}`);
    process.exit(1);
  }

  const openMap = new Map();
  const closed = [];

  const rl = openLineReader(inputPath);
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === 'shadow_open' && obj?.shadowId) {
      openMap.set(String(obj.shadowId), obj);
    } else if (obj?.type === 'shadow_close' && obj?.shadowId) {
      const id = String(obj.shadowId);
      const op = openMap.get(id) || null;
      closed.push({
        shadowId: id,
        dir: obj.dir ?? op?.dir ?? null,
        openTs: toNum(obj.openTs, toNum(op?.ts, null)),
        closeTs: toNum(obj.closeTs, toNum(obj.ts, null)),
        holdMs: toNum(obj.holdMs, null),
        entryPx: toNum(obj.entryPx, toNum(op?.entryPx, null)),
        exitPx: toNum(obj.exitPx, null),
        grossUsd: toNum(obj.grossUsd, 0),
        feeUsd: toNum(obj.feeUsd, 0),
        netUsd: toNum(obj.netUsd, 0),
        closeReason: obj.closeReason ?? null
      });
      openMap.delete(id);
    }
  }

  let netSum = 0;
  let grossSum = 0;
  let feeSum = 0;
  let win = 0;
  let loss = 0;
  let timeout = 0;
  let flip = 0;
  for (const t of closed) {
    netSum += t.netUsd;
    grossSum += t.grossUsd;
    feeSum += t.feeUsd;
    if (t.netUsd > 0) win += 1;
    else if (t.netUsd < 0) loss += 1;
    if (t.closeReason === 'timeout') timeout += 1;
    if (t.closeReason === 'decision_flip') flip += 1;
  }

  const summary = {
    input: inputPath,
    generatedAt: new Date().toISOString(),
    counts: {
      shadowOpenStillActive: openMap.size,
      shadowClosed: closed.length
    },
    performance: {
      netUsd: netSum,
      grossUsd: grossSum,
      feeUsd: feeSum,
      winRate: closed.length > 0 ? (win / closed.length) : null,
      wins: win,
      losses: loss
    },
    exitReason: {
      timeout,
      decisionFlip: flip
    },
    sample: closed.slice(-20)
  };

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[ERR] shadow_live_summary failed', err);
  process.exit(1);
});

