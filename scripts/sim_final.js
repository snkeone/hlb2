import fs from 'fs';
import readline from 'readline';

const LOG_FILE = 'logs/raw-20260217.jsonl';

async function analyze() {
    const stats = fs.statSync(LOG_FILE);
    const startPos = Math.max(0, stats.size - 20 * 1024 * 1024);

    const stream = fs.createReadStream(LOG_FILE, { start: startPos });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let counts = {
        total_lines: 0,
        decision_traces: 0,
        has_payload: 0,
        has_bResult: 0,
        has_phase4: 0,
        has_quality: 0,
        has_flow: 0
    };

    let qualityScores = [];
    let flowPressures = [];

    let simStats = {
        valid_setups_blocked_by_flow: 0,
        scenario_A: 0,
        scenario_B: 0,
        scenario_C: 0
    };

    const CFG = {
        current_hostile: 0.45,
        current_quality: 0.2,
        relaxed_hostile: 0.8,
        relaxed_quality: 0.1,
        divergence_strength_th: 0.3
    };

    for await (const line of rl) {
        counts.total_lines++;
        if (!line.includes('"type":"decision_trace"')) continue;
        counts.decision_traces++;

        try {
            const json = JSON.parse(line);
            const payload = json.payload || {};
            if (Object.keys(payload).length === 0) continue;
            counts.has_payload++;

            const ctx = payload.context || {};
            const bRes = payload.bResult || ctx.bResult;

            if (!bRes) continue;
            counts.has_bResult++;

            const phase4 = bRes.phase4 || {};
            if (Object.keys(phase4).length > 0) counts.has_phase4++;

            const side = phase4.decidedSide || bRes.side;
            if (!side || side === 'none') continue;

            // Extract Quality
            let q = phase4.executionQuality?.score;
            if (q === undefined) q = bRes.executionQuality?.score;

            if (q !== undefined) {
                counts.has_quality++;
                qualityScores.push(Number(q));
            }

            // Extract Flow
            const flowGate = phase4.flowGate || {};
            const fgDiag = flowGate.diagnostics || {};
            const divergence = fgDiag.divergence || {};
            let f = fgDiag.flowPressure;

            if (f !== undefined) {
                counts.has_flow++;
                flowPressures.push(Number(f));
            }

            // Simulation Logic
            const fp5 = divergence.flowPressure5s || 0;
            const fp60 = divergence.flowPressure60s || 0;
            const isDivergence = (fp5 * fp60 < 0) && (Math.abs(fp5) >= CFG.divergence_strength_th);

            const pass_Flow_Current = !isDivergence && Math.abs(f || 0) < CFG.current_hostile;
            const pass_Flow_Relaxed = Math.abs(f || 0) < CFG.relaxed_hostile;

            const pass_Quality_Current = (q || 0) >= CFG.current_quality;
            const pass_Quality_Relaxed = (q || 0) >= CFG.relaxed_quality;

            if (pass_Quality_Current && !pass_Flow_Current) {
                simStats.valid_setups_blocked_by_flow++;
            }

            if (pass_Flow_Relaxed && pass_Quality_Current) simStats.scenario_A++;
            if (pass_Flow_Current && pass_Quality_Relaxed) simStats.scenario_B++;
            if (pass_Flow_Relaxed && pass_Quality_Relaxed) simStats.scenario_C++;

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

    console.log('--- Debug Counts ---');
    console.log(JSON.stringify(counts, null, 2));

    console.log('\n--- Metrics Distribution ---');
    console.log('Quality Scores:', getStats(qualityScores));
    console.log('Flow Pressures:', getStats(flowPressures));

    console.log('\n--- Simulation Results ---');
    console.log('Valid Setups Blocked by Flow:', simStats.valid_setups_blocked_by_flow);
    console.log('Scenario A (Relax Flow):', simStats.scenario_A);
    console.log('Scenario B (Relax Quality):', simStats.scenario_B);
    console.log('Scenario C (Relax BOTH):', simStats.scenario_C);
}

analyze();
