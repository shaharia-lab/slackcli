import { afterEach, describe, expect, it } from 'bun:test';
import { getAppVersion, isRunningUnderBun } from './version.ts';
import packageJson from '../package.json';

describe('getAppVersion', () => {
  it('returns package.json version when __APP_VERSION__ is not baked in', () => {
    expect(getAppVersion()).toBe(packageJson.version);
  });
});

describe('isRunningUnderBun', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it.each([
    ['the Bun interpreter', '/Users/me/.bun/bin/bun', true],
    ['bun.exe on Windows', 'C:\\Users\\me\\.bun\\bin\\bun.exe', true],
    ['a compiled slackcli binary', '/usr/local/bin/slackcli', false],
  ])('for %s (%s) returns %p', (_label, execPath, expected) => {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    expect(isRunningUnderBun()).toBe(expected);
  });
});
