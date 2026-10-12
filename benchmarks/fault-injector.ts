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

/** Per-task state. Each operation's fault sequence persists across LLM calls. */
export class WorkspaceService implements ToolAdapter {
  readonly records: string[] = [];
  readonly successfulReads: string[] = [];
  readonly resources: Readonly<Record<string, string>> = Object.freeze({ report: 'REPORT_OK_42' });
  calls = 0;
  private validReads = 0;
  private committedWrites = 0;
  constructor(readonly scenario: Scenario) {}
  retrySafe(args: WorkspaceArgs): boolean { return args.operation === 'read_resource'; }
  async execute(args: WorkspaceArgs, signal?: AbortSignal): Promise<AdapterResult> {
    signal?.throwIfAborted();
    this.calls++;
    if (args.operation === 'read_resource') {
      if (typeof args.resource !== 'string' || args.resource.length === 0)
        throw new ToolExecutionError('EINVAL', 'read_resource requires resource:string, for example resource="report"');
      this.validReads++;
      if (this.scenario === 'transient' && this.validReads === 1)
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
      this.committedWrites++;
      if (this.scenario === 'unsafe' && this.committedWrites === 1)
        throw new ToolExecutionError('ECONNRESET', 'Append committed; response lost; outcome unknown to caller');
      return { ok: true, value: 'APPEND_ACK' };
    }
    throw new ToolExecutionError('EINVAL', 'append_record requires a nonempty record:string; resource is not the record');
  }
}
