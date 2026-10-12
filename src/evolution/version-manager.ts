import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compilePolicy, sha, openPolicyBinding, type PolicyIdentity } from '../evaluation/policy-runtime.js';
import { guardPolicy, normalizeSource, POLICY_FILE } from './patch-guard.js';
import { selectCandidate, type SelectionInput, type SelectionDecision } from '../evaluation/selector.js';

export type HarnessRevision = { revisionId: string; parentRevision: string | null; candidateId?: string;
  sourceHash: string; compiledHash: string; sourcePath: string; validationPath: string; evaluationPath?: string;
  createdAt: string; status: 'active' | 'accepted' | 'rejected' };
export type VersionState = { version: 1; active: string; previous: string | null; revisions: HarnessRevision[];
  history: { action: string; at: string; from: string; to: string; candidateId?: string; evaluationPath?: string; reasons?: string[] }[] };
function versionDirectory(root: string, namespace?: string) {
  if (namespace !== undefined && !/^[a-z0-9-]{1,80}$/.test(namespace)) throw new Error('Invalid demo namespace');
  return namespace ? join(root, '.pi-rsi', 'demos', namespace) : join(root, '.pi-rsi');
}
const statePath = (root: string, namespace?: string) => join(versionDirectory(root, namespace), 'revisions.json');
export function contained(root: string, path: string): string {
  const resolved = realpathSync(resolve(root, path)); const rel = relative(realpathSync(root), resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escapes repository');
  return resolved;
}
function persist(root: string, state: VersionState, namespace?: string) {
  const target = statePath(root, namespace); const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, target);
}
export function loadVersions(root: string, namespace?: string): VersionState {
  if (!existsSync(statePath(root, namespace))) {
    const source = normalizeSource(readFileSync(join(root, POLICY_FILE), 'utf8'));
    guardPolicy(source, source);
    const directory = join(versionDirectory(root, namespace), 'revisions/H0'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'policy.ts'), source, { flag: 'wx' });
    const revision: HarnessRevision = { revisionId: 'H0', parentRevision: null, sourceHash: sha(source),
      compiledHash: sha(compilePolicy(source)), sourcePath: relative(root, join(directory, 'policy.ts')),
      validationPath: relative(root, join(directory, 'validation.json')), createdAt: new Date().toISOString(), status: 'active' };
    writeFileSync(join(directory, 'validation.json'), JSON.stringify({ status: 'PASS', kind: 'trusted-baseline-snapshot', sourceHash: revision.sourceHash }));
    persist(root, { version: 1, active: 'H0', previous: null, revisions: [revision], history: [] }, namespace);
  }
  const state = JSON.parse(readFileSync(statePath(root, namespace), 'utf8')) as VersionState;
  if (state.version !== 1 || !Array.isArray(state.revisions) || !Array.isArray(state.history) ||
      new Set(state.revisions.map(item => item.revisionId)).size !== state.revisions.length ||
      state.revisions.filter(item => item.status === 'active').length !== 1 ||
      !state.revisions.some(item => item.revisionId === state.active && item.status === 'active') ||
      (state.previous !== null && !state.revisions.some(item => item.revisionId === state.previous && item.status !== 'rejected')))
    throw new Error('Invalid Active Revision manifest');
  for (const revision of state.revisions) {
    if (revision.parentRevision !== null && (revision.parentRevision === revision.revisionId ||
        !state.revisions.some(item => item.revisionId === revision.parentRevision))) throw new Error('Invalid revision parent');
    if (!/^[A-Za-z0-9-]+$/.test(revision.revisionId) || !/^[a-f0-9]{64}$/.test(revision.sourceHash) ||
        !/^[a-f0-9]{64}$/.test(revision.compiledHash) || !['active', 'accepted', 'rejected'].includes(revision.status))
      throw new Error('Invalid Harness Revision');
    const source = normalizeSource(readFileSync(contained(root, revision.sourcePath), 'utf8'));
    if (sha(source) !== revision.sourceHash || sha(compilePolicy(source)) !== revision.compiledHash)
      throw new Error('Active Revision artifact corrupted');
    contained(root, revision.validationPath);
  }
  return state;
}
export function activeRevision(root: string, namespace?: string): HarnessRevision {
  const state = loadVersions(root, namespace); return state.revisions.find(item => item.revisionId === state.active)!;
}
export function identity(root: string, revision: HarnessRevision): PolicyIdentity {
  return { ...revision, sourcePath: contained(root, revision.sourcePath), validationPath: contained(root, revision.validationPath) };
}
export async function activeWorkerBinding(root: string) {
  // No manifest inside Phase 2 validation containers: keep their natural compiled-policy import.
  if (!existsSync(statePath(root))) return null;
  const revision = activeRevision(root);
  return openPolicyBinding(root, identity(root, revision), join(root, 'experiments', `worker-policy-${randomUUID()}`));
}
export function validatedCandidate(root: string, candidatePath: string): PolicyIdentity {
  const audit = contained(root, candidatePath.includes('/') || candidatePath.includes('\\') ? candidatePath : join('experiments', candidatePath));
  const validation = JSON.parse(readFileSync(join(audit, 'validation.json'), 'utf8'));
  if (validation.status !== 'PASS' || ['staticGuard', 'compilation', 'invariantTests', 'behavior'].some(field => validation[field] !== 'PASS') ||
      !validation.baselineUnchanged || !validation.isolation?.available || validation.behaviorEvidence?.status !== 'PASS')
    throw new Error('Candidate Phase 2 validation did not pass');
  const sourcePath = contained(audit, join('workspace', POLICY_FILE));
  const source = normalizeSource(readFileSync(sourcePath, 'utf8'));
  guardPolicy(readFileSync(join(root, POLICY_FILE), 'utf8'), source);
  const sourceHash = sha(source); const compiledHash = sha(compilePolicy(source));
  if (sourceHash !== validation.candidatePolicyHash || compiledHash !== validation.behaviorEvidence.compiledHash)
    throw new Error('Validated Candidate artifact hash mismatch');
  return { revisionId: `H1-${sourceHash.slice(0, 12)}`, candidateId: basename(audit), parentRevision: validation.parentRevision ?? 'H0',
    sourceHash, compiledHash, sourcePath, validationPath: join(audit, 'validation.json') };
}
function withLock<T>(root: string, action: () => T, namespace?: string): T {
  loadVersions(root, namespace);
  const path = join(versionDirectory(root, namespace), 'revisions.lock'); const fd = openSync(path, 'wx');
  try { return action(); } finally { closeSync(fd); unlinkSync(path); }
}
export function applySelection(root: string, evaluationPath: string, namespace?: string) {
  return withLock(root, () => {
    const file = contained(root, evaluationPath);
    const evaluation = JSON.parse(readFileSync(file, 'utf8')) as {
      kind?: string; configHash?: string; phase2ValidationHash?: string;
      candidatePath: string; input: SelectionInput; selection: { decision: SelectionDecision; reasons: string[] } };
    const selection = selectCandidate(evaluation.input);
    if (selection.decision !== evaluation.selection.decision) throw new Error('Selection artifact does not reproduce');
    const state = loadVersions(root, namespace); const active = state.revisions.find(item => item.revisionId === state.active)!;
    if (selection.decision !== 'ACCEPT') {
      state.history.push({ action: selection.decision, at: new Date().toISOString(), from: state.active, to: state.active,
        evaluationPath: relative(root, file), reasons: selection.reasons }); persist(root, state, namespace);
      return { ...selection, active: state.active };
    }
    const candidate = validatedCandidate(root, evaluation.candidatePath);
    if (candidate.sourceHash !== evaluation.input.candidateHash) throw new Error('Evaluation candidate hash mismatch');
    if (evaluation.kind === 'real-pi-llm-paired-e2e') {
      const frozen = JSON.parse(readFileSync(join(dirname(file), 'frozen-config.json'), 'utf8'));
      if (evaluation.configHash !== sha(JSON.stringify(evaluation.input.config)) || frozen.configHash !== evaluation.configHash ||
          frozen.candidate.sourceHash !== candidate.sourceHash || frozen.candidate.compiledHash !== candidate.compiledHash ||
          frozen.active.sourceHash !== evaluation.input.activeHash ||
          evaluation.phase2ValidationHash !== sha(readFileSync(candidate.validationPath)) ||
          frozen.phase2ValidationHash !== evaluation.phase2ValidationHash)
        throw new Error('Frozen evaluation or validation provenance mismatch');
    }
    if (active.sourceHash === candidate.sourceHash) return { ...selection, active: state.active, idempotent: true };
    if (active.sourceHash !== evaluation.input.activeHash) throw new Error('Active Revision changed since evaluation');
    const directory = join(versionDirectory(root, namespace), 'revisions', candidate.revisionId); mkdirSync(directory, { recursive: true });
    const policyPath = join(directory, 'policy.ts');
    if (!existsSync(policyPath)) writeFileSync(policyPath, readFileSync(candidate.sourcePath), { flag: 'wx' });
    else if (sha(normalizeSource(readFileSync(policyPath, 'utf8'))) !== candidate.sourceHash) throw new Error('Revision ID collision');
    active.status = 'accepted';
    const revision: HarnessRevision = { ...candidate, parentRevision: active.revisionId,
      sourcePath: relative(root, policyPath), validationPath: relative(root, candidate.validationPath),
      evaluationPath: relative(root, file), status: 'active', createdAt: new Date().toISOString() };
    const oldIndex = state.revisions.findIndex(item => item.revisionId === revision.revisionId);
    if (oldIndex >= 0) state.revisions[oldIndex] = revision; else state.revisions.push(revision);
    state.previous = active.revisionId; state.active = revision.revisionId;
    state.history.push({ action: 'ACCEPT', at: new Date().toISOString(), from: active.revisionId, to: revision.revisionId,
      candidateId: candidate.candidateId, evaluationPath: relative(root, file), reasons: selection.reasons });
    persist(root, state, namespace); return { ...selection, active: state.active, previous: state.previous };
  }, namespace);
}
export function rollback(root: string, namespace?: string) {
  return withLock(root, () => {
    const state = loadVersions(root, namespace);
    if (!state.previous) return { active: state.active, idempotent: true };
    const previous = state.revisions.find(item => item.revisionId === state.previous)!;
    const from = state.active;
    state.revisions.find(item => item.revisionId === from)!.status = 'accepted'; previous.status = 'active';
    state.active = previous.revisionId; state.previous = previous.parentRevision;
    state.history.push({ action: 'ROLLBACK', at: new Date().toISOString(), from, to: previous.revisionId });
    persist(root, state, namespace); return { active: state.active, sourceHash: previous.sourceHash, previous: state.previous };
  }, namespace);
}
