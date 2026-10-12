import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runWorker, readModelConfig } from './agent.js';
import { WorkspaceService } from '../benchmarks/fault-injector.js';
import { runBenchmark } from '../benchmarks/runner.js';
import { redact } from './trajectory.js';
import { evolveOnce } from './evolver.js';
import { prepareValidationImage } from './evolution/candidate.js';
import { evaluateCandidate } from './evaluation/evaluator.js';
import { applySelection, loadVersions, rollback, contained } from './evolution/version-manager.js';
import { rsiOnce } from './rsi.js';

export async function main() {
  const command = process.argv[2];
  if (command === 'status') {
    const state = loadVersions(process.cwd());
    const latest = [...state.history].reverse().find(item => item.evaluationPath);
    const evaluation = latest?.evaluationPath ? JSON.parse(readFileSync(contained(process.cwd(), latest.evaluationPath), 'utf8')) : null;
    console.log(JSON.stringify({ ...state, latestEvaluation: evaluation ? {
      path: latest!.evaluationPath, selection: evaluation.selection, metrics: evaluation.metrics } : null }, null, 2)); return;
  }
  if (command === 'rollback') { console.log(JSON.stringify(rollback(process.cwd()), null, 2)); return; }
  if (command === 'prepare-validation') {
    const result = await prepareValidationImage(process.cwd());
    console.log(JSON.stringify(result, null, 2));
    if (!result.available) process.exitCode = 2;
    return;
  }
  if (!['demo', 'benchmark', 'evolve', 'evaluate', 'rsi'].includes(command ?? '')) throw new Error('Usage: demo | benchmark | evolve | evaluate | rsi | status | rollback');
  const config = readModelConfig();
  if (command === 'rsi') { console.log(JSON.stringify(await rsiOnce(config), null, 2)); return; }
  if (command === 'evaluate') {
    const args = process.argv.slice(3);
    if (args[0] !== '--candidate' || !args[1] || args.slice(2).some(arg => !['--smoke', '--activate'].includes(arg)))
      throw new Error('Usage: evaluate --candidate <id-or-path> [--smoke] [--activate]');
    const result = await evaluateCandidate(config, args[1], args.includes('--smoke'));
    console.log(JSON.stringify(result, null, 2));
    if (args.includes('--activate')) console.log(JSON.stringify(applySelection(process.cwd(), join(result.audit, 'evaluation.json')), null, 2));
    return;
  }
  if (command === 'evolve') {
    const args = process.argv.slice(3);
    if (args.length && (args.length !== 2 || args[0] !== '--run' || !args[1])) throw new Error('Usage: evolve --run <benchmark-directory>');
    const result = await evolveOnce(config, args[1]);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'FAIL') process.exitCode = 1;
    if (result.status === 'BLOCKED') process.exitCode = 2;
    return;
  }
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
