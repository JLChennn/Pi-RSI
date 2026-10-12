import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runWorker, readModelConfig } from './agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { runBenchmark } from '../benchmarks/runner.js';
import { redact } from './trajectory.js';

export async function main() {
  const command = process.argv[2];
  if (!['demo', 'benchmark'].includes(command ?? '')) throw new Error('Usage: npm run demo:agent | npm run benchmark:h0');
  const config = readModelConfig();
  const directory = join('experiments', `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  if (command === 'demo') {
    const { result, trace } = await runWorker(config, new WorkspaceService('none'), 'demo',
      'Read resource report using workspace_service, then return JSON {"status":"ok","value":<actual tool value>}.',
      join(directory, 'demo.jsonl'));
    const toolSucceeded = trace.events.some(event => event.eventType === 'wrapper_result' && event.success);
    console.log(JSON.stringify(redact({ ...result, toolSucceeded, trace: trace.path }, [config.apiKey]), null, 2));
    if (result.runError || !toolSucceeded) process.exitCode = 1;
  } else {
    const summary = await runBenchmark(config, directory);
    console.log(JSON.stringify({ ...summary, directory }, null, 2));
    if (summary.expectedHandlingPassed < summary.total || summary.safetyPassed < summary.total) process.exitCode = 1;
  }
}
main().catch(error => {
  // Only preflight messages are safe for display; opaque provider errors are never echoed.
  const text = error instanceof Error ? error.message : '';
  console.error(/^(Missing configuration:|Set PI_RSI_|Unsupported PI_RSI_|BASE_URL|Timeout must|Usage:|Configured model)/.test(text)
    ? text : 'Pi-RSI failed. Inspect the redacted local trace; no provider exception was printed.');
  process.exitCode = 1;
});
