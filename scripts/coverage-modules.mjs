// Per-module coverage gate for the critical engine modules, read from coverage/coverage-summary.json
// (`pnpm run test:coverage`). The global percentage cannot hide a weak module: each module is aggregated on its own.
// FLOOR = measured baseline (fails below it, so coverage can only ratchet up). TARGET = 85% lines / 80% branches;
// a module under target is reported as WARN, never as PASS.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const TARGET = { lines: 85, branches: 80 };
// Measured on 2026-11-08 (docs/ENTERPRISE_AAAAA_TEST_EVIDENCE.md), rounded down.
const FLOOR = {
  core: { lines: 90, branches: 84 },
  verification: { lines: 94, branches: 83 },
  git: { lines: 90, branches: 73 },
  github: { lines: 95, branches: 80 },
  mutation: { lines: 91, branches: 74 },
};

const file = process.argv[2] ?? 'coverage/coverage-summary.json';
const summary = JSON.parse(readFileSync(file, 'utf8'));
const totals = Object.fromEntries(Object.keys(FLOOR).map((name) => [name, { lines: [0, 0], branches: [0, 0] }]));
for (const [source, metrics] of Object.entries(summary)) {
  if (source === 'total') continue;
  const parts = path.relative(process.cwd(), source).split(path.sep);
  const module = parts[0] === 'src' ? parts[1] : undefined;
  if (!module || !(module in totals)) continue;
  for (const kind of ['lines', 'branches']) {
    totals[module][kind][0] += metrics[kind].covered;
    totals[module][kind][1] += metrics[kind].total;
  }
}

let failed = false;
console.log('module        lines     branches  state');
for (const [module, metric] of Object.entries(totals)) {
  const pct = (kind) => (metric[kind][1] === 0 ? 100 : (100 * metric[kind][0]) / metric[kind][1]);
  const lines = pct('lines'), branches = pct('branches');
  const belowFloor = lines < FLOOR[module].lines || branches < FLOOR[module].branches;
  const state = belowFloor ? 'FAIL' : lines >= TARGET.lines && branches >= TARGET.branches ? 'PASS' : 'WARN';
  failed ||= belowFloor;
  console.log(`${module.padEnd(13)} ${lines.toFixed(1).padStart(6)}%  ${branches.toFixed(1).padStart(6)}%   ${state}`);
}
if (failed) {
  console.error('Coverage dropped below the measured floor of a critical module.');
  process.exitCode = 1;
}
