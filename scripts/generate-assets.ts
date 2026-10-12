import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEvidence } from '../src/demo/evidence.js';

const evidence = loadEvidence(process.cwd(), process.argv[2]);
const { evaluation: e } = evidence;
const header = (width: number, height: number, title: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><title>${title}</title><style>text{font-family:Arial,Helvetica,sans-serif;font-size:15px;fill:#243447}.title{font-size:24px;font-weight:700}.small{font-size:12px;fill:#526477}.label{font-weight:600}</style>`;
const output = join(process.cwd(), 'docs/assets'); mkdirSync(output, { recursive: true });
let chart = header(1000, 390, 'Real IQuest-Q1 engineering evaluation: H0 versus H1') + '<rect width="1000" height="390" fill="#fff"/>';
chart += '<text x="35" y="40" class="title">Fewer model interactions; same task outcomes</text>';
chart += `<text x="35" y="67" class="small">${e.input.config.model} · ${e.input.config.tasks.length} tasks × ${e.input.config.repeats} repeats / harness · real Pi sessions</text>`;
for (const [index, field, title] of [[0, 'llmToolCalls', 'LLM tool calls'], [1, 'modelTokens', 'Provider total tokens']] as const) {
  const x = 35 + index * 480; const b = e.metrics.baseline[field]; const c = e.metrics.candidate[field]; const max = Math.max(b, c);
  chart += `<text x="${x}" y="110" class="label">${title}</text>`;
  for (const [i, name, value, color] of [[0, 'H0', b, '#8799ad'], [1, 'H1', c, '#326b9d']] as const) {
    const y = 135 + i * 65; const width = value / max * 330;
    chart += `<text x="${x}" y="${y + 25}">${name}</text><rect data-metric="${field}" data-harness="${name}" data-value="${value}" x="${x + 35}" y="${y}" width="${width}" height="38" fill="${color}"/><text x="${x + 45 + width}" y="${y + 25}" class="label">${value.toLocaleString('en-US')}</text>`;
  }
  chart += `<text x="${x}" y="284" class="label">Reduction: ${((b - c) / b * 100).toFixed(2)}%</text>`;
}
const b = e.metrics.baseline; const c = e.metrics.candidate; const n = e.input.baseline.length;
chart += `<text x="35" y="324" class="small">Business success ${Math.round(b.taskSuccessRate * n)}/${n} → ${Math.round(c.taskSuccessRate * n)}/${n}; handling ${Math.round(b.expectedHandlingRate * n)}/${n} → ${Math.round(c.expectedHandlingRate * n)}/${n}; attempts ${b.underlyingAttempts} → ${c.underlyingAttempts}; duplicate writes ${b.unsafeSideEffects} → ${c.unsafeSideEffects}.</text><text x="35" y="347" class="small">Latency ${(b.latencyMs / 1000).toFixed(3)}s → ${(c.latencyMs / 1000).toFixed(3)}s (task totals). Small sample; no statistical-significance claim.</text><text x="35" y="370" class="small">Source: verified ${evidence.source}/evaluation.json · API billed cost unknown</text></svg>`;
writeFileSync(join(output, 'benchmark-results.svg'), chart);
let loop = header(1120, 360, 'Pi-RSI: failure-driven harness code evolution');
loop += '<defs><marker id="arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0 0L9 3.5L0 7" fill="#64748b"/></marker></defs><rect width="1120" height="360" fill="#f8fafc"/><text x="35" y="40" class="title">Run → Reflect → Rewrite → Evaluate → Accept / Rollback</text>';
const nodes = [
  [40, 85, 'Pi Worker', 'Real task + controlled faults'], [310, 85, 'Trajectory Collector', 'Calls, attempts, state, usage'],
  [580, 85, 'Pi Evolver', 'Independent session; no tools'], [850, 85, 'Candidate Policy', 'One TypeScript function'],
  [850, 235, 'Docker Validation', 'No network or credentials'], [580, 235, 'Evaluator / Selector', 'Paired E2E + fixed gates'],
  [310, 235, 'Version Manager', 'Accept / keep / rollback'], [40, 235, 'Next Worker', 'Loads accepted snapshot'],
] as const;
for (let i = 0; i < nodes.length - 1; i++) {
  const a = nodes[i]!; const b = nodes[i + 1]!;
  const sameRow = a[1] === b[1]; const forward = b[0] > a[0];
  loop += `<path d="${sameRow ? `M${a[0] + (forward ? 220 : 0)} ${a[1] + 32}H${b[0] + (forward ? 0 : 220)}` : `M${a[0] + 110} ${a[1] + 64}V${b[1]}`}" stroke="#64748b" fill="none" stroke-width="1.5" marker-end="url(#arrow)"/>`;
}
loop += '<path d="M150 235V149" stroke="#64748b" fill="none" stroke-dasharray="5 4" marker-end="url(#arrow)"/>';
for (const [x, y, title, description] of nodes) loop += `<rect x="${x}" y="${y}" width="220" height="64" rx="6" fill="#fff" stroke="#aab9ca"/><text x="${x + 110}" y="${y + 26}" text-anchor="middle" class="label">${title}</text><text x="${x + 110}" y="${y + 47}" text-anchor="middle" class="small">${description}</text>`;
loop += '<text x="35" y="339" class="small">Host: trusted Pi + model boundary. Candidate: isolated Docker. REJECT / INCONCLUSIVE retain the current policy.</text></svg>';
writeFileSync(join(output, 'rsi-loop.svg'), loop);
console.log('Verified evidence → docs/assets/rsi-loop.svg and benchmark-results.svg');
