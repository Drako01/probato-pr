// Creates a small Git repository with seeded, realistic defects to try Probato PR by hand.
// Usage: node scripts/create-demo-repo.mjs <target-folder>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'probato-demo');
if (existsSync(target)) {
  console.error(`${target} already exists; choose an empty path.`);
  process.exit(1);
}

const write = (files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    writeFileSync(path.join(target, rel), content);
  }
};
const git = (...args) => execFileSync('git', ['-c', 'user.name=Probato Demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: target, stdio: 'ignore' });

// Base revision: everything works and the test passes.
write({
  'package.json': JSON.stringify({ name: 'probato-demo', private: true, scripts: { test: 'node test/run.js' } }, null, 2) + '\n',
  'src/pricing.js': "exports.priceWithTax = function priceWithTax(amount) {\n  return Math.round(amount * 1.21 * 100) / 100;\n};\n",
  'src/api/user.ts': 'export function getUserName(id: string): string {\n  return `user-${id}`;\n}\n',
  'src/ui/profile.ts': "import { getUserName } from '../api/user';\n\nexport const title = getUserName('42');\n",
  'src/cart.test.ts': "describe('cart', () => {\n  it('adds items', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n  it('removes items', () => {\n    expect(remove(3, 1)).toBe(2);\n  });\n});\n",
  'src/storage.ts': 'export async function save(data: string): Promise<void> {\n  await write(data);\n}\n',
  'test/run.js': "const { priceWithTax } = require('../src/pricing');\nconst got = priceWithTax(100);\nif (got !== 121) {\n  console.error(`priceWithTax(100) expected 121, got ${got}`);\n  process.exit(1);\n}\nconsole.log('pricing ok');\n",
});
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'Base revision');

// Uncommitted change with seeded defects.
write({
  'src/pricing.js': "exports.priceWithTax = function priceWithTax(amount) {\n  return Math.round(amount * 1.12 * 100) / 100; // wrong rate\n};\n",
  'src/api/user.ts': 'export function getDisplayName(id: string): string {\n  return `user-${id}`;\n}\n',
  'src/cart.test.ts': "describe('cart', () => {\n  it.only('adds items', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n  it('removes items', () => {\n    remove(3, 1);\n  });\n});\n",
  'src/storage.ts': `export const awsKey = '${['AKIA', 'DEMO0EXAMPLE0KEY'].join('')}';\n\nexport async function save(data: string): Promise<void> {\n  try {\n    await write(data);\n  } catch (e) {}\n}\n`,
});

console.log(`Demo repository created at ${target}
Open it in VS Code, trust the folder, then run "Probato PR: Review Current Changes".
Expected: broken consumer of getUserName, focused test, assertion removed, AWS key, empty catch.
Then run "Verify Findings": "npm run test" fails only after the change -> attribution "introduced".`);
