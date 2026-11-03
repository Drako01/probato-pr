// Bundles the extension (CommonJS for the extension host) and the Review Summary webview script (browser IIFE).
import { writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const extension = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  legalComments: 'linked',
  metafile: true,
});

// The webview imports protocol types only, so it bundles no third-party code.
const webview = await esbuild.context({
  ...shared,
  entryPoints: ['src/webview/summary.ts'],
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview/summary.js',
});

const cli = await esbuild.context({
  ...shared,
  entryPoints: ['src/cli-main.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/cli.cjs',
  legalComments: 'linked',
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch(), cli.watch()]);
} else {
  const [result] = await Promise.all([extension.rebuild(), webview.rebuild(), cli.rebuild()]);
  // The metafile lists every bundled input; scripts/third-party-notices.mjs derives license notices from it.
  writeFileSync('dist/metafile.json', JSON.stringify(result.metafile));
  await Promise.all([extension.dispose(), webview.dispose(), cli.dispose()]);
}
