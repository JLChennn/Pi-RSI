import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { guardPolicy, normalizeSource } from '../evolution/patch-guard.js';
import { prepareValidationImage } from '../evolution/candidate.js';
import type { ToolFailure, RecoveryDecision } from '../harness/recovery-policy.js';

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export type PolicyIdentity = { revisionId: string; parentRevision: string | null; candidateId?: string;
  sourceHash: string; compiledHash: string; sourcePath: string; validationPath: string };
export type PolicyBinding = { identity: PolicyIdentity; decide(failure: ToolFailure): RecoveryDecision;
  close(): void; calls: number; failure?: string };
function docker(args: string[], timeout = 10000): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME'].includes(key)));
  return execFileSync('docker', args, { encoding: 'utf8', timeout, env, windowsHide: true, maxBuffer: 1000000 }).trim();
}
export function compilePolicy(source: string) {
  return ts.transpileModule(normalizeSource(source), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}
export async function openPolicyBinding(root: string, identity: PolicyIdentity, directory: string): Promise<PolicyBinding> {
  const source = normalizeSource(readFileSync(identity.sourcePath, 'utf8'));
  guardPolicy(readFileSync(join(root, 'src/harness/recovery-policy.ts'), 'utf8'), source);
  const compiled = compilePolicy(source);
  if (sha(source) !== identity.sourceHash || sha(compiled) !== identity.compiledHash) throw new Error('Policy artifact hash mismatch');
  const image = await prepareValidationImage(root);
  if (!image.available) throw new Error('Docker isolation unavailable');
  mkdirSync(directory, { recursive: true });
  const modulePath = join(directory, 'policy.mjs'); writeFileSync(modulePath, compiled);
  const name = `pi-rsi-policy-${randomUUID().slice(0, 12)}`;
  let binding: PolicyBinding | undefined;
  try {
    docker(['run', '-d', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--cpus', '0.5', '--memory', '128m', '--pids-limit', '32',
      '--mount', `type=bind,source=${modulePath},target=/policy.mjs,readonly`,
      '--mount', `type=bind,source=${join(root, 'scripts/policy-rpc.mjs')},target=/rpc.mjs,readonly`,
      image.imageId, 'node', '/rpc.mjs', '--serve', identity.sourceHash], 20000);
    const exchange = (payload: string) => {
      const response = JSON.parse(docker(['exec', name, 'node', '/rpc.mjs', payload, identity.sourceHash]));
      if (response.sourceHash !== identity.sourceHash || response.compiledHash !== identity.compiledHash)
        throw new Error('Runtime policy attestation mismatch');
      return response as { sourceHash: string; compiledHash: string; requestId?: string; action?: string };
    };
    exchange('--attest');
    let closed = false;
    binding = { identity, calls: 0,
      decide(failure) {
        if (closed) throw new Error('Policy container already closed');
        const requestId = randomUUID();
        try {
          const result = exchange(Buffer.from(JSON.stringify({ requestId, failure })).toString('base64'));
          if (result.requestId !== requestId || !['retry', 'stop'].includes(result.action ?? '')) throw new Error('Invalid policy response');
          binding!.calls++;
          return { action: result.action as RecoveryDecision['action'] };
        } catch { binding!.failure = 'POLICY_RPC_FAILED'; throw new Error('Policy RPC failed'); }
      },
      close() {
        if (!closed) { docker(['rm', '-f', name]); closed = true; }
      },
    };
    writeFileSync(join(directory, 'attestation.json'), JSON.stringify({ ...identity, imageId: image.imageId,
      network: 'none', credentialsInjected: false, mounts: ['policy.mjs', 'trusted rpc.mjs'] }, null, 2));
    return binding;
  } catch (error) { try { docker(['rm', '-f', name]); } catch {} throw error; }
}
