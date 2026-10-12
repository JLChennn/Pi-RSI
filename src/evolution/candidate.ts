import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';
import { redact } from '../trajectory.js';
import { applyReplacement, guardPolicy, normalizeSource, parseProposal, POLICY_FILE, type EvolutionProposal } from './patch-guard.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type ValidationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NO_CHANGE';
function commandEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME'].includes(key)));
}
const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1_000_000, env: commandEnv(), windowsHide: true }).trim();
export function saveAudit(audit: string, name: string, value: unknown) {
  if (name.includes('/') || name.includes('\\')) throw new Error('Invalid artifact name');
  writeFileSync(join(audit, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function createAuditDirectory(repoRoot: string): string {
  const root = realpathSync(repoRoot);
  const experiments = join(root, 'experiments'); mkdirSync(experiments, { recursive: true });
  if (lstatSync(experiments).isSymbolicLink() || realpathSync(experiments) !== experiments) throw new Error('Unsafe audit root');
  const audit = join(experiments, `evolution-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(audit);
  saveAudit(audit, 'parent.json', { parentCommit: git(root, ['rev-parse', 'HEAD']), baselineRoot: root,
    baselinePolicyHash: digest(readFileSync(join(root, POLICY_FILE))) });
  return audit;
}

export async function runCommand(file: string, args: string[], timeout: number, cwd?: string) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolveResult => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 2_000_000, cwd, env: commandEnv(), windowsHide: true },
      (error, stdout, stderr) => resolveResult({ exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: String(stdout), stderr: String(stderr) }));
  });
}

export async function prepareValidationImage(repoRoot: string) {
  const lock = readFileSync(join(repoRoot, 'package-lock.json'));
  const dockerfile = readFileSync(join(repoRoot, 'scripts/candidate.Dockerfile'));
  const image = `pi-rsi-validation:${digest(Buffer.concat([lock, dockerfile])).slice(0, 16)}`;
  const server = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], 10000);
  if (server.exitCode) return { available: false as const, reason: 'Docker engine unavailable' };
  let inspect = await runCommand('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], 10000);
  if (inspect.exitCode) {
    console.log('Building trusted Linux dependency image; no candidate code or credentials enter the build.');
    const context = join(repoRoot, 'experiments', `image-${randomUUID()}`); mkdirSync(context);
    for (const name of ['package.json', 'package-lock.json']) writeFileSync(join(context, name), readFileSync(join(repoRoot, name)));
    writeFileSync(join(context, 'Dockerfile'), dockerfile);
    const build = await runCommand('docker', ['build', '--tag', image, context], 600000);
    saveAudit(context, 'build.json', build);
    if (build.exitCode) return { available: false as const, reason: 'Trusted dependency image build failed', buildArtifact: context };
    inspect = await runCommand('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], 10000);
  }
  const imageId = inspect.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) return { available: false as const, reason: 'Cannot pin validation image ID' };
  return { available: true as const, imageId };
}

export async function validateCandidate(repoRoot: string, audit: string, raw: unknown, secrets: string[] = []) {
  const root = realpathSync(repoRoot);
  const auditReal = realpathSync(audit);
  const rel = relative(join(root, 'experiments'), auditReal);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || lstatSync(audit).isSymbolicLink()) throw new Error('Candidate audit path escapes experiments');
  saveAudit(audit, 'proposal.json', redact(raw, secrets));
  const baselinePath = join(root, POLICY_FILE);
  const before = readFileSync(baselinePath);
  const beforeStatus = git(root, ['status', '--porcelain']);
  const parent = JSON.parse(readFileSync(join(audit, 'parent.json'), 'utf8')) as { parentCommit: string; baselinePolicyHash: string };
  let status: ValidationStatus = 'FAIL';
  const validation: Record<string, unknown> = { status, parentCommit: parent.parentCommit, staticGuard: 'NOT_RUN',
    compilation: 'NOT_RUN', invariantTests: 'NOT_RUN', behavior: 'NOT_RUN', baselineUnchanged: false };
  let proposal: EvolutionProposal | undefined;
  try {
    if (digest(before) !== parent.baselinePolicyHash) throw new Error('Baseline changed after observation');
    proposal = parseProposal(raw);
    if (proposal.decision === 'NO_CHANGE') { status = 'NO_CHANGE'; validation.reason = 'Evolver proposed no change'; }
    else {
      const changed = applyReplacement(before.toString('utf8'), proposal);
      guardPolicy(before.toString('utf8'), changed); validation.staticGuard = 'PASS';
      const workspace = join(auditReal, 'workspace');
      if (existsSync(workspace)) throw new Error('Candidate workspace already exists');
      const clone = await runCommand('git', ['clone', '--no-hardlinks', '--no-checkout', '--', root, workspace], 30000);
      saveAudit(audit, 'clone.json', redact(clone, secrets));
      if (clone.exitCode) throw new Error('Independent candidate clone failed');
      git(workspace, ['checkout', '--detach', parent.parentCommit]);
      const target = join(workspace, POLICY_FILE);
      if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('Policy is not a regular candidate file');
      const original = normalizeSource(readFileSync(target, 'utf8'));
      if (original !== normalizeSource(before.toString('utf8'))) throw new Error('Working policy differs from parent commit');
      writeFileSync(target, changed);
      const files = git(workspace, ['diff', '--name-only']).split('\n');
      if (files.length !== 1 || files[0] !== POLICY_FILE || git(workspace, ['ls-files', '--others', '--exclude-standard']))
        throw new Error('Candidate changed files outside whitelist');
      const diff = git(workspace, ['diff', '--', POLICY_FILE]);
      writeFileSync(join(audit, 'candidate.patch'), diff + '\n');
      validation.candidatePolicyHash = digest(normalizeSource(changed));
      validation.workspace = relative(root, workspace);
      // TypeScript compiler is trusted tooling; this does not import or execute candidate code.
      const compile = await runCommand(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
        '-p', join(workspace, 'tsconfig.json'), '--noEmit'], 60000, workspace);
      saveAudit(audit, 'compile.json', redact(compile, secrets));
      if (compile.exitCode) throw new Error('Candidate TypeScript compilation failed');
      validation.compilation = 'PASS';
      const baselineJs = ts.transpileModule(before.toString('utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(audit, 'baseline-policy.mjs'), baselineJs);
      const isolation = await prepareValidationImage(root);
      validation.isolation = isolation;
      if (!isolation.available) { status = 'BLOCKED'; validation.reason = isolation.reason; }
      else {
        const name = `pi-rsi-candidate-${randomUUID().slice(0, 12)}`;
        const common = ['run', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--cpus', '1', '--memory', '1g',
          '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
          '--mount', `type=bind,source=${workspace},target=/workspace,readonly`,
          '--mount', `type=bind,source=${join(auditReal, 'baseline-policy.mjs')},target=/baseline-policy.mjs,readonly`,
          '--workdir', '/workspace', isolation.imageId];
        // Fixed trusted script runs build, unchanged invariant tests, then the candidate behavior probe.
        const shell = 'node /node_modules/typescript/bin/tsc -p /workspace/tsconfig.json --outDir /tmp/build && ' +
          'node /node_modules/vitest/vitest.mjs run --configLoader native tests/harness.test.ts tests/benchmark.test.ts ' +
          '-t "^(?!.*(?:H0 always stops|transient H0 fails once)).*$" && ' +
          `node /tmp/build/scripts/validate-candidate.js ${validation.candidatePolicyHash}`;
        let execution;
        console.log('Executing guarded candidate in a credential-free, network-disabled container.');
        try { execution = await runCommand('docker', [...common, 'sh', '-c', shell], 120000); }
        finally {
          const cleanup = await runCommand('docker', ['rm', '-f', name], 15000);
          saveAudit(audit, 'cleanup.json', cleanup);
        }
        saveAudit(audit, 'execution.json', redact(execution, secrets));
        validation.containerCompilation = execution.stdout.includes(' RUN ') ? 'PASS' : 'FAIL';
        validation.invariantTests = /Test Files[^\n]*\bfailed\b/.test(execution.stdout) ? 'FAIL' :
          execution.stdout.includes('Test Files') ? 'PASS' : 'NOT_RUN';
        const marker = execution.stdout.split('\n').find(line => line.startsWith('CANDIDATE_RESULT='));
        if (!marker) throw new Error('Isolated validation failed before behavior evidence');
        const behavior = JSON.parse(marker.slice('CANDIDATE_RESULT='.length)) as Record<string, unknown>;
        validation.behaviorEvidence = behavior;
        if (behavior.sourceHash !== validation.candidatePolicyHash || behavior.baselineHash !== digest(baselineJs) ||
            validation.invariantTests !== 'PASS' || execution.exitCode || behavior.status !== 'PASS')
          throw new Error('Candidate behavior or safety checks failed');
        validation.behavior = 'PASS'; status = 'PASS';
      }
    }
  } catch (error) {
    validation.reason = redact(error instanceof Error ? error.message : 'Candidate validation failed', secrets);
    status = 'FAIL';
  } finally {
    validation.baselineUnchanged = digest(readFileSync(baselinePath)) === digest(before) && git(root, ['status', '--porcelain']) === beforeStatus;
    if (!validation.baselineUnchanged) { status = 'FAIL'; validation.reason = 'Baseline integrity check failed'; }
    validation.status = status;
    saveAudit(audit, 'validation.json', validation);
    writeFileSync(join(audit, 'summary.md'), `# Candidate ${status}\n\nParent: ${parent.parentCommit}\n\n` +
      `Decision: ${proposal?.decision ?? 'INVALID'}\n\nBaseline unchanged: ${validation.baselineUnchanged}\n\n` +
      'See proposal.json, candidate.patch (if applied), compile.json, execution.json and validation.json.\n' +
      'No candidate was accepted or merged. Full H0 tests remain baseline oracles; candidate uses the unchanged invariant subset.\n');
  }
  return { audit, status };
}
