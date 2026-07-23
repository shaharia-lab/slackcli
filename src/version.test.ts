import { describe, expect, it } from 'bun:test';
import { getAppVersion, isRunningUnderBun } from './version.ts';
import packageJson from '../package.json';

describe('getAppVersion', () => {
  it('returns package.json version when __APP_VERSION__ is not baked in', () => {
    expect(getAppVersion()).toBe(packageJson.version);
  });
});

describe('isRunningUnderBun', () => {
  const originalExecPath = process.execPath;

  it('returns true when execPath is the Bun interpreter', () => {
    Object.defineProperty(process, 'execPath', { value: '/Users/me/.bun/bin/bun', configurable: true });
    expect(isRunningUnderBun()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns true for bun.exe on Windows', () => {
    Object.defineProperty(process, 'execPath', { value: 'C:\\Users\\me\\.bun\\bin\\bun.exe', configurable: true });
    expect(isRunningUnderBun()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns false for a compiled slackcli binary', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(isRunningUnderBun()).toBe(false);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });
});
