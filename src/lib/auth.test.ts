import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { authenticateAuto, AutoLoginError } from './auth';
import { configureLogging } from './logger';

// A failed `login-auto` must leave enough in the log to answer "which browser,
// which step, why" without a reproduction session. Driven end to end through a
// stand-in browser that exits at once; POSIX-only, since it execs a shell script.
describe.skipIf(process.platform === 'win32')('authenticateAuto logging', () => {
  const savedBrowser = process.env.SLACKCLI_BROWSER;
  const savedProfile = process.env.SLACKCLI_BROWSER_PROFILE;
  let dir: string;
  let records: LogRecord[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slackcli-auth-log-'));
    const browser = join(dir, 'fake-browser');
    await writeFile(browser, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.SLACKCLI_BROWSER = browser;
    process.env.SLACKCLI_BROWSER_PROFILE = join(dir, 'profile');
    records = [];
    configureLogging({ level: 'info', verbose: false, sinks: { capture: (r) => records.push(r) } });
  });

  afterEach(async () => {
    resetSync();
    if (savedBrowser === undefined) delete process.env.SLACKCLI_BROWSER;
    else process.env.SLACKCLI_BROWSER = savedBrowser;
    if (savedProfile === undefined) delete process.env.SLACKCLI_BROWSER_PROFILE;
    else process.env.SLACKCLI_BROWSER_PROFILE = savedProfile;
    await rm(dir, { recursive: true, force: true });
  });

  it('records the browser, the profile, the port discovery and the typed reason', async () => {
    const error = await authenticateAuto({ headless: true }).catch((err) => err);

    expect(error).toBeInstanceOf(AutoLoginError);
    expect(error.reason).toBe('browser_exited');

    const byCategory = (area: string) => records.filter((r) => r.category.join('.') === `slackcli.${area}`);
    const auth = byCategory('auth');
    expect(auth[0].message.join('')).toBe('login-auto started');
    expect(auth[0].properties).toMatchObject({ headless: true, workspace_url_given: false });
    const failure = auth.find((r) => r.level === 'error');
    expect(failure?.properties.reason).toBe('browser_exited');

    const launcher = byCategory('browser-launcher').map((r) => r.properties);
    expect(launcher).toContainEqual(expect.objectContaining({
      executable: join(dir, 'fake-browser'),
      source: 'SLACKCLI_BROWSER',
    }));
    expect(launcher).toContainEqual(expect.objectContaining({
      profile_dir: join(dir, 'profile'),
      profile_state: 'created',
      source: 'SLACKCLI_BROWSER_PROFILE',
    }));
    expect(launcher).toContainEqual(expect.objectContaining({ reason: 'browser_exited' }));
  });

  it('records browser_not_found as the typed reason', async () => {
    process.env.SLACKCLI_BROWSER = join(dir, 'missing');

    const error = await authenticateAuto().catch((err) => err);

    expect(error).toBeInstanceOf(AutoLoginError);
    const failure = records.find((r) => r.category.join('.') === 'slackcli.auth' && r.level === 'error');
    expect(failure?.properties.reason).toBe('browser_not_found');
  });
});
