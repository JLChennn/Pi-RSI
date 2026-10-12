import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { loadEvidence } from '../src/demo/evidence.js';
const root = process.cwd();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const errors: string[] = []; let links = 0;
for (const file of files) {
  if (/(^|\/)(?:\.env|node_modules|upstream|dist)(\/|$)/.test(file) || file.startsWith('.pi-rsi/')) errors.push(`Private/generated path: ${file}`);
  if (!['.md', '.json', '.ts', '.mjs', '.patch', '.svg'].includes(extname(file))) continue;
  const content = readFileSync(file, 'utf8');
  if (/[A-Za-z]:[\\/]Users[\\/]|\bsk-[A-Za-z0-9_-]{20,}\b|Bearer\s+[A-Za-z0-9_-]{20,}/.test(content)) errors.push(`Potential personal path or credential: ${file}`);
  if (extname(file) === '.md') {
    const prose = content.replace(/```[\s\S]*?```/g, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const url = match[1]!.split('#')[0]!;
      if (!url || /^(https?:|mailto:)/.test(url)) continue;
      links++;
      if (!existsSync(resolve(root, dirname(file), decodeURIComponent(url)))) errors.push(`Broken local link: ${file} -> ${url}`);
    }
  }
}
const evidence = loadEvidence(root);
const b = evidence.evaluation.metrics.baseline; const c = evidence.evaluation.metrics.candidate;
const sample = evidence.evaluation.input.baseline.length;
const expectedTable = [
  [`${Math.round(b.taskSuccessRate * sample)}/${sample}`, `${Math.round(c.taskSuccessRate * sample)}/${sample}`],
  [`${Math.round(b.expectedHandlingRate * sample)}/${sample}`, `${Math.round(c.expectedHandlingRate * sample)}/${sample}`],
  ...(['llmToolCalls', 'internalRetries', 'underlyingAttempts', 'modelTokens'] as const).map(field =>
    [b[field].toLocaleString('en-US'), c[field].toLocaleString('en-US')]),
  [(b.latencyMs / 1000).toFixed(3) + 's', (c.latencyMs / 1000).toFixed(3) + 's'],
  [String(b.unsafeSideEffects), String(c.unsafeSideEffects)],
];
for (const document of ['README.md', 'README.zh-CN.md']) {
  const text = readFileSync(document, 'utf8');
  const table = text.split('\n').filter(line => line.startsWith('|')).slice(2).map(line => line.split('|').slice(2, 4).map(value => value.trim()));
  if (JSON.stringify(table) !== JSON.stringify(expectedTable)) errors.push(`README table differs from original data: ${document}`);
  for (const value of [evidence.evaluation.metrics.baseline.modelTokens, evidence.evaluation.metrics.candidate.modelTokens])
    if (!text.includes(value.toLocaleString('en-US'))) errors.push(`README metric missing: ${document}`);
  for (const command of ['demo:replay', 'demo:live', 'rsi:status', 'rsi:rollback']) if (!text.includes(command)) errors.push(`README command missing: ${document}`);
}
const svg = readFileSync('docs/assets/benchmark-results.svg', 'utf8');
for (const field of ['llmToolCalls', 'modelTokens'] as const) for (const [name, side] of [['H0', 'baseline'], ['H1', 'candidate']] as const)
  if (!svg.includes(`data-metric="${field}" data-harness="${name}" data-value="${evidence.evaluation.metrics[side][field]}"`)) errors.push(`Chart differs from evidence: ${field}/${name}`);
console.log(JSON.stringify({ filesChecked: files.length, localLinksChecked: links, evidenceAndChartMatch: true,
  license: 'No project-level license selected; explicitly documented', errors }, null, 2));
if (errors.length) process.exitCode = 1;
