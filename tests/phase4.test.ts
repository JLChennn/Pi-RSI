import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadEvidence, replay } from '../src/demo/evidence.js';
import { activeRevision, applySelection, loadVersions, rollback } from '../src/evolution/version-manager.js';
const root = process.cwd(); const bundle = join(root, 'examples/phase3-demo');
const temporary = () => mkdtempSync(join(tmpdir(), 'pi-rsi-delivery-'));
function fixture() {
  const project = temporary(); mkdirSync(join(project, 'src/harness'), { recursive: true });
  writeFileSync(join(project, 'src/harness/recovery-policy.ts'), readFileSync(join(bundle, 'h0-policy.ts')));
  mkdirSync(join(project, 'experiments/candidate/workspace/src/harness'), { recursive: true });
  writeFileSync(join(project, 'experiments/candidate/workspace/src/harness/recovery-policy.ts'), readFileSync(join(bundle, 'h1-policy.ts')));
  writeFileSync(join(project, 'experiments/candidate/validation.json'), readFileSync(join(bundle, 'validation.json')));
  const evaluation = JSON.parse(readFileSync(join(bundle, 'evaluation.json'), 'utf8'));
  evaluation.kind = 'UNIT_VERSION_FIXTURE_ONLY'; evaluation.candidatePath = 'experiments/candidate';
  const file = join(project, 'experiments/evaluation.json'); writeFileSync(file, JSON.stringify(evaluation));
  return { project, file };
}
describe('real historical evidence and isolated delivery', () => {
  it('reproduces historical metrics and selection without executing candidate source', () => {
    const evidence = loadEvidence(root); const output = replay(evidence);
    expect(output).toContain('REPLAY'); expect(output).toContain('historical ACCEPT');
    expect(evidence.evaluation.metrics.baseline.llmToolCalls).toBe(16);
    expect(evidence.evaluation.metrics.candidate.modelTokens).toBe(11382);
  });
  it('rejects modified evidence by content hash', () => {
    const project = temporary(); cpSync(bundle, project, { recursive: true });
    writeFileSync(join(project, 'candidate.patch'), 'changed'); expect(() => loadEvidence(root, project)).toThrow(/hash mismatch/);
  });
  it('rejects inconsistent metrics even when the outer file hash is updated', () => {
    const project = temporary(); cpSync(bundle, project, { recursive: true });
    const path = join(project, 'evaluation.json'); const data = JSON.parse(readFileSync(path, 'utf8'));
    data.metrics.candidate.modelTokens++; writeFileSync(path, JSON.stringify(data));
    const provenance = JSON.parse(readFileSync(join(project, 'provenance.json'), 'utf8'));
    provenance.hashes['evaluation.json'] = createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(join(project, 'provenance.json'), JSON.stringify(provenance));
    expect(() => loadEvidence(root, project)).toThrow(/Metric mismatch/);
  });
  it('demo Accept and Rollback preserve the primary active manifest byte for byte', () => {
    const f = fixture(); applySelection(f.project, f.file); const file = join(f.project, '.pi-rsi/revisions.json');
    const before = readFileSync(file); expect(activeRevision(f.project, 'demo-test').revisionId).toBe('H0');
    applySelection(f.project, f.file, 'demo-test'); expect(activeRevision(f.project, 'demo-test').revisionId).not.toBe('H0');
    rollback(f.project, 'demo-test'); expect(activeRevision(f.project, 'demo-test').revisionId).toBe('H0');
    expect(readFileSync(file).equals(before)).toBe(true);
  });
  it('rejects namespace traversal', () => { const f = fixture(); expect(() => loadVersions(f.project, '../main')).toThrow(/namespace/); });
  it('Replay CLI works with no API credentials, no Docker on PATH and no version store', () => {
    const project = temporary();
    const output = execFileSync(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href,
      join(root, 'scripts/demo.ts'), 'replay', '--bundle', bundle], { cwd: project, encoding: 'utf8', timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: '', TEMP: tmpdir() }, windowsHide: true });
    expect(output).toContain('REPLAY'); expect(output).toContain('13718'); expect(existsSync(join(project, '.pi-rsi'))).toBe(false);
  }, 40000);
  it('Live missing credentials reports BLOCKED and preserves the primary manifest', () => {
    const f = fixture(); loadVersions(f.project); const before = readFileSync(join(f.project, '.pi-rsi/revisions.json'));
    let output = ''; let status = 0;
    try {
      execFileSync(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href,
        join(root, 'scripts/demo.ts'), 'live'], { cwd: f.project, encoding: 'utf8', timeout: 30000,
        env: { SystemRoot: process.env.SystemRoot, PATH: '', TEMP: tmpdir() }, windowsHide: true });
    } catch (error) { const failure = error as { status: number; stdout: string }; status = failure.status; output = String(failure.stdout); }
    expect(status).toBe(2); expect(output).toContain('BLOCKED'); expect(output).toContain('"mainManifestUnchanged": true');
    expect(readFileSync(join(f.project, '.pi-rsi/revisions.json')).equals(before)).toBe(true);
  }, 40000);
  it('status and explicit rollback CLI work without model credentials or Docker in a temporary repository', () => {
    const f = fixture(); applySelection(f.project, f.file);
    const invoke = (command: string) => execFileSync(process.execPath, [
      '--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, join(root, 'src/cli.ts'), command,
    ], { cwd: f.project, encoding: 'utf8', timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: '', TEMP: tmpdir() }, windowsHide: true });
    expect(JSON.parse(invoke('status')).active).not.toBe('H0');
    expect(JSON.parse(invoke('rollback')).active).toBe('H0');
  }, 60000);
});
