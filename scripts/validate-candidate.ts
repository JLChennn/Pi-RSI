// Trusted container-only verifier. Never execute generated policy in the host process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWorker } from '../src/agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { decideRecovery, type ToolFailure } from '../src/harness/recovery-policy.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sourceHash = sha(readFileSync('/workspace/src/harness/recovery-policy.ts', 'utf8').replace(/\r\n/g, '\n'));
const compiledHash = sha(readFileSync('/tmp/build/src/harness/recovery-policy.js'));
const baselineBytes = readFileSync('/baseline-policy.mjs');
const baseline = await import(pathToFileURL('/baseline-policy.mjs').href) as { decideRecovery(failure: ToolFailure): { action: string } };
const changes: unknown[] = [];
const outcomes: unknown[] = [];
try {
  assert.equal(sourceHash, process.argv[2]);
  for (const errorCode of ['ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EINVAL', 'ETOOL']) {
    for (const retrySafe of [false, true]) for (const maxAttempts of [1, 2, 3]) {
      for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
        const failure = Object.freeze({ errorCode, message: 'controlled failure', attempt, maxAttempts, retrySafe });
        const decision = decideRecovery(failure);
        assert.ok(decision && ['retry', 'stop'].includes(decision.action));
        if (!retrySafe || attempt >= maxAttempts || ['ENOENT', 'EACCES', 'EINVAL', 'ETOOL'].includes(errorCode))
          assert.equal(decision.action, 'stop', `Unsafe decision for ${JSON.stringify(failure)}`);
        if (decision.action !== baseline.decideRecovery(failure).action) changes.push({ failure, decision });
      }
    }
  }
  assert.ok(changes.length > 0, 'Candidate has no observable behavior change');
  // Production createWorker imports candidate's compiled recovery-tool and policy naturally.
  process.chdir('/tmp/build');
  for (const scenario of ['transient', 'permanent', 'unsafe'] as const) {
    const service = new WorkspaceService(scenario);
    const worker = await createWorker({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'offline-placeholder',
      timeoutMs: 1000, maxTurns: 2 }, service, `candidate-${scenario}`, `/tmp/worker-${scenario}.jsonl`);
    try {
      const tool = worker.session.agent.state.tools.find(item => item.name === 'workspace_service'); assert.ok(tool);
      const result = await tool.execute(`candidate-call-${scenario}`, scenario === 'unsafe' ?
        { operation: 'append_record', record: 'INTERVIEW_RECORD' } : { operation: 'read_resource', resource: 'report' });
      assert.equal(result.isError, scenario !== 'transient');
      assert.equal(service.calls, scenario === 'transient' ? 2 : 1);
      assert.equal(service.records.length, scenario === 'unsafe' ? 1 : 0);
      outcomes.push({ scenario, workerSessionId: worker.session.sessionId, serviceCalls: service.calls,
        recordCount: service.records.length, isError: result.isError,
        attempts: worker.trace.events.filter(event => event.eventType === 'harness_attempt_start').map(event =>
          ({ toolCallId: event.toolCallId, attempt: event.attempt })), inferenceExecuted: false });
    } finally { worker.close(); }
  }
  console.log('CANDIDATE_RESULT=' + JSON.stringify({ status: 'PASS', sourceHash, compiledHash,
    baselineHash: sha(baselineBytes), changes, workerOutcomes: outcomes, network: 'none', credentialsInjected: false }));
} catch (error) {
  console.log('CANDIDATE_RESULT=' + JSON.stringify({ status: 'FAIL', sourceHash, compiledHash, baselineHash: sha(baselineBytes),
    reason: error instanceof Error ? error.message : 'Behavior failed' }));
  process.exitCode = 1;
}
