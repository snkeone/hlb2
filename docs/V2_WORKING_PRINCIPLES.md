# V2 Working Principles

## Hard Constraints (Locked)
- Scope lock:
  - Only perform data analysis, validity verification, and edge discovery for V2.
- Change lock:
  - Do not touch unnecessary files/components.
  - Keep edits minimal and directly tied to the active analysis objective.
- Decision lock:
  - Prioritize effect quality (edge, stability, expected value proxy) over signal frequency.

## North Star
- Goal: improve trading outcomes by extracting and validating meaningful signals from raw WS logs.
- Non-goal: increasing feature count without measurable edge.

## Mandatory Task Framing
- Before work:
  - State the target metric (example: uplift, OOS stability, expected value proxy, false positive reduction).
  - State which raw-log-derived feature(s) are being tested or revised.
- During work:
  - Prefer evidence from latest generated artifacts in `logs/ops/...` and `data/validation/runs/...`.
  - Separate "frequent" from "effective" (frequency alone is not validity).
- After work:
  - Record concise outcome in `docs/V2_WORK_LOG.md`.
  - Include what changed, observed effect, and next action.

## Quick Checklist (Per Task)
- Objective linkage is explicit.
- Metrics before/after are comparable.
- OOS or walk-forward impact is checked when available.
- Any operational risk (missing env, notification failure, data gap) is noted.
- One-line next step is defined.
