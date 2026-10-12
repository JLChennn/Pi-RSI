import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceService, type ToolAdapter } from '../benchmarks/fault-injector.js';
import { createRecoveryTool, normalizeFailure, MAX_ATTEMPTS } from '../src/harness/recovery-tool.js';
import { decideRecovery } from '../src/harness/recovery-policy.js';
import { TrajectoryCollector, redact } from '../src/trajectory.js';

function collector(secrets: string[] = []) {
  return new TrajectoryCollector(join(mkdtempSync(join(tmpdir(), 'pi-rsi-test-')), 'trace.jsonl'), 'session', 'task', secrets);
}
function call(tool: ReturnType<typeof createRecoveryTool>, id: string, operation: 'read_resource' | 'append_record', signal?: AbortSignal) {
  return tool.execute(id, { operation, resource: 'report', record: 'INTERVIEW_RECORD' }, signal, undefined, {} as never);
}
describe('H0 and deterministic fault injection', () => {
  it.each(['ECONNRESET', 'ENOENT', 'EACCES', 'ETOOL'])('H0 always stops on %s', code => {
    expect(decideRecovery({ errorCode: code, message: 'fault', attempt: 1, maxAttempts: 3, retrySafe: true })).toEqual({ action: 'stop' });
  });
  it('successful read returns a proper Pi result', async () => {
    const result = await call(createRecoveryTool(new WorkspaceService('none'), collector()), 'a', 'read_resource');
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'REPORT_OK_42' }]);
  });
  it('transient H0 fails once; separate LLM call can recover with attempt 1', async () => {
    const service = new WorkspaceService('transient'); const trace = collector(); const tool = createRecoveryTool(service, trace);
    expect((await call(tool, 'llm-1', 'read_resource')).isError).toBe(true);
    expect(service.calls).toBe(1);
    expect((await call(tool, 'llm-2', 'read_resource')).isError).toBe(false);
    const attempts = trace.events.filter(event => event.eventType === 'harness_attempt_start');
    expect(attempts.map(event => [event.toolCallId, event.attempt])).toEqual([['llm-1', 1], ['llm-2', 1]]);
    expect(trace.events.find(event => event.eventType === 'recovery_decision')?.recoveryDecision).toBe('stop');
  });
  it('returned permanent errors are normalized and never retried by H0', async () => {
    const service = new WorkspaceService('permanent'); const trace = collector();
    const result = await call(createRecoveryTool(service, trace), 'a', 'read_resource');
    expect(result.isError).toBe(true); expect(result.details).toMatchObject({ errorCode: 'ENOENT', attempt: 1 });
    expect(service.calls).toBe(1);
  });
  it('unsafe response loss leaves exactly one write, no internal retry', async () => {
    const service = new WorkspaceService('unsafe'); const trace = collector();
    const result = await call(createRecoveryTool(service, trace), 'a', 'append_record');
    expect(result.isError).toBe(true); expect(service.records).toEqual(['INTERVIEW_RECORD']);
    expect(service.calls).toBe(1);
    expect(trace.events.find(event => event.eventType === 'recovery_decision')?.retrySafe).toBe(false);
  });
  it('fresh injectors reproduce the same first transient error', async () => {
    for (let i = 0; i < 2; i++) {
      const service = new WorkspaceService('transient');
      await expect(service.execute({ operation: 'read_resource', resource: 'report' })).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect((await service.execute({ operation: 'read_resource', resource: 'report' })).ok).toBe(true);
    }
  });
  it('missing resources and invalid append parameters have stable error codes', async () => {
    const service = new WorkspaceService('none');
    await expect(service.execute({ operation: 'read_resource', resource: 'missing' })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.execute({ operation: 'append_record', record: '' })).rejects.toMatchObject({ code: 'EINVAL' });
    expect(service.records).toHaveLength(0);
  });
  it('invalid append calls cannot consume the first committed-write response loss', async () => {
    const service = new WorkspaceService('unsafe');
    await expect(service.execute({ operation: 'append_record' })).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(service.execute({ operation: 'append_record', record: 'INTERVIEW_RECORD' })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(service.records).toEqual(['INTERVIEW_RECORD']);
  });
  it('a read cannot consume the first unsafe append fault', async () => {
    const service = new WorkspaceService('unsafe');
    await service.execute({ operation: 'read_resource', resource: 'report' });
    await expect(service.execute({ operation: 'append_record', record: 'INTERVIEW_RECORD' })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(service.records).toHaveLength(1);
  });
  it('missing read resource is a parameter error and does not consume transient fault', async () => {
    const service = new WorkspaceService('transient');
    await expect(service.execute({ operation: 'read_resource' })).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(service.execute({ operation: 'read_resource', resource: 'report' })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect((await service.execute({ operation: 'read_resource', resource: 'report' })).ok).toBe(true);
  });
});
describe('fixed Wrapper safety boundaries (adversarial policies, not an H1 implementation)', () => {
  const alwaysRetry = () => ({ action: 'retry' as const });
  it('rejects unsafe retry even when policy requests it', async () => {
    const service = new WorkspaceService('unsafe'); const trace = collector();
    await call(createRecoveryTool(service, trace, alwaysRetry), 'a', 'append_record');
    expect(service.records).toHaveLength(1); expect(service.calls).toBe(1);
    expect(trace.events.find(event => event.eventType === 'recovery_decision')).toMatchObject({ requestedAction: 'retry', recoveryDecision: 'stop' });
  });
  it('caps internal attempts even for an always-retry policy', async () => {
    const service = new WorkspaceService('permanent'); const trace = collector();
    expect((await call(createRecoveryTool(service, trace, alwaysRetry), 'one-id', 'read_resource')).isError).toBe(true);
    expect(service.calls).toBe(MAX_ATTEMPTS);
    expect(trace.events.filter(event => event.eventType === 'harness_attempt_start').map(event => event.toolCallId)).toEqual(['one-id', 'one-id', 'one-id']);
  });
  it('aborted calls never start the backend', async () => {
    const service = new WorkspaceService('none'); const abort = new AbortController(); abort.abort();
    const result = await call(createRecoveryTool(service, collector(), alwaysRetry), 'a', 'append_record', abort.signal);
    expect(result.details).toMatchObject({ errorCode: 'EABORT' }); expect(service.calls).toBe(0);
  });
  it('cancellation during a failing attempt suppresses further attempts', async () => {
    const controller = new AbortController(); let calls = 0;
    const adapter: ToolAdapter = { retrySafe: () => true, execute: async () => {
      calls++; controller.abort(); throw new Error('cancelled');
    } };
    await call(createRecoveryTool(adapter, collector(), alwaysRetry), 'a', 'read_resource', controller.signal);
    expect(calls).toBe(1);
  });
  it('policy exceptions fail closed', async () => {
    const service = new WorkspaceService('transient');
    const result = await call(createRecoveryTool(service, collector(), () => { throw new Error('candidate bug'); }), 'a', 'read_resource');
    expect(result.isError).toBe(true); expect(service.calls).toBe(1);
  });
  it('policy cannot mutate trusted retrySafe', async () => {
    const service = new WorkspaceService('unsafe');
    await call(createRecoveryTool(service, collector(), failure => { failure.retrySafe = true; return alwaysRetry(); }), 'a', 'append_record');
    expect(service.calls).toBe(1);
  });
  it('bounds backend calls across repeated model calls', async () => {
    const service = new WorkspaceService('none'); const tool = createRecoveryTool(service, collector());
    for (let i = 0; i < 12; i++) await call(tool, `call-${i}`, 'read_resource');
    expect((await call(tool, 'call-13', 'read_resource')).details).toMatchObject({ errorCode: 'ECALLLIMIT' });
    expect(service.calls).toBe(12);
  });
});
describe('error shape and durable JSONL', () => {
  it('normalizes coded Error and arbitrary thrown values', () => {
    expect(normalizeFailure(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toEqual({ errorCode: 'ENOENT', message: 'missing' });
    expect(normalizeFailure('string error')).toEqual({ errorCode: 'ETOOL', message: 'string error' });
    expect(normalizeFailure(null)).toEqual({ errorCode: 'ETOOL', message: 'Unknown tool failure' });
  });
  it('persists reconstructable events and redacts nested credentials and configured secrets', () => {
    const trace = collector(['fictional-sensitive-value']);
    trace.record('task_start', { prompt: 'a fictional-sensitive-value', headers: { Authorization: 'private' },
      nested: { apiKey: 'x', text: 'Bearer fake-token sk-fictional' } });
    const lines = readFileSync(trace.path, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]!);
    expect(event).toMatchObject({ sessionId: 'session', taskId: 'task', eventType: 'task_start' });
    expect(event.timestamp).toMatch(/Z$/); expect(event.headers).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('fictional-sensitive-value'); expect(lines[0]).not.toContain('fake-token');
  });
  it('does not overwrite prior traces', () => {
    const trace = collector();
    expect(() => new TrajectoryCollector(trace.path, 's', 't')).toThrow();
  });
  it('redacts structured tokens while preserving safe fields', () => {
    expect(redact({ token: 'private', value: 'REPORT_OK_42' })).toEqual({ token: '[REDACTED]', value: 'REPORT_OK_42' });
  });
});
