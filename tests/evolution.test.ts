import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFacts, loadObservation, parseModelProposal } from '../src/evolver.js';
import { createAuditDirectory, validateCandidate } from '../src/evolution/candidate.js';
import { applyReplacement, guardPolicy, parseProposal, POLICY_FILE, type EvolutionProposal } from '../src/evolution/patch-guard.js';
import type { TraceEvent } from '../src/trajectory.js';

const root = process.cwd();
const baseline = readFileSync(join(root, POLICY_FILE), 'utf8');
// Synthetic test inputs only; production Evolver never uses these functions as templates.
const fixture = (body: string) => baseline.slice(0, baseline.indexOf('export function')) +
  `export function decideRecovery(failure: ToolFailure): RecoveryDecision { ${body} }\n`;
const proposal = (source: string): EvolutionProposal => ({ decision: 'PATCH', failureMode: 'synthetic test',
  evidence: ['fixture-task#0'], hypothesis: 'synthetic test', targetFile: POLICY_FILE,
  patch: { oldText: baseline, newText: source }, expectedBenefit: 'fixture', risks: [] });

describe('fact extraction, not hardcoded conclusions', () => {
  it('preserves actual error, IDs and attempts and drops unrelated streaming events', () => {
    const events = [
      { taskId: 'read-a', eventType: 'pi_message_update' },
      { taskId: 'read-a', eventType: 'harness_attempt_end', toolCallId: 'call-a', attempt: 1, success: false, errorCode: 'ECUSTOM' },
      { taskId: 'read-a', eventType: 'recovery_decision', toolCallId: 'call-a', recoveryDecision: 'stop', retrySafe: true },
      { taskId: 'read-a', eventType: 'llm_tool_call', toolCallId: 'call-b' },
      { taskId: 'read-a', eventType: 'task_end', successfulReads: ['value'], records: [], stopReason: 'stop' },
    ] as TraceEvent[];
    const facts = extractFacts(events);
    expect(facts).toHaveLength(4);
    expect(facts[0]).toMatchObject({ ref: 'read-a#1', errorCode: 'ECUSTOM', toolCallId: 'call-a', attempt: 1 });
    expect(facts[2]?.toolCallId).toBe('call-b');
    expect(facts[3]).toMatchObject({ successfulReadCount: 1, recordCount: 0 });
    expect(JSON.stringify(facts)).not.toContain('ECONNRESET');
  });
  it('rejects a requested run outside experiments', () => { expect(() => loadObservation(root, '.')).toThrow(/outside experiments/); });
});

describe('strict structured Proposal', () => {
  it('accepts a parsed exact replacement Proposal', () => { expect(parseProposal(proposal(fixture("return {action:'stop'};"))).decision).toBe('PATCH'); });
  it('accepts NO_CHANGE without patch', () => {
    const { patch: _, ...value } = proposal('unused');
    expect(parseProposal({ ...value, decision: 'NO_CHANGE' }).decision).toBe('NO_CHANGE');
  });
  it('rejects NO_CHANGE with a patch', () => { expect(() => parseProposal({ ...proposal('x'), decision: 'NO_CHANGE' })).toThrow(); });
  it.each(['../src/harness/recovery-policy.ts', '/tmp/policy.ts', 'src/harness/../harness/recovery-policy.ts',
    'src/harness/recovery-tool.ts', 'tests/harness.test.ts', 'src\\harness\\recovery-policy.ts'])('rejects nonliteral target %s', targetFile => {
    expect(() => parseProposal({ ...proposal('x'), targetFile })).toThrow(/whitelist/);
  });
  it('rejects wrong schema and unknown fields', () => {
    expect(() => parseProposal({ ...proposal('x'), evidence: [] })).toThrow();
    expect(() => parseProposal({ ...proposal('x'), command: 'shell' })).toThrow();
    expect(() => parseModelProposal('not JSON')).toThrow();
  });
  it('extracts fenced JSON without inventing a patch', () => {
    const value = proposal(fixture("return {action:'stop'};"));
    expect(parseModelProposal('```json\n' + JSON.stringify(value) + '\n```')).toEqual(value);
  });
  it('requires a unique exact source match and a real change', () => {
    expect(() => applyReplacement(baseline, proposal(baseline))).toThrow(/did not change/);
    const value = proposal('different'); value.patch!.oldText = 'nonexistent';
    expect(() => applyReplacement(baseline, value)).toThrow(/exactly once/);
    value.patch = { oldText: 'stop', newText: 'retry' };
    expect(() => applyReplacement("'stop' 'stop'", value)).toThrow(/exactly once/);
  });
});

describe('AST guard permits only the small pure language', () => {
  it('permits pure conditionals and literal includes', () => {
    const code = fixture("if (!failure.retrySafe || failure.attempt >= failure.maxAttempts) return {action:'stop'}; return {action: ['ECONNRESET'].includes(failure.errorCode) ? 'retry' : 'stop'};");
    expect(() => guardPolicy(baseline, code)).not.toThrow();
  });
  it('rejects malformed TypeScript', () => { expect(() => guardPolicy(baseline, fixture('return {'))).toThrow(/syntax/); });
  it('rejects a changed signature', () => {
    expect(() => guardPolicy(baseline, fixture("return {action:'stop'};").replace('failure: ToolFailure', 'failure: string'))).toThrow(/signature/);
  });
  it('rejects changed exported types', () => {
    expect(() => guardPolicy(baseline, fixture("return {action:'stop'};").replace('maxAttempts: number', 'maxAttempts: string'))).toThrow(/types/);
  });
  it.each([
    "return {action: process.env.API_KEY ? 'retry' : 'stop'};",
    "fetch('https://example.com'); return {action:'stop'};",
    "return {action: globalThis['process'] ? 'retry' : 'stop'};",
    "return {action: failure['retrySafe'] ? 'retry' : 'stop'};",
    "while (true) {} return {action:'stop'};",
    "const value = Function('return process')(); return {action:'stop'};",
    "failure.retrySafe = true; return {action:'retry'};",
    "return {action: (failure as any).constructor ? 'retry' : 'stop'};",
  ])('rejects disallowed body %s', body => { expect(() => guardPolicy(baseline, fixture(body))).toThrow(); });
  it('rejects imports and top-level effects', () => {
    expect(() => guardPolicy(baseline, "import fs from 'node:fs';\n" + fixture("return {action:'stop'};"))).toThrow();
    expect(() => guardPolicy(baseline, fixture("return {action:'stop'};") + 'console.log(1);')).toThrow();
  });
});

describe('auditable candidate isolation without executing proposals on the host', () => {
  it('NO_CHANGE preserves baseline and writes a terminal record', async () => {
    const audit = createAuditDirectory(root); const { patch: _, ...value } = proposal('unused');
    const result = await validateCandidate(root, audit, { ...value, decision: 'NO_CHANGE' });
    expect(result.status).toBe('NO_CHANGE'); expect(readFileSync(join(root, POLICY_FILE), 'utf8')).toBe(baseline);
    expect(JSON.parse(readFileSync(join(audit, 'validation.json'), 'utf8')).baselineUnchanged).toBe(true);
  });
  it('rejected source retains proposal, diagnostics and baseline', async () => {
    const audit = createAuditDirectory(root);
    expect((await validateCandidate(root, audit, proposal(fixture("return {action: process.env.KEY ? 'retry' : 'stop'};")))).status).toBe('FAIL');
    expect(existsSync(join(audit, 'proposal.json'))).toBe(true); expect(existsSync(join(audit, 'validation.json'))).toBe(true);
    expect(existsSync(join(audit, 'workspace'))).toBe(false); expect(readFileSync(join(root, POLICY_FILE), 'utf8')).toBe(baseline);
  });
});

describe.skipIf(process.env.PI_RSI_TEST_DOCKER !== '1')('isolated Docker fixtures (not model generation)', () => {
  it('a compliant fixture changes behavior in a new real Worker Session', async () => {
    const audit = createAuditDirectory(root);
    const code = fixture("return {action: failure.retrySafe && failure.attempt < failure.maxAttempts && failure.errorCode === 'ECONNRESET' ? 'retry' : 'stop'};");
    const result = await validateCandidate(root, audit, proposal(code));
    expect(result.status).toBe('PASS');
    const validation = JSON.parse(readFileSync(join(audit, 'validation.json'), 'utf8'));
    expect(validation.baselineUnchanged).toBe(true); expect(validation.behaviorEvidence.workerOutcomes[0].serviceCalls).toBe(2);
    expect(readFileSync(join(root, POLICY_FILE), 'utf8')).toBe(baseline);
  }, 180000);
  it('an unsafe-only retry fixture is rejected by isolated safety checks', async () => {
    const audit = createAuditDirectory(root);
    const result = await validateCandidate(root, audit, proposal(fixture("return {action: failure.retrySafe ? 'stop' : 'retry'};")));
    expect(result.status).toBe('FAIL');
    expect(existsSync(join(audit, 'candidate.patch'))).toBe(true);
    const record = JSON.parse(readFileSync(join(audit, 'validation.json'), 'utf8'));
    expect(record.baselineUnchanged).toBe(true); expect(record.invariantTests).toBe('PASS');
    expect(record.behaviorEvidence.reason).toMatch(/Unsafe decision/);
  }, 180000);
  it('AST-compatible but type-incompatible code is rejected before execution', async () => {
    const audit = createAuditDirectory(root);
    expect((await validateCandidate(root, audit, proposal(fixture("return {action:'invalid'};")))).status).toBe('FAIL');
    const record = JSON.parse(readFileSync(join(audit, 'validation.json'), 'utf8'));
    expect(record.reason).toMatch(/compilation/); expect(record.behavior).toBe('NOT_RUN');
  }, 90000);
});
