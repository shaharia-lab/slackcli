import { afterEach, describe, expect, it } from 'bun:test';
import { isNewerVersion, isInstalledViaHomebrew, getUpdateCommand, getCurrentVersion, performUpdate, verifyAssetDigest } from './updater.ts';
import { createHash } from 'crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
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

  it('detects macOS Homebrew Cellar path', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/Cellar/slackcli/0.4.0/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('detects macOS Apple Silicon Homebrew path', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('detects Linux Homebrew path', () => {
    Object.defineProperty(process, 'execPath', { value: '/home/linuxbrew/.linuxbrew/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns false for direct binary install', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(false);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns false for path in home directory', () => {
    Object.defineProperty(process, 'execPath', { value: '/home/user/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(false);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });
});

describe('getUpdateCommand', () => {
  const originalExecPath = process.execPath;

  it('returns brew command for Homebrew installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('brew upgrade slackcli');
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns slackcli update for direct installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('slackcli update');
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });
});

describe('getCurrentVersion', () => {
  it('matches package.json when not running a baked-in binary', () => {
    expect(getCurrentVersion()).toBe(packageJson.version);
  });
});

describe('performUpdate', () => {
  const originalExecPath = process.execPath;

  it('bails early when running under bun without downloading', async () => {
    Object.defineProperty(process, 'execPath', { value: '/Users/me/.bun/bin/bun', configurable: true });
    await expect(performUpdate()).resolves.toBeUndefined();
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
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
    expect(after.length).toBe(before.length);
  });
});
