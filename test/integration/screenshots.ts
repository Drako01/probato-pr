// Regenerates the README screenshots from the real extension: launches VS Code (Extension Development Host) on the
// demonstration repository from scripts/create-demo-repo.mjs, lets screenshot-driver.ts put the extension into
// each state, and captures the workbench through the Chromium DevTools protocol into media/screenshots/.
// Nothing is published and no account is connected. Usage: pnpm run screenshots
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'media', 'screenshots');
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false } as const;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => { if (address && typeof address === 'object') resolve(address.port); else reject(new Error('no port assigned')); });
    });
  });
}

/** Minimal DevTools protocol client over the WebSocket of the workbench page. */
class DevTools {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiter || message.id === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`DevTools: ${message.error.message}`)); else waiter.resolve(message.result);
    });
  }

  static async connect(port: number): Promise<DevTools> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
    const targets = await response.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const workbench = targets.find((target) => target.type === 'page' && target.url.includes('workbench'));
    if (!workbench) throw new Error(`workbench page not found among ${targets.length} DevTools targets`);
    const socket = new WebSocket(workbench.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve(); }, { once: true });
      socket.addEventListener('error', () => { reject(new Error('DevTools WebSocket failed to open')); }, { once: true });
    });
    return new DevTools(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.socket.close(); }
}

/** Captures every shot the driver marks ready until `finished` settles. */
async function captureLoop(handshake: string, port: number, finished: { done: boolean }): Promise<string[]> {
  const captured: string[] = [];
  let devTools: DevTools | undefined;
  try {
    while (!finished.done) {
      const ready = readdirSync(handshake).filter((file) => file.endsWith('.ready')).map((file) => file.slice(0, -'.ready'.length))
        .filter((name) => !existsSync(path.join(handshake, `${name}.done`)));
      for (const name of ready) {
        if (!devTools) {
          devTools = await DevTools.connect(port);
          await devTools.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
          await delay(1_500);
        }
        const { data } = await devTools.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
        writeFileSync(path.join(OUTPUT, `${name}.png`), Buffer.from(data, 'base64'));
        captured.push(name);
        console.log(`captured media/screenshots/${name}.png`);
        writeFileSync(path.join(handshake, `${name}.done`), '');
      }
      await delay(200);
    }
  } finally {
    devTools?.close();
  }
  return captured;
}

async function main(): Promise<void> {
  // Inherited when launched from a VS Code integrated terminal or extension host; it would make Code.exe start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const sandbox = mkdtempSync(path.join(tmpdir(), 'probato-shots-'));
  try {
    const repository = path.join(sandbox, 'probato-demo');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'create-demo-repo.mjs'), repository], { stdio: 'ignore' });
    const handshake = path.join(sandbox, 'handshake');
    const userSettings = path.join(sandbox, 'user-data', 'User');
    mkdirSync(handshake);
    mkdirSync(userSettings, { recursive: true });
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(path.join(userSettings, 'settings.json'), JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.commandCenter.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.ignoreRecommendations': true,
      'git.openRepositoryInParentFolders': 'never',
      'window.restoreWindows': 'none',
    }));
    const port = await freePort();
    const finished = { done: false };
    const capture = captureLoop(handshake, port, finished);
    // Observed below with `await capture`; this only prevents an early unhandled-rejection crash meanwhile.
    capture.catch(() => undefined);
    try {
      await runTests({
        ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
        extensionDevelopmentPath: ROOT,
        extensionTestsPath: path.resolve(__dirname, 'screenshot-driver.js'),
        launchArgs: [
          repository,
          '--disable-extensions',
          '--disable-workspace-trust',
          '--locale=en',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${path.join(sandbox, 'user-data')}`,
          `--extensions-dir=${path.join(sandbox, 'extensions')}`,
        ],
        extensionTestsEnv: { PROBATO_SHOTS_HANDSHAKE: handshake, GIT_CEILING_DIRECTORIES: sandbox },
      });
    } finally {
      finished.done = true;
    }
    const captured = await capture;
    if (!captured.length) throw new Error('no screenshot was captured');
  } finally {
    // VS Code child processes can hold handles briefly after exit (EPERM/EBUSY on Windows).
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
