/**
 * Locate and launch a local Chromium-family browser with CDP enabled.
 *
 * Used by `auth login-auto` to give the user a real browser to sign into,
 * while exposing a DevTools endpoint the CLI can read tokens from.
 *
 * The browser always runs against a dedicated profile under the slackcli
 * config dir, never the user's own. That is not politeness: since Chrome 136
 * the browser refuses `--remote-debugging-port` when pointed at the default
 * user-data directory, so automating the everyday profile does not work at
 * all. The cost is a one-time sign-in inside the slackcli profile; the
 * profile persists, so later runs need no interaction.
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdir, readFile, rm, stat } from 'fs/promises';
import { join, delimiter } from 'path';
import { homedir } from 'os';

export type BrowserLaunchFailure =
  | 'browser_not_found'
  | 'launch_timeout'
  | 'browser_exited';

export type BrowserLaunchResult =
  | {
      ok: true;
      /** Loopback port serving the DevTools HTTP + WebSocket endpoints. */
      port: number;
      executable: string;
      /** Terminate the browser. Idempotent; escalates to SIGKILL. */
      stop: () => Promise<void>;
    }
  | { ok: false; reason: BrowserLaunchFailure; message: string };

export interface LaunchOptions {
  headless?: boolean;
  /** Initial URL, so a `page` target exists as soon as we attach. */
  startUrl?: string;
  profileDir?: string;
  /** Budget for the browser to write DevToolsActivePort. */
  launchTimeoutMs?: number;
  /** Seam for tests; defaults to a real filesystem probe. */
  fileExists?: (path: string) => Promise<boolean>;
}

/** Candidate executables per platform, most-preferred first. */
const BROWSER_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ],
};

/** Bare names to resolve against PATH when no absolute candidate exists. */
const PATH_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Default profile location; `SLACKCLI_BROWSER_PROFILE` overrides. */
export function defaultProfileDir(): string {
  return (
    process.env.SLACKCLI_BROWSER_PROFILE ||
    join(homedir(), '.config', 'slackcli', 'browser-profile')
  );
}

/**
 * Resolve a usable browser executable.
 *
 * `SLACKCLI_BROWSER` wins outright so a user with an unusual install (or a
 * browser we do not enumerate) is never blocked by our table.
 */
export async function findBrowser(
  fileExists: (path: string) => Promise<boolean> = defaultFileExists,
  platform: string = process.platform
): Promise<string | null> {
  const override = process.env.SLACKCLI_BROWSER;
  if (override) {
    return (await fileExists(override)) ? override : null;
  }

  for (const candidate of BROWSER_PATHS[platform] ?? []) {
    if (await fileExists(candidate)) return candidate;
  }

  // PATH scan covers Linux installs outside /usr/bin (Nix, Flatpak shims,
  // distro variants) without hardcoding every layout.
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of PATH_CANDIDATES) {
    for (const dir of pathDirs) {
      const full = join(dir, name);
      if (await fileExists(full)) return full;
    }
  }

  return null;
}

/** Read the port the browser bound, or null while it has not written it yet. */
async function readDevToolsPort(profileDir: string): Promise<number | null> {
  try {
    const contents = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf-8');
    const firstLine = contents.split('\n')[0]?.trim();
    if (!firstLine) return null;
    const port = Number.parseInt(firstLine, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Launch the browser and wait until its DevTools endpoint is addressable.
 *
 * `--remote-debugging-port=0` lets the OS assign a free port, which the
 * browser reports via `DevToolsActivePort`. Binding an explicit port would
 * collide with any other automated browser the user is running.
 */
export async function launchBrowser(
  options: LaunchOptions = {}
): Promise<BrowserLaunchResult> {
  const fileExists = options.fileExists ?? defaultFileExists;
  const profileDir = options.profileDir ?? defaultProfileDir();
  const launchTimeoutMs = options.launchTimeoutMs ?? 30_000;

  const executable = await findBrowser(fileExists);
  if (!executable) {
    return {
      ok: false,
      reason: 'browser_not_found',
      message:
        'No Chrome, Edge, Chromium, or Brave installation found.\n' +
        '   Install one, or point SLACKCLI_BROWSER at the executable.',
    };
  }

  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  // A port file left by a previous run would otherwise be read as this run's
  // port, pointing the session at a browser that is already gone.
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true }).catch(() => {});

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Slack serves a degraded client to obviously-automated browsers.
    '--disable-blink-features=AutomationControlled',
  ];
  if (options.headless) args.push('--headless=new');
  if (options.startUrl) args.push(options.startUrl);

  let child: ChildProcess;
  try {
    child = spawn(executable, args, { stdio: 'ignore', detached: false });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'browser_not_found',
      message: `Failed to start ${executable}: ${err?.message ?? 'unknown error'}`,
    };
  }

  let exitedEarly = false;
  child.on('exit', () => {
    exitedEarly = true;
  });
  // Without a listener, a spawn error (ENOENT on a stale path) is an
  // unhandled 'error' event and takes the whole CLI down.
  child.on('error', () => {
    exitedEarly = true;
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    // Give the browser a moment to flush its profile, then insist.
    for (let i = 0; i < 20; i++) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await sleep(100);
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };

  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    const port = await readDevToolsPort(profileDir);
    if (port !== null) {
      return { ok: true, port, executable, stop };
    }
    if (exitedEarly) {
      return {
        ok: false,
        reason: 'browser_exited',
        message:
          'The browser exited before exposing its DevTools endpoint.\n' +
          '   This usually means the profile directory is in use by another window.\n' +
          '   Close other slackcli browser windows, or retry with --force.',
      };
    }
    await sleep(100);
  }

  await stop();
  return {
    ok: false,
    reason: 'launch_timeout',
    message: `The browser did not expose a DevTools endpoint within ${Math.round(
      launchTimeoutMs / 1000
    )}s.`,
  };
}

/**
 * Find the page target's WebSocket URL.
 *
 * A fresh profile also reports extension `background_page` targets, so the
 * `page` filter is load-bearing, not defensive.
 */
export async function findPageTarget(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const targets = (await response.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}
