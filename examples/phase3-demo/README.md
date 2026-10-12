# Real Phase 3 evidence bundle

This small bundle copies public controlled-task artifacts from the completed real IQuest-Q1 round recorded in `provenance.json`. It contains no fabricated scores, raw HTTP/stream traces, credentials, dependency folders or source clones.

`provenance.json` records original relative paths, parent/upstream commits and SHA256 of every copied file. Copies retain original bytes. Replay verifies hashes, source identities, Phase 2 validation, paired metrics and deterministic selection. These hashes detect accidental changes; they are not an independent evaluator's cryptographic signature.

- `development.json`: real H0 outcomes and call counts.
- `proposal.json` / `candidate.patch`: actual Evolver hypothesis and patch.
- `h0-policy.ts` / `h1-policy.ts`: actual source, read as text only by Replay.
- `validation.json`: isolated compilation, invariants, behavior and hashes.
- `evaluation.json`: real paired rows, metrics, configuration and ACCEPT reasons.

Reproduce from the original local, ignored artifacts:

```powershell
npm.cmd run demo:bundle -- --run experiments/<completed-rsi-run>
npm.cmd run docs:assets
npm.cmd run demo:replay
```

This bundle uses `rsi-2026-10-12T12-04-29-750Z-20447277`. Export stops on obvious private path/credential patterns. Before publishing another bundle, inspect it and run the delivery check; arbitrary task content may be private even though these controlled tasks are public.
