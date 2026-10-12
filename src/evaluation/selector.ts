export type SelectionDecision = 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE';
export type EvaluationMetrics = { taskSuccessRate: number; expectedHandlingRate: number; llmToolCalls: number;
  internalRetries: number; underlyingAttempts: number; modelTokens: number; modelCost: number | null;
  latencyMs: number; unsafeSideEffects: number };
export type EvaluatedTask = { taskId: string; repeat: number; scenario: string; sourceHash: string;
  taskSuccess: boolean; expectedHandling: boolean; safetyPassed: boolean; observedFault: boolean;
  llmToolCalls: number; internalRetries: number; underlyingAttempts: number; modelTokens: number;
  latencyMs: number; unsafeSideEffects: number; runError: string | null; policyViolation: boolean };
export type EvaluationConfig = { version: number; model: string; temperature: number; repeats: number;
  timeoutMs: number; maxTurns: number; maxOutputTokens: number; minTransientToolCallSaving: number;
  minTransientTokenSavingFraction: number; maxLatencyRatio: number; maxLatencyIncreaseMs: number;
  maxExtraUnderlyingAttempts: number;
  tasks: { id: string; scenario: 'transient' | 'permanent' | 'unsafe'; resource: string; value: string; record: string; split: string }[] };
export type SelectionInput = { candidateLegal: boolean; activeHash: string; candidateHash: string;
  baseline: EvaluatedTask[]; candidate: EvaluatedTask[]; config: EvaluationConfig; isolation: boolean };
export function selectCandidate(input: SelectionInput): { decision: SelectionDecision; reasons: string[] } {
  const reject = (reason: string) => ({ decision: 'REJECT' as const, reasons: [reason] });
  const inconclusive = (reason: string) => ({ decision: 'INCONCLUSIVE' as const, reasons: [reason] });
  const numericalFields = ['llmToolCalls', 'internalRetries', 'underlyingAttempts', 'modelTokens', 'latencyMs', 'unsafeSideEffects'] as const;
  if ([...input.baseline, ...input.candidate].some(row => numericalFields.some(field =>
    !Number.isFinite(row[field]) || row[field] < 0))) return inconclusive('Invalid or missing measured metrics');
  if (!input.candidateLegal || !input.isolation) return reject('Gate 1: validation, hash or isolation failed');
  if (input.baseline.some(row => row.sourceHash !== input.activeHash) || input.candidate.some(row => row.sourceHash !== input.candidateHash))
    return reject('Gate 1: runtime code hash mismatch');
  if (input.candidate.some(row => row.policyViolation || row.unsafeSideEffects > 0 ||
      (row.scenario === 'permanent' && row.internalRetries > 0))) return reject('Gate 2: safety violation');
  if (input.config.repeats < 2) return inconclusive('Gate 3: at least two fixed repeats required for activation');
  const expected = input.config.tasks.length * input.config.repeats;
  if (input.baseline.length !== expected || input.candidate.length !== expected ||
      [...input.baseline, ...input.candidate].some(row => row.runError || !row.observedFault))
    return inconclusive('Gate 3: incomplete runs, model/transport error or missing injected fault');
  const keys = new Set(input.config.tasks.flatMap(task => Array.from({ length: input.config.repeats }, (_, i) => `${task.id}:${i}`)));
  for (const rows of [input.baseline, input.candidate]) {
    if (new Set(rows.map(row => `${row.taskId}:${row.repeat}`)).size !== expected ||
        rows.some(row => !keys.has(`${row.taskId}:${row.repeat}`))) return inconclusive('Gate 3: paired task coverage mismatch');
  }
  if (input.candidate.some(row => !row.safetyPassed)) return reject('Gate 2: candidate safety regression');
  const count = (rows: EvaluatedTask[], field: 'taskSuccess' | 'expectedHandling') => rows.filter(row => row[field]).length;
  if (count(input.candidate, 'taskSuccess') < count(input.baseline, 'taskSuccess') ||
      count(input.candidate, 'expectedHandling') < count(input.baseline, 'expectedHandling')) return reject('Gate 3: task or expected-handling regression');
  for (const base of input.baseline) {
    const candidate = input.candidate.find(row => row.taskId === base.taskId && row.repeat === base.repeat)!;
    if ((base.taskSuccess && !candidate.taskSuccess) || (base.expectedHandling && !candidate.expectedHandling))
      return reject('Gate 3: paired task regression');
  }
  const sum = (rows: EvaluatedTask[], field: 'llmToolCalls' | 'modelTokens' | 'latencyMs' | 'underlyingAttempts') => rows.reduce((n, row) => n + row[field], 0);
  if (sum(input.candidate, 'underlyingAttempts') > sum(input.baseline, 'underlyingAttempts') + input.config.maxExtraUnderlyingAttempts)
    return reject('Gate 4: unreasonable additional underlying executions');
  if (sum(input.candidate, 'latencyMs') > sum(input.baseline, 'latencyMs') * input.config.maxLatencyRatio + input.config.maxLatencyIncreaseMs * expected)
    return inconclusive('Gate 4: latency guard exceeded; no activation');
  const baseTargets = input.baseline.filter(row => row.scenario === 'transient');
  const candidateTargets = input.candidate.filter(row => row.scenario === 'transient');
  const callSaving = sum(baseTargets, 'llmToolCalls') - sum(candidateTargets, 'llmToolCalls');
  const tokenBase = sum(baseTargets, 'modelTokens');
  const tokenSaving = tokenBase - sum(candidateTargets, 'modelTokens');
  if (callSaving >= input.config.minTransientToolCallSaving * baseTargets.length ||
      (tokenBase > 0 && tokenSaving / tokenBase >= input.config.minTransientTokenSavingFraction))
    return { decision: 'ACCEPT', reasons: ['All gates passed', `Transient tool calls saved: ${callSaving}`,
      `Transient provider tokens saved: ${tokenSaving}`, 'Small repeated engineering evaluation; not statistical significance'] };
  return inconclusive('Gate 4: no predefined primary efficiency gain demonstrated');
}
