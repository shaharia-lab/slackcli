import { afterEach, describe, expect, it } from 'bun:test';
import { findBrowser, defaultProfileDir } from './browser-launcher';

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_MAC = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_LINUX = '/usr/bin/google-chrome';

/** Probe that reports only the given paths as present. */
const existsAmong = (present: string[]) => async (path: string) =>
  present.includes(path);

const savedEnv = { ...process.env };

afterEach(() => {
  process.env.SLACKCLI_BROWSER = savedEnv.SLACKCLI_BROWSER;
  process.env.SLACKCLI_BROWSER_PROFILE = savedEnv.SLACKCLI_BROWSER_PROFILE;
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
