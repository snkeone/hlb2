#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function parseList(s) {
  return String(s || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
}

function readCsv(csvPath) {
  const txt = fs.readFileSync(csvPath, 'utf8').trim();
  if (!txt) return [];
  const lines = txt.split('\n');
  const headers = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = cols[j] ?? '';
    out.push(row);
  }
  return out;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const xs = [...arr].sort((a, b) => a - b);
  const pos = (xs.length - 1) * q;
  const b = Math.floor(pos);
  const r = pos - b;
  if (xs[b + 1] !== undefined) return xs[b] + r * (xs[b + 1] - xs[b]);
  return xs[b];
}

function parseArgs(argv) {
  const out = {
    mode: 'train',
    eventsCsv: '',
    modelPath: '',
    outDir: 'logs/ops/ws_pattern_discovery',
    features: [
      'avgSpreadBps', 'tradeRate', 'flipRate', 'flowAccel', 'ofi',
      'avgDepthImbalance', 'wallStrengthP90', 'spreadDeltaBps',
      'avgMicropriceDevBps', 'microDriftBps', 'wallImbalance',
      'wallBidDominanceRate', 'wallAskDominanceRate', 'wallDominanceFlipRate',
      'buyRunShare', 'sellRunShare',
    ],
    clusters: 6,
    maxIters: 40,
    seed: 42,
    eventMoveBps: 0,
    eventQuantile: 0.9,
    testDays: 2,
    minPatternSamples: 20,
    refreshMinFitRate: 0.55,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--mode') out.mode = String(argv[++i] ?? out.mode);
    else if (a === '--events-csv') out.eventsCsv = String(argv[++i] ?? out.eventsCsv);
    else if (a === '--model-path') out.modelPath = String(argv[++i] ?? out.modelPath);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--features') out.features = parseList(argv[++i]);
    else if (a === '--clusters') out.clusters = Math.max(2, Math.floor(toNum(argv[++i], out.clusters)));
    else if (a === '--max-iters') out.maxIters = Math.max(5, Math.floor(toNum(argv[++i], out.maxIters)));
    else if (a === '--seed') out.seed = Math.floor(toNum(argv[++i], out.seed));
    else if (a === '--event-move-bps') out.eventMoveBps = Math.max(0, toNum(argv[++i], out.eventMoveBps));
    else if (a === '--event-quantile') out.eventQuantile = Math.min(0.99, Math.max(0.5, toNum(argv[++i], out.eventQuantile)));
    else if (a === '--test-days') out.testDays = Math.max(1, Math.floor(toNum(argv[++i], out.testDays)));
    else if (a === '--min-pattern-samples') out.minPatternSamples = Math.max(1, Math.floor(toNum(argv[++i], out.minPatternSamples)));
    else if (a === '--refresh-min-fit-rate') out.refreshMinFitRate = Math.min(0.99, Math.max(0, toNum(argv[++i], out.refreshMinFitRate)));
  }
  return out;
}

function splitByDate(rows, testDays) {
  const dates = [...new Set(rows.map((r) => String(r.date || '')))].filter(Boolean).sort();
  if (dates.length <= testDays) return { train: rows, test: [] };
  const testSet = new Set(dates.slice(dates.length - testDays));
  return {
    train: rows.filter((r) => !testSet.has(String(r.date || ''))),
    test: rows.filter((r) => testSet.has(String(r.date || ''))),
  };
}

function buildMatrix(rows, features) {
  return rows.map((r) => features.map((f) => toNum(r[f], NaN)));
}

function calcNorm(matrix) {
  const dim = matrix[0]?.length || 0;
  const meanV = new Array(dim).fill(0);
  const stdV = new Array(dim).fill(1);
  for (let j = 0; j < dim; j += 1) {
    const xs = matrix.map((r) => r[j]).filter(Number.isFinite);
    const m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const v = xs.length ? xs.reduce((a, b) => a + ((b - m) ** 2), 0) / xs.length : 1;
    meanV[j] = m;
    stdV[j] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  return { mean: meanV, std: stdV };
}

function normalize(matrix, norm) {
  return matrix.map((r) => r.map((x, j) => Number.isFinite(x) ? ((x - norm.mean[j]) / norm.std[j]) : 0));
}

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] - b[i]);
    s += d * d;
  }
  return s;
}

function seededRand(seed) {
  let x = seed | 0;
  return () => {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296);
  };
}

function kmeans(points, k, maxIters, seed) {
  if (!points.length) return { centroids: [], assign: [] };
  const rand = seededRand(seed);
  const n = points.length;
  const dim = points[0].length;
  const centroids = [];
  const chosen = new Set();
  while (centroids.length < k && chosen.size < n) {
    const idx = Math.floor(rand() * n);
    if (chosen.has(idx)) continue;
    chosen.add(idx);
    centroids.push([...points[idx]]);
  }
  while (centroids.length < k) centroids.push([...points[centroids.length % n]]);

  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < maxIters; iter += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = sqDist(points[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const cnts = new Array(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assign[i];
      cnts[c] += 1;
      for (let j = 0; j < dim; j += 1) sums[c][j] += points[i][j];
    }
    for (let c = 0; c < k; c += 1) {
      if (cnts[c] === 0) continue;
      for (let j = 0; j < dim; j += 1) centroids[c][j] = sums[c][j] / cnts[c];
    }
    if (!changed) break;
  }
  return { centroids, assign };
}

function nearestIndex(x, centroids) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centroids.length; i += 1) {
    const d = sqDist(x, centroids[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function isEvent(row, threshold) {
  const ret = toNum(row.retBps, NaN);
  return Number.isFinite(ret) && Math.abs(ret) >= threshold;
}

function describePattern(idx, centroidZ, features) {
  const pairs = centroidZ.map((v, i) => ({ f: features[i], v, a: Math.abs(v) }))
    .sort((a, b) => b.a - a.a)
    .slice(0, 2);
  const words = pairs.map((p) => `${p.v >= 0 ? 'high' : 'low'}_${p.f}`);
  return `P${idx + 1}_${words.join('_')}`;
}

function evaluateByPattern(rows, assign, threshold, k) {
  const per = Array.from({ length: k }, (_, c) => ({ c, n: 0, nEvent: 0, up: 0, down: 0, rets: [] }));
  for (let i = 0; i < rows.length; i += 1) {
    const c = assign[i];
    const p = per[c];
    const ret = toNum(rows[i].retBps, NaN);
    p.n += 1;
    if (Number.isFinite(ret)) p.rets.push(ret);
    if (isEvent(rows[i], threshold)) p.nEvent += 1;
    if (Number.isFinite(ret) && ret > 0) p.up += 1;
    if (Number.isFinite(ret) && ret < 0) p.down += 1;
  }
  return per.map((p) => ({
    patternIdx: p.c,
    n: p.n,
    nEvent: p.nEvent,
    fitRate: p.n > 0 ? (p.nEvent / p.n) : null,
    upRatio: (p.up + p.down) > 0 ? (p.up / (p.up + p.down)) : null,
    meanRetBps: mean(p.rets),
    p10RetBps: quantile(p.rets, 0.1),
  }));
}

function evaluateWithModel(rows, model) {
  const features = model?.config?.features || [];
  const threshold = toNum(model?.config?.eventThresholdBps, NaN);
  const norm = model?.norm || {};
  const centroids = (model?.centroidsZ || []).map((c) => c.map((v) => toNum(v, 0)));
  if (!rows.length || !features.length || !centroids.length || !Number.isFinite(threshold)) {
    throw new Error('invalid model for evaluation');
  }
  const x = normalize(buildMatrix(rows, features), norm);
  const assign = x.map((v) => nearestIndex(v, centroids));
  const evalRows = evaluateByPattern(rows, assign, threshold, centroids.length);
  return { evalRows, assign, x, centroids, features, threshold, norm };
}

function train(cfg) {
  const rowsRaw = readCsv(cfg.eventsCsv);
  const rows = rowsRaw.filter((r) => Number.isFinite(toNum(r.retBps, NaN)));
  if (!rows.length) throw new Error('no valid rows in events-csv');
  const { train: trainRows, test: testRows } = splitByDate(rows, cfg.testDays);
  if (!trainRows.length) throw new Error('no train rows after split');

  const absRet = trainRows.map((r) => Math.abs(toNum(r.retBps, 0)));
  const threshold = cfg.eventMoveBps > 0 ? cfg.eventMoveBps : quantile(absRet, cfg.eventQuantile);
  const trainX = buildMatrix(trainRows, cfg.features);
  const norm = calcNorm(trainX);
  const trainXz = normalize(trainX, norm);
  const trainEventIdx = trainRows.map((r, i) => (isEvent(r, threshold) ? i : -1)).filter((i) => i >= 0);
  if (trainEventIdx.length < cfg.clusters) throw new Error(`insufficient event samples: ${trainEventIdx.length}`);

  const eventPts = trainEventIdx.map((i) => trainXz[i]);
  const km = kmeans(eventPts, cfg.clusters, cfg.maxIters, cfg.seed);
  const centroids = km.centroids;

  const assignTrain = trainXz.map((x) => nearestIndex(x, centroids));
  const trainEval = evaluateByPattern(trainRows, assignTrain, threshold, cfg.clusters);

  const testX = buildMatrix(testRows, cfg.features);
  const testXz = normalize(testX, norm);
  const assignTest = testXz.map((x) => nearestIndex(x, centroids));
  const testEval = evaluateByPattern(testRows, assignTest, threshold, cfg.clusters);

  const patterns = centroids.map((c, i) => ({
    patternIdx: i,
    patternName: describePattern(i, c, cfg.features),
    centroidZ: c.map((v) => round(v, 6)),
  }));
  const trainMap = new Map(trainEval.map((r) => [r.patternIdx, r]));
  const testMap = new Map(testEval.map((r) => [r.patternIdx, r]));
  const merged = patterns.map((p) => {
    const tr = trainMap.get(p.patternIdx) || {};
    const te = testMap.get(p.patternIdx) || {};
    const nTrain = toNum(tr.n, 0);
    const gate = nTrain >= cfg.minPatternSamples ? 'GREEN' : 'GRAY';
    return {
      ...p,
      gate,
      trainN: nTrain,
      trainFitRate: round(toNum(tr.fitRate, NaN), 6),
      trainMeanRetBps: round(toNum(tr.meanRetBps, NaN), 6),
      trainP10RetBps: round(toNum(tr.p10RetBps, NaN), 6),
      testN: toNum(te.n, 0),
      testFitRate: round(toNum(te.fitRate, NaN), 6),
      testMeanRetBps: round(toNum(te.meanRetBps, NaN), 6),
      testP10RetBps: round(toNum(te.p10RetBps, NaN), 6),
    };
  }).sort((a, b) => toNum(b.testFitRate, -Infinity) - toNum(a.testFitRate, -Infinity));

  const model = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      features: cfg.features,
      clusters: cfg.clusters,
      eventThresholdBps: round(toNum(threshold, NaN), 6),
      minPatternSamples: cfg.minPatternSamples,
      testDays: cfg.testDays,
    },
    norm: {
      mean: norm.mean.map((v) => round(v, 8)),
      std: norm.std.map((v) => round(v, 8)),
    },
    centroidsZ: centroids.map((c) => c.map((v) => round(v, 8))),
    patterns: merged,
  };

  const outDirAbs = path.resolve(process.cwd(), cfg.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'pattern_model.json'), `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'pattern_report.csv'), toCsv(merged), 'utf8');

  const assignRows = rows.map((r) => ({
    date: r.date,
    ts: r.ts,
    retBps: round(toNum(r.retBps, NaN), 6),
  }));
  const allX = normalize(buildMatrix(rows, cfg.features), norm);
  for (let i = 0; i < assignRows.length; i += 1) {
    const c = nearestIndex(allX[i], centroids);
    assignRows[i].patternIdx = c;
    assignRows[i].patternName = patterns[c]?.patternName || `P${c + 1}`;
    assignRows[i].event = isEvent(rows[i], threshold) ? 1 : 0;
  }
  fs.writeFileSync(path.join(outDirAbs, 'pattern_assignments.csv'), toCsv(assignRows), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    rows: rows.length,
    trainRows: trainRows.length,
    testRows: testRows.length,
    eventThresholdBps: round(toNum(threshold, NaN), 6),
    topPatterns: merged.slice(0, 5).map((p) => ({
      patternName: p.patternName,
      gate: p.gate,
      trainFitRate: p.trainFitRate,
      testFitRate: p.testFitRate,
      trainN: p.trainN,
      testN: p.testN,
    })),
  }, null, 2));
}

function applyModel(cfg) {
  const model = JSON.parse(fs.readFileSync(cfg.modelPath, 'utf8'));
  const rows = readCsv(cfg.eventsCsv);
  if (!rows.length) {
    throw new Error('invalid model or empty events-csv');
  }
  const { evalRows } = evaluateWithModel(rows, model);
  const patterns = model?.patterns || [];
  const pmap = new Map(patterns.map((p) => [toNum(p.patternIdx, -1), p]));
  const out = evalRows.map((r) => ({
    patternIdx: r.patternIdx,
    patternName: pmap.get(r.patternIdx)?.patternName || `P${r.patternIdx + 1}`,
    n: r.n,
    nEvent: r.nEvent,
    fitRate: round(toNum(r.fitRate, NaN), 6),
    upRatio: round(toNum(r.upRatio, NaN), 6),
    meanRetBps: round(toNum(r.meanRetBps, NaN), 6),
    p10RetBps: round(toNum(r.p10RetBps, NaN), 6),
  })).sort((a, b) => toNum(b.fitRate, -Infinity) - toNum(a.fitRate, -Infinity));

  const outDirAbs = path.resolve(process.cwd(), cfg.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'pattern_apply_report.csv'), toCsv(out), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'pattern_apply_summary.json'), `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    modelPath: path.resolve(process.cwd(), cfg.modelPath),
    report: out,
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    rows: rows.length,
    topPatterns: out.slice(0, 5),
  }, null, 2));
}

function refreshModel(cfg) {
  const oldModel = JSON.parse(fs.readFileSync(cfg.modelPath, 'utf8'));
  const rowsRaw = readCsv(cfg.eventsCsv);
  const rows = rowsRaw.filter((r) => Number.isFinite(toNum(r.retBps, NaN)));
  if (!rows.length) throw new Error('empty events-csv');

  const oldEval = evaluateWithModel(rows, oldModel);
  const evalMap = new Map(oldEval.evalRows.map((r) => [r.patternIdx, r]));
  const oldPatterns = oldModel?.patterns || [];
  const oldCentroids = oldEval.centroids;
  const oldThreshold = oldEval.threshold;
  const features = oldEval.features;
  const norm = oldEval.norm;
  const targetClusters = Math.max(2, Math.floor(toNum(oldModel?.config?.clusters, oldCentroids.length)));

  const keep = [];
  const drop = [];
  for (let i = 0; i < oldCentroids.length; i += 1) {
    const ev = evalMap.get(i) || {};
    const n = toNum(ev.n, 0);
    const fit = toNum(ev.fitRate, NaN);
    const pass = n >= cfg.minPatternSamples && Number.isFinite(fit) && fit >= cfg.refreshMinFitRate;
    const row = {
      patternIdx: i,
      patternName: oldPatterns[i]?.patternName || `P${i + 1}`,
      n,
      fitRate: round(fit, 6),
    };
    if (pass) keep.push({ ...row, centroid: oldCentroids[i] });
    else drop.push(row);
  }

  const need = Math.max(0, targetClusters - keep.length);
  const { train: trainRows, test: testRows } = splitByDate(rows, cfg.testDays);
  const trainX = normalize(buildMatrix(trainRows, features), norm);
  const trainEventIdx = trainRows.map((r, i) => (isEvent(r, oldThreshold) ? i : -1)).filter((i) => i >= 0);
  const poolIdx = trainEventIdx.filter((i) => {
    if (keep.length === 0) return true;
    const c = nearestIndex(trainX[i], keep.map((k) => k.centroid));
    const d = sqDist(trainX[i], keep[c].centroid);
    return d > 0.25;
  });
  const poolPts = (poolIdx.length > 0 ? poolIdx : trainEventIdx).map((i) => trainX[i]);

  let newCentroids = [];
  if (need > 0 && poolPts.length > 0) {
    const km = kmeans(poolPts, Math.min(need, poolPts.length), cfg.maxIters, cfg.seed + 99);
    newCentroids = km.centroids;
  }
  while (keep.length + newCentroids.length < targetClusters && trainX.length > 0) {
    newCentroids.push([...trainX[(keep.length + newCentroids.length) % trainX.length]]);
  }

  const combinedCentroids = [
    ...keep.map((k) => k.centroid),
    ...newCentroids,
  ].slice(0, targetClusters);

  const assignTrain = trainX.map((x) => nearestIndex(x, combinedCentroids));
  const trainEval = evaluateByPattern(trainRows, assignTrain, oldThreshold, combinedCentroids.length);
  const testX = normalize(buildMatrix(testRows, features), norm);
  const assignTest = testX.map((x) => nearestIndex(x, combinedCentroids));
  const testEval = evaluateByPattern(testRows, assignTest, oldThreshold, combinedCentroids.length);
  const trMap = new Map(trainEval.map((r) => [r.patternIdx, r]));
  const teMap = new Map(testEval.map((r) => [r.patternIdx, r]));

  const patterns = combinedCentroids.map((c, i) => {
    const kept = keep[i];
    return {
      patternIdx: i,
      patternName: kept?.patternName || describePattern(i, c, features),
      centroidZ: c.map((v) => round(v, 6)),
    };
  });

  const merged = patterns.map((p) => {
    const tr = trMap.get(p.patternIdx) || {};
    const te = teMap.get(p.patternIdx) || {};
    const nTrain = toNum(tr.n, 0);
    return {
      ...p,
      gate: nTrain >= cfg.minPatternSamples ? 'GREEN' : 'GRAY',
      trainN: nTrain,
      trainFitRate: round(toNum(tr.fitRate, NaN), 6),
      trainMeanRetBps: round(toNum(tr.meanRetBps, NaN), 6),
      trainP10RetBps: round(toNum(tr.p10RetBps, NaN), 6),
      testN: toNum(te.n, 0),
      testFitRate: round(toNum(te.fitRate, NaN), 6),
      testMeanRetBps: round(toNum(te.meanRetBps, NaN), 6),
      testP10RetBps: round(toNum(te.p10RetBps, NaN), 6),
    };
  }).sort((a, b) => toNum(b.testFitRate, -Infinity) - toNum(a.testFitRate, -Infinity));

  const model = {
    ok: true,
    refreshedAt: new Date().toISOString(),
    refreshedFrom: path.resolve(process.cwd(), cfg.modelPath),
    config: {
      features,
      clusters: combinedCentroids.length,
      eventThresholdBps: round(toNum(oldThreshold, NaN), 6),
      minPatternSamples: cfg.minPatternSamples,
      testDays: cfg.testDays,
      refreshMinFitRate: cfg.refreshMinFitRate,
    },
    norm: {
      mean: (norm.mean || []).map((v) => round(toNum(v, 0), 8)),
      std: (norm.std || []).map((v) => round(toNum(v, 1), 8)),
    },
    centroidsZ: combinedCentroids.map((c) => c.map((v) => round(v, 8))),
    patterns: merged,
    refreshStats: {
      oldPatternCount: oldCentroids.length,
      kept: keep.length,
      dropped: drop.length,
      created: Math.max(0, combinedCentroids.length - keep.length),
      droppedPatterns: drop,
    },
  };

  const outDirAbs = path.resolve(process.cwd(), cfg.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'pattern_model_refreshed.json'), `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'pattern_refresh_report.csv'), toCsv(merged), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    rows: rows.length,
    kept: keep.length,
    dropped: drop.length,
    created: Math.max(0, combinedCentroids.length - keep.length),
    topPatterns: merged.slice(0, 5).map((p) => ({
      patternName: p.patternName,
      trainFitRate: p.trainFitRate,
      testFitRate: p.testFitRate,
      trainN: p.trainN,
      testN: p.testN,
    })),
  }, null, 2));
}

function main() {
  const cfg = parseArgs(process.argv);
  if (!cfg.eventsCsv) {
    console.error('[ws_pattern_discovery] --events-csv is required');
    process.exit(1);
  }
  if (cfg.mode === 'apply') {
    if (!cfg.modelPath) {
      console.error('[ws_pattern_discovery] --model-path is required in apply mode');
      process.exit(1);
    }
    applyModel(cfg);
    return;
  }
  if (cfg.mode === 'refresh') {
    if (!cfg.modelPath) {
      console.error('[ws_pattern_discovery] --model-path is required in refresh mode');
      process.exit(1);
    }
    refreshModel(cfg);
    return;
  }
  train(cfg);
}

main();
