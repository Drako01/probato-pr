// Lists every vscode.l10n.t() message in src/ and reports keys missing from (or stale in) a bundle.
// Usage: node scripts/l10n-keys.mjs [l10n/bundle.l10n.es.json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : n.endsWith('.ts') ? [path.join(dir, n)] : []));
const keys = new Set();
for (const file of files('src')) {
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:l10n\.t|\btr|\bmsg)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
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
  const placeholders = (text) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join(',');
  const invalid = Object.entries(bundle).filter(([key, value]) => placeholders(key) !== placeholders(typeof value === 'string' ? value : value.message ?? ''));
  console.log(`${keys.size} keys; missing ${missing.length}; stale ${stale.length}; invalid placeholders ${invalid.length}`);
  invalid.forEach(([key]) => console.log(`PLACEHOLDERS: ${key}`));
  missing.forEach((k) => console.log(`MISSING: ${k}`));
  stale.forEach((k) => console.log(`STALE: ${k}`));
  process.exitCode = missing.length + stale.length + invalid.length > 0 ? 1 : 0;
}
