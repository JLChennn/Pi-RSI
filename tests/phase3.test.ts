import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectCandidate, type SelectionInput, type EvaluatedTask } from '../src/evaluation/selector.js';
import { loadEvaluationConfig, freshService, assessEvaluation } from '../src/evaluation/evaluator.js';
import { activeRevision, loadVersions, applySelection, rollback, identity, validatedCandidate } from '../src/evolution/version-manager.js';
import { sha, compilePolicy, openPolicyBinding } from '../src/evaluation/policy-runtime.js';
import { createWorker } from '../src/agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';

const project = process.cwd(); const config = loadEvaluationConfig(project);
const baseSource = readFileSync(join(project, 'src/harness/recovery-policy.ts'), 'utf8');
// Synthetic fixture only; not a model-generated proposal or measured evaluation.
const fixtureSource = baseSource.slice(0, baseSource.indexOf('export function')) +
  "export function decideRecovery(f: ToolFailure): RecoveryDecision { return { action: f.retrySafe && f.attempt < f.maxAttempts && f.errorCode === 'ECONNRESET' ? 'retry' : 'stop' }; }\n";
function metricsInput(): SelectionInput {
  const rows = (candidate: boolean): EvaluatedTask[] => config.tasks.flatMap(task => [0, 1].map(repeat => ({
    taskId: task.id, repeat, scenario: task.scenario, sourceHash: candidate ? sha(fixtureSource) : sha(baseSource),
    taskSuccess: task.scenario === 'transient', expectedHandling: true, safetyPassed: true, observedFault: true,
    llmToolCalls: task.scenario === 'transient' && !candidate ? 2 : 1,
    internalRetries: candidate && task.scenario === 'transient' ? 1 : 0,
    underlyingAttempts: task.scenario === 'transient' ? 2 : 1, modelTokens: candidate ? 200 : 300,
    latencyMs: 1000, unsafeSideEffects: 0, runError: null, policyViolation: false,
  })));
  return { candidateLegal: true, isolation: true, activeHash: sha(baseSource), candidateHash: sha(fixtureSource),
    baseline: rows(false), candidate: rows(true), config };
}
function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-rsi-versions-'));
  mkdirSync(join(root, 'src/harness'), { recursive: true }); writeFileSync(join(root, 'src/harness/recovery-policy.ts'), baseSource);
  const candidate = join(root, 'experiments', 'unit-candidate'); mkdirSync(join(candidate, 'workspace/src/harness'), { recursive: true });
  writeFileSync(join(candidate, 'workspace/src/harness/recovery-policy.ts'), fixtureSource);
  writeFileSync(join(candidate, 'validation.json'), JSON.stringify({ kind: 'UNIT_FIXTURE_ONLY', status: 'PASS',
    staticGuard: 'PASS', compilation: 'PASS', invariantTests: 'PASS', behavior: 'PASS', baselineUnchanged: true,
    candidatePolicyHash: sha(fixtureSource), isolation: { available: true },
    behaviorEvidence: { status: 'PASS', compiledHash: sha(compilePolicy(fixtureSource)) } }));
  const input = metricsInput();
  const evaluation = join(root, 'experiments', 'mock-evaluation.json');
  writeFileSync(evaluation, JSON.stringify({ kind: 'MOCK_METRICS_ONLY', candidatePath: 'experiments/unit-candidate',
    input, selection: selectCandidate(input) }));
  return { root, candidate, evaluation, input };
}
describe('version-independent environment and grading', () => {
  it('initializes independent H0/H1 fault state', async () => {
    const task = config.tasks[0]!; const h0 = freshService(task); const h1 = freshService(task);
    await expect(h0.execute({ operation: 'read_resource', resource: task.resource })).rejects.toMatchObject({ code: 'ECONNRESET' });
    await expect(h1.execute({ operation: 'read_resource', resource: task.resource })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(h0.calls).toBe(1); expect(h1.calls).toBe(1);
  });
  it('keeps heldout content out of development tasks', () => {
    expect(config.tasks.filter(task => task.split === 'heldout')).toHaveLength(3);
    expect(config.tasks.find(task => task.id === 'heldout-transient')!.value).not.toBe('REPORT_OK_42');
  });
  it('counts internal retries without adding an LLM call and allows safe recovery', async () => {
    const task = config.tasks[0]!; const service = freshService(task);
    await service.execute({ operation: 'read_resource', resource: task.resource }).catch(() => {});
    await service.execute({ operation: 'read_resource', resource: task.resource });
    const events = [ { eventType: 'llm_tool_call' }, { eventType: 'harness_attempt_start', attempt: 1 },
      { eventType: 'harness_attempt_start', attempt: 2 }, { eventType: 'harness_attempt_end', success: false, errorCode: 'ECONNRESET' } ];
    const result = assessEvaluation(task, 0, 'hash', service, { finalText: JSON.stringify({ status: 'ok', value: task.value }), stopReason: 'stop' }, events as never);
    expect(result).toMatchObject({ llmToolCalls: 1, internalRetries: 1, underlyingAttempts: 2, safetyPassed: true, taskSuccess: true });
  });
  it('rejects permanent retries and duplicate unsafe writes regardless of final text', async () => {
    const task = config.tasks.find(item => item.scenario === 'unsafe')!; const service = freshService(task);
    await service.execute({ operation: 'append_record', record: task.record }).catch(() => {});
    await service.execute({ operation: 'append_record', record: task.record });
    const row = assessEvaluation(task, 0, 'hash', service, { finalText: '{"status":"unknown"}', stopReason: 'stop' }, []);
    expect(row.unsafeSideEffects).toBe(1); expect(row.safetyPassed).toBe(false);
  });
});
describe('Selector mock metrics, not real evaluation', () => {
  it('accepts a safe paired primary efficiency improvement', () => { expect(selectCandidate(metricsInput()).decision).toBe('ACCEPT'); });
  it('rejects validation failure', () => { expect(selectCandidate({ ...metricsInput(), candidateLegal: false }).decision).toBe('REJECT'); });
  it('rejects runtime hash mismatch', () => { const input = metricsInput(); input.candidate[0]!.sourceHash = 'wrong'; expect(selectCandidate(input).decision).toBe('REJECT'); });
  it('rejects permanent automatic retries', () => { const input = metricsInput(); input.candidate.find(row => row.scenario === 'permanent')!.internalRetries = 1; expect(selectCandidate(input).decision).toBe('REJECT'); });
  it('rejects unsafe side effects', () => { const input = metricsInput(); input.candidate[0]!.unsafeSideEffects = 1; expect(selectCandidate(input).decision).toBe('REJECT'); });
  it('rejects paired task regression', () => { const input = metricsInput(); input.candidate[0]!.taskSuccess = false; expect(selectCandidate(input).decision).toBe('REJECT'); });
  it('returns inconclusive for missing pairs', () => { const input = metricsInput(); input.candidate.pop(); expect(selectCandidate(input).decision).toBe('INCONCLUSIVE'); });
  it('returns inconclusive for model exceptions', () => { const input = metricsInput(); input.candidate[0]!.runError = 'ETIMEOUT'; expect(selectCandidate(input).decision).toBe('INCONCLUSIVE'); });
  it('returns inconclusive for smoke only', () => { const input = metricsInput(); input.config = { ...config, repeats: 1 }; expect(selectCandidate(input).decision).toBe('INCONCLUSIVE'); });
  it('returns inconclusive without a predetermined benefit', () => { const input = metricsInput(); input.candidate = input.baseline.map(row => ({ ...row, sourceHash: input.candidateHash })); expect(selectCandidate(input).decision).toBe('INCONCLUSIVE'); });
  it('returns inconclusive for material latency degradation', () => { const input = metricsInput(); input.candidate.forEach(row => { row.latencyMs = 100000; }); expect(selectCandidate(input).decision).toBe('INCONCLUSIVE'); });
});
describe('atomic pointer operations with clearly synthetic artifacts', () => {
  it('Accept loads the expected hash; repeat Accept is idempotent', () => {
    const fixture = repositoryFixture(); loadVersions(fixture.root);
    expect(applySelection(fixture.root, fixture.evaluation).decision).toBe('ACCEPT');
    expect(activeRevision(fixture.root).sourceHash).toBe(sha(fixtureSource));
    expect(applySelection(fixture.root, fixture.evaluation)).toMatchObject({ idempotent: true });
    expect(readFileSync(join(fixture.root, 'src/harness/recovery-policy.ts'), 'utf8')).toBe(baseSource);
  });
  it('Rollback restores H0 and repeated rollback cannot toggle forward', () => {
    const fixture = repositoryFixture(); applySelection(fixture.root, fixture.evaluation);
    expect(rollback(fixture.root).active).toBe('H0'); expect(activeRevision(fixture.root).sourceHash).toBe(sha(baseSource));
    expect(rollback(fixture.root).idempotent).toBe(true);
  });
  it('Reject leaves Active unchanged and retains reasons', () => {
    const fixture = repositoryFixture(); fixture.input.candidateLegal = false;
    writeFileSync(fixture.evaluation, JSON.stringify({ candidatePath: 'experiments/unit-candidate', input: fixture.input, selection: selectCandidate(fixture.input) }));
    expect(applySelection(fixture.root, fixture.evaluation).decision).toBe('REJECT');
    expect(activeRevision(fixture.root).revisionId).toBe('H0'); expect(loadVersions(fixture.root).history.at(-1)!.action).toBe('REJECT');
  });
  it('corrupt manifest fails closed instead of silently resetting', () => {
    const fixture = repositoryFixture(); loadVersions(fixture.root);
    writeFileSync(join(fixture.root, '.pi-rsi/revisions.json'), '{broken');
    expect(() => activeRevision(fixture.root)).toThrow();
  });
  it('modified validated candidate hash is rejected before activation', () => {
    const fixture = repositoryFixture(); writeFileSync(join(fixture.candidate, 'workspace/src/harness/recovery-policy.ts'), baseSource);
    expect(() => validatedCandidate(fixture.root, 'experiments/unit-candidate')).toThrow(/hash/);
  });
  it('modified revision content is rejected', () => {
    const fixture = repositoryFixture(); loadVersions(fixture.root);
    writeFileSync(join(fixture.root, '.pi-rsi/revisions/H0/policy.ts'), fixtureSource);
    expect(() => activeRevision(fixture.root)).toThrow(/corrupted/);
  });
});
describe.skipIf(process.env.PI_RSI_TEST_DOCKER !== '1')('real isolated policy boundary with synthetic version fixture', () => {
  it('new Pi Worker loads accepted and rolled-back policy while host never imports it', async () => {
    const fixture = repositoryFixture();
    for (const file of ['package.json', 'package-lock.json', 'scripts/candidate.Dockerfile', 'scripts/policy-rpc.mjs']) {
      mkdirSync(join(fixture.root, file, '..'), { recursive: true }); writeFileSync(join(fixture.root, file), readFileSync(join(project, file)));
    }
    applySelection(fixture.root, fixture.evaluation);
    for (const expected of [2, 1]) {
      const rev = activeRevision(fixture.root);
      const binding = await openPolicyBinding(fixture.root, identity(fixture.root, rev), join(fixture.root, `runtime-${expected}`));
      const service = new WorkspaceService('transient');
      const worker = await createWorker({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'offline', timeoutMs: 1000, maxTurns: 2 },
        service, 'version-proof', join(fixture.root, `trace-${expected}.jsonl`), binding);
      try { await worker.session.agent.state.tools[0]!.execute('same-call', { operation: 'read_resource', resource: 'report' });
        expect(service.calls).toBe(expected); expect(worker.policyBinding!.identity.sourceHash).toBe(rev.sourceHash);
      } finally { worker.close(); }
      rollback(fixture.root);
    }
  }, 120000);
});
