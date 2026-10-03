import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SlackAuthError, type AuthErrorProfile } from './auth-errors.ts';
import {
  CliError,
  ConfirmationRequiredError,
  InvalidInputError,
  NotFoundError,
  UnsupportedAuthTypeError,
} from './cli-errors.ts';
import {
  ERROR_CODES,
  classifyError,
  failCommand,
  isJsonErrorMode,
  renderJsonError,
  setJsonErrorMode,
} from './command-errors.ts';
import { SlackClient, SlackTransportError } from './slack-client.ts';
import { findActiveDraft, parseDraftLimit, validateSendableDraft } from './drafts.ts';
import { filterNewerThan } from './poll.ts';
import { SlackUrlParseError } from './slack-url-parser.ts';
import type { WorkspaceConfig } from '../types/index.ts';

// Short fake tokens only: realistic ones are rejected by push protection.
const token = (prefix: string, ...parts: string[]) => [prefix, ...parts].join('-');

// An error as either transport throws it for an ok:false answer: the message
// carries Slack's code, and `slackData` the whole payload.
function slackError(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

const browserProfile: AuthErrorProfile = {
  profileKey: 'acme',
  workspaceName: 'Acme Corp',
  authType: 'browser',
  workspaceUrl: 'https://acme.slack.com',
};

describe('classifyError', () => {
  it('reports a refused credential as auth_failed, with the fix as the hint', () => {
    const err = new SlackAuthError('invalid_auth', browserProfile, { ok: false, error: 'invalid_auth' });
    expect(classifyError(err)).toEqual({
      code: 'auth_failed',
      message: 'Authentication failed for profile "acme" (Acme Corp, browser auth): invalid_auth',
      hint: 'slackcli auth login-auto --workspace-url https://acme.slack.com',
      retryable: false,
      slack_error: 'invalid_auth',
    });
  });

  it.each([
    ['channel_not_found', 'not_found'],
    ['user_not_found', 'not_found'],
    ['message_not_found', 'not_found'],
    ['no_such_subteam', 'not_found'],
    ['missing_scope', 'permission_denied'],
    ['not_in_channel', 'permission_denied'],
    ['restricted_action', 'permission_denied'],
    ['enterprise_is_restricted', 'permission_denied'],
    ['ratelimited', 'rate_limited'],
    ['invalid_ts', 'invalid_input'],
    ['invalid_blocks', 'invalid_input'],
    ['not_allowed_token_type', 'unsupported_auth_type'],
    ['service_unavailable', 'network'],
    ['some_future_code', 'unknown'],
  ])('maps Slack code %p to %p and keeps it verbatim', (code, expected) => {
    const result = classifyError(slackError(code));
    expect(result.code as string).toBe(expected);
    expect(result.slack_error).toBe(code);
    expect(result.message).toBe(`Slack API error: ${code}`);
  });

  it('does not read a Slack code from a slackData without one (conversations.leave not_in_channel shape)', () => {
    const err = Object.assign(new Error('Slack API error: Unknown API error'), { slackData: { ok: false, not_in_channel: true } });
    expect(classifyError(err)).toEqual({ code: 'unknown', message: 'Slack API error: Unknown API error', retryable: false });
  });

  it.each([
    ['a 429', new SlackTransportError('Slack API error: HTTP error! status: 429', 429, 3000, false), 'rate_limited', true],
    ['no response', new SlackTransportError('Slack API error: fetch failed', undefined, undefined, true), 'network', true],
    ['a 503', new SlackTransportError('Slack API error: HTTP error! status: 503', 503, undefined, false), 'network', true],
    ['a 404', new SlackTransportError('Slack API error: HTTP error! status: 404', 404, undefined, false), 'unknown', false],
  ])('classifies a transport failure with %s', (_label, err, code, retryable) => {
    const result = classifyError(err);
    expect(result.code as string).toBe(code);
    expect(result.retryable).toBe(retryable as boolean);
    expect(result.slack_error).toBeUndefined();
  });

  it.each([
    [new InvalidInputError('--limit must be a positive integer'), 'invalid_input'],
    [new NotFoundError('Message not found'), 'not_found'],
    [new UnsupportedAuthTypeError('Draft creation requires browser authentication'), 'unsupported_auth_type'],
    [new ConfirmationRequiredError('Refusing to run this write unattended.', 'Re-run with --yes to confirm the write.'), 'confirmation_required'],
    [new CliError('auth_failed', 'No workspace configured.'), 'auth_failed'],
    [new SlackUrlParseError('Not a Slack message link'), 'invalid_input'],
  ])('classifies the CLI-raised %p by type, not by message', (err, code) => {
    const result = classifyError(err);
    expect(result.code as string).toBe(code);
    expect(result.message).toBe(err.message);
    expect(result.retryable).toBe(false);
  });

  it('carries a CLI error hint, and its jsonMessage in place of a message that quotes input', () => {
    const err = new InvalidInputError('Invalid blocks JSON: Unexpected identifier "secret plan"', 'see --help', 'Invalid blocks JSON.');
    expect(classifyError(err)).toEqual({
      code: 'invalid_input',
      message: 'Invalid blocks JSON.',
      hint: 'see --help',
      retryable: false,
    });
  });

  it.each([
    ['a string', 'plain reason', 'plain reason'],
    ['undefined', undefined, 'Unknown error'],
    ['null', null, 'Unknown error'],
    ['a number', 42, '42'],
    ['a plain object', { reason: 'x' }, 'Unknown error'],
    ['a plain Error', new Error('boom'), 'boom'],
  ])('reports %s as unknown', (_label, value, message) => {
    expect(classifyError(value)).toEqual({ code: 'unknown', message, retryable: false });
  });

  it('is retryable only for rate_limited and network', () => {
    const retryable = ERROR_CODES.filter((code) => classifyError(new CliError(code, 'x')).retryable);
    expect(retryable).toEqual(['rate_limited', 'network']);
  });

  it('redacts Slack credentials from the message and the hint', () => {
    const xoxc = token('xoxc', '1234567890', 'abcdefghijkl');
    const xoxd = token('xoxd', 'abc%2Fdef', 'ghi');
    const err = new CliError('unknown', `bad config near ${xoxc}`, `cookie d=${xoxd}`);
    const result = classifyError(err);
    expect(result.message).toBe('bad config near xox?-[REDACTED]');
    expect(result.hint).toBe('cookie d=[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('abcdefghijkl');
  });
});

// Failures the CLI detects inside lib modules: each is thrown as a typed error,
// so a --json run reports a specific code rather than `unknown`.
describe('classifyError on CLI-raised lib failures', () => {
  async function codeOf(run: () => unknown): Promise<string> {
    try {
      await run();
    } catch (err) {
      return classifyError(err).code;
    }
    throw new Error('expected a failure');
  }

  const draft = (overrides: Record<string, unknown> = {}) => ({
    id: 'Dr0123456789',
    destinations: [{ channel_id: 'C0123456789' }],
    blocks: [{ type: 'rich_text', elements: [] }],
    ...overrides,
  }) as any;

  it.each([
    ['a draft --limit of 0', () => parseDraftLimit('0'), 'invalid_input'],
    ['a draft ID that is not active', () => findActiveDraft({ ok: true, drafts: [] } as any, 'Dr0123456789'), 'not_found'],
    ['a scheduled draft', () => validateSendableDraft(draft({ date_scheduled: 1 })), 'invalid_input'],
    ['a draft with attachments', () => validateSendableDraft(draft({ file_ids: ['F0123456789'] })), 'invalid_input'],
    ['a malformed --oldest', () => filterNewerThan([{ ts: '1712345678.000100' } as any], 'yesterday'), 'invalid_input'],
  ])('reports %s as %p', async (_label, run, code) => {
    expect(await codeOf(run)).toBe(code);
  });

  it('reports a --file that does not exist as invalid_input, on either auth type', async () => {
    const missing = join(tmpdir(), 'slackcli-no-such-file-326.txt');
    for (const config of [
      { workspace_id: 'T1', workspace_name: 'x', auth_type: 'standard', token_type: 'bot', token: token('xoxb', 'fake') },
      { workspace_id: 'T1', workspace_name: 'x', auth_type: 'browser', workspace_url: 'https://acme.slack.com', xoxd_token: token('xoxd', 'f'), xoxc_token: token('xoxc', 'f') },
    ]) {
      const client = new SlackClient(config as WorkspaceConfig);
      expect(await codeOf(() => client.uploadFileExternal('C0123456789', missing))).toBe('invalid_input');
    }
  });
});

describe('renderJsonError', () => {
  it('writes one line that parses on its own', () => {
    const line = renderJsonError(classifyError(new NotFoundError('Message "x"\nnot found')));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      error: { code: 'not_found', message: 'Message "x"\nnot found', retryable: false },
    });
  });
});

describe('failCommand', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  function fakeSpinner() {
    return { fail: mock((_text?: string) => {}), stop: mock(() => {}) };
  }

  it('in JSON mode stops the spinner silently and writes only the error object to stderr', () => {
    const spinner = fakeSpinner();
    failCommand(slackError('channel_not_found'), {
      json: true,
      spinner: spinner as any,
      context: 'Failed to send message',
      hint: 'Run "slackcli auth list" to check your authentication.',
    });
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.fail).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(stderr).not.toContain('Failed to send message');
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: 'not_found',
        message: 'Slack API error: channel_not_found',
        hint: 'Run "slackcli auth list" to check your authentication.',
        retryable: false,
        slack_error: 'channel_not_found',
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('in JSON mode prefers the error\'s own hint, and applies a message override', () => {
    failCommand(new CliError('auth_failed', 'original', 'own hint'), { json: true, hint: 'fallback', message: 'replaced' });
    expect(JSON.parse(stderr).error).toEqual({ code: 'auth_failed', message: 'replaced', hint: 'own hint', retryable: false });
  });

  it('in JSON mode keeps the documented field order when the hint comes from the call site', () => {
    failCommand(slackError('channel_not_found'), { json: true, hint: 'fallback' });
    expect(Object.keys(JSON.parse(stderr).error)).toEqual(['code', 'message', 'hint', 'retryable', 'slack_error']);
  });

  it('in text mode fails the spinner with the context, then prints the message and hint', () => {
    const spinner = fakeSpinner();
    failCommand(slackError('channel_not_found'), { spinner: spinner as any, context: 'Failed to send message', hint: 'a hint' });
    expect(spinner.fail).toHaveBeenCalledWith('Failed to send message');
    expect(spinner.stop).not.toHaveBeenCalled();
    expect(stderr).toContain('Error: Slack API error: channel_not_found');
    expect(stderr).toContain('a hint');
    expect(stderr).not.toContain('{"error"');
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(1);
  });

  it('in text mode with a spinner and no context, fails the spinner with the message alone', () => {
    const spinner = fakeSpinner();
    failCommand(new NotFoundError('Message not found'), { json: false, spinner: spinner as any });
    expect(spinner.fail).toHaveBeenCalledWith('Message not found');
    expect(stderr).toBe('');
  });

  it('in text mode without a spinner prints the error line only, never the error\'s own hint', () => {
    failCommand(new ConfirmationRequiredError('Refusing to run this write unattended.', 'Re-run with --yes.'));
    expect(stderr).toContain('Error: Refusing to run this write unattended.');
    expect(stderr).not.toContain('Re-run with --yes.');
    expect(process.exitCode).toBe(1);
  });

  it('prints the full three-line authentication message in text mode', () => {
    failCommand(new SlackAuthError('invalid_auth', browserProfile), { context: 'x' });
    expect(stderr).toContain('Authentication failed for profile "acme"');
    expect(stderr).toContain('To fix: slackcli auth login-auto --workspace-url https://acme.slack.com');
  });
});

describe('JSON error mode', () => {
  afterEach(() => setJsonErrorMode(false));

  it('is off until a command with --json sets it', () => {
    expect(isJsonErrorMode()).toBe(false);
    setJsonErrorMode(true);
    expect(isJsonErrorMode()).toBe(true);
  });
});

// The browser transport against a local stand-in: the errors it throws classify
// the same way as the hand-built ones above.
describe('classifyError on real browser-transport failures', () => {
  let server: ReturnType<typeof Bun.serve>;
  let reply: () => Response;

  beforeEach(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => reply() });
  });

  afterEach(async () => {
    await server.stop(true);
  });

  function client(url = `http://127.0.0.1:${server.port}`): SlackClient {
    const config: WorkspaceConfig = {
      workspace_id: 'T1',
      workspace_name: 'Acme Corp',
      workspace_url: url,
      auth_type: 'browser',
      xoxd_token: token('xoxd', 'fake'),
      xoxc_token: token('xoxc', 'fake'),
    } as WorkspaceConfig;
    return new SlackClient(config, { retry: { maxRetries: 0 } });
  }

  async function failure(call: Promise<unknown>): Promise<unknown> {
    try {
      await call;
    } catch (err) {
      return err;
    }
    throw new Error('expected the call to fail');
  }

  it('reports an ok:false answer with Slack\'s code', async () => {
    reply = () => Response.json({ ok: false, error: 'channel_not_found' });
    const err = await failure(client().getConversationHistory('C0123456789'));
    expect(classifyError(err)).toMatchObject({ code: 'not_found', slack_error: 'channel_not_found', retryable: false });
  });

  it('reports a refused session as auth_failed', async () => {
    reply = () => Response.json({ ok: false, error: 'invalid_auth' });
    const err = await failure(client().testAuth());
    expect(classifyError(err)).toMatchObject({ code: 'auth_failed', slack_error: 'invalid_auth', retryable: false });
  });

  it('reports an HTTP 429 as rate_limited and retryable', async () => {
    reply = () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    const err = await failure(client().testAuth());
    expect(classifyError(err)).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('reports a connection that never answered as network and retryable', async () => {
    const port = server.port;
    await server.stop(true);
    const err = await failure(client(`http://127.0.0.1:${port}`).testAuth());
    expect(classifyError(err)).toMatchObject({ code: 'network', retryable: true });
    // Restart so afterEach has a server to stop.
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => reply() });
  });
});

// A failing command end to end: real CLI, temp HOME, a stand-in for Slack.
describe.skipIf(process.platform === 'win32')('a failing command through the CLI', () => {
  const root = resolve(import.meta.dir, '../..');
  let home: string;
  let server: ReturnType<typeof Bun.serve>;

  let slackCode: string;

  beforeEach(async () => {
    slackCode = 'channel_not_found';
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: false, error: slackCode }),
    });
    home = await mkdtemp(join(tmpdir(), 'slackcli-errors-'));
    const configDir = join(home, '.config', 'slackcli');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T1',
        workspaces: {
          T1: {
            workspace_id: 'T1',
            workspace_name: 'example',
            workspace_url: `http://127.0.0.1:${server.port}`,
            auth_type: 'browser',
            xoxd_token: token('xoxd', 'fakecookie'),
            xoxc_token: token('xoxc', 'faketoken'),
          },
        },
      }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  });

  // Asynchronous spawn: the stand-in server runs on this process's event loop.
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, 'run', join(root, 'src/index.ts'), ...args], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home, SLACKCLI_LOG_LEVEL: 'off', SLACKCLI_NO_UPDATE_NOTIFIER: '1', SLACKCLI_WORKSPACE: '' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  function lastLine(text: string): string {
    const lines = text.trimEnd().split('\n');
    return lines[lines.length - 1];
  }

  it('writes the error object as the last line of stderr, nothing on stdout, and exits 1', async () => {
    const { code, stdout, stderr } = await run(['conversations', 'read', 'C0123456789', '--json']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).not.toContain('Failed to fetch messages');
    expect(JSON.parse(lastLine(stderr))).toEqual({
      error: {
        code: 'not_found',
        message: 'Slack API error: channel_not_found',
        retryable: false,
        slack_error: 'channel_not_found',
      },
    });
    expect(stderr).not.toContain('fakecookie');
    expect(stderr).not.toContain('faketoken');
  }, 30_000);

  // One command per group that calls Slack: each reports Slack's refusal the same way.
  it.each([
    [['auth', 'whoami']],
    [['canvas', 'list']],
    [['canvas', 'read', 'F0123456789']],
    [['conversations', 'list']],
    [['emoji', 'list']],
    [['files', 'info', 'F0123456789']],
    [['messages', 'send', '--recipient-id', 'C0123456789', '--message', 'hi']],
    [['saved', 'list']],
    [['search', 'channels', 'deploy']],
    [['team', 'info']],
    [['usergroups', 'list']],
    [['users', 'info', 'U0123456789']],
  ])('reports a Slack refusal from %j as permission_denied', async (args) => {
    slackCode = 'missing_scope';
    const { code, stdout, stderr } = await run([...args, '--json']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    // toMatchObject: some commands add their own hint.
    expect(JSON.parse(lastLine(stderr)).error).toMatchObject({
      code: 'permission_denied',
      message: 'Slack API error: missing_scope',
      retryable: false,
      slack_error: 'missing_scope',
    });
  }, 30_000);

  it('keeps the text output without --json', async () => {
    const { code, stdout, stderr } = await run(['conversations', 'read', 'C0123456789']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Failed to fetch messages');
    expect(stderr).toContain('Error: Slack API error: channel_not_found');
    expect(stderr).not.toContain('{"error"');
  }, 30_000);

  it('reports a non-TTY write without --yes as confirmation_required', async () => {
    const { code, stdout, stderr } = await run(['conversations', 'leave', 'C0123456789', '--json']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(lastLine(stderr))).toEqual({
      error: {
        code: 'confirmation_required',
        message:
          'Refusing to run this write unattended. stdin is not a terminal, so there is no way to confirm ' +
          'interactively. Re-run with --yes to proceed non-interactively.',
        hint: 'Re-run with --yes to confirm the write.',
        retryable: false,
      },
    });
  }, 30_000);

  it('reports invalid input caught before any Slack call', async () => {
    const { code, stdout, stderr } = await run(['users', 'list', '--limit', '0', '--json']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(lastLine(stderr)).error).toEqual({
      code: 'invalid_input',
      message: '--limit must be a positive integer',
      retryable: false,
    });
  }, 30_000);

  it('reports an error no command caught (a bad link outside the try) as JSON too', async () => {
    const { code, stdout, stderr } = await run([
      'conversations', 'leave', 'https://acme.slack.com/not-a-message-link', '--json', '--yes',
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(lastLine(stderr)).error).toMatchObject({ code: 'invalid_input', retryable: false });
  }, 30_000);

  it('reports a browser-only command on an app token as unsupported_auth_type', async () => {
    await writeFile(
      join(home, '.config', 'slackcli', 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T1',
        workspaces: {
          T1: { workspace_id: 'T1', workspace_name: 'example', auth_type: 'standard', token_type: 'bot', token: token('xoxb', 'fake') },
        },
      }),
      { mode: 0o600 },
    );
    const { code, stdout, stderr } = await run(['messages', 'list-drafts', '--json']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(lastLine(stderr)).error).toEqual({
      code: 'unsupported_auth_type',
      message: 'Draft listing requires browser authentication',
      retryable: false,
    });
  }, 30_000);
});
