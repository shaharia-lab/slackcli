import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetSync, type LogRecord } from '@logtape/logtape';
import {
  authenticateAuto,
  AutoLoginError,
  effectiveWorkspaceSelector,
  selectWorkspace,
  WORKSPACE_ENV_VAR,
} from './auth';
import { AmbiguousWorkspaceError, resolveWorkspace } from './workspaces';
import type { WorkspaceConfig, WorkspacesData } from '../types/index';
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
