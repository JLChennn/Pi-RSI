import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createWorker, type ModelConfig } from '../src/agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';

// Offline construction check ONLY: never calls session.prompt or replaces Pi's model loop.
const configs: ModelConfig[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'offline-construction-placeholder', timeoutMs: 1000, maxTurns: 2 },
  { provider: 'iquest', model: 'IQuest-Q1', api: 'openai-responses',
    baseUrl: 'https://codeplan.iquestlab.com/api/predict/converge.converge/v1',
    apiKey: 'offline-construction-placeholder', timeoutMs: 1000, maxTurns: 2 },
];
for (const config of configs) {
  const worker = await createWorker(config, new WorkspaceService('none'), 'sdk-construction',
    join('experiments', `sdk-smoke-${randomUUID()}.jsonl`));
  try {
  const tool = worker.session.agent.state.tools.find(item => item.name === 'workspace_service');
  if (!tool) throw new Error('Missing custom tool');
  const result = await tool.execute('offline-direct-call', { operation: 'read_resource', resource: 'report' });
  if (result.isError || result.content[0]?.type !== 'text' || result.content[0].text !== 'REPORT_OK_42')
    throw new Error('Custom tool integration failed');
  worker.trace.record('offline_sdk_smoke', { success: true, inferenceExecuted: false });
    console.log(`${config.provider}: real Pi AgentSession constructed; registered custom tool executed directly; session disposed. No LLM inference performed.`);
  } finally { worker.close(); }
}
