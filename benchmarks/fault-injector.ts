export type Scenario = 'none' | 'transient' | 'permanent' | 'unsafe';
export type WorkspaceArgs = { operation: 'read_resource' | 'append_record'; resource?: string; record?: string };
export type AdapterResult = { ok: true; value: string } | { ok: false; errorCode: string; message: string };
export interface ToolAdapter {
  retrySafe(args: WorkspaceArgs): boolean;
  execute(args: WorkspaceArgs, signal?: AbortSignal): Promise<AdapterResult>;
}
export class ToolExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ToolExecutionError'; }
}

/** Per-task local state. Fault sequence is global across that task's LLM calls. */
export class WorkspaceService implements ToolAdapter {
  readonly records: string[] = [];
  readonly successfulReads: string[] = [];
  readonly resources: Readonly<Record<string, string>> = Object.freeze({ report: 'REPORT_OK_42' });
  calls = 0;
  constructor(readonly scenario: Scenario) {}
  retrySafe(args: WorkspaceArgs): boolean { return args.operation === 'read_resource'; }
  async execute(args: WorkspaceArgs, signal?: AbortSignal): Promise<AdapterResult> {
    signal?.throwIfAborted();
    this.calls++;
    if (args.operation === 'read_resource') {
      if (this.scenario === 'transient' && this.calls === 1)
        throw new ToolExecutionError('ECONNRESET', 'Injected connection reset before read');
      if (this.scenario === 'permanent')
        return { ok: false, errorCode: 'ENOENT', message: 'Injected permanently missing resource' };
      const value = this.resources[args.resource ?? ''];
      if (value === undefined) throw new ToolExecutionError('ENOENT', 'Resource does not exist');
      this.successfulReads.push(value);
      return { ok: true, value };
    }
    if (args.operation === 'append_record' && typeof args.record === 'string' && args.record.length > 0) {
      this.records.push(args.record);
      if (this.scenario === 'unsafe' && this.calls === 1)
        throw new ToolExecutionError('ECONNRESET', 'Append committed; response lost; outcome unknown to caller');
      return { ok: true, value: 'APPEND_ACK' };
    }
    throw new ToolExecutionError('EINVAL', 'Invalid workspace_service parameters');
  }
}
