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
  checkIdentity,
  effectiveWorkspaceSelector,
  selectWorkspace,
  selectWorkspaceEntry,
  WORKSPACE_ENV_VAR,
} from './auth';
import { AmbiguousWorkspaceError, resolveWorkspace } from './workspaces';
import type { SlackAuthTestResponse, WorkspaceConfig, WorkspacesData } from '../types/index';
import { configureLogging } from './logger';
import { AUTH_ERROR_CODES, SlackAuthError, authErrorProfile } from './auth-errors';
import { SlackClient, SlackTransportError } from './slack-client';
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

describe('selectWorkspaceEntry', () => {
  const config: WorkspaceConfig = {
    workspace_id: 'T1',
    workspace_name: 'example',
    auth_type: 'standard',
    token: 'xoxb-test',
    token_type: 'bot',
  };
  const data: WorkspacesData = { default_workspace: 'acme', workspaces: { acme: config } };
  const lookup = async (identifier?: string) => resolveWorkspace(data, identifier);

  it('returns the profile key along with the config', async () => {
    expect(await selectWorkspaceEntry({ source: 'default' }, lookup)).toEqual({ key: 'acme', config });
    expect(await selectWorkspaceEntry({ identifier: 'T1', source: 'flag' }, lookup)).toEqual({ key: 'acme', config });
  });

  it('fails like selectWorkspace when nothing matches', async () => {
    await expect(selectWorkspaceEntry({ identifier: 'nope', source: 'env' }, lookup)).rejects.toThrow(
      'Workspace not found: nope (from SLACKCLI_WORKSPACE)',
    );
    await expect(selectWorkspaceEntry({ source: 'default' }, async () => null)).rejects.toThrow(
      'No workspace configured. Run "slackcli auth login" first.',
    );
  });
});

describe('checkIdentity', () => {
  const browser: WorkspaceConfig = {
    workspace_id: 'T1',
    workspace_name: 'example',
    workspace_url: 'https://example.slack.com',
    auth_type: 'browser',
    xoxd_token: 'xoxd-secretcookie',
    xoxc_token: 'xoxc-secrettoken',
    profile: 'acme',
    user_id: 'U_STORED',
  };
  const bot: WorkspaceConfig = {
    workspace_id: 'T1',
    workspace_name: 'example',
    auth_type: 'standard',
    token: 'xoxb-secrettoken',
    token_type: 'bot',
    profile: 'T1-2',
    user_id: 'U_BOT',
  };
  // A record written before `user_id` and `profile` existed, keyed by team id.
  const legacy: WorkspaceConfig = {
    workspace_id: 'T2',
    workspace_name: 'other',
    auth_type: 'standard',
    token: 'xoxp-secrettoken',
    token_type: 'user',
  };
  const data: WorkspacesData = {
    default_workspace: 'T2',
    workspaces: { acme: browser, 'T1-2': bot, T2: legacy },
  };
  const lookup = async (identifier?: string) => resolveWorkspace(data, identifier);

  const answer: SlackAuthTestResponse = {
    ok: true,
    url: 'https://example.slack.com/',
    team: 'Example Inc',
    user: 'alice',
    team_id: 'T1',
    user_id: 'U_LIVE',
  };

  // A client whose only call is counted, so "exactly one auth.test" is checked.
  function clientThat(outcome: () => Promise<SlackAuthTestResponse>) {
    const seen: WorkspaceConfig[] = [];
    let calls = 0;
    const createClient = (config: WorkspaceConfig) => {
      seen.push(config);
      return { testAuth: async () => { calls += 1; return outcome(); } };
    };
    return { createClient, seen, calls: () => calls };
  }
  const answering = (response: SlackAuthTestResponse = answer) => clientThat(async () => response);
  const failing = (error: unknown) => clientThat(async () => { throw error; });

  it('reports the default profile, verified by one auth.test call', async () => {
    const client = answering({ ...answer, team_id: 'T2', user: 'carol', user_id: 'U_CAROL' });
    const identity = await checkIdentity(undefined, { env: '', lookup, createClient: client.createClient });
    expect(identity).toEqual({
      profile: 'T2',
      workspace_id: 'T2',
      workspace_name: 'other',
      auth_type: 'standard',
      source: 'default',
      status: 'ok',
      user: 'carol',
      user_id: 'U_CAROL',
    });
    expect(client.calls()).toBe(1);
    expect(client.seen).toEqual([legacy]);
  });

  it('selects the profile named by --workspace and reports the flag as the source', async () => {
    const client = answering();
    const identity = await checkIdentity('acme', { env: 'T2', lookup, createClient: client.createClient });
    expect(identity).toMatchObject({ profile: 'acme', workspace_id: 'T1', auth_type: 'browser', source: 'flag' });
    expect(client.seen).toEqual([browser]);
  });

  it('selects the profile named by SLACKCLI_WORKSPACE and reports env as the source', async () => {
    const identity = await checkIdentity(undefined, { env: 'T1-2', lookup, createClient: answering().createClient });
    expect(identity).toMatchObject({ profile: 'T1-2', auth_type: 'standard', source: 'env' });
  });

  it('reports the user Slack returns, not the one stored at login', async () => {
    const identity = await checkIdentity('acme', { env: '', lookup, createClient: answering().createClient });
    expect(identity).toMatchObject({ status: 'ok', user: 'alice', user_id: 'U_LIVE' });
  });

  it('includes bot_id only when Slack returns one', async () => {
    const asBot = await checkIdentity('T1-2', {
      env: '',
      lookup,
      createClient: answering({ ...answer, user: 'deploybot', user_id: 'U_BOT', bot_id: 'B42' }).createClient,
    });
    expect(asBot).toMatchObject({ status: 'ok', user: 'deploybot', bot_id: 'B42' });

    const asUser = await checkIdentity('acme', { env: '', lookup, createClient: answering().createClient });
    expect(asUser).not.toHaveProperty('bot_id');
  });

  it.each(AUTH_ERROR_CODES.map((code) => [code]))(
    'returns auth_failed with the stored details, meaning and fix for %s',
    async (code) => {
      const refusal = new SlackAuthError(code, authErrorProfile(browser), { ok: false, error: code });
      const client = failing(refusal);
      const identity = await checkIdentity('acme', { env: '', lookup, createClient: client.createClient });
      expect(identity).toEqual({
        profile: 'acme',
        workspace_id: 'T1',
        workspace_name: 'example',
        auth_type: 'browser',
        source: 'flag',
        user_id: 'U_STORED',
        status: 'auth_failed',
        error: { code, meaning: refusal.meaning, fix: refusal.fix },
      });
      expect(client.calls()).toBe(1);
    },
  );

  it('omits user_id for a failing legacy record that never stored one', async () => {
    const refusal = new SlackAuthError('invalid_auth', authErrorProfile(legacy));
    const identity = await checkIdentity(undefined, { env: '', lookup, createClient: failing(refusal).createClient });
    expect(identity).toMatchObject({ profile: 'T2', status: 'auth_failed' });
    expect(identity).not.toHaveProperty('user_id');
  });

  it('returns unreachable, not auth_failed, when no response was received', async () => {
    const dropped = new SlackTransportError('Slack API error: fetch failed', undefined, undefined, true);
    const identity = await checkIdentity('acme', { env: '', lookup, createClient: failing(dropped).createClient });
    expect(identity).toEqual({
      profile: 'acme',
      workspace_id: 'T1',
      workspace_name: 'example',
      auth_type: 'browser',
      source: 'flag',
      user_id: 'U_STORED',
      status: 'unreachable',
      error: { message: 'Slack API error: fetch failed' },
    });
  });

  it('returns unreachable with the HTTP status when Slack answered with a non-2xx', async () => {
    const down = new SlackTransportError('Slack API error: HTTP error! status: 503', 503, undefined, false);
    const identity = await checkIdentity('T1-2', { env: '', lookup, createClient: failing(down).createClient });
    expect(identity).toMatchObject({
      status: 'unreachable',
      error: { message: 'Slack API error: HTTP error! status: 503', http_status: 503 },
    });
  });

  it('rethrows a failure that is neither refused credentials nor a transport error', async () => {
    const other = new Error('Slack API error: ratelimited');
    await expect(
      checkIdentity('acme', { env: '', lookup, createClient: failing(other).createClient }),
    ).rejects.toBe(other);
  });

  it('never puts a credential in the result, whatever the outcome', async () => {
    const outcomes = [
      answering(),
      failing(new SlackAuthError('invalid_auth', authErrorProfile(browser))),
      failing(new SlackTransportError('Slack API error: fetch failed', undefined, undefined, true)),
    ];
    for (const selector of ['acme', 'T1-2', 'T2']) {
      for (const client of outcomes) {
        const identity = await checkIdentity(selector, { env: '', lookup, createClient: client.createClient });
        const serialised = JSON.stringify(identity);
        expect(serialised).not.toContain('secret');
        expect(serialised).not.toMatch(/xox[a-z]-/);
      }
    }
  });

  describe('when no profile can be resolved', () => {
    it('fails with the login hint when nothing is configured, without calling Slack', async () => {
      const client = answering();
      await expect(
        checkIdentity(undefined, { env: '', lookup: async () => null, createClient: client.createClient }),
      ).rejects.toThrow('No workspace configured. Run "slackcli auth login" first.');
      expect(client.calls()).toBe(0);
    });

    it('fails for an unknown --workspace, without calling Slack', async () => {
      const client = answering();
      await expect(
        checkIdentity('nope', { env: '', lookup, createClient: client.createClient }),
      ).rejects.toThrow('Workspace not found: nope');
      expect(client.calls()).toBe(0);
    });

    it('names the variable for an unknown SLACKCLI_WORKSPACE value', async () => {
      await expect(
        checkIdentity(undefined, { env: 'nope', lookup, createClient: answering().createClient }),
      ).rejects.toThrow(`Workspace not found: nope (from ${WORKSPACE_ENV_VAR})`);
    });

    it.each(['T1', 'example'])('raises the ambiguity error for the selector %p', async (selector) => {
      const client = answering();
      const failure = await checkIdentity(selector, { env: '', lookup, createClient: client.createClient })
        .catch((err) => err);
      expect(failure).toBeInstanceOf(AmbiguousWorkspaceError);
      expect(failure.keys).toEqual(['acme', 'T1-2']);
      expect(client.calls()).toBe(0);
    });
  });

  describe('logging', () => {
    let records: LogRecord[];

    beforeEach(() => {
      records = [];
      configureLogging({ level: 'debug', verbose: false, sinks: { capture: (r) => records.push(r) } });
    });

    afterEach(() => {
      resetSync();
    });

    const outcomeRecord = () => records.find((r) => r.properties.status !== undefined)!;

    it('logs the outcome with IDs only', async () => {
      await checkIdentity('acme', { env: '', lookup, createClient: answering().createClient });
      expect(outcomeRecord().properties).toMatchObject({
        profile_key: 'acme',
        workspace_id: 'T1',
        auth_type: 'browser',
        source: 'flag',
        status: 'ok',
      });
      expect(JSON.stringify(records.map((r) => r.properties))).not.toContain('secret');
    });

    it('logs the Slack code of refused credentials, not the message', async () => {
      const refusal = new SlackAuthError('token_revoked', authErrorProfile(browser));
      await checkIdentity('acme', { env: '', lookup, createClient: failing(refusal).createClient });
      expect(outcomeRecord().properties).toMatchObject({ status: 'auth_failed', slack_error: 'token_revoked' });
    });

    it('logs the HTTP status of an unreachable Slack', async () => {
      const down = new SlackTransportError('Slack API error: HTTP error! status: 502', 502, undefined, false);
      await checkIdentity('acme', { env: '', lookup, createClient: failing(down).createClient });
      expect(outcomeRecord().properties).toMatchObject({ status: 'unreachable', http_status: 502 });
    });
  });
});

// The real wiring: config file -> profile key -> SlackClient -> one auth.test
// -> command output and exit code. A local server stands in for Slack as the
// stored workspace URL, so nothing leaves the machine. POSIX-only: Windows does
// not take its home from HOME.
describe.skipIf(process.platform === 'win32')('auth whoami through the CLI', () => {
  const root = resolve(import.meta.dir, '../..');
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let reply: Record<string, unknown>;
  let requests: Array<{ path: string; body: string }>;

  beforeEach(async () => {
    requests = [];
    reply = { ok: true, url: 'https://example.slack.com/', team: 'Example', user: 'alice', team_id: 'T1', user_id: 'U_LIVE' };
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        requests.push({ path: new URL(request.url).pathname, body: await request.text() });
        return Response.json(reply);
      },
    });

    home = await mkdtemp(join(tmpdir(), 'slackcli-whoami-'));
    const configDir = join(home, '.config', 'slackcli');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const record = (name: string) => ({
      workspace_id: 'T1',
      workspace_name: name,
      workspace_url: `http://127.0.0.1:${server.port}`,
      auth_type: 'browser',
      xoxd_token: 'xoxd-secretcookie',
      xoxc_token: 'xoxc-secrettoken',
      user_id: 'U_STORED',
    });
    await writeFile(
      join(configDir, 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T1',
        workspaces: { T1: record('example'), second: { ...record('example'), profile: 'second' } },
      }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  });

  // Asynchronous spawn: the stand-in server runs on this process's event loop.
  async function run(args: string[], workspaceEnv = '') {
    const child = Bun.spawn([process.execPath, 'run', join(root, 'src/index.ts'), 'auth', 'whoami', ...args], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        SLACKCLI_LOG_LEVEL: 'off',
        SLACKCLI_NO_UPDATE_NOTIFIER: '1',
        SLACKCLI_WORKSPACE: workspaceEnv,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  it('prints one JSON object for a verified identity and exits 0 after one auth.test call', async () => {
    const { code, stdout } = await run(['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      profile: 'T1',
      workspace_id: 'T1',
      workspace_name: 'example',
      auth_type: 'browser',
      source: 'default',
      status: 'ok',
      user: 'alice',
      user_id: 'U_LIVE',
    });
    expect(requests.map((r) => r.path)).toEqual(['/api/auth.test']);
  }, 30_000);

  it('reports the profile key and the env source for a SLACKCLI_WORKSPACE selection', async () => {
    const { code, stdout } = await run(['--json'], 'second');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ profile: 'second', source: 'env', status: 'ok' });
  }, 30_000);

  it('prints the human-readable identity and exits 0', async () => {
    const { code, stdout } = await run(['--workspace', 'second']);
    expect(code).toBe(0);
    expect(stdout).toContain('Profile: second');
    expect(stdout).toContain('User: alice (U_LIVE)');
    expect(stdout).toContain('Selected by: --workspace flag');
    expect(stdout).toContain('Status: verified');
  }, 30_000);

  it('exits 1 with the stored details and the fix when Slack refuses the credentials', async () => {
    reply = { ok: false, error: 'invalid_auth' };
    const json = await run(['--json']);
    expect(json.code).toBe(1);
    const identity = JSON.parse(json.stdout);
    expect(identity).toMatchObject({
      profile: 'T1',
      workspace_name: 'example',
      user_id: 'U_STORED',
      status: 'auth_failed',
      error: { code: 'invalid_auth' },
    });
    expect(identity.error.meaning).toContain('browser session');
    expect(identity.error.fix).toContain('slackcli auth login-auto');

    const human = await run([]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('Profile: T1');
    expect(human.stdout).toContain('User: U_STORED (stored at login)');
    expect(human.stdout).toContain('Status: authentication failed (invalid_auth)');
    expect(human.stderr).toContain('invalid_auth: The stored browser session is no longer valid.');
    expect(human.stderr).toContain('To fix: slackcli auth login-auto');
  }, 30_000);

  it('never prints a token, on stdout or stderr', async () => {
    for (const args of [['--json'], []]) {
      const { stdout, stderr } = await run(args);
      expect(stdout + stderr).not.toContain('secret');
      expect(stdout + stderr).not.toMatch(/xox[a-z]-/);
    }
  }, 30_000);

  it.each([
    [['--workspace', 'nope'], '', 'Workspace not found: nope'],
    [[], 'nope', 'Workspace not found: nope (from SLACKCLI_WORKSPACE)'],
    [['--workspace', 'example'], '', '"example" matches multiple profiles: T1, second'],
  ] as const)('exits 1 with a clear error and no Slack call for %j (env %p)', async (args, env, message) => {
    const { code, stdout, stderr } = await run([...args, '--json'], env);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(stdout).toBe('');
    expect(requests).toEqual([]);
  }, 30_000);

  it('exits 1 with the login hint when no workspace is configured', async () => {
    await writeFile(join(home, '.config', 'slackcli', 'workspaces.json'), JSON.stringify({ workspaces: {} }), { mode: 0o600 });
    const { code, stdout, stderr } = await run(['--json']);
    expect(code).toBe(1);
    expect(stderr).toContain('No workspace configured. Run "slackcli auth login" first.');
    expect(stdout).toBe('');
  }, 30_000);
});
