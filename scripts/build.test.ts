import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import pkg from '../package.json';
import { checkBunVersion, MIN_BUN_VERSION } from './build';

const EXPECTED_ERROR = (found: string) =>
  `slackcli builds need Bun >= 1.4.1 (found ${found}). ` +
  'See docs/development/build-and-release.md#why-bun-is-pinned';

describe('checkBunVersion', () => {
  it('requires Bun 1.4.1, the first release where --bytecode builds every target', () => {
    expect(MIN_BUN_VERSION).toBe('1.4.1');
  });

  it.each(['1.0.0', '1.3.5', '1.3.14', '1.4.0'])('rejects Bun %s with the documented message', (v) => {
    expect(checkBunVersion(v)).toBe(EXPECTED_ERROR(v));
  });

  it.each(['1.4.1', '1.4.2', '1.5.0', '2.0.0'])('accepts Bun %s', (v) => {
    expect(checkBunVersion(v)).toBeNull();
  });

  it('accepts a canary of a release newer than the minimum', () => {
    expect(checkBunVersion('1.5.0-canary.1')).toBeNull();
    expect(checkBunVersion('1.4.2-canary.3+abc1234')).toBeNull();
  });

  it('rejects a canary that precedes the minimum release', () => {
    expect(checkBunVersion('1.4.1-canary.7')).toBe(EXPECTED_ERROR('1.4.1-canary.7'));
    expect(checkBunVersion('1.4.0-canary.9')).toBe(EXPECTED_ERROR('1.4.0-canary.9'));
  });

  it.each(['', 'garbage', '1.4', '1.5', '2', 'v1.5.0', '1.x', ' 1.5.0'])('rejects an unparseable version %p instead of throwing', (v) => {
    expect(checkBunVersion(v)).toBe(EXPECTED_ERROR(v));
  });

  it('rejects a Bun without Bun.semver (older than 1.0.11) instead of crashing', () => {
    // A version that would otherwise pass, so only the missing order() can reject it.
    expect(checkBunVersion('1.5.0', null)).toBe(EXPECTED_ERROR('1.5.0'));
  });

  it('keeps package.json engines.bun in step with the minimum', () => {
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  });
});

describe('scripts/build.ts', () => {
  const script = join(import.meta.dir, 'build.ts');

  it('does not check the version or start a build when imported', () => {
    // Without the import.meta.main guard this would exit 1 on an old Bun or
    // compile a binary on a new one; either way 'imported' would not print.
    const res = Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(script)}); console.log('imported')`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(res.stdout.toString().trim()).toBe('imported');
    expect(res.exitCode).toBe(0);
  });

  // Only an old Bun can reach the refusal; on a supported one this would run a full build.
  it.skipIf(checkBunVersion(Bun.version) === null)(
    'exits 1 with the message before calling bun build when Bun is too old',
    () => {
      const res = Bun.spawnSync([process.execPath, 'run', script, '--outfile=/nonexistent/slackcli'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr.toString().trim()).toBe(EXPECTED_ERROR(Bun.version));
    },
  );
});
