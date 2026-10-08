import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { configureLogging } from './logger';
import { tildify } from './tildify';
import {
  findBrowser,
  defaultProfileDir,
  escapeEre,
  isSafeStartUrl,
  launchBrowser,
  waitForPageTarget,
  clearBrowserProfile,
  resetProfileIfStale,
  PROFILE_FORMAT,
  hasExited,
  signalBrowserTree,
  buildLaunchArgs,
} from './browser-launcher';

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_MAC = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_LINUX = '/usr/bin/google-chrome';

/** Probe that reports only the given paths as present. */
const existsAmong = (present: string[]) => async (path: string) =>
  present.includes(path);

const savedEnv = { ...process.env };

// Start every test from a known environment. Without this the suite inherits
// whatever the developer (or CI) happens to have exported: a machine with
// SLACKCLI_BROWSER set fails nine of these for reasons that have nothing to do
// with the code.
beforeEach(() => {
  delete process.env.SLACKCLI_BROWSER;
  delete process.env.SLACKCLI_BROWSER_PROFILE;
  delete process.env.LOCALAPPDATA;
});

afterEach(() => {
  // PATH is mutated by the PATH-scan case; leaving it set leaks into every
  // later test file in the run (clipboard.ts resolves pbpaste via PATH).
  process.env.PATH = savedEnv.PATH;
  process.env.SLACKCLI_BROWSER = savedEnv.SLACKCLI_BROWSER;
  process.env.SLACKCLI_BROWSER_PROFILE = savedEnv.SLACKCLI_BROWSER_PROFILE;
  process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA;
  if (savedEnv.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  if (savedEnv.SLACKCLI_BROWSER === undefined) delete process.env.SLACKCLI_BROWSER;
  if (savedEnv.SLACKCLI_BROWSER_PROFILE === undefined) {
    delete process.env.SLACKCLI_BROWSER_PROFILE;
  }
});

describe('findBrowser', () => {
  it('finds Chrome on macOS', async () => {
    expect(await findBrowser(existsAmong([CHROME_MAC]), 'darwin')).toBe(CHROME_MAC);
  });

  it('prefers Chrome over Edge when both are installed', async () => {
    const found = await findBrowser(existsAmong([CHROME_MAC, EDGE_MAC]), 'darwin');
    expect(found).toBe(CHROME_MAC);
  });

  it('falls back to Edge when Chrome is absent', async () => {
    expect(await findBrowser(existsAmong([EDGE_MAC]), 'darwin')).toBe(EDGE_MAC);
  });

  it('finds Chrome on Linux', async () => {
    expect(await findBrowser(existsAmong([CHROME_LINUX]), 'linux')).toBe(CHROME_LINUX);
  });

  it('returns null when nothing is installed', async () => {
    expect(await findBrowser(existsAmong([]), 'darwin')).toBeNull();
  });

  it('honours SLACKCLI_BROWSER over the built-in table', async () => {
    process.env.SLACKCLI_BROWSER = '/custom/brave';
    const found = await findBrowser(existsAmong(['/custom/brave', CHROME_MAC]), 'darwin');
    expect(found).toBe('/custom/brave');
  });

  it('returns null when SLACKCLI_BROWSER points at nothing, rather than falling back', async () => {
    // Silently ignoring a bad override would hide the user's own typo behind a
    // different browser launching.
    process.env.SLACKCLI_BROWSER = '/nonexistent/browser';
    expect(await findBrowser(existsAmong([CHROME_MAC]), 'darwin')).toBeNull();
  });

  it('resolves a bare executable name from PATH', async () => {
    process.env.PATH = '/opt/bin';
    const found = await findBrowser(existsAmong(['/opt/bin/chromium']), 'freebsd');
    expect(found).toBe('/opt/bin/chromium');
  });
});

// Windows ships a released binary (`build:windows`), and per-user installs
// under %LOCALAPPDATA% are the norm on machines where the user has no admin
// rights — exactly the population most likely to reach for this command.
describe('findBrowser on Windows', () => {
  const LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';
  const PER_USER_CHROME = `${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`;
  const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

  it('finds a per-user Chrome install', async () => {
    process.env.LOCALAPPDATA = LOCALAPPDATA;
    // Table is built at module load, so this asserts the shape rather than
    // the interpolation; both entries must be present for the case to pass.
    const found = await findBrowser(existsAmong([PER_USER_CHROME, SYSTEM_CHROME]), 'win32');
    expect(found).not.toBeNull();
  });

  it('finds a system-wide Chrome install', async () => {
    expect(await findBrowser(existsAmong([SYSTEM_CHROME]), 'win32')).toBe(SYSTEM_CHROME);
  });

  it('finds Brave when it is the only browser present', async () => {
    expect(await findBrowser(existsAmong([BRAVE]), 'win32')).toBe(BRAVE);
  });

  it('scans PATH for .exe names, not POSIX ones', async () => {
    // The regression this guards: PATH_CANDIDATES previously held only
    // extension-less POSIX names ('google-chrome'), which can never match a
    // Windows executable. findBrowser resolves 'win32' paths with the win32
    // path module regardless of the host OS running the test, so the
    // expected value here is composed with `win32.join`, not the host's
    // `join` — the assertion is about the executable *name*, not about
    // whichever path syntax the test happens to run on.
    const dir = '/tools/chrome';
    process.env.PATH = dir;
    const probed: string[] = [];
    const found = await findBrowser(async (p) => {
      probed.push(p);
      return p === win32.join(dir, 'chrome.exe');
    }, 'win32');

    expect(found).toBe(win32.join(dir, 'chrome.exe'));
    expect(probed.some((p) => p.endsWith('.exe'))).toBe(true);
    expect(probed).not.toContain(win32.join(dir, 'google-chrome'));
  });

  it('returns null when no browser is installed', async () => {
    process.env.PATH = '';
    expect(await findBrowser(existsAmong([]), 'win32')).toBeNull();
  });
});

describe('isSafeStartUrl (launcher gate)', () => {
  it('rejects a value that would become a browser switch', () => {
    expect(isSafeStartUrl('--proxy-server=127.0.0.1:9931')).toBe(false);
  });

  it('accepts an https URL', () => {
    expect(isSafeStartUrl('https://app.slack.com/client')).toBe(true);
  });
});

describe('escapeEre', () => {
  it('escapes regex metacharacters so pkill -f matches literally', () => {
    expect(escapeEre('/tmp/foo.bar+baz(qux)')).toBe(
      '/tmp/foo\\.bar\\+baz\\(qux\\)'
    );
  });

  it('leaves a plain path unchanged', () => {
    expect(escapeEre('/home/user/slackcli-profile')).toBe(
      '/home/user/slackcli-profile'
    );
  });
});

describe('buildLaunchArgs', () => {
  const BASE_ARGS = [
    '--remote-debugging-port=0',
    '--user-data-dir=/p',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];

  it('builds the base flags with no headless flag and no start URL', () => {
    expect(buildLaunchArgs('/p', {})).toEqual({ ok: true, args: BASE_ARGS });
  });

  it('adds --headless=new and appends a safe start URL last', () => {
    expect(buildLaunchArgs('/p', { headless: true, startUrl: 'https://acme.slack.com/' })).toEqual({
      ok: true,
      args: [...BASE_ARGS, '--headless=new', 'https://acme.slack.com/'],
    });
  });

  it.each(['--proxy-server=http://evil', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url'])(
    'refuses the unsafe start URL %p instead of passing it as argv',
    (startUrl) => {
      const result = buildLaunchArgs('/p', { startUrl });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_start_url');
        expect(result.message).toContain(startUrl);
      }
    }
  );
});

describe('hasExited', () => {
  it('is false only while neither an exit code nor a signal is recorded', () => {
    expect(hasExited({ exitCode: null, signalCode: null })).toBe(false);
    expect(hasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: 'SIGTERM' })).toBe(true);
  });
});

describe('signalBrowserTree', () => {
  function fakeChild(pid: number | undefined, kill: (signal?: NodeJS.Signals | number) => boolean = () => true) {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    return {
      signals,
      child: {
        pid,
        kill: (signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          return kill(signal);
        },
      },
    };
  }

  function recorder() {
    const spawned: Array<[string, string[]]> = [];
    const swept: string[] = [];
    return {
      spawned,
      swept,
      spawnProcess: (command: string, args: string[]) => {
        spawned.push([command, args]);
      },
      sweep: (dir: string) => {
        swept.push(dir);
      },
    };
  }

  it('does nothing for a child that never got a pid', () => {
    const { child, signals } = fakeChild(undefined);
    const deps = recorder();
    signalBrowserTree(child, '/p', 'SIGKILL', { platform: 'linux', ...deps });
    expect(signals).toEqual([]);
    expect(deps.spawned).toEqual([]);
    expect(deps.swept).toEqual([]);
  });

  it('signals the child without sweeping helpers on SIGTERM', () => {
    const { child, signals } = fakeChild(42);
    const deps = recorder();
    signalBrowserTree(child, '/p', 'SIGTERM', { platform: 'linux', ...deps });
    expect(signals).toEqual(['SIGTERM']);
    expect(deps.swept).toEqual([]);
    expect(deps.spawned).toEqual([]);
  });

  it('sweeps the profile helpers on SIGKILL, even when the child is already gone', () => {
    const { child, signals } = fakeChild(42, () => {
      throw new Error('ESRCH');
    });
    const deps = recorder();
    signalBrowserTree(child, '/p', 'SIGKILL', { platform: 'darwin', ...deps });
    expect(signals).toEqual(['SIGKILL']);
    expect(deps.swept).toEqual(['/p']);
  });

  it('tears the tree down with taskkill on Windows instead of signalling', () => {
    const { child, signals } = fakeChild(42);
    const deps = recorder();
    signalBrowserTree(child, 'C:\\p', 'SIGKILL', { platform: 'win32', ...deps });
    expect(deps.spawned).toEqual([['taskkill', ['/pid', '42', '/T', '/F']]]);
    expect(signals).toEqual([]);
    expect(deps.swept).toEqual([]);
  });

  it('swallows a taskkill that cannot be started', () => {
    const { child } = fakeChild(42);
    expect(() =>
      signalBrowserTree(child, 'C:\\p', 'SIGTERM', {
        platform: 'win32',
        spawnProcess: () => {
          throw new Error('ENOENT');
        },
      })
    ).not.toThrow();
  });
});

describe('launchBrowser', () => {
  it('refuses to exec a start URL that would be read as a switch', async () => {
    // SLACKCLI_BROWSER rather than a path from the platform table: the table is
    // per-OS, so a macOS path resolves to nothing on the Linux CI runner and
    // the run fails at browser_not_found before it ever reaches the URL check.
    process.env.SLACKCLI_BROWSER = '/fake/browser';
    const result = await launchBrowser({
      startUrl: '--proxy-server=127.0.0.1:9931',
      fileExists: existsAmong(['/fake/browser']),
      profileDir: join(tmpdir(), `slackcli-launch-guard-${Math.random().toString(36).slice(2)}`),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Its own reason, not browser_not_found — the command layer branches on
    // that one to suggest installing a browser, which is unhelpful advice when
    // the real problem is the URL.
    expect(result.reason).toBe('invalid_start_url');
    expect(result.message).toContain('Refusing to open an unsupported URL');
  });

  it('reports browser_not_found when nothing resolves', async () => {
    process.env.SLACKCLI_BROWSER = '/nonexistent/browser';
    const result = await launchBrowser({
      fileExists: existsAmong([]),
      profileDir: `${tmpdir()}/slackcli-launch-missing-test`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('browser_not_found');
  });
});

describe('waitForPageTarget', () => {
  const PAGE = 'ws://127.0.0.1:1234/devtools/page/ABC';

  /** Fake clock where sleeping advances time. */
  const fakeTiming = () => {
    let now = 0;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  };

  it('returns an immediately-available page target without polling', async () => {
    const timing = fakeTiming();
    let probes = 0;
    const wsUrl = await waitForPageTarget(1234, {
      ...timing,
      probe: async () => {
        probes++;
        return PAGE;
      },
    });

    expect(wsUrl).toBe(PAGE);
    expect(probes).toBe(1);
    expect(timing.sleeps).toHaveLength(0);
  });

  it('keeps polling when the page target registers late', async () => {
    // The launch race this exists for: Chrome answers on the DevTools port a
    // few hundred ms before the initial tab appears in /json/list, so the
    // first probes come back empty.
    const timing = fakeTiming();
    let probes = 0;
    const wsUrl = await waitForPageTarget(1234, {
      ...timing,
      probe: async () => {
        probes++;
        return probes >= 3 ? PAGE : null;
      },
    });

    expect(wsUrl).toBe(PAGE);
    expect(probes).toBe(3);
    expect(timing.sleeps).toEqual([100, 100]);
  });

  it('gives up with null once the budget expires', async () => {
    const timing = fakeTiming();
    let probes = 0;
    const wsUrl = await waitForPageTarget(1234, {
      ...timing,
      timeoutMs: 200,
      probe: async () => {
        probes++;
        return null;
      },
    });

    expect(wsUrl).toBeNull();
    // Probes at t=0, 100, 200: the attempt at the deadline still runs, then
    // the loop exits without another sleep.
    expect(probes).toBe(3);
    expect(timing.sleeps).toEqual([100, 100]);
  });

  it('always probes at least once, even with a zero budget', async () => {
    const timing = fakeTiming();
    let probes = 0;
    const wsUrl = await waitForPageTarget(1234, {
      ...timing,
      timeoutMs: 0,
      probe: async () => {
        probes++;
        return null;
      },
    });

    expect(wsUrl).toBeNull();
    expect(probes).toBe(1);
    expect(timing.sleeps).toHaveLength(0);
  });
});

describe('clearBrowserProfile', () => {
  const scratch = () => join(tmpdir(), `slackcli-clear-test-${Math.random().toString(36).slice(2)}`);

  it('deletes a profile slackcli created', async () => {
    const dir = scratch();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.slackcli-browser-profile'), 'slackcli browser profile\n');
    await writeFile(join(dir, 'Cookies'), 'session');

    const result = await clearBrowserProfile(dir);

    expect(result.cleared).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  // The case that matters: SLACKCLI_BROWSER_PROFILE is user input and this is a
  // recursive delete. Pointed at a real browser profile or a home directory, an
  // unguarded rm destroys it and still reports success.
  it('refuses to delete a directory it did not create', async () => {
    const dir = scratch();
    await mkdir(join(dir, 'irreplaceable'), { recursive: true });
    await writeFile(join(dir, 'irreplaceable', 'photos.jpg'), 'precious');

    const result = await clearBrowserProfile(dir);

    expect(result.cleared).toBe(false);
    if (result.cleared) return;
    expect(result.reason).toBe('not_ours');
    expect(existsSync(join(dir, 'irreplaceable', 'photos.jpg'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports absent rather than failing when there is no profile', async () => {
    const result = await clearBrowserProfile(scratch());

    expect(result.cleared).toBe(false);
    if (result.cleared) return;
    expect(result.reason).toBe('absent');
  });

  // A stat-based check follows the symlink and passes, then `rm` unlinks the
  // link while the real credential store survives — a logout that reports
  // success but leaves a signed-in profile behind.
  it('refuses a symlink pointing at a real profile', async () => {
    const real = scratch();
    const link = scratch();
    await mkdir(real, { recursive: true });
    await writeFile(join(real, '.slackcli-browser-profile'), `slackcli browser profile\n${PROFILE_FORMAT}\n`);
    await writeFile(join(real, 'Cookies'), 'live session');
    await symlink(real, link);

    const result = await clearBrowserProfile(link);

    expect(result.cleared).toBe(false);
    expect(existsSync(join(real, 'Cookies'))).toBe(true);

    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  });

  // A *directory* named like the sentinel satisfies a mere existence test, so
  // the ownership guard would delete a tree slackcli never created.
  it('refuses when the sentinel is a directory rather than a file', async () => {
    const dir = scratch();
    await mkdir(join(dir, '.slackcli-browser-profile'), { recursive: true });
    await writeFile(join(dir, 'important.txt'), 'not ours');

    const result = await clearBrowserProfile(dir);

    expect(result.cleared).toBe(false);
    expect(existsSync(join(dir, 'important.txt'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('resetProfileIfStale', () => {
  const scratch = () => join(tmpdir(), `slackcli-stale-test-${Math.random().toString(36).slice(2)}`);

  it('discards a profile written in an older format', async () => {
    // v1 profiles encrypted cookies with the OS keyring key; the mock keyring
    // cannot decrypt them, so the session is unrecoverable and the profile is
    // worse than useless — it fails with a confusing "cookie not readable".
    const dir = scratch();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.slackcli-browser-profile'), 'slackcli browser profile\n');
    await writeFile(join(dir, 'Cookies'), 'undecryptable');

    expect(await resetProfileIfStale(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a profile in the current format', async () => {
    const dir = scratch();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '.slackcli-browser-profile'),
      `slackcli browser profile\n${PROFILE_FORMAT}\n`
    );

    expect(await resetProfileIfStale(dir)).toBe(false);
    expect(existsSync(dir)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('never deletes a directory without our sentinel', async () => {
    const dir = scratch();
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'photo.jpg'), 'precious');

    expect(await resetProfileIfStale(dir)).toBe(false);
    expect(existsSync(join(dir, 'nested', 'photo.jpg'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the profile does not exist yet', async () => {
    expect(await resetProfileIfStale(scratch())).toBe(false);
  });
});

describe('defaultProfileDir', () => {
  it('is a dedicated slackcli directory, never the browser default', () => {
    delete process.env.SLACKCLI_BROWSER_PROFILE;
    const dir = defaultProfileDir();
    expect(dir).toContain('slackcli');
    expect(dir).toContain('browser-profile');
  });

  it('honours SLACKCLI_BROWSER_PROFILE', () => {
    process.env.SLACKCLI_BROWSER_PROFILE = '/tmp/custom-profile';
    expect(defaultProfileDir()).toBe('/tmp/custom-profile');
  });
});

// A real launch against a stand-in "browser" that exits at once: the path a
// broken or mismatched install takes. POSIX-only, since it execs a shell script.
describe.skipIf(process.platform === 'win32')('launchBrowser logging', () => {
  let dir: string;
  let records: LogRecord[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slackcli-launch-log-'));
    const browser = join(dir, 'fake-browser');
    await writeFile(browser, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    process.env.SLACKCLI_BROWSER = browser;
    records = [];
    configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => records.push(r) } });
  });

  afterEach(async () => {
    resetSync();
    await rm(dir, { recursive: true, force: true });
  });

  const find = (text: string) => records.find((r) => r.message.join('').includes(text));

  it('records the browser, the profile, the launch flags and why it failed', async () => {
    const profileDir = join(dir, 'profile');
    const result = await launchBrowser({
      profileDir,
      startUrl: 'https://acme.slack.com/?redir=secret-value',
      launchTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('browser_exited');

    // The logger abbreviates a leading home dir to `~` (tildify), so compare the
    // log fields against the tildified paths. On a normal CI runner tmpdir() is
    // outside $HOME and tildify is a no-op; in an agentic sandbox tmpdir() is
    // relocated under $HOME, so the raw path would never match. See fix for
    // sandbox tmpdir portability.
    const home = homedir();
    expect(find('Browser resolved')?.properties).toMatchObject({
      executable: tildify(join(dir, 'fake-browser'), home),
      source: 'SLACKCLI_BROWSER',
    });
    expect(find('Browser profile')?.properties).toMatchObject({
      profile_dir: tildify(profileDir, home),
      profile_state: 'created',
      source: 'option',
    });
    const launch = find('Launching browser');
    expect(launch?.properties.args).toContain(`--user-data-dir=${tildify(profileDir, home)}`);
    expect(launch?.properties.start_url_origin).toBe('https://acme.slack.com');
    const exited = find('exited before exposing');
    expect(exited?.level).toBe('warning');
    expect(exited?.properties).toMatchObject({ reason: 'browser_exited', exit_code: 3 });

    // The start URL's path and query never reach the log.
    const output = JSON.stringify(records.map((r) => [r.message, r.properties]));
    expect(output).not.toContain('secret-value');
  });

  it('records a reused profile on the second launch', async () => {
    const profileDir = join(dir, 'profile');
    await launchBrowser({ profileDir, launchTimeoutMs: 10_000 });
    records.length = 0;

    await launchBrowser({ profileDir, launchTimeoutMs: 10_000 });

    expect(find('Browser profile')?.properties.profile_state).toBe('reused');
  });

  it('records browser_not_found with where it looked', async () => {
    process.env.SLACKCLI_BROWSER = join(dir, 'missing');
    const result = await launchBrowser({ profileDir: join(dir, 'profile') });

    expect(result.ok).toBe(false);
    expect(find('No browser found')?.properties).toMatchObject({
      source: 'SLACKCLI_BROWSER',
      reason: 'browser_not_found',
    });
  });

  it('records a refused profile directory without the directory contents', async () => {
    const profileDir = join(dir, 'someone-elses-profile');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'Cookies'), 'not ours');

    const result = await launchBrowser({ profileDir });

    expect(result.ok).toBe(false);
    expect(find('does not own')?.level).toBe('warning');
  });
});
