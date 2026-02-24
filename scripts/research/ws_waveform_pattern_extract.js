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
  const base = Math.floor(pos);
  const rest = pos - base;
  if (xs[base + 1] !== undefined) return xs[base] + rest * (xs[base + 1] - xs[base]);
  return xs[base];
}

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
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
  const n = points.length;
  const rand = seededRand(seed);
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
  const dim = points[0].length;
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

function parseArgs(argv) {
  const out = {
    eventsCsv: '',
    outDir: 'logs/ops/ws_waveform_pattern',
    features: [
      'avgSpreadBps',
      'tradeRate',
      'avgDepthImbalance',
      'avgMicropriceDevBps',
      'microDriftBps',
      'wallDominanceFlipRate',
      'buyRunShare',
      'sellRunShare',
    ],
    eventMoveBps: 5,
    preSec: 60,
    postSec: 10,
    minGapSec: 10,
    stepSec: 0,
    waveType: 'rolling_delta', // from_event | rolling_delta | incremental
    baselineStartSec: -90,
    baselineEndSec: -60,
    clusterPreSec: 60,
    clusters: 6,
    maxIters: 50,
    seed: 42,
    minPatternSamples: 30,
    keepMinUplift: 0.01,
    keepMinStability: 0.65,
    watchMinUplift: 0,
    watchMinStability: 0.5,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--events-csv') out.eventsCsv = String(argv[++i] ?? out.eventsCsv);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--features') out.features = parseList(argv[++i]);
    else if (a === '--event-move-bps') out.eventMoveBps = Math.max(0.1, toNum(argv[++i], out.eventMoveBps));
    else if (a === '--pre-sec') out.preSec = Math.max(5, Math.floor(toNum(argv[++i], out.preSec)));
    else if (a === '--post-sec') out.postSec = Math.max(5, Math.floor(toNum(argv[++i], out.postSec)));
    else if (a === '--min-gap-sec') out.minGapSec = Math.max(1, Math.floor(toNum(argv[++i], out.minGapSec)));
    else if (a === '--step-sec') out.stepSec = Math.max(0, Math.floor(toNum(argv[++i], out.stepSec)));
    else if (a === '--wave-type') {
      const t = String(argv[++i] ?? out.waveType);
      if (['from_event', 'rolling_delta', 'incremental'].includes(t)) out.waveType = t;
    }
    else if (a === '--baseline-start-sec') out.baselineStartSec = Math.floor(toNum(argv[++i], out.baselineStartSec));
    else if (a === '--baseline-end-sec') out.baselineEndSec = Math.floor(toNum(argv[++i], out.baselineEndSec));
    else if (a === '--cluster-pre-sec') out.clusterPreSec = Math.max(5, Math.floor(toNum(argv[++i], out.clusterPreSec)));
    else if (a === '--clusters') out.clusters = Math.max(2, Math.floor(toNum(argv[++i], out.clusters)));
    else if (a === '--max-iters') out.maxIters = Math.max(5, Math.floor(toNum(argv[++i], out.maxIters)));
    else if (a === '--seed') out.seed = Math.floor(toNum(argv[++i], out.seed));
    else if (a === '--min-pattern-samples') out.minPatternSamples = Math.max(1, Math.floor(toNum(argv[++i], out.minPatternSamples)));
    else if (a === '--keep-min-uplift') out.keepMinUplift = toNum(argv[++i], out.keepMinUplift);
    else if (a === '--keep-min-stability') out.keepMinStability = toNum(argv[++i], out.keepMinStability);
    else if (a === '--watch-min-uplift') out.watchMinUplift = toNum(argv[++i], out.watchMinUplift);
    else if (a === '--watch-min-stability') out.watchMinStability = toNum(argv[++i], out.watchMinStability);
  }
  return out;
}

function detectStepSec(rows) {
  const secs = rows.map((r) => toNum(r.sec, NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < secs.length; i += 1) {
    const d = secs[i] - secs[i - 1];
    if (d > 0 && d <= 60) diffs.push(d);
  }
  return Math.max(1, Math.floor(quantile(diffs, 0.5) || 5));
}

function makeOffsets(preSec, postSec, stepSec) {
  const out = [];
  for (let t = -preSec; t <= postSec; t += stepSec) out.push(t);
  return out;
}

function buildEventCenters(rows, threshold, minGapSec) {
  const centers = [];
  let last = -Infinity;
  for (const r of rows) {
    const sec = toNum(r.sec, NaN);
    const ret = toNum(r.retBps, NaN);
    if (!Number.isFinite(sec) || !Number.isFinite(ret)) continue;
    if (Math.abs(ret) < threshold) continue;
    if (sec - last < minGapSec) continue;
    centers.push(sec);
    last = sec;
  }
  return centers;
}

function buildVectors(rows, centers, features, offsets) {
  const bySec = new Map(rows.map((r) => [toNum(r.sec, NaN), r]));
  const out = [];
  for (const sec0 of centers) {
    const r0 = bySec.get(sec0);
    if (!r0) continue;
    const vec = [];
    let ok = true;
    for (const f of features) {
      const v0 = toNum(r0[f], NaN);
      if (!Number.isFinite(v0)) {
        ok = false;
        break;
      }
      for (const dt of offsets) {
        const rr = bySec.get(sec0 + dt);
        const vv = toNum(rr?.[f], NaN);
        if (!Number.isFinite(vv)) {
          ok = false;
          break;
        }
        vec.push(vv - v0);
      }
      if (!ok) break;
    }
    if (!ok) continue;
    out.push({ sec: sec0, row: r0, vec });
  }
  return out;
}

function buildVectorsByWaveType(rows, centers, features, offsets, cfg, stepSec, clusterOffsets) {
  const bySec = new Map(rows.map((r) => [toNum(r.sec, NaN), r]));
  const clusterSet = new Set(clusterOffsets);
  const out = [];

  for (const sec0 of centers) {
    const r0 = bySec.get(sec0);
    if (!r0) continue;
    const fullVec = [];
    const clusterVec = [];
    let ok = true;

    for (const f of features) {
      const v0 = toNum(r0[f], NaN);
      if (!Number.isFinite(v0)) {
        ok = false;
        break;
      }

      let baseline = null;
      if (cfg.waveType === 'rolling_delta') {
        const vals = [];
        for (let t = cfg.baselineStartSec; t <= cfg.baselineEndSec; t += stepSec) {
          const rr = bySec.get(sec0 + t);
          const vv = toNum(rr?.[f], NaN);
          if (Number.isFinite(vv)) vals.push(vv);
        }
        baseline = mean(vals);
        if (!Number.isFinite(baseline)) {
          ok = false;
          break;
        }
      }

      for (const dt of offsets) {
        const rr = bySec.get(sec0 + dt);
        const vv = toNum(rr?.[f], NaN);
        if (!Number.isFinite(vv)) {
          ok = false;
          break;
        }
        let x = NaN;
        if (cfg.waveType === 'from_event') {
          x = vv - v0;
        } else if (cfg.waveType === 'rolling_delta') {
          x = vv - baseline;
        } else {
          const rp = bySec.get(sec0 + dt - stepSec);
          const vp = toNum(rp?.[f], NaN);
          if (!Number.isFinite(vp)) {
            ok = false;
            break;
          }
          x = vv - vp;
        }
        if (!Number.isFinite(x)) {
          ok = false;
          break;
        }
        fullVec.push(x);
        if (clusterSet.has(dt)) clusterVec.push(x);
      }
      if (!ok) break;
    }
    if (!ok) continue;
    out.push({ sec: sec0, row: r0, fullVec, clusterVec });
  }
  return out;
}

function normalizeMatrix(vectors) {
  const n = vectors.length;
  if (n === 0) return { points: [], mean: [], std: [] };
  const dim = vectors[0].vec.length;
  const meanV = new Array(dim).fill(0);
  const stdV = new Array(dim).fill(1);
  for (let j = 0; j < dim; j += 1) {
    const xs = vectors.map((v) => v.vec[j]).filter(Number.isFinite);
    const m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const vv = xs.length ? xs.reduce((a, b) => a + ((b - m) ** 2), 0) / xs.length : 1;
    meanV[j] = m;
    stdV[j] = vv > 1e-12 ? Math.sqrt(vv) : 1;
  }
  const points = vectors.map((v) => v.vec.map((x, j) => (x - meanV[j]) / stdV[j]));
  return { points, mean: meanV, std: stdV };
}

function describePattern(idx, centroid, features, offsets) {
  const perFeature = [];
  const t0i = offsets.indexOf(0);
  const preI = offsets.findIndex((x) => x >= -10);
  const postI = offsets.findIndex((x) => x >= 10);
  const nT = offsets.length;
  for (let fi = 0; fi < features.length; fi += 1) {
    const base = fi * nT;
    const pre = centroid[base + (preI >= 0 ? preI : Math.max(0, t0i - 1))];
    const post = centroid[base + (postI >= 0 ? postI : Math.min(nT - 1, t0i + 1))];
    const swing = (Number.isFinite(pre) && Number.isFinite(post)) ? (post - pre) : 0;
    perFeature.push({ feature: features[fi], swing, abs: Math.abs(swing) });
  }
  perFeature.sort((a, b) => b.abs - a.abs);
  const top = perFeature.slice(0, 2).map((x) => `${x.swing >= 0 ? 'rise' : 'drop'}_${x.feature}`);
  return `WF${idx + 1}_${top.join('_')}`;
}

function buildDailyStability(rows, assign, k, threshold, baseRate) {
  const by = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const d = String(rows[i]?.date ?? '');
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(i);
  }
  const dates = [...by.keys()].sort();
  const out = Array.from({ length: k }, () => []);
  for (const d of dates) {
    const idxs = by.get(d) || [];
    const totalByC = new Array(k).fill(0);
    const hitByC = new Array(k).fill(0);
    for (const i of idxs) {
      const c = assign[i];
      totalByC[c] += 1;
      const ret = toNum(rows[i]?.retBps, NaN);
      if (Number.isFinite(ret) && Math.abs(ret) >= threshold) hitByC[c] += 1;
    }
    for (let c = 0; c < k; c += 1) {
      if (totalByC[c] === 0) continue;
      const fit = hitByC[c] / totalByC[c];
      out[c].push({ date: d, uplift: fit - baseRate, n: totalByC[c] });
    }
  }
  return out.map((days) => {
    if (days.length === 0) return null;
    const pos = days.filter((d) => d.uplift > 0).length;
    return pos / days.length;
  });
}

function classify(statusRow, cfg) {
  if (statusRow.n < cfg.minPatternSamples) return 'DROP';
  if (statusRow.uplift >= cfg.keepMinUplift && statusRow.dailySignStability >= cfg.keepMinStability) return 'KEEP';
  if (statusRow.uplift >= cfg.watchMinUplift && statusRow.dailySignStability >= cfg.watchMinStability) return 'WATCH';
  return 'DROP';
}

function main() {
  const cfg = parseArgs(process.argv);
  if (!cfg.eventsCsv) {
    console.error('[ws_waveform_pattern_extract] --events-csv is required');
    process.exit(1);
  }

  const rows = readCsv(cfg.eventsCsv)
    .map((r) => {
      const tsMs = toNum(r.ts, NaN);
      const sec = Number.isFinite(toNum(r.sec, NaN))
        ? toNum(r.sec, NaN)
        : (Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : NaN);
      return { ...r, sec, retBps: toNum(r.retBps, NaN) };
    })
    .filter((r) => Number.isFinite(r.sec) && Number.isFinite(r.retBps))
    .sort((a, b) => a.sec - b.sec);
  if (rows.length === 0) {
    console.error('[ws_waveform_pattern_extract] no valid rows');
    process.exit(1);
  }

  const stepSec = cfg.stepSec > 0 ? cfg.stepSec : detectStepSec(rows);
  const offsets = makeOffsets(cfg.preSec, cfg.postSec, stepSec);
  const clusterOffsets = offsets.filter((t) => t <= 0 && t >= -cfg.clusterPreSec);
  if (clusterOffsets.length === 0) {
    console.error('[ws_waveform_pattern_extract] invalid cluster offsets; check --cluster-pre-sec');
    process.exit(1);
  }
  const eventCenters = buildEventCenters(rows, cfg.eventMoveBps, cfg.minGapSec);
  const evVectors = buildVectorsByWaveType(rows, eventCenters, cfg.features, offsets, cfg, stepSec, clusterOffsets);
  if (evVectors.length < cfg.clusters) {
    console.error(`[ws_waveform_pattern_extract] insufficient event vectors: ${evVectors.length}`);
    process.exit(1);
  }

  const normEvent = normalizeMatrix(evVectors.map((v) => ({ vec: v.clusterVec })));
  const km = kmeans(normEvent.points, cfg.clusters, cfg.maxIters, cfg.seed);
  const eventAssign = km.assign;
  const eventCentroids = km.centroids;

  const allCenters = rows.map((r) => r.sec);
  const allVectors = buildVectorsByWaveType(rows, allCenters, cfg.features, offsets, cfg, stepSec, clusterOffsets);
  const normAllPoints = allVectors.map((v) => v.clusterVec.map((x, j) => (x - normEvent.mean[j]) / normEvent.std[j]));
  const allAssign = normAllPoints.map((x) => nearestIndex(x, eventCentroids));

  const baseRate = rows.filter((r) => Math.abs(r.retBps) >= cfg.eventMoveBps).length / rows.length;
  const stats = Array.from({ length: cfg.clusters }, (_, c) => ({
    patternIdx: c,
    n: 0,
    nEvent: 0,
    meanRetBps: 0,
    rets: [],
  }));
  for (let i = 0; i < allVectors.length; i += 1) {
    const c = allAssign[i];
    const s = stats[c];
    s.n += 1;
    const ret = toNum(allVectors[i].row.retBps, NaN);
    if (Number.isFinite(ret)) s.rets.push(ret);
    if (Number.isFinite(ret) && Math.abs(ret) >= cfg.eventMoveBps) s.nEvent += 1;
  }

  const stability = buildDailyStability(allVectors.map((x) => x.row), allAssign, cfg.clusters, cfg.eventMoveBps, baseRate);

  const summary = stats.map((s) => {
    const fitRate = s.n > 0 ? s.nEvent / s.n : null;
    const uplift = Number.isFinite(fitRate) ? (fitRate - baseRate) : null;
    const row = {
      patternIdx: s.patternIdx,
      patternName: describePattern(s.patternIdx, eventCentroids[s.patternIdx], cfg.features, clusterOffsets),
      n: s.n,
      nEvent: s.nEvent,
      fitRate: round(toNum(fitRate, NaN), 6),
      uplift: round(toNum(uplift, NaN), 6),
      baseRate: round(baseRate, 6),
      meanRetBps: round(toNum(mean(s.rets), NaN), 6),
      p10RetBps: round(toNum(quantile(s.rets, 0.1), NaN), 6),
      dailySignStability: round(toNum(stability[s.patternIdx], NaN), 6),
    };
    return {
      ...row,
      status: classify({
        n: toNum(row.n, 0),
        uplift: toNum(row.uplift, -Infinity),
        dailySignStability: toNum(row.dailySignStability, -Infinity),
      }, cfg),
    };
  }).sort((a, b) => toNum(b.uplift, -Infinity) - toNum(a.uplift, -Infinity));

  const outDirAbs = path.resolve(process.cwd(), cfg.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'waveform_patterns.csv'), toCsv(summary), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'waveform_model.json'), `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      eventsCsv: path.resolve(process.cwd(), cfg.eventsCsv),
      waveType: cfg.waveType,
      baselineStartSec: cfg.baselineStartSec,
      baselineEndSec: cfg.baselineEndSec,
      clusterPreSec: cfg.clusterPreSec,
      features: cfg.features,
      eventMoveBps: cfg.eventMoveBps,
      preSec: cfg.preSec,
      postSec: cfg.postSec,
      stepSec,
      minGapSec: cfg.minGapSec,
      clusters: cfg.clusters,
      minPatternSamples: cfg.minPatternSamples,
      keepMinUplift: cfg.keepMinUplift,
      keepMinStability: cfg.keepMinStability,
      watchMinUplift: cfg.watchMinUplift,
      watchMinStability: cfg.watchMinStability,
    },
    norm: {
      mean: normEvent.mean.map((v) => round(v, 8)),
      std: normEvent.std.map((v) => round(v, 8)),
    },
    offsets,
    clusterOffsets,
    centroidsZ: eventCentroids.map((c) => c.map((v) => round(v, 8))),
    patterns: summary,
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    rows: rows.length,
    eventCenters: eventCenters.length,
    eventVectors: evVectors.length,
    baseRate: round(baseRate, 6),
    topPatterns: summary.slice(0, 5).map((p) => ({
      patternName: p.patternName,
      status: p.status,
      uplift: p.uplift,
      fitRate: p.fitRate,
      n: p.n,
      dailySignStability: p.dailySignStability,
    })),
  }, null, 2));
}

main();
