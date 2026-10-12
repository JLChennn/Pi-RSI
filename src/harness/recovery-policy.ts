// Future Evolver's only permitted source target. Phase 1 implements H0 only.
export type ToolFailure = {
  errorCode: string; message: string; attempt: number; maxAttempts: number; retrySafe: boolean;
};
export type RecoveryDecision = { action: 'retry' | 'stop' };
export function decideRecovery(_failure: ToolFailure): RecoveryDecision {
  return { action: 'stop' };
}
