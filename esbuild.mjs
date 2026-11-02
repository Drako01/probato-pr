// Bundles the extension into a single CommonJS file loaded by the VS Code extension host.
import { writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'linked',
  metafile: true,
  logLevel: 'info',
});

if (watch) {
  await context.watch();
} else {
  const result = await context.rebuild();
  // The metafile lists every bundled input; scripts/third-party-notices.mjs derives license notices from it.
  writeFileSync('dist/metafile.json', JSON.stringify(result.metafile));
  await context.dispose();
}
