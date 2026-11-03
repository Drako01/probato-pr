// Publishes the VSIX to Open VSX without blocking the release when the registry is slow or holds the version back.
// Usage:
//   node scripts/open-vsx-publish.mjs probato-pr.vsix --trusted-publishing [--version 0.1.2]
//   node scripts/open-vsx-publish.mjs --check <version>     (prints "true" or "false": is it active on open-vsx.org?)
//
//  - Transient failures are retried with a growing delay; an invalid token fails at once.
//  - After publishing it waits for the version to become active (visible) on open-vsx.org.
//  - A version that stays inactive (unverified namespace, publish-time scan) is reported as a warning, not as a
//    failure: the cause is on the registry's side and the Marketplace release must not depend on it.
//    The scheduled open-vsx-sync workflow keeps retrying and opens an issue if it does not resolve.
//    Any other error fails the job so it is never silent.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const INACTIVE = /already published, but currently isn't active/;
const INVALID_TOKEN = /Invalid access token|trusted publisher|OIDC|ID token|id.token|unauthori[sz]ed|forbidden/i;

/** @returns {'published' | 'inactive' | 'fatal' | 'retry'} */
export function classify(output, exitCode) {
  if (exitCode === 0) {
    return 'published';
  }
  if (INACTIVE.test(output)) {
    return 'inactive';
  }
  return INVALID_TOKEN.test(output) ? 'fatal' : 'retry';
}

/** @returns {{ mode: 'publish', vsix: string, version?: string, trustedPublishing?: boolean } | { mode: 'check', version: string }} */
export function parseArgs(argv) {
  if (argv[0] === '--check') {
    if (!argv[1]) {
      throw new Error('--check needs a version');
    }
    return { mode: 'check', version: argv[1] };
  }
  const [vsix, ...flags] = argv;
  if (!vsix || vsix.startsWith('--')) {
    throw new Error('Usage: node scripts/open-vsx-publish.mjs <file.vsix> [--trusted-publishing] [--version <x.y.z>] | --check <version>');
  }
  let version;
  let trustedPublishing = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--trusted-publishing' && !trustedPublishing) { trustedPublishing = true; continue; }
    if (flag === '--version' && version === undefined) {
      version = flags[++index];
      if (!version || version.startsWith('--')) throw new Error('--version needs a value');
      continue;
    }
    throw new Error(`Unknown or duplicate option: ${flag}`);
  }
  return { mode: 'publish', vsix, ...(version ? { version } : {}), ...(trustedPublishing ? { trustedPublishing: true } : {}) };
}

/** Runs the publish command until it succeeds, reports the inactive state, or runs out of attempts. */
export async function publishWithRetry({ run, sleep, log, attempts = 3, baseDelayMs = 10_000 }) {
  for (let attempt = 1; ; attempt++) {
    const { code, output } = await run();
    const kind = classify(output, code);
    if (kind === 'published' || kind === 'inactive') {
      return kind;
    }
    if (kind === 'fatal' || attempt >= attempts) {
      throw new Error(`ovsx publish failed after ${attempt} attempt(s):\n${output}`);
    }
    log(`ovsx publish failed (attempt ${attempt} of ${attempts}); retrying.`);
    await sleep(baseDelayMs * 3 ** (attempt - 1));
  }
}

/** One look at the public API. A network or parse error only means "not confirmed". */
export async function isActive({ url, version, fetchImpl }) {
  try {
    const body = await (await fetchImpl(url)).json();
    return !body.error && body.version === version;
  } catch {
    return false;
  }
}

/** Polls the public API until the version is visible or the deadline passes. */
export async function waitUntilActive({ url, version, fetchImpl, sleep, now = Date.now, timeoutMs = 300_000, intervalMs = 15_000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isActive({ url, version, fetchImpl })) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

/** Explicit trusted publishing strips PAT precedence; no stored long-lived token is passed to the child. */
export function publishInvocation(vsix, trustedPublishing, environment = process.env) {
  const env = { ...environment };
  if (trustedPublishing) { delete env.OVSX_PAT; delete env.OVSX_TOKEN; }
  return { args: ['exec', 'ovsx', 'publish', vsix, '--skip-duplicate', ...(trustedPublishing ? ['--trusted-publishing'] : [])], env };
}

function runOvsx(vsix, trustedPublishing) {
  return new Promise((resolve) => {
    const invocation = publishInvocation(vsix, trustedPublishing);
    const child = spawn('pnpm', invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ code: 1, output: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function report(level, message) {
  console.log(`::${level} title=Open VSX::${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Open VSX:** ${message}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { publisher, name, version: packageVersion } = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = args.version ?? packageVersion;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const url = `https://open-vsx.org/api/${publisher}/${name}/${version}`;

  if (args.mode === 'check') {
    console.log(String(await isActive({ url, version, fetchImpl: fetch })));
    return;
  }
  const kind = await publishWithRetry({ run: () => runOvsx(args.vsix, args.trustedPublishing === true), sleep, log: console.log });
  const active = kind === 'published' && (await waitUntilActive({ url, version, fetchImpl: fetch, sleep }));
  if (active) {
    report('notice', `${publisher}.${name} ${version} is live.`);
  } else {
    report(
      'warning',
      `${publisher}.${name} ${version} is on Open VSX but not active yet (unverified namespace or a pending publish-time scan). The release is not affected; the daily open-vsx-sync workflow keeps retrying. Status: https://open-vsx.org/user-settings/extensions`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
