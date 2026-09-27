import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  fetchLatestRelease,
  isNewerVersion,
  isInstalledViaHomebrew,
  isInstallDirWritable,
  isUpdateCommand,
  isUpdateNotifierDisabled,
  checkForUpdates,
  getUpdateCommand,
  getCurrentVersion,
  notifyIfUpdateAvailable,
  performUpdate,
  setUpdateCacheDirForTesting,
  updateCommandSuffix,
  BACKGROUND_CHECK_TIMEOUT_MS,
  RETRY_AFTER_FAILURE_MS,
  verifyAssetDigest,
} from './updater.ts';
import { createHash } from 'crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import packageJson from '../../package.json';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { configureLogging } from './logger.ts';

function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => records.push(r) } });
  return records;
}

function updaterRecords(records: LogRecord[]): LogRecord[] {
  return records.filter((r) => r.category.join('.') === 'slackcli.updater');
}

// A fetch that never answers on its own and rejects only when its signal aborts.
function hangingFetch(onCall?: () => void): typeof fetch {
  return ((_input: unknown, init?: RequestInit) => {
    onCall?.();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
}

// Mode bits cannot make a folder unwritable for root, and Windows ignores them,
// so the "not writable" cases only run as a regular POSIX user.
const canLockDirs = process.platform !== 'win32' && process.getuid?.() !== 0;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
}

// A fake installed binary. `locked` makes its folder read-only (0o555), like
// /usr/local/bin for a regular user. `name` lets a test shape the path.
async function fakeBinary(
  dirs: string[],
  { locked = false, name = 'slackcli-installed-' }: { locked?: boolean; name?: string } = {},
): Promise<{ dir: string; installed: string }> {
  const dir = await mkdtemp(join(tmpdir(), name));
  dirs.push(dir);
  const installed = join(dir, 'slackcli');
  await writeFile(installed, 'THE BINARY THAT IS ALREADY INSTALLED');
  if (locked) await chmod(dir, 0o555);
  Object.defineProperty(process, 'execPath', { value: installed, configurable: true });
  return { dir, installed };
}

// Unlocks before removing, so a read-only fake install can be cleaned up.
async function removeDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function releaseResponse(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag, name: tag, body: '', assets: [] }), { status: 200 });
}

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

describe('isInstallDirWritable', () => {
  const originalExecPath = process.execPath;
  const dirs: string[] = [];

  afterEach(async () => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    await removeDirs(dirs);
  });

  it('is true for a folder the user can write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-writable-'));
    dirs.push(dir);
    expect(isInstallDirWritable(join(dir, 'slackcli'))).toBe(true);
  });

  it.skipIf(!canLockDirs)('is false for a read-only folder, even when the file itself is writable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-locked-'));
    dirs.push(dir);
    const binary = join(dir, 'slackcli');
    await writeFile(binary, 'x');
    await chmod(dir, 0o555);
    expect(isInstallDirWritable(binary)).toBe(false);
  });

  it('is false when the folder does not exist', () => {
    expect(isInstallDirWritable(join(tmpdir(), 'slackcli-no-such-dir-284', 'slackcli'))).toBe(false);
  });

  it.skipIf(!canLockDirs)('defaults to the folder of the running binary', async () => {
    await fakeBinary(dirs, { locked: true });
    expect(isInstallDirWritable()).toBe(false);
  });
});

describe('getUpdateCommand', () => {
  const originalExecPath = process.execPath;
  const dirs: string[] = [];

  afterEach(async () => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    restorePlatform();
    await removeDirs(dirs);
  });

  it('returns brew command for Homebrew installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('brew upgrade slackcli');
    expect(updateCommandSuffix()).toBe('');
  });

  it('returns slackcli update for a writable direct install', async () => {
    await fakeBinary(dirs);
    expect(getUpdateCommand()).toBe('slackcli update');
    expect(updateCommandSuffix()).toBe('');
  });

  it.skipIf(!canLockDirs).each(['linux', 'darwin'] as const)(
    'suggests sudo for an unwritable install folder on %s',
    async (platform) => {
      await fakeBinary(dirs, { locked: true });
      setPlatform(platform);
      expect(getUpdateCommand()).toBe('sudo slackcli update');
      expect(updateCommandSuffix()).toBe('');
    },
  );

  it.skipIf(!canLockDirs)('asks for an Administrator terminal, not sudo, on win32', async () => {
    await fakeBinary(dirs, { locked: true });
    setPlatform('win32');
    expect(getUpdateCommand()).toBe('slackcli update');
    expect(updateCommandSuffix()).toBe(' from an Administrator terminal');
  });

  it.skipIf(!canLockDirs).each(['linux', 'win32'] as const)(
    'still gives brew upgrade for an unwritable Cellar on %s',
    async (platform) => {
      await fakeBinary(dirs, { locked: true, name: 'Cellar-' });
      setPlatform(platform);
      expect(getUpdateCommand()).toBe('brew upgrade slackcli');
      expect(updateCommandSuffix()).toBe('');
    },
  );
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
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(performUpdate()).resolves.toBeUndefined();
      expect(log.mock.calls.flat().join('\n')).toContain('Installed via Homebrew — run: brew upgrade slackcli');
    } finally {
      log.mockRestore();
    }
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

describe('performUpdate on an unwritable install folder', () => {
  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const dirs: string[] = [];
  let fetchCalls: string[];
  let log: ReturnType<typeof spyOn>;

  // A release at `tag` whose assets are named for every platform, so a
  // download would be attempted if the permission check did not stop it.
  function stubRelease(tag: string) {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('/releases/latest')) {
        const names = ['slackcli-linux', 'slackcli-linux-arm64', 'slackcli-macos', 'slackcli-macos-arm64', 'slackcli-windows.exe'];
        return new Response(
          JSON.stringify({
            tag_name: tag,
            name: tag,
            body: '',
            assets: names.map(name => ({
              name,
              browser_download_url: `https://example.invalid/${name}`,
              digest: `sha256:${'0'.repeat(64)}`,
            })),
          }),
          { status: 200 },
        );
      }
      return new Response('NEW BINARY', { status: 200 });
    }) as typeof fetch;
  }

  beforeEach(async () => {
    fetchCalls = [];
    const cacheDir = await mkdtemp(join(tmpdir(), 'slackcli-cache-'));
    dirs.push(cacheDir);
    setUpdateCacheDirForTesting(cacheDir);
    log = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    restorePlatform();
    setUpdateCacheDirForTesting(null);
    await removeDirs(dirs);
  });

  it.skipIf(!canLockDirs).each(['linux', 'darwin'] as const)(
    'refuses before downloading and names the folder and sudo on %s',
    async (platform) => {
      const { dir, installed } = await fakeBinary(dirs, { locked: true });
      setPlatform(platform);
      stubRelease('v99.0.0');

      await expect(performUpdate()).rejects.toThrow(
        `No write permission for ${dir} — run: sudo slackcli update`,
      );
      // Only the release lookup went out: no asset was fetched.
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toContain('/releases/latest');
      expect(await readFile(installed, 'utf-8')).toBe('THE BINARY THAT IS ALREADY INSTALLED');
    },
  );

  it.skipIf(!canLockDirs)('asks for an Administrator terminal, not sudo, on win32', async () => {
    const { dir } = await fakeBinary(dirs, { locked: true });
    setPlatform('win32');
    stubRelease('v99.0.0');

    const failure = await performUpdate().then(
      () => undefined,
      (err: Error) => err.message,
    );
    expect(failure).toBe(`No write permission for ${dir} — run slackcli update from an Administrator terminal`);
    expect(failure).not.toContain('sudo');
    expect(fetchCalls).toHaveLength(1);
  });

  it.skipIf(!canLockDirs)('logs the refusal without the folder path', async () => {
    const { dir } = await fakeBinary(dirs, { locked: true });
    stubRelease('v99.0.0');
    const records = captureLogs();
    try {
      await expect(performUpdate()).rejects.toThrow(/No write permission/);
    } finally {
      resetSync();
    }

    const refusal = updaterRecords(records).find(r => r.message.join('').includes('Self-update refused'));
    expect(refusal?.level).toBe('error');
    expect(JSON.stringify(updaterRecords(records))).not.toContain(dir);
  });

  it.skipIf(!canLockDirs)('still reports "Already on latest version" with no permission error', async () => {
    await fakeBinary(dirs, { locked: true });
    stubRelease('v0.0.1');

    await expect(performUpdate()).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('Already on latest version');
    expect(fetchCalls).toHaveLength(1);
  });

  it('downloads as before when the folder is writable', async () => {
    await fakeBinary(dirs);
    stubRelease('v99.0.0');

    // The stub's all-zero digest makes the install fail after the download,
    // which is enough to show the download was not blocked.
    await expect(performUpdate()).rejects.toThrow(/Checksum mismatch/);
    expect(fetchCalls).toHaveLength(2);
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

  describe('logging', () => {
    afterEach(() => resetSync());

    it('logs current → target version and a failed digest verification', async () => {
      await fakeInstall();
      stubRelease(new TextEncoder().encode('MALICIOUS PAYLOAD'), `sha256:${'0'.repeat(64)}`);
      const records = captureLogs();

      await expect(performUpdate()).rejects.toThrow(/Checksum mismatch/);

      const logged = updaterRecords(records);
      const target = logged.find((r) => r.properties.latest_version === 'v99.0.0' && r.properties.asset);
      expect(target?.level).toBe('info');
      expect(target?.properties.current_version).toBe(getCurrentVersion());
      const failure = logged.find((r) => r.message.join('').includes('Digest verification failed'));
      expect(failure?.level).toBe('error');
      expect(String(failure?.properties.error)).toContain('Checksum mismatch');
      expect(logged.some((r) => r.message.join('').includes('Digest verification passed'))).toBe(false);
    });

    it('logs a passed digest verification and the installed version', async () => {
      await fakeInstall();
      const payload = new TextEncoder().encode('THE NEW BINARY');
      const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
      stubRelease(payload, digest);
      const records = captureLogs();

      await performUpdate();

      const messages = updaterRecords(records).map((r) => r.message.join(''));
      expect(messages).toContain(`Digest verification passed (${digest})`);
      expect(messages).toContain('Self-update installed v99.0.0');
    });
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

describe('checkForUpdates', () => {
  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const dirs: string[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    restorePlatform();
    await removeDirs(dirs);
  });

  type Install = 'homebrew' | 'writable' | 'locked';
  const cases: Array<[string, Install, NodeJS.Platform, string]> = [
    ['a Homebrew install', 'homebrew', 'darwin', 'Run "brew upgrade slackcli" to update'],
    ['a writable direct install', 'writable', 'linux', 'Run "slackcli update" to update'],
  ];
  if (canLockDirs) {
    cases.push(
      ['an unwritable folder on linux', 'locked', 'linux', 'Run "sudo slackcli update" to update'],
      ['an unwritable folder on win32', 'locked', 'win32', 'Run "slackcli update" from an Administrator terminal to update'],
    );
  }

  it.each(cases)('names the right update command for %s', async (_label, install, platform, hint) => {
    if (install === 'homebrew') {
      Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    } else {
      await fakeBinary(dirs, { locked: install === 'locked' });
    }
    setPlatform(platform);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: 'v99.0.0', name: 'v99.0.0', body: '', assets: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await checkForUpdates(false);
      expect(result.updateAvailable).toBe(true);
      expect(log.mock.calls.flat().join('\n')).toContain(hint);
    } finally {
      log.mockRestore();
    }
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

describe('isUpdateNotifierDisabled', () => {
  it.each([
    [{}, false],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: '1' }, true],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: 'true' }, true],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: 'yes' }, true],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: '' }, false],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: '0' }, false],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: 'false' }, false],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: 'FALSE' }, false],
    [{ CI: 'true' }, true],
    [{ CI: '1' }, true],
    [{ CI: 'TRUE' }, true],
    [{ CI: '' }, false],
    [{ CI: '0' }, false],
    [{ CI: 'false' }, false],
    [{ CI: 'False' }, false],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: '0', CI: 'true' }, true],
    [{ SLACKCLI_NO_UPDATE_NOTIFIER: '1', CI: 'false' }, true],
  ])('%p → %p', (env, expected) => {
    expect(isUpdateNotifierDisabled(env)).toBe(expected);
  });
});

describe('notifyIfUpdateAvailable', () => {
  // An explicit, empty environment: CI runners set `CI`, which would switch the
  // notifier off and silently skip every assertion below.
  const NO_ENV: NodeJS.ProcessEnv = {};
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
    notifyIfUpdateAvailable(argv, NO_ENV);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length);
  });

  it('does not refresh a stale cache during `update`', async () => {
    await writeCache(0);
    notifyIfUpdateAvailable(['bun', 'slackcli', 'update'], NO_ENV);
    expect(fetchCalls).toBe(0);
  });

  it('still schedules the banner for other commands', async () => {
    await writeCache(Date.now());
    notifyIfUpdateAvailable(['bun', 'slackcli', 'auth', 'list'], NO_ENV);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length + 1);
  });

  it.each([
    ['SLACKCLI_NO_UPDATE_NOTIFIER=1', { SLACKCLI_NO_UPDATE_NOTIFIER: '1' }],
    ['CI=true', { CI: 'true' }],
    ['CI=1', { CI: '1' }],
  ])('makes no request and schedules no banner with %s', async (_label, env) => {
    // A stale cache announcing a newer version: both a refresh and a banner are due.
    await writeCache(0);
    await notifyIfUpdateAvailable(['bun', 'slackcli', 'auth', 'list'], env);
    expect(fetchCalls).toBe(0);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length);
  });

  it.each([
    ['SLACKCLI_NO_UPDATE_NOTIFIER=0', { SLACKCLI_NO_UPDATE_NOTIFIER: '0' }],
    ['CI=false', { CI: 'false' }],
  ])('still refreshes and schedules the banner with %s', async (_label, env) => {
    await writeCache(0);
    await notifyIfUpdateAvailable(['bun', 'slackcli', 'auth', 'list'], env);
    expect(fetchCalls).toBe(1);
    expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length + 1);
  });

  describe('refresh, back-off and banner', () => {
    const argv = ['bun', 'slackcli', 'auth', 'list'];
    const cacheFile = () => join(cacheDir, 'update-check.json');
    let stderr: ReturnType<typeof spyOn>;

    beforeEach(() => {
      stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderr.mockRestore();
    });

    async function writeRawCache(cache: unknown) {
      await writeFile(cacheFile(), JSON.stringify(cache));
    }

    async function readCache() {
      return JSON.parse(await readFile(cacheFile(), 'utf-8'));
    }

    function stubRelease(tag: string) {
      globalThis.fetch = (async () => {
        fetchCalls++;
        return releaseResponse(tag);
      }) as unknown as typeof fetch;
    }

    // Fires the listeners this test registered, as the runtime does at exit.
    function fireBeforeExit(): string {
      for (const listener of process.listeners('beforeExit')) {
        if (!listenersBefore.includes(listener)) (listener as (code: number) => void)(0);
      }
      return stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    }

    it('tells a writable direct install to run slackcli update', async () => {
      const dirs: string[] = [];
      try {
        await fakeBinary(dirs);
        await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v99.0.0' });
        await notifyIfUpdateAvailable(argv, NO_ENV);
        expect(fireBeforeExit()).toContain('Run: slackcli update\n');
      } finally {
        await removeDirs(dirs);
      }
    });

    it.skipIf(!canLockDirs)('suggests sudo when the install folder is not writable', async () => {
      const dirs: string[] = [];
      try {
        await fakeBinary(dirs, { locked: true });
        setPlatform('linux');
        await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v99.0.0' });
        await notifyIfUpdateAvailable(argv, NO_ENV);
        expect(fireBeforeExit()).toContain('Run: sudo slackcli update\n');
      } finally {
        restorePlatform();
        await removeDirs(dirs);
      }
    });

    it.skipIf(!canLockDirs)('asks for an Administrator terminal on win32', async () => {
      const dirs: string[] = [];
      try {
        await fakeBinary(dirs, { locked: true });
        setPlatform('win32');
        await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v99.0.0' });
        await notifyIfUpdateAvailable(argv, NO_ENV);
        const banner = fireBeforeExit();
        expect(banner).toContain('Run: slackcli update from an Administrator terminal\n');
        expect(banner).not.toContain('sudo');
      } finally {
        restorePlatform();
        await removeDirs(dirs);
      }
    });

    it('bounds a hanging background check by its timeout and records the failure', async () => {
      globalThis.fetch = hangingFetch(() => fetchCalls++);
      const started = Date.now();

      await notifyIfUpdateAvailable(argv, NO_ENV);

      const elapsed = Date.now() - started;
      expect(fetchCalls).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(BACKGROUND_CHECK_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(BACKGROUND_CHECK_TIMEOUT_MS + 1500);
      const cache = await readCache();
      expect(cache.failedAt).toBeGreaterThanOrEqual(started);
      expect(fireBeforeExit()).toBe('');
    });

    it('keeps the known latest version and checkedAt when a check fails', async () => {
      await writeRawCache({ checkedAt: 1000, latestVersion: 'v99.0.0' });
      const started = Date.now();

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(1);
      const cache = await readCache();
      expect(cache).toMatchObject({ checkedAt: 1000, latestVersion: 'v99.0.0' });
      expect(cache.failedAt).toBeGreaterThanOrEqual(started);
    });

    it('records a failure even when there was no cache yet', async () => {
      await notifyIfUpdateAvailable(argv, NO_ENV);

      const cache = await readCache();
      expect(cache.checkedAt).toBe(0);
      expect(cache.latestVersion).toBeUndefined();
      expect(typeof cache.failedAt).toBe('number');
    });

    it('makes no request within the back-off window after a failure', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v99.0.0', failedAt: Date.now() - 1000 });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(0);
      // The known newer version is still announced while backing off.
      expect(fireBeforeExit()).toContain('v99.0.0');
    });

    it('retries once the back-off window has passed', async () => {
      await writeRawCache({ checkedAt: 0, failedAt: Date.now() - RETRY_AFTER_FAILURE_MS - 1 });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(1);
    });

    it('does not let a failure timestamp in the future suppress checks', async () => {
      await writeRawCache({ checkedAt: 0, failedAt: Date.now() + 24 * 60 * 60 * 1000 });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(1);
    });

    it('does not refresh a successful check younger than 24h, even after a failure', async () => {
      await writeRawCache({ checkedAt: Date.now() - 60_000, latestVersion: 'v99.0.0' });
      await notifyIfUpdateAvailable(argv, NO_ENV);
      await writeRawCache({
        checkedAt: Date.now() - 60_000,
        latestVersion: 'v99.0.0',
        failedAt: Date.now() - RETRY_AFTER_FAILURE_MS - 1,
      });
      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(0);
    });

    it('clears the failure marker on a successful check', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v1.0.0', failedAt: 1 });
      stubRelease('v99.0.0');
      const started = Date.now();

      await notifyIfUpdateAvailable(argv, NO_ENV);

      const cache = await readCache();
      expect(cache.latestVersion).toBe('v99.0.0');
      expect(cache.checkedAt).toBeGreaterThanOrEqual(started);
      expect(cache.failedAt).toBeUndefined();
    });

    it('announces the freshly fetched version, not the stale cached one', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v1.0.0' });
      stubRelease('v99.0.0');

      await notifyIfUpdateAvailable(argv, NO_ENV);

      const banner = fireBeforeExit();
      expect(banner).toContain('→ v99.0.0');
      expect(banner).not.toContain('v1.0.0');
    });

    it('announces a release found by the first ever check in the same run', async () => {
      stubRelease('v99.0.0');

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fireBeforeExit()).toContain('→ v99.0.0');
    });

    it('falls back to the cached version when the background check fails', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v99.0.0' });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fireBeforeExit()).toContain('→ v99.0.0');
    });

    it('falls back to the cached version when the background check times out', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v99.0.0' });
      globalThis.fetch = hangingFetch();

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fireBeforeExit()).toContain('→ v99.0.0');
    });

    it('prints nothing when the fresh result is not newer, even if the cache was', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v99.0.0' });
      stubRelease('v0.0.1');

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fireBeforeExit()).toBe('');
    });

    it('prints nothing when neither the fetched nor the cached version is newer', async () => {
      await writeRawCache({ checkedAt: 0, latestVersion: 'v0.0.1' });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fireBeforeExit()).toBe('');
    });

    it('registers no listener when nothing is pending and nothing is newer', async () => {
      await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v0.0.1' });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(process.listeners('beforeExit')).toHaveLength(listenersBefore.length);
    });

    it('prints the banner only once when beforeExit fires repeatedly', async () => {
      await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v99.0.0' });

      await notifyIfUpdateAvailable(argv, NO_ENV);
      fireBeforeExit();
      fireBeforeExit();

      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it('reads an old cache file without the failure field', async () => {
      await writeRawCache({ checkedAt: Date.now(), latestVersion: 'v99.0.0' });

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(0);
      expect(fireBeforeExit()).toContain('→ v99.0.0');
    });

    it.each([
      ['fields of the wrong type', { checkedAt: 'yesterday', latestVersion: 5, failedAt: 'now' }],
      ['a JSON array', []],
      ['JSON null', null],
    ])('treats a cache with %s as stale without crashing', async (_label, cache) => {
      await writeRawCache(cache);

      await notifyIfUpdateAvailable(argv, NO_ENV);

      expect(fetchCalls).toBe(1);
      expect(fireBeforeExit()).toBe('');
    });
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

  it('logs fail-soft errors at debug', async () => {
    const records = captureLogs();
    try {
      globalThis.fetch = (async () =>
        new Response('rate limited', { status: 403 })) as unknown as typeof fetch;
      await fetchLatestRelease();
      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await fetchLatestRelease();
    } finally {
      resetSync();
    }

    const logged = updaterRecords(records);
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.level === 'debug')).toBe(true);
    expect(logged[0].properties.http_status).toBe(403);
    expect(logged[1].properties.error).toBe('fetch failed');
  });

  it('aborts a request that does not answer within the timeout', async () => {
    globalThis.fetch = hangingFetch();
    const started = Date.now();
    expect(await fetchLatestRelease(50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds every lookup with an abort signal by default', async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return releaseResponse('v1.2.3');
    }) as unknown as typeof fetch;
    await fetchLatestRelease();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('returns null when the body is not valid JSON', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestRelease()).toBeNull();
  });
});
