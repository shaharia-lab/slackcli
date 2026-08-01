import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, defaultProfileDir, isSafeStartUrl, launchBrowser } from './browser-launcher';

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_MAC = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_LINUX = '/usr/bin/google-chrome';

/** Probe that reports only the given paths as present. */
const existsAmong = (present: string[]) => async (path: string) =>
  present.includes(path);

const savedEnv = { ...process.env };

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

describe('launchBrowser', () => {
  it('refuses to exec a start URL that would be read as a switch', async () => {
    const result = await launchBrowser({
      startUrl: '--proxy-server=127.0.0.1:9931',
      fileExists: existsAmong([CHROME_MAC]),
      profileDir: `${tmpdir()}/slackcli-launch-guard-test`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
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
