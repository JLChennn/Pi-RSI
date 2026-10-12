import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type TraceEvent = {
  timestamp: string; sessionId: string; taskId: string; eventType: string;
  toolName?: string; toolCallId?: string; attempt?: number; errorCode?: string;
  recoveryDecision?: 'retry' | 'stop'; success?: boolean;
  [key: string]: unknown;
};
const sensitiveKey = /^(authorization|headers|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|signature|thinkingSignature)$/i;

/** Defense in depth. Controlled tasks must never include credentials. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
    return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitiveKey.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  }
  return value;
}

export class TrajectoryCollector {
  readonly events: TraceEvent[] = [];
  constructor(readonly path: string, readonly sessionId: string, readonly taskId: string,
    private readonly secrets: readonly string[] = []) {
    mkdirSync(dirname(path), { recursive: true });
    // Exclusive creation prevents accidental overwriting of earlier experiment evidence.
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  }
  record(eventType: string, fields: Record<string, unknown> = {}): void {
    const event = redact({ ...fields, timestamp: new Date().toISOString(),
      sessionId: this.sessionId, taskId: this.taskId, eventType }, this.secrets) as TraceEvent;
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.events.push(event);
  }
}
