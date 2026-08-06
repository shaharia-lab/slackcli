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

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join, delimiter } from 'path';
import { homedir } from 'os';

export type BrowserLaunchFailure =
  | 'browser_not_found'
  | 'invalid_start_url'
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
  // Per-user installs come FIRST: on a managed Windows machine the user
  // often lacks the admin rights to install into Program Files, so
  // %LOCALAPPDATA% is the common layout, not the exotic one.
  win32: [
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Chromium\\Application\\chrome.exe`,
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
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

/**
 * Bare names to resolve against PATH when no absolute candidate exists.
 * Platform-specific: POSIX names never match on Windows, where the
 * executables carry a `.exe` suffix and are named differently.
 */
const PATH_CANDIDATES: Record<string, string[]> = {
  win32: ['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe'],
  default: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'brave-browser',
  ],
};

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

  // PATH scan covers installs outside the standard prefixes (Nix, Flatpak
  // shims, distro variants, Scoop/Chocolatey on Windows) without hardcoding
  // every layout.
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const names = PATH_CANDIDATES[platform] ?? PATH_CANDIDATES.default;
  for (const name of names) {
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
 * Escape a string for use in a POSIX extended regular expression (ERE).
 *
 * `pkill -f` treats its pattern as an ERE, so a custom SLACKCLI_BROWSER_PROFILE
 * containing `.`, `+`, etc. would otherwise widen the match.
 */
export function escapeEre(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Kill helper processes still bound to this profile.
 *
 * Every Chrome helper carries `--user-data-dir=<profileDir>` on its command
 * line, and that path is ours alone, so the match hits exactly this browser's
 * residue and nothing the user is running. Synchronous because it must also
 * work from an exit handler, where nothing can be awaited.
 *
 * Note the pattern drops the flag's leading `--`: pkill reads a pattern
 * starting with a dash as an option and aborts outright ("illegal option -- -",
 * exit 2) without killing anything.
 */
export function sweepProfileHelpers(profileDir: string): void {
  if (process.platform === 'win32') return;
  try {
    spawnSync('pkill', ['-9', '-f', `user-data-dir=${escapeEre(profileDir)}`], {
      stdio: 'ignore',
    });
  } catch {
    // Best effort; the browser's own shutdown is the primary path.
  }
}

/**
 * Discard a profile written in a format this build can no longer read.
 *
 * Only ever touches a directory carrying our own sentinel, so the same
 * ownership rule that guards `clearBrowserProfile` applies here — a profile
 * directory we did not create is left alone even if it looks stale.
 */
export async function resetProfileIfStale(profileDir: string): Promise<boolean> {
  if (!(await isOwnedProfile(profileDir))) return false;
  let sentinel: string;
  try {
    sentinel = await readFile(join(profileDir, PROFILE_SENTINEL), 'utf-8');
  } catch {
    // No sentinel: either a brand-new profile, or one we do not own. Creating
    // is handled by the caller; deleting an unowned directory is never ours.
    return false;
  }

  // Line-exact, not a substring: `includes('v2')` would also match `v20`.
  if (sentinel.split('\n').some((line) => line.trim() === PROFILE_FORMAT)) return false;

  await rm(profileDir, { recursive: true, force: true });
  return true;
}

/**
 * Only http(s) URLs may be handed to the browser as positional argv.
 *
 * Rejects anything that could be read as a switch, plus non-web schemes
 * (`file:`, `javascript:`) that would give a caller-supplied string more
 * reach than opening a page.
 */
export function isSafeStartUrl(candidate: string): boolean {
  if (candidate.startsWith('-')) return false;
  try {
    const { protocol } = new URL(candidate);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

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

  await resetProfileIfStale(profileDir);

  // Claim the directory before using it. The sentinel is what later authorises
  // `auth logout` to delete this tree, so it may only ever be written to a
  // directory slackcli created or already owns — never stamped onto whatever
  // SLACKCLI_BROWSER_PROFILE happens to point at. Without this rule, pointing
  // the documented override at an existing browser profile (the natural way to
  // try to reuse a session) and then running `logout` recursively deletes it
  // and reports success.
  const claim = await claimProfileDir(profileDir);
  if (!claim.ok) {
    return { ok: false, reason: 'browser_not_found', message: claim.message };
  }

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
  // Defence in depth against argument injection: a start URL is positional
  // argv, so any value beginning with `-` would be read by the browser as a
  // switch instead. `--proxy-server=...` alone would route the user's entire
  // sign-in through an attacker's host. Callers validate too; this is the
  // last gate before exec, so it must not trust them.
  if (options.startUrl) {
    if (!isSafeStartUrl(options.startUrl)) {
      return {
        ok: false,
        reason: 'invalid_start_url',
        message: `Refusing to open an unsupported URL: ${options.startUrl}`,
      };
    }
    args.push(options.startUrl);
  }

  let child: ChildProcess;
  try {
    // Deliberately NOT detached. Detaching makes the browser a process-group
    // leader, which is a tidy way to signal the whole tree — but on macOS it
    // also severs the process from the login session's keyring, and Chrome
    // then interrupts the user with "Keychain cannot be found to store
    // Chrome" (observed 2026-08-01). Suppressing that with
    // `--use-mock-keychain` trades one bug for a worse one: Chrome derives a
    // fresh cookie-encryption key per launch, so the saved session stops
    // surviving a restart and silent re-login — the point of the persistent
    // profile — breaks. Helpers are reaped by profile match instead; see
    // `killProfileProcesses`.
    child = spawn(executable, args, { stdio: 'ignore', detached: false });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'browser_not_found',
      message: `Failed to start ${executable}: ${err?.message ?? 'unknown error'}`,
    };
  }

  // Registered here, immediately after spawn — NOT once CDP is attached.
  // Everything between spawn and attach (the DevToolsActivePort wait, target
  // lookup, WebSocket connect) is seconds of real time, and it is exactly when
  // a user hits Ctrl-C because nothing appears to be happening. Without this,
  // that interrupt strands a signed-in browser holding an open, unauthenticated
  // DevTools port indefinitely.
  /**
   * Signal the browser's whole process group.
   *
   * Falls back to the bare child if the group signal fails (no group leader,
   * or the process is already gone). Windows has no process groups, so the
   * tree is torn down with taskkill /T.
   */
  const signalTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // Nothing further to try.
      }
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    // Chrome's renderer and GPU helpers outlive a signalled parent and get
    // reparented to init. Every one of them carries our --user-data-dir on its
    // command line, and that path is unique to this profile, so matching on it
    // reaps exactly our tree and nothing else — no process group required, so
    // the browser keeps its keyring access.
    if (signal === 'SIGKILL') sweepProfileHelpers(profileDir);
  };

  const reap = (): void => signalTree('SIGKILL');

  // SIGHUP matters as much as SIGINT here: closing a terminal tab or dropping
  // an SSH session sends it, and an unhandled SIGHUP would leave a signed-in
  // browser running with an open DevTools port.
  const FATAL_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

  // Installing a listener replaces Node's default disposition, so the process
  // would otherwise survive the first Ctrl-C and need a second. Reap, restore
  // the default, then re-raise so the shell sees the conventional 128+signal
  // exit rather than a silently swallowed interrupt.
  const onFatalSignal = (signal: NodeJS.Signals): void => {
    reap();
    for (const s of FATAL_SIGNALS) process.off(s, onFatalSignal);
    process.kill(process.pid, signal);
  };
  for (const s of FATAL_SIGNALS) process.once(s, onFatalSignal);
  process.once('exit', reap);

  const unregisterReap = (): void => {
    for (const s of FATAL_SIGNALS) process.off(s, onFatalSignal);
    process.off('exit', reap);
  };

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
    unregisterReap();
    if (child.exitCode !== null || child.signalCode !== null) {
      // The parent is gone but helpers may not be; sweep the group regardless.
      signalTree('SIGKILL');
      return;
    }

    // SIGTERM first so the browser flushes its profile — the session cookies
    // and localConfig_v2 we depend on next run live there.
    signalTree('SIGTERM');
    for (let i = 0; i < 30; i++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(100);
    }
    signalTree('SIGKILL');

    // Chrome leaves a `--type=utility` helper behind even after closing itself
    // cleanly, so one targeted sweep clears the residue. Order matters: this
    // runs only AFTER the browser has shut down and released its profile
    // locks. Sweeping *instead of* a clean shutdown leaves the profile in a
    // state Chrome refuses to reopen (exit 13, "profile in use"), which broke
    // login entirely when it was tried the other way round.
    await sleep(300);
    sweepProfileHelpers(profileDir);
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
          '   Most often the profile is already open in another slackcli window —\n' +
          '   close it and retry. On a headless machine with no display, add --headless.',
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
 * Marker written when slackcli creates a profile directory. Its presence is
 * what makes deletion safe: without it, `clearBrowserProfile` has no way to
 * tell its own scratch profile from a directory the user pointed
 * `SLACKCLI_BROWSER_PROFILE` at.
 */
const PROFILE_SENTINEL = '.slackcli-browser-profile';

/**
 * Bumped when a launch-flag change makes an existing profile unusable.
 *
 * Cookie encryption is the reason this exists. Chrome's key comes from the OS
 * keyring, so any change to how the browser reaches that keyring makes existing
 * cookies undecryptable — the session is unrecoverable and the only honest
 * outcome is one fresh sign-in. Doing that automatically beats failing with
 * "the `d` cookie was not readable" and leaving the user to work out why.
 *
 * v2 briefly used `--use-mock-keychain`; that suppressed a macOS keychain
 * prompt but made Chrome mint a new key per launch, so the saved session never
 * survived a restart. v3 is the revert.
 */
export const PROFILE_FORMAT = 'v3';

export type ClearProfileResult =
  | { cleared: true }
  | { cleared: false; reason: 'absent' | 'not_ours'; path: string };

/**
 * Delete the browser profile, but only one slackcli created.
 *
 * The profile holds a signed-in Slack session — a longer-lived credential than
 * `workspaces.json`, since `login-auto` re-mints working tokens from it with no
 * interaction. `auth logout` therefore has to clear it, or it reports a logout
 * it did not perform.
 *
 * The sentinel check is the whole safety story. `SLACKCLI_BROWSER_PROFILE` is
 * user input, and this is a recursive delete: pointed at a real browser profile
 * or a home directory, an unguarded `rm` destroys it and still exits 0. Refusing
 * anything we did not create keeps the logout guarantee without ever deleting
 * something we do not own.
 */
export async function clearBrowserProfile(
  profileDir?: string
): Promise<ClearProfileResult> {
  const target = profileDir ?? defaultProfileDir();

  if (!(await isOwnedProfile(target))) {
    // `absent` and `not_ours` read the same to a caller that only needs to know
    // nothing was deleted, but they lead to different advice.
    const exists = await lstat(target).then(
      () => true,
      () => false
    );
    return { cleared: false, reason: exists ? 'not_ours' : 'absent', path: target };
  }

  await rm(target, { recursive: true, force: true });
  return { cleared: true };
}

/**
 * Take ownership of the profile directory, or refuse to use it.
 *
 * Creating it ourselves, or finding our own sentinel already there, both count
 * as ownership. An existing directory with other content and no sentinel is
 * somebody else's — most likely a real browser profile the user pointed
 * SLACKCLI_BROWSER_PROFILE at — so we neither stamp it nor touch it.
 */
async function claimProfileDir(
  profileDir: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (await isOwnedProfile(profileDir)) {
    // mkdir's mode only applies on creation, so an existing profile (restored
    // from backup, or made by an older build) could hold a live cookie store
    // with looser bits.
    await chmod(profileDir, 0o700).catch(() => {});
    await stampSentinel(profileDir);
    return { ok: true };
  }

  let existing: string[] | null = null;
  try {
    existing = await readdir(profileDir);
  } catch {
    existing = null; // does not exist yet
  }

  if (existing !== null && existing.length > 0) {
    return {
      ok: false,
      message:
        `${profileDir} already contains data and was not created by slackcli.\n` +
        '   Refusing to use it as a browser profile. Point SLACKCLI_BROWSER_PROFILE\n' +
        '   at a new or empty directory, or unset it to use the default.',
    };
  }

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700).catch(() => {});
  await stampSentinel(profileDir);
  return { ok: true };
}

/** Record ownership and the profile format this build writes. */
async function stampSentinel(profileDir: string): Promise<void> {
  await writeFile(
    join(profileDir, PROFILE_SENTINEL),
    `slackcli browser profile\n${PROFILE_FORMAT}\n`,
    { mode: 0o600 }
  ).catch(() => {});
}

/**
 * Is this a profile directory slackcli created?
 *
 * `lstat`, not `stat`: a symlink pointing at a real profile would otherwise
 * pass the check, and `rm` would unlink the symlink while the credential store
 * it referenced survived — reporting a logout that never happened. The sentinel
 * must be a regular file for the same reason: a *directory* by that name
 * satisfies a mere existence test and would let the guard delete a tree we
 * never created.
 */
async function isOwnedProfile(target: string): Promise<boolean> {
  try {
    const dir = await lstat(target);
    if (!dir.isDirectory()) return false;
    const sentinel = await lstat(join(target, PROFILE_SENTINEL));
    return sentinel.isFile();
  } catch {
    return false;
  }
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
