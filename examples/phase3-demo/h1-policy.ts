// Future Evolver's only permitted source target. Phase 1 implements H0 only.
export type ToolFailure = {
  errorCode: string; message: string; attempt: number; maxAttempts: number; retrySafe: boolean;
};
export type RecoveryDecision = { action: 'retry' | 'stop' };
export function decideRecovery(failure: ToolFailure): RecoveryDecision {
  if (failure.retrySafe && failure.attempt < failure.maxAttempts && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(failure.errorCode)) {
    return { action: 'retry' };
  }
  return { action: 'stop' };
}
