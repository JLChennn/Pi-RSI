import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorker } from '../src/agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { activeRevision } from '../src/evolution/version-manager.js';
import { saveAudit } from '../src/evolution/candidate.js';
const root = process.cwd();
const revision = activeRevision(root);
const service = new WorkspaceService('transient');
const path = join(root, 'experiments', `revision-probe-${randomUUID()}.jsonl`);
const worker = await createWorker({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'offline-placeholder', timeoutMs: 1000, maxTurns: 2 }, service, 'active-revision-probe', path);
try {
  const tool = worker.session.agent.state.tools.find(item => item.name === 'workspace_service');
  if (!tool) throw new Error('Missing tool');
  const result = await tool.execute('active-probe', { operation: 'read_resource', resource: 'report' });
  const proof = { revisionId: revision.revisionId, sourceHash: revision.sourceHash, compiledHash: revision.compiledHash,
    runtimeHash: worker.policyBinding?.identity.sourceHash, attempts: service.calls, isError: result.isError,
    inferenceExecuted: false, trace: path };
  if (proof.runtimeHash !== proof.sourceHash) throw new Error('Active runtime hash mismatch');
  saveAudit(join(root, 'experiments'), `revision-probe-${randomUUID()}.json`, proof);
  console.log(JSON.stringify(proof, null, 2));
} finally { worker.close(); }
