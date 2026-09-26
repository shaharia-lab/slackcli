import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  fetchLatestRelease,
  isNewerVersion,
  isInstalledViaHomebrew,
  isUpdateCommand,
  getUpdateCommand,
  getCurrentVersion,
  notifyIfUpdateAvailable,
  performUpdate,
  setUpdateCacheDirForTesting,
  verifyAssetDigest,
} from './updater.ts';
import { createHash } from 'crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import packageJson from '../../package.json';

describe('isNewerVersion', () => {
  it('returns true when latest is newer', () => {
    expect(isNewerVersion('v0.5.0', '0.4.0')).toBe(true);
  });

  it('returns false when already on latest', () => {
    expect(isNewerVersion('v0.4.0', '0.4.0')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isNewerVersion('v0.3.0', '0.4.0')).toBe(false);
  });

  it('handles patch version bumps', () => {
    expect(isNewerVersion('v0.4.1', '0.4.0')).toBe(true);
    expect(isNewerVersion('v0.4.0', '0.4.1')).toBe(false);
  });

  it('handles major version bumps', () => {
    expect(isNewerVersion('v1.0.0', '0.9.9')).toBe(true);
  });
});

describe('isInstalledViaHomebrew', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it.each([
    ['macOS Homebrew Cellar path', '/usr/local/Cellar/slackcli/0.4.0/bin/slackcli', true],
    ['macOS Apple Silicon Homebrew path', '/opt/homebrew/bin/slackcli', true],
    ['Linux Homebrew path', '/home/linuxbrew/.linuxbrew/bin/slackcli', true],
    ['direct binary install', '/usr/local/bin/slackcli', false],
    ['path in home directory', '/home/user/bin/slackcli', false],
  ])('for %s (%s) returns %p', (_label, execPath, expected) => {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    expect(isInstalledViaHomebrew()).toBe(expected);
  });
});

describe('getUpdateCommand', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns brew command for Homebrew installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('brew upgrade slackcli');
  });

  it('returns slackcli update for direct installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('slackcli update');
  });
});

describe('getCurrentVersion', () => {
  it('matches package.json when not running a baked-in binary', () => {
    expect(getCurrentVersion()).toBe(packageJson.version);
  });
});

describe('performUpdate', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('bails early when running under bun without downloading', async () => {
    Object.defineProperty(process, 'execPath', { value: '/Users/me/.bun/bin/bun', configurable: true });
    await expect(performUpdate()).resolves.toBeUndefined();
  });
});

describe('performUpdate on a Homebrew install', () => {
  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const dirs: string[] = [];
  let fetchCalls: string[];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (input: any) => {
      fetchCalls.push(String(input));
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    setUpdateCacheDirForTesting(null);
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['macOS Cellar', '/usr/local/Cellar/slackcli/0.4.0/bin/slackcli'],
    ['Apple Silicon Homebrew', '/opt/homebrew/bin/slackcli'],
    ['Linuxbrew', '/home/linuxbrew/.linuxbrew/bin/slackcli'],
  ])('refuses without any network call for %s (%s)', async (_label, execPath) => {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    await expect(performUpdate()).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it('leaves the installed binary, its directory and the update cache untouched', async () => {
    const cellar = await mkdtemp(join(tmpdir(), 'Cellar-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'slackcli-cache-'));
    dirs.push(cellar, cacheDir);
    const installed = join(cellar, 'slackcli');
    await writeFile(installed, 'THE BREW-MANAGED BINARY');
    Object.defineProperty(process, 'execPath', { value: installed, configurable: true });
    setUpdateCacheDirForTesting(cacheDir);

    await performUpdate();

    expect(await readFile(installed, 'utf-8')).toBe('THE BREW-MANAGED BINARY');
    expect(await readdir(cellar)).toEqual(['slackcli']);
    expect(await readdir(cacheDir)).toEqual([]);
  });
});

describe('verifyAssetDigest', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  it('accepts bytes that match the published digest', () => {
    expect(() => verifyAssetDigest('slackcli-macos-arm64', bytes, `sha256:${sha256}`)).not.toThrow();
  });

  it('accepts an uppercase hex digest', () => {
    expect(() =>
      verifyAssetDigest('slackcli-macos-arm64', bytes, `sha256:${sha256.toUpperCase()}`)
    ).not.toThrow();
  });

  it('rejects bytes that do not match', () => {
    expect(() =>
      verifyAssetDigest('slackcli-macos-arm64', new Uint8Array([9, 9, 9]), `sha256:${sha256}`)
    ).toThrow(/Checksum mismatch for slackcli-macos-arm64/);
  });

  // Fail closed: dropping the field must not be a way to skip the check.
  it('rejects an asset with no digest', () => {
    expect(() => verifyAssetDigest('slackcli-macos-arm64', bytes, undefined)).toThrow(/no digest/);
  });

  it('rejects a digest algorithm it cannot check', () => {
    expect(() => verifyAssetDigest('slackcli-macos-arm64', bytes, 'md5:abc')).toThrow(
      /Unsupported digest format/
    );
  });
});

describe('performUpdate integrity check', () => {
  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const binaryName =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'slackcli-macos-arm64'
        : 'slackcli-macos'
      : process.platform === 'win32'
        ? 'slackcli-windows.exe'
        : process.arch === 'arm64'
          ? 'slackcli-linux-arm64'
          : 'slackcli-linux';

  // A release whose asset bytes are `payload`, advertising `digest`.
  function stubRelease(payload: Uint8Array, digest: string | undefined) {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v99.0.0',
            name: 'v99.0.0',
            body: '',
            assets: [
              {
                name: binaryName,
                browser_download_url: 'https://example.invalid/asset',
                ...(digest === undefined ? {} : { digest }),
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
  }

  const installDirs: string[] = [];
  let cacheDir: string;

  beforeEach(async () => {
    // A successful install refreshes the update cache; keep it off the real ~/.config.
    cacheDir = await mkdtemp(join(tmpdir(), 'slackcli-cache-'));
    installDirs.push(cacheDir);
    setUpdateCacheDirForTesting(cacheDir);
  });

  // Stands in for the installed CLI: performUpdate renames over process.execPath,
  // so the test points that at a throwaway file instead of the real binary.
  async function fakeInstall() {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-installed-'));
    installDirs.push(dir);
    const installed = join(dir, 'slackcli');
    await writeFile(installed, 'THE BINARY THAT IS ALREADY INSTALLED');
    Object.defineProperty(process, 'execPath', { value: installed, configurable: true });
    return { dir, installed };
  }

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    setUpdateCacheDirForTesting(null);
    for (const dir of installDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to install bytes that do not match the digest', async () => {
    const { installed } = await fakeInstall();
    stubRelease(new TextEncoder().encode('MALICIOUS PAYLOAD'), `sha256:${'0'.repeat(64)}`);

    await expect(performUpdate()).rejects.toThrow(/Checksum mismatch/);
    // The binary that was already there is untouched.
    expect(await readFile(installed, 'utf-8')).toBe('THE BINARY THAT IS ALREADY INSTALLED');
    // A failed install must not claim the new version is installed.
    expect(existsSync(join(cacheDir, 'update-check.json'))).toBe(false);
  });

  it('refuses to install an asset that publishes no digest', async () => {
    const { installed } = await fakeInstall();
    stubRelease(new TextEncoder().encode('anything'), undefined);

    await expect(performUpdate()).rejects.toThrow(/no digest/);
    expect(await readFile(installed, 'utf-8')).toBe('THE BINARY THAT IS ALREADY INSTALLED');
  });

  it('installs bytes that match, and leaves no temp directory behind', async () => {
    const { installed } = await fakeInstall();
    const payload = new TextEncoder().encode('THE NEW BINARY');
    stubRelease(payload, `sha256:${createHash('sha256').update(payload).digest('hex')}`);

    const before = (await readdir(tmpdir())).filter(n => n.startsWith('slackcli-update-'));
    await performUpdate();
    const after = (await readdir(tmpdir())).filter(n => n.startsWith('slackcli-update-'));

    expect(await readFile(installed, 'utf-8')).toBe('THE NEW BINARY');
    expect(after).toHaveLength(before.length);
  });

  it('records the installed version in the update cache', async () => {
    await fakeInstall();
    const payload = new TextEncoder().encode('THE NEW BINARY');
    stubRelease(payload, `sha256:${createHash('sha256').update(payload).digest('hex')}`);

    const startedAt = Date.now();
    await performUpdate();

    const cache = JSON.parse(await readFile(join(cacheDir, 'update-check.json'), 'utf-8'));
    expect(cache.latestVersion).toBe('v99.0.0');
    expect(cache.checkedAt).toBeGreaterThanOrEqual(startedAt);
  });
});

describe('isUpdateCommand', () => {
  it.each([
    [['bun', 'slackcli', 'update'], true],
    [['bun', 'slackcli', 'update', 'check'], true],
    [['bun', 'slackcli', '--no-color', 'update'], true],
    [['bun', 'slackcli', 'auth', 'list'], false],
    [['bun', 'slackcli', 'messages', 'send', '--message', 'update'], false],
    [['bun', 'slackcli'], false],
    [['bun', 'slackcli', '--version'], false],
  ])('%p → %p', (argv, expected) => {
    expect(isUpdateCommand(argv)).toBe(expected);
  });
});

describe('notifyIfUpdateAvailable', () => {
  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  let cacheDir: string;
  let fetchCalls: number;
  let listenersBefore: Function[];

  beforeEach(async () => {
    // A release binary (not bun), with a cache announcing a newer version.
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    cacheDir = await mkdtemp(join(tmpdir(), 'slackcli-cache-'));
    setUpdateCacheDirForTesting(cacheDir);
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    listenersBefore = process.listeners('beforeExit');
  });

  afterEach(async () => {
    for (const listener of process.listeners('beforeExit')) {
      if (!listenersBefore.includes(listener)) {
        process.removeListener('beforeExit', listener as (...args: any[]) => void);
      }
    }
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    setUpdateCacheDirForTesting(null);
    await rm(cacheDir, { recursive: true, force: true });
  });

  async function writeCache(checkedAt: number) {
    await writeFile(
      join(cacheDir, 'update-check.json'),
      JSON.stringify({ checkedAt, latestVersion: 'v99.0.0' })
    );
  }

  it.each([
    ['update', ['bun', 'slackcli', 'update']],
    ['update check', ['bun', 'slackcli', 'update', 'check']],
  ])('prints no banner during `%s`', async (_label, argv) => {
    await writeCache(Date.now());
    notifyIfUpdateAvailable(argv);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length);
  });

  it('does not refresh a stale cache during `update`', async () => {
    await writeCache(0);
    notifyIfUpdateAvailable(['bun', 'slackcli', 'update']);
    expect(fetchCalls).toBe(0);
  });

  it('still schedules the banner for other commands', async () => {
    await writeCache(Date.now());
    notifyIfUpdateAvailable(['bun', 'slackcli', 'auth', 'list']);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length + 1);
  });
});

describe('fetchLatestRelease', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the parsed release on success', async () => {
    const release = { tag_name: 'v1.2.3', name: 'v1.2.3', body: '', assets: [] };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(release), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestRelease()).toEqual(release);
  });

  it('returns null on a non-OK response', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 403 })) as unknown as typeof fetch;
    expect(await fetchLatestRelease()).toBeNull();
  });

  it('returns null when the network request fails', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchLatestRelease()).toBeNull();
  });

  it('returns null when the body is not valid JSON', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestRelease()).toBeNull();
  });
});
