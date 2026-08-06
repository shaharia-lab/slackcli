import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import {
  findBrowser,
  defaultProfileDir,
  escapeEre,
  isSafeStartUrl,
  launchBrowser,
  clearBrowserProfile,
  resetProfileIfStale,
  PROFILE_FORMAT,
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
    // Windows executable. Both the path separator and the PATH delimiter come
    // from the host, so this uses a delimiter-free directory and composes the
    // expected value with the same join — the assertion is about the
    // executable *name*, not Windows path syntax.
    const dir = '/tools/chrome';
    process.env.PATH = dir;
    const probed: string[] = [];
    const found = await findBrowser(async (p) => {
      probed.push(p);
      return p === join(dir, 'chrome.exe');
    }, 'win32');

    expect(found).toBe(join(dir, 'chrome.exe'));
    expect(probed.some((p) => p.endsWith('.exe'))).toBe(true);
    expect(probed).not.toContain(join(dir, 'google-chrome'));
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
