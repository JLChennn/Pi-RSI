import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadEvidence, replay, exportEvidence } from '../src/demo/evidence.js';

async function main() {
  const root = process.cwd(); const mode = process.argv[2]; const args = process.argv.slice(3);
  if (mode === 'replay') {
    if (args.length && (args.length !== 2 || !['--run', '--bundle'].includes(args[0]!))) throw new Error('Usage: demo:replay [--run <historical-rsi-dir> | --bundle <evidence-dir>]');
    console.log(replay(loadEvidence(root, args[1], args[0] === '--run'))); return;
  }
  if (mode === 'export') {
    if (args.length !== 2 || args[0] !== '--run') throw new Error('Usage: demo:bundle --run <historical-rsi-dir>');
    console.log(`Verified real evidence exported: ${exportEvidence(root, args[1]!).source}`); return;
  }
  if (mode !== 'live' || args.length) throw new Error('Usage: demo:live');
  const namespace = `demo-${randomUUID()}`;
  const path = join(root, 'experiments', namespace); mkdirSync(path, { recursive: true });
  const primary = join(root, '.pi-rsi/revisions.json');
  const before = existsSync(primary) ? readFileSync(primary) : null;
  const digest = (bytes: Buffer | null) => bytes === null ? 'ABSENT' : createHash('sha256').update(bytes).digest('hex');
  const report: Record<string, unknown> = { mode: 'LIVE', namespace, mainManifestBefore: digest(before) };
  console.log(`LIVE — real Worker/Evolver, isolated version namespace ${namespace}, starting at H0.`);
  try {
    const { readModelConfig } = await import('../src/agent.js');
    const config = readModelConfig();
    if (config.model !== 'IQuest-Q1') throw new Error('Live demo requires IQuest-Q1');
    const { prepareValidationImage } = await import('../src/evolution/candidate.js');
    const docker = await prepareValidationImage(root);
    if (!docker.available) throw new Error('Docker unavailable');
    process.env.PI_RSI_EVOLVER_MAX_TOKENS ??= '16384';
    report.evolverOutputBudget = Number(process.env.PI_RSI_EVOLVER_MAX_TOKENS);
    const { rsiOnce } = await import('../src/rsi.js');
    report.round = await rsiOnce(config, namespace);
    report.outcome = (report.round as { outcome: string }).outcome;
    const roundAudit = (report.round as { audit: string }).audit;
    const development = JSON.parse(readFileSync(join(roundAudit, 'development/summary.json'), 'utf8'));
    if (development.kind === 'incomplete-development') {
      report.outcome = 'BLOCKED'; report.reason = 'Development model/runtime unavailable or incomplete; original RSI evidence retained'; process.exitCode = 2;
    }
  } catch { report.outcome = 'BLOCKED'; report.reason = 'Model configuration, Docker or runtime unavailable; inspect local redacted artifacts.'; process.exitCode = 2; }
  finally {
    report.mainManifestAfter = digest(existsSync(primary) ? readFileSync(primary) : null);
    report.mainManifestUnchanged = report.mainManifestBefore === report.mainManifestAfter;
    if (!report.mainManifestUnchanged) { report.outcome = 'FAIL'; process.exitCode = 1; }
    writeFileSync(join(path, 'demo.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exitCode = 1; });
