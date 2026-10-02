import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetSync, type LogRecord } from '@logtape/logtape';
import {
  authenticateAuto,
  authenticateBrowser,
  authenticateStandard,
  AutoLoginError,
  effectiveWorkspaceSelector,
  selectWorkspace,
  WORKSPACE_ENV_VAR,
} from './auth';
import { AmbiguousWorkspaceError, resolveWorkspace } from './workspaces';
import type { WorkspaceConfig, WorkspacesData } from '../types/index';
import { configureLogging } from './logger';
import { AUTH_ERROR_CODES, SlackAuthError } from './auth-errors';
import { SlackClient } from './slack-client';
import * as browserAuth from './browser-auth';

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

// A token Slack refuses at login was never stored, so the "log in again" advice
// a stale profile gets would send the user round in a circle. Both login paths
// fail before `addWorkspace()`, so nothing here touches the config file.
describe('login with rejected credentials', () => {
  const originalFetch = globalThis.fetch;
  let records: LogRecord[];

  beforeEach(() => {
    records = [];
    configureLogging({ level: 'info', verbose: false, sinks: { capture: (r) => records.push(r) } });
  });

  afterEach(() => {
    resetSync();
    globalThis.fetch = originalFetch;
  });

  function slackReplies(payload: Record<string, unknown>): void {
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
  }

  const loginBrowser = () =>
    authenticateBrowser('xoxd-secretcookie', 'xoxc-secrettoken', 'https://acme.slack.com', 'Acme Corp')
      .catch((err) => err);

  // The standard path goes through `@slack/web-api`, which has no fetch seam;
  // `testAuth()` is stubbed to fail the way `SlackClient.request()` does.
  async function loginStandard(failure: Error): Promise<any> {
    const testAuth = spyOn(SlackClient.prototype, 'testAuth').mockRejectedValue(failure);
    try {
      return await authenticateStandard('xoxb-1234567890-secrettoken', 'Acme Corp').catch((err) => err);
    } finally {
      testAuth.mockRestore();
    }
  }

  const rejectedAs = (code: (typeof AUTH_ERROR_CODES)[number]) =>
    new SlackAuthError(code, { profileKey: 'temp', workspaceName: 'Acme Corp', authType: 'standard' });

  it.each([...AUTH_ERROR_CODES])('reports browser tokens rejected with %s without re-login advice', async (code) => {
    slackReplies({ ok: false, error: code });

    const error = await loginBrowser();

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SlackAuthError);
    expect(error.message).toStartWith(
      `Authentication failed: the browser session tokens were rejected by Slack (${code}).`,
    );
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('To fix');
    expect(error.message).not.toContain('slackcli auth');
    expect(error.message).not.toContain('profile "temp"');
    expect(error.message).not.toContain('secret');
  });

  it.each([...AUTH_ERROR_CODES])('reports a standard token rejected with %s without re-login advice', async (code) => {
    const error = await loginStandard(rejectedAs(code));

    expect(error).not.toBeInstanceOf(SlackAuthError);
    expect(error.message).toStartWith(`Authentication failed: the supplied token was rejected by Slack (${code}).`);
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('To fix');
    expect(error.message).not.toContain('slackcli auth');
    expect(error.message).not.toContain('profile "temp"');
    expect(error.message).not.toContain('secret');
  });

  // `login-auto` captures the tokens itself and verifies them through
  // `authenticateBrowser()`. The browser is stubbed out; the capture result and
  // Slack's refusal are real inputs to the code under test.
  it('reports a token captured by login-auto and refused by Slack without re-login or copy advice', async () => {
    let stopped = 0;
    const open = spyOn(browserAuth, 'openBrowserSession').mockResolvedValue({
      ok: true,
      session: {} as never,
      stop: async () => { stopped += 1; },
    } as never);
    const capture = spyOn(browserAuth, 'captureSlackTokens').mockResolvedValue({
      ok: true,
      xoxd: 'xoxd-secretcookie',
      workspaces: [{ workspaceUrl: 'https://acme.slack.com', xoxc: 'xoxc-secrettoken', teamId: 'T1', teamName: 'Acme Corp' }],
    });
    slackReplies({ ok: false, error: 'invalid_auth' });

    try {
      const result = await authenticateAuto({ headless: true });

      expect(stopped).toBe(1);
      expect(result.saved).toEqual([]);
      expect(result.failed).toEqual([{
        workspaceUrl: 'https://acme.slack.com',
        error: 'Authentication failed: the browser session tokens were rejected by Slack (invalid_auth). '
          + 'They must come from a browser that is signed in to this workspace: sign in there, then try again.',
      }]);
    } finally {
      open.mockRestore();
      capture.mockRestore();
    }
  });

  it('logs only the Slack code of a rejected login', async () => {
    slackReplies({ ok: false, error: 'invalid_auth' });
    await loginBrowser();

    const failure = records.find((r) => r.category.join('.') === 'slackcli.auth' && r.level === 'warning');
    expect(failure?.properties).toMatchObject({ auth_type: 'browser', error: 'invalid_auth' });
    expect(JSON.stringify(failure)).not.toContain('Acme Corp');
  });

  it('keeps the message of a login that failed for another reason', async () => {
    slackReplies({ ok: false, error: 'team_access_not_granted' });
    expect((await loginBrowser()).message).toBe('Authentication failed: Slack API error: team_access_not_granted');

    const error = await loginStandard(new Error('Slack API error: An API error occurred: ratelimited'));
    expect(error.message).toBe('Authentication failed: Slack API error: An API error occurred: ratelimited');
  });
});

describe('effectiveWorkspaceSelector', () => {
  it('prefers the flag over the environment variable', () => {
    expect(effectiveWorkspaceSelector('other', 'acme')).toEqual({ identifier: 'other', source: 'flag' });
  });

  it('uses the environment variable when no flag is given', () => {
    expect(effectiveWorkspaceSelector(undefined, 'acme')).toEqual({ identifier: 'acme', source: 'env' });
  });

  it('treats an empty flag as not given', () => {
    expect(effectiveWorkspaceSelector('', 'acme')).toEqual({ identifier: 'acme', source: 'env' });
  });

  it('trims the environment value', () => {
    expect(effectiveWorkspaceSelector(undefined, '  acme\n')).toEqual({ identifier: 'acme', source: 'env' });
  });

  it('keeps inner whitespace, so a workspace name with spaces still works', () => {
    expect(effectiveWorkspaceSelector(undefined, ' My Team ')).toEqual({ identifier: 'My Team', source: 'env' });
  });

  it.each([undefined, '', ' ', '\t\n  '])('falls back to the stored default for env %p', (env) => {
    const selector = effectiveWorkspaceSelector(undefined, env);
    expect(selector).toEqual({ source: 'default' });
    expect('identifier' in selector).toBe(false);
  });

  it('does not let a blank environment value shadow the flag', () => {
    expect(effectiveWorkspaceSelector('other', '  ')).toEqual({ identifier: 'other', source: 'flag' });
  });
});

describe('selectWorkspace', () => {
  const standard = (id: string, name: string, profile?: string): WorkspaceConfig => ({
    workspace_id: id,
    workspace_name: name,
    auth_type: 'standard',
    token: 'xoxb-test',
    token_type: 'bot',
    ...(profile ? { profile } : {}),
  });

  // Two identities in team T1 (so "T1" by id and "example" by name are
  // ambiguous), plus an unrelated default.
  const data: WorkspacesData = {
    default_workspace: 'T2',
    workspaces: {
      acme: standard('T1', 'example', 'acme'),
      'T1-2': standard('T1', 'example'),
      T2: standard('T2', 'other'),
    },
  };
  // Same matching as the real getWorkspace(), minus the config file.
  const lookup = async (identifier?: string) => resolveWorkspace(data, identifier)?.config ?? null;
  const select = (flag?: string, env?: string) => selectWorkspace(effectiveWorkspaceSelector(flag, env), lookup);

  let records: LogRecord[];

  beforeEach(() => {
    records = [];
    configureLogging({ level: 'debug', verbose: false, sinks: { capture: (r) => records.push(r) } });
  });

  afterEach(() => {
    resetSync();
  });

  const authRecords = () => records.filter((r) => r.category.join('.') === 'slackcli.auth');

  it('selects the profile named by the environment variable', async () => {
    expect(await select(undefined, 'acme')).toBe(data.workspaces.acme);
  });

  it('accepts every selector kind --workspace accepts', async () => {
    expect(await select(undefined, 'T1-2')).toBe(data.workspaces['T1-2']); // profile key
    expect(await select(undefined, 'T2')).toBe(data.workspaces.T2); // workspace id
    expect(await select(undefined, 'other')).toBe(data.workspaces.T2); // workspace name
  });

  it('lets the flag override the environment variable', async () => {
    expect(await select('T2', 'acme')).toBe(data.workspaces.T2);
  });

  it.each([undefined, '', '   '])('uses the stored default when the variable is %p', async (env) => {
    expect(await select(undefined, env)).toBe(data.workspaces.T2);
  });

  it('names the variable when its value matches no profile, and does not fall back', async () => {
    await expect(select(undefined, 'nope')).rejects.toThrow(`Workspace not found: nope (from ${WORKSPACE_ENV_VAR})`);
  });

  it('reports a trimmed value in the not-found error', async () => {
    await expect(select(undefined, ' nope ')).rejects.toThrow('Workspace not found: nope (from SLACKCLI_WORKSPACE)');
  });

  it('keeps the plain not-found error for an unknown flag value', async () => {
    const failure = await select('nope', 'acme').catch((e: Error) => e);
    expect((failure as Error).message).toBe('Workspace not found: nope');
  });

  it('raises the existing ambiguity error for an ambiguous environment value', async () => {
    const failure = await select(undefined, 'example').catch((e: Error) => e);
    expect(failure).toBeInstanceOf(AmbiguousWorkspaceError);
    expect((failure as AmbiguousWorkspaceError).keys).toEqual(['acme', 'T1-2']);
  });

  it('reports no workspace configured when nothing is stored and nothing is selected', async () => {
    await expect(selectWorkspace({ source: 'default' }, async () => null)).rejects.toThrow(
      'No workspace configured. Run "slackcli auth login" first.',
    );
  });

  it.each([
    ['flag', 'T2', 'acme'],
    ['env', undefined, 'acme'],
    ['default', undefined, undefined],
  ] as const)('logs the selection source %s without the selector value', async (source, flag, env) => {
    const workspace = await select(flag, env);
    const [record] = authRecords();
    expect(record.properties).toMatchObject({ source, workspace_id: workspace.workspace_id });
    // `run_id` is added to every record by the logger.
    const keys = Object.keys(record.properties).filter((key) => key !== 'run_id');
    expect(keys.sort()).toEqual(['auth_type', 'source', 'workspace_id']);
  });

  it('logs the source, not the value, when nothing resolves', async () => {
    await select(undefined, 'nope').catch(() => {});
    const [record] = authRecords();
    expect(record.level).toBe('warning');
    expect(record.properties).toMatchObject({ source: 'env' });
    expect(JSON.stringify(record.properties)).not.toContain('nope');
  });
});

// getAuthenticatedClient() is where the variable is actually read, so the
// wiring is exercised as a subprocess under a temporary HOME. Every case fails
// before any Slack call. POSIX-only: Windows does not take its home from HOME.
describe.skipIf(process.platform === 'win32')('SLACKCLI_WORKSPACE through the CLI', () => {
  const root = resolve(import.meta.dir, '../..');
  const record = (id: string, name: string) => ({
    workspace_id: id,
    workspace_name: name,
    auth_type: 'standard',
    token: 'xoxb-test',
    token_type: 'bot',
  });
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slackcli-auth-env-'));
    const configDir = join(home, '.config', 'slackcli');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T2',
        workspaces: { acme: record('T1', 'example'), 'T1-2': record('T1', 'example'), T2: record('T2', 'other') },
      }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function run(args: string[], workspaceEnv: string) {
    const result = Bun.spawnSync([process.execPath, 'run', join(root, 'src/index.ts'), ...args], {
      cwd: root,
      stdin: 'ignore',
      env: {
        ...process.env,
        HOME: home,
        SLACKCLI_LOG_LEVEL: 'off',
        SLACKCLI_NO_UPDATE_NOTIFIER: '1',
        SLACKCLI_WORKSPACE: workspaceEnv,
      },
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  it('fails, naming the variable, when its value matches no profile', () => {
    const { code, output } = run(['team', 'info'], 'nope');
    expect(code).toBe(1);
    expect(output).toContain('Workspace not found: nope (from SLACKCLI_WORKSPACE)');
  }, 30_000);

  it('lets --workspace override the variable', () => {
    const { code, output } = run(['team', 'info', '--workspace', 'zzz'], 'acme');
    expect(code).toBe(1);
    expect(output).toContain('Workspace not found: zzz');
    expect(output).not.toContain('SLACKCLI_WORKSPACE');
  }, 30_000);

  it('raises the ambiguity error for a value matching several profiles', () => {
    const { code, output } = run(['team', 'info'], 'example');
    expect(code).toBe(1);
    expect(output).toContain('"example" matches multiple profiles: acme, T1-2');
  }, 30_000);

  it('leaves auth list working and marking the stored default', () => {
    const { code, output } = run(['auth', 'list'], 'nope');
    expect(code).toBe(0);
    expect(output).not.toContain('Workspace not found');
    expect(output).toMatch(/other.*\(default\)/);
  }, 30_000);
});
