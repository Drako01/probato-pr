// Lists every vscode.l10n.t() message in src/ and reports keys missing from (or stale in) a bundle.
// Usage: node scripts/l10n-keys.mjs [l10n/bundle.l10n.es.json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : n.endsWith('.ts') ? [path.join(dir, n)] : []));
const keys = new Set();
for (const file of files('src')) {
  for (const m of readFileSync(file, 'utf8').matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    keys.add(m[1].replace(/\\'/g, "'"));
  }
}
const bundlePath = process.argv[2];
if (!bundlePath) {
  console.log(JSON.stringify([...keys].sort(), null, 2));
} else {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const missing = [...keys].filter((k) => !(k in bundle));
  const stale = Object.keys(bundle).filter((k) => !keys.has(k));
  console.log(`${keys.size} keys; missing ${missing.length}; stale ${stale.length}`);
  missing.forEach((k) => console.log(`MISSING: ${k}`));
  stale.forEach((k) => console.log(`STALE: ${k}`));
  process.exitCode = missing.length + stale.length > 0 ? 1 : 0;
}
