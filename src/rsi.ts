import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTask, loadTasks, assess } from '../benchmarks/runner.js';
import type { ModelConfig } from './agent.js';
import { evolveOnce } from './evolver.js';
import { saveAudit } from './evolution/candidate.js';
import { activeRevision, identity, applySelection, loadVersions } from './evolution/version-manager.js';
import { openPolicyBinding, sha } from './evaluation/policy-runtime.js';
import { evaluateCandidate, loadEvaluationConfig } from './evaluation/evaluator.js';

export function evolutionOutcome(status: string, stage?: string): 'NO_CHANGE' | 'INCONCLUSIVE' | 'REJECT' {
  if (status === 'NO_CHANGE') return 'NO_CHANGE';
  if (status === 'BLOCKED' || stage === 'evolver') return 'INCONCLUSIVE';
  return 'REJECT';
}

export async function rsiOnce(config: ModelConfig) {
  const root = process.cwd(); const active = activeRevision(root);
  const frozen = loadEvaluationConfig(root);
  const workerConfig = { ...config, temperature: frozen.temperature, timeoutMs: frozen.timeoutMs,
    maxTurns: frozen.maxTurns, maxOutputTokens: frozen.maxOutputTokens };
  const audit = join(root, 'experiments', `rsi-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(audit);
  saveAudit(audit, 'initial-version.json', { ...active });
  const development = join(audit, 'development'); mkdirSync(development);
  const source = readFileSync(identity(root, active).sourcePath, 'utf8');
  saveAudit(development, 'manifest.json', { policy: active.revisionId, policyHash: sha(source),
    purpose: 'development-only; evaluation tasks and assertions are never sent to Evolver' });
  const results = [];
  for (const task of loadTasks()) {
    let binding;
    try {
      binding = await openPolicyBinding(root, identity(root, active), join(development, `runtime-${task.id}`));
      const { result, trace, service } = await executeTask(workerConfig, task, development, binding);
      // Legacy grading is used only as development evidence, never H1 evaluation safety.
      const assessment = assess(task, service, result, trace.events);
      trace.record('benchmark_assessment', assessment); results.push({ taskId: task.id, scenario: task.scenario, ...assessment });
      if (result.runError) throw new Error('Development model run incomplete');
    } catch {
      saveAudit(development, 'summary.json', { kind: 'incomplete-development', results });
      saveAudit(audit, 'outcome.json', { outcome: 'INCONCLUSIVE', active: active.revisionId,
        reason: 'Development runtime/model evidence incomplete; Evolver was not invoked' });
      return { audit, outcome: 'INCONCLUSIVE' };
    } finally { binding?.close(); }
  }
  saveAudit(development, 'summary.json', { kind: 'real-pi-llm-e2e', policy: active.revisionId, results });
  console.log('Development trajectories collected; invoking existing independent Evolver.');
  const evolved = await evolveOnce(workerConfig, relative(root, development), { source, revisionId: active.revisionId });
  saveAudit(audit, 'evolution.json', evolved);
  if (evolved.status !== 'PASS') {
    const validation = JSON.parse(readFileSync(join(evolved.audit, 'validation.json'), 'utf8'));
    const outcome = evolutionOutcome(evolved.status, validation.stage);
    saveAudit(audit, 'outcome.json', { outcome, active: activeRevision(root).revisionId, evolution: relative(root, evolved.audit) });
    return { audit, outcome };
  }
  const evaluation = await evaluateCandidate(workerConfig, relative(root, evolved.audit));
  const selection = applySelection(root, join(evaluation.audit, 'evaluation.json'));
  const outcome = { audit, outcome: selection.decision, active: selection.active, evaluation: relative(root, evaluation.audit),
    candidate: relative(root, evolved.audit), versions: loadVersions(root).history.at(-1) };
  saveAudit(audit, 'outcome.json', outcome); return outcome;
}
