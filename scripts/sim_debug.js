import fs from 'fs';
import readline from 'readline';

const LOG_FILE = 'logs/raw-20260217.jsonl';

async function analyze() {
    const stats = fs.statSync(LOG_FILE);
    const startPos = Math.max(0, stats.size - 20 * 1024 * 1024);

    const stream = fs.createReadStream(LOG_FILE, { start: startPos });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let qualityScores = [];
    let flowPressures = [];
    let total = 0;

    for await (const line of rl) {
        if (!line.includes('"type":"decision_trace"')) continue;
        try {
            const json = JSON.parse(line);
            const payload = json.payload || {};
            const ctx = payload.context || {};
            const bRes = payload.bResult || ctx.bResult;

            if (!bRes) continue;
            const phase4 = bRes.phase4 || {};
            const side = phase4.decidedSide || bRes.side;
            if (!side || side === 'none') continue;

            total++;

            // Extract Quality
            // Check different paths just in case
            let q = phase4.executionQuality?.score;
            if (q === undefined) q = bRes.executionQuality?.score;
            if (q !== undefined) qualityScores.push(Number(q));

            // Extract Flow
            let f = phase4.flowGate?.diagnostics?.flowPressure;
            if (f !== undefined) flowPressures.push(Number(f));

        } catch (e) { }
    }

    const getStats = (arr) => {
        if (arr.length === 0) return 'No Data';
        arr.sort((a, b) => a - b);
        const p50 = arr[Math.floor(arr.length * 0.5)];
        const p90 = arr[Math.floor(arr.length * 0.9)];
        const max = arr[arr.length - 1];
        return `n=${arr.length}, Min=${arr[0].toFixed(4)}, P50=${p50.toFixed(4)}, P90=${p90.toFixed(4)}, Max=${max.toFixed(4)}`;
    }

    console.log(`Analyzed ${total} traces.`);
    console.log('Quality Scores:', getStats(qualityScores));
    console.log('Flow Pressures (Abs):', getStats(flowPressures.map(v => Math.abs(v))));
    console.log('Flow Pressures (Raw):', getStats(flowPressures));
}

analyze();
