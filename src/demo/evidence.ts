import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { selectCandidate, type SelectionInput, type EvaluationMetrics } from '../evaluation/selector.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
export const defaultEvidence = 'examples/phase3-demo';
const files = ['evaluation.json', 'validation.json', 'proposal.json', 'candidate.patch', 'h0-policy.ts', 'h1-policy.ts', 'development.json'];
export function experimentFiles(root: string, run: string) {
  const inside = (path: string) => {
    const actual = realpathSync(resolve(root, path)); const rel = relative(realpathSync(join(root, 'experiments')), actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Replay run must be inside experiments');
    return actual;
  };
  const directory = inside(run); const outcome = json(join(directory, 'outcome.json'));
  if (!outcome.evaluation || !outcome.candidate) throw new Error(`Incomplete historical round: ${outcome.outcome}; no E2E results to replay`);
  const candidate = inside(outcome.candidate); const evaluation = inside(outcome.evaluation);
  return { directory, candidate, evaluation, mapping: {
    'evaluation.json': join(evaluation, 'evaluation.json'), 'validation.json': join(candidate, 'validation.json'),
    'proposal.json': join(candidate, 'proposal.json'), 'candidate.patch': join(candidate, 'candidate.patch'),
    'h0-policy.ts': join(candidate, 'baseline-policy.ts'), 'h1-policy.ts': join(candidate, 'workspace/src/harness/recovery-policy.ts'),
    'development.json': join(directory, 'development/summary.json'),
  } };
}
export function exportEvidence(root: string, run: string, output = defaultEvidence) {
  const source = experimentFiles(root, run); const target = resolve(root, output); mkdirSync(target, { recursive: true });
  const hashes: Record<string, string> = {}; const originals: Record<string, string> = {};
  for (const [name, path] of Object.entries(source.mapping)) {
    const bytes = readFileSync(path);
    if (/[A-Za-z]:[\\/](?:Users|Windows)|Bearer\s+[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}/.test(bytes.toString('utf8')))
      throw new Error(`Potential private data in ${name}; export stopped`);
    writeFileSync(join(target, name), bytes); hashes[name] = sha(bytes); originals[name] = relative(root, path).replaceAll('\\', '/');
  }
  const validation = json(source.mapping['validation.json']);
  writeFileSync(join(target, 'provenance.json'), JSON.stringify({ version: 1, kind: 'REAL_PHASE3_EVIDENCE_COPY',
    run: relative(root, source.directory).replaceAll('\\', '/'), parentCommit: validation.parentCommit,
    upstreamCommit: '7c10bd4337495ee613f2224843ecdf349b80d1df', model: 'IQuest-Q1', originals, hashes,
    scope: 'Exact public controlled-task artifacts; raw HTTP/stream traces, credentials, machine paths and source clones excluded' }, null, 2) + '\n');
  return loadEvidence(root, output);
}
export function loadEvidence(root: string, directory = defaultEvidence, historical = false) {
  const target = resolve(root, directory);
  const mapping: Record<string, string> = historical ? experimentFiles(root, directory).mapping :
    Object.fromEntries(files.map(file => [file, join(target, file)]));
  if (!historical) {
    const provenance = json(join(target, 'provenance.json'));
    if (provenance.kind !== 'REAL_PHASE3_EVIDENCE_COPY') throw new Error('Unknown evidence provenance');
    for (const file of files) if (sha(readFileSync(mapping[file]!)) !== provenance.hashes[file]) throw new Error(`Evidence hash mismatch: ${file}`);
  }
  const evaluation = json(mapping['evaluation.json']!) as { input: SelectionInput; metrics: { baseline: EvaluationMetrics; candidate: EvaluationMetrics }; selection: { decision: string; reasons: string[] } };
  const validation = json(mapping['validation.json']!); const proposal = json(mapping['proposal.json']!);
  const normalizedHash = (path: string) => sha(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
  if (normalizedHash(mapping['h0-policy.ts']!) !== evaluation.input.activeHash ||
      normalizedHash(mapping['h1-policy.ts']!) !== evaluation.input.candidateHash ||
      validation.candidatePolicyHash !== evaluation.input.candidateHash || validation.status !== 'PASS' ||
      sha(readFileSync(mapping['validation.json']!)) !== (evaluation as unknown as { phase2ValidationHash: string }).phase2ValidationHash ||
      selectCandidate(evaluation.input).decision !== evaluation.selection.decision) throw new Error('Historical evidence does not reproduce');
  for (const side of ['baseline', 'candidate'] as const) {
    const rows = evaluation.input[side]; const metrics = evaluation.metrics[side];
    for (const field of ['llmToolCalls', 'internalRetries', 'underlyingAttempts', 'modelTokens', 'latencyMs', 'unsafeSideEffects'] as const) {
      if (Math.abs(rows.reduce((sum, row) => sum + row[field], 0) - metrics[field]) > 0.000001) throw new Error(`Metric mismatch: ${side}.${field}`);
    }
    if (rows.filter(row => row.taskSuccess).length / rows.length !== metrics.taskSuccessRate ||
        rows.filter(row => row.expectedHandling).length / rows.length !== metrics.expectedHandlingRate) throw new Error('Outcome metric mismatch');
  }
  return { evaluation, validation, proposal, patch: readFileSync(mapping['candidate.patch']!, 'utf8'),
    development: json(mapping['development.json']!), source: directory };
}
export function replay(evidence: ReturnType<typeof loadEvidence>): string {
  const { evaluation: e, proposal: p, validation: v } = evidence;
  const b = e.metrics.baseline; const c = e.metrics.candidate;
  const sample = e.input.baseline.length;
  return ['REPLAY — historical real IQuest-Q1 evidence; no LLM, Docker or version writes.',
    `Source: ${evidence.source}`, '', '1. RUN / OBSERVE',
    'H0 stops each failed tool call. Transient recovery required an additional model tool call.',
    '', '2. REFLECT', p.hypothesis, '', '3. REWRITE — actual model-generated patch', evidence.patch,
    '4. VALIDATE', `Guard=${v.staticGuard}; compile=${v.compilation}; invariants=${v.invariantTests}; behavior=${v.behavior}`,
    `Source SHA256: ${v.candidatePolicyHash}`, '', `5. EVALUATE — ${e.input.config.tasks.length} tasks × ${e.input.config.repeats} repeats per harness`,
    'Metric                        H0           H1',
    ...([
      ['Business success', `${Math.round(b.taskSuccessRate * sample)}/${sample}`, `${Math.round(c.taskSuccessRate * sample)}/${sample}`],
      ['Expected handling', `${Math.round(b.expectedHandlingRate * sample)}/${sample}`, `${Math.round(c.expectedHandlingRate * sample)}/${sample}`],
      ['LLM tool calls', b.llmToolCalls, c.llmToolCalls], ['Internal retries', b.internalRetries, c.internalRetries],
      ['Underlying attempts', b.underlyingAttempts, c.underlyingAttempts], ['Provider tokens', b.modelTokens, c.modelTokens],
      ['Total latency (s)', (b.latencyMs / 1000).toFixed(3), (c.latencyMs / 1000).toFixed(3)],
      ['Duplicate side effects', b.unsafeSideEffects, c.unsafeSideEffects],
    ]).map(([name, a, z]) => `${String(name).padEnd(30)}${String(a).padEnd(13)}${z}`),
    '', `6. SELECT — historical ${e.selection.decision}`, ...e.selection.reasons,
    'No current revision was activated or rolled back. Small engineering sample; billed cost unknown.', ''].join('\n');
}
