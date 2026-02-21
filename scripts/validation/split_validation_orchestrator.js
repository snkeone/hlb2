#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));
const trainInputs = args['train'];
const validateInputs = args['validate'];
const forwardInputs = args['forward'];
const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '../..'));

if (!trainInputs) {
    console.error("Usage: node split_validation_orchestrator.js --train <train_files> [--validate <val_files>] [--forward <fwd_files>]");
    process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, '').replace('Z', '');
const outBase = path.join(rootDir, 'data/validation/split-runs', runId);
fs.mkdirSync(outBase, { recursive: true });

function parseInputList(inputs) {
    if (!inputs) return [];
    return String(inputs)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function mergeCsvRows(sourceCsvFiles, outputCsv) {
    let header = null;
    const rows = [];
    for (const filePath of sourceCsvFiles) {
        if (!fs.existsSync(filePath)) continue;
        const text = fs.readFileSync(filePath, 'utf8').trim();
        if (!text) continue;
        const lines = text.split('\n');
        if (lines.length < 2) continue;
        if (!header) header = lines[0];
        for (let i = 1; i < lines.length; i += 1) {
            if (lines[i]) rows.push(lines[i]);
        }
    }
    if (!header) {
        throw new Error(`no csv rows to merge for ${outputCsv}`);
    }
    fs.mkdirSync(path.dirname(outputCsv), { recursive: true });
    fs.writeFileSync(outputCsv, `${header}\n${rows.join('\n')}\n`, 'utf8');
}

function runEvalAndJudge(phase, inputs) {
    const files = parseInputList(inputs);
    if (files.length === 0) {
        throw new Error(`[${phase}] no input files`);
    }
    console.log(`\n[${phase}] Starting eval loop for ${files.length} file(s)`);
    const outDir = path.join(outBase, phase);
    const chunksDir = path.join(outDir, 'chunks');
    fs.mkdirSync(chunksDir, { recursive: true });

    const eventCsvs = [];
    const summaries = [];
    for (let i = 0; i < files.length; i += 1) {
        const inputFile = files[i];
        const chunkOut = path.join(chunksDir, String(i + 1).padStart(3, '0'));
        const evalArgs = [
            path.join(rootDir, 'scripts/validation/ws_event_truth_eval.js'),
            '--input', inputFile,
            '--out-dir', chunkOut,
            '--eval-worker', '1'
        ];

        if (args['max-lines']) evalArgs.push('--max-lines', String(args['max-lines']));

        const evalRes = spawnSync('node', evalArgs, { stdio: 'inherit' });
        if (evalRes.status !== 0) {
            console.error(`[ERR] ${phase} eval failed on ${inputFile}`);
            process.exit(1);
        }

        eventCsvs.push(path.join(chunkOut, 'events_labeled.csv'));
        const summaryPath = path.join(chunkOut, 'summary.json');
        if (fs.existsSync(summaryPath)) {
            try {
                summaries.push(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));
            } catch (_) {}
        }
    }

    mergeCsvRows(eventCsvs, path.join(outDir, 'events_labeled.csv'));
    fs.writeFileSync(path.join(outDir, 'split_summary.json'), JSON.stringify({
        phase,
        runId,
        files,
        chunks: summaries.map((s) => s?.counts ?? null)
    }, null, 2));

    const judgeArgs = [
        path.join(rootDir, 'scripts/validation/judge_validation_results.js'),
        '--run-dir', outDir
    ];

    const judgeRes = spawnSync('node', judgeArgs, { stdio: 'pipe', encoding: 'utf8' });
    if (judgeRes.status !== 0) {
        console.error(`[ERR] ${phase} judge failed:\n`, judgeRes.stderr);
        process.exit(1);
    }

    const judgeSummary = JSON.parse(judgeRes.stdout);
    fs.writeFileSync(path.join(outDir, 'judge_output.json'), JSON.stringify(judgeSummary, null, 2));

    const candJson = JSON.parse(fs.readFileSync(path.join(outDir, 'validation_judgement.json'), 'utf8'));
    return candJson.candidates;
}

const trainCandidates = runEvalAndJudge('train', trainInputs);
const adoptedTrain = trainCandidates.filter(c => c.decision === 'adopt_candidate');

if (adoptedTrain.length === 0) {
    console.error('\n[FAILED] No candidates passed the strict requirements in Train phase.');
    process.exit(1);
}

console.log(`\n[OK] Train phase passed. ${adoptedTrain.length} robust candidate(s) found.`);

let valCandidates = [];
if (validateInputs) {
    valCandidates = runEvalAndJudge('validate', validateInputs);

    // Cross check adopted real candidates in Validate
    const stillAdopted = [];
    for (const c of adoptedTrain) {
        const vc = valCandidates.find(v => v.type === c.type && v.side === c.side);
        // As per user rule: "Validateで崩れない"
        // Meaning it shouldn't hit decision='reject' in Validation
        if (vc && vc.decision !== 'reject') {
            stillAdopted.push(vc);
        }
    }

    if (stillAdopted.length === 0) {
        console.error('\n[FAILED] All train candidates broke down (rejected) in Validate phase.');
        process.exit(1);
    }

    console.log(`\n[OK] Validate phase passed. ${stillAdopted.length} candidate(s) survived.`);
}

if (forwardInputs) {
    const fwdCandidates = runEvalAndJudge('forward', forwardInputs);

    const finalAdopted = [];
    for (const c of adoptedTrain) {
        const fc = fwdCandidates.find(v => v.type === c.type && v.side === c.side);
        if (!fc) continue;

        const trainNet = c.avg_net_real;
        const fwdNet = fc.avg_net_real;

        // User condition: Forwardで meanが50%未満に落ちない (パフォーマンスが30%以上劣化したら却下, meaning fwdNet >= 0.7 * trainNet )
        // Wait, the user said "50%未満に落ちない" and then "30%以上劣化したら却下". We'll use 70% retention rule as the strict interpretation of "30%以上劣化"
        if (fwdNet >= 0.7 * trainNet && fc.decision !== 'reject') {
            finalAdopted.push(fc);
        } else {
            console.log(`\n[WARN] Candidate ${c.type}/${c.side} degraded in Forward. Train avg: ${trainNet.toFixed(4)}, Forward avg: ${fwdNet.toFixed(4)}`);
        }
    }

    if (finalAdopted.length === 0) {
        console.error('\n[FAILED] All candidates fell off in Forward testing (>= 30% degradation or core criteria failure).');
        process.exit(1);
    }

    console.log(`\n[SUCCESS] Forward testing passed for ${finalAdopted.length} candidate(s).`);
    console.log(finalAdopted.map(c => `${c.type} (${c.side})`).join('\n'));
}

console.log('\n[SPLIT PIPELINE COMPLETE] ->', outBase);
