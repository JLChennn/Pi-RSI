import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AdapterResult, ToolAdapter, WorkspaceArgs } from '../../benchmarks/fault-injector.js';
import { TrajectoryCollector } from '../trajectory.js';
import { decideRecovery, type ToolFailure, type RecoveryDecision } from './recovery-policy.js';

export const MAX_ATTEMPTS = 3;
const MAX_TOOL_CALLS = 12;
export const workspaceSchema = Type.Object({
  operation: Type.Union([Type.Literal('read_resource'), Type.Literal('append_record')]),
  resource: Type.Optional(Type.String()), record: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function normalizeFailure(error: unknown): { errorCode: string; message: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return { errorCode: typeof code === 'string' ? code : 'ETOOL',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown tool failure' };
}

/** Policy injection exists solely for wrapper safety tests, never exposed to the model. */
export function createRecoveryTool(adapter: ToolAdapter, trace: TrajectoryCollector,
  policy: (failure: ToolFailure) => RecoveryDecision = decideRecovery): ToolDefinition<typeof workspaceSchema> {
  let toolCalls = 0;
  return {
    name: 'workspace_service', label: 'Controlled workspace service',
    description: 'Local service. read_resource reads report. append_record appends a record once; a lost response may mean the write committed. Never assume an error means no side effect.',
    parameters: workspaceSchema, executionMode: 'sequential',
    async execute(toolCallId, args: WorkspaceArgs, signal) {
      const base = { toolName: 'workspace_service', toolCallId };
      toolCalls++;
      trace.record('wrapper_call', { ...base, args, callIndex: toolCalls });
      const fail = (errorCode: string, message: string, attempt: number) => {
        const result = { content: [{ type: 'text' as const, text: JSON.stringify({ errorCode, message }) }],
          details: { errorCode, message, attempt }, isError: true };
        trace.record('wrapper_result', { ...base, success: false, result });
        return result;
      };
      if (toolCalls > MAX_TOOL_CALLS) return fail('ECALLLIMIT', 'Per-task tool call budget exhausted', 0);
      // Frozen adapter fact computed before invoking any candidate policy.
      const retrySafe = adapter.retrySafe(args) === true;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) return fail('EABORT', 'Tool execution cancelled', attempt - 1);
        trace.record('harness_attempt_start', { ...base, attempt, retrySafe });
        let outcome: AdapterResult;
        try { outcome = await adapter.execute(args, signal); }
        catch (error) { outcome = { ok: false, ...normalizeFailure(error) }; }
        if (outcome.ok) {
          trace.record('harness_attempt_end', { ...base, attempt, success: true, value: outcome.value });
          const result = { content: [{ type: 'text' as const, text: outcome.value }],
            details: { attempt }, isError: false };
          trace.record('wrapper_result', { ...base, success: true, result });
          return result;
        }
        trace.record('harness_attempt_end', { ...base, attempt, success: false, ...outcome });
        let requested: RecoveryDecision;
        try { requested = policy(Object.freeze({ errorCode: outcome.errorCode, message: outcome.message,
          attempt, maxAttempts: MAX_ATTEMPTS, retrySafe })); }
        catch { requested = { action: 'stop' }; }
        const canRetry = requested?.action === 'retry' && retrySafe && attempt < MAX_ATTEMPTS && !signal?.aborted;
        trace.record('recovery_decision', { ...base, attempt, errorCode: outcome.errorCode,
          requestedAction: requested?.action ?? 'invalid', recoveryDecision: canRetry ? 'retry' : 'stop',
          retrySafe, maxAttempts: MAX_ATTEMPTS });
        if (!canRetry) return fail(outcome.errorCode, outcome.message, attempt);
      }
      throw new Error('Unreachable wrapper state');
    },
  };
}
