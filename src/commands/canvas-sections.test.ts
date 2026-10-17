// canvas sections (#431), in process. The client is a real SlackClient whose
// transport is replaced, so the auth guard, the parameters sent and the calls
// made are all checked at the one seam every Slack call goes through.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createCanvasCommand } from './canvas.ts';

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  profile: 'acme',
  auth_type: 'standard',
  token: 'xoxb-fake',
  token_type: 'bot',
};

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

type Call = { method: string; params: Record<string, any> };

const FOUND = { ok: true, sections: [{ id: 'temp:C:abc123' }, { id: 'temp:C:def456' }] };

let calls: Call[];
let answer: Record<string, unknown> | Error;
let stdout: string;
let stderr: string;
let getClient: ReturnType<typeof spyOn>;

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return client;
}

async function run(argv: string[], config: WorkspaceConfig = STANDARD): Promise<void> {
  getClient = spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(config));
  await createCanvasCommand().parseAsync(['sections', ...argv], { from: 'user' });
}

async function runJson(argv: string[]): Promise<any> {
  await run([...argv, '--json']);
  expect(process.exitCode ?? 0).toBe(0);
  return JSON.parse(stdout);
}

async function failJson(argv: string[], config: WorkspaceConfig = STANDARD): Promise<any> {
  await run([...argv, '--json'], config);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

describe('canvas sections (#431)', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    calls = [];
    answer = FOUND;
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

  it('prints the canvas ID, the count and the sections under --json', async () => {
    const out = await runJson(['F0123456789', '--type', 'h2', '--contains', 'Status']);

    expect(out).toEqual({
      canvas_id: 'F0123456789',
      section_count: 2,
      sections: [{ id: 'temp:C:abc123' }, { id: 'temp:C:def456' }],
    });
    expect(calls).toStrictEqual([{
      method: 'canvases.sections.lookup',
      params: { canvas_id: 'F0123456789', criteria: '{"section_types":["h2"],"contains_text":"Status"}' },
    }]);
  });

  it('takes a canvas URL', async () => {
    const out = await runJson(['https://acme.slack.com/docs/T0123456789/F0ABCDEF123', '--contains', 'Status']);

    expect(out.canvas_id).toBe('F0ABCDEF123');
    expect(calls.map((call) => call.params.canvas_id)).toEqual(['F0ABCDEF123']);
  });

  it('prints one section ID per line without --json', async () => {
    await run(['F0123456789', '--type', 'any_header']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toBe('temp:C:abc123\ntemp:C:def456\n');
  });

  it('prints nothing on stdout when nothing matches, and an empty list under --json', async () => {
    answer = { ok: true, sections: [] };
    await run(['F0123456789', '--contains', 'nope']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('No matching sections');

    stdout = '';
    expect(await runJson(['F0123456789', '--contains', 'nope']))
      .toEqual({ canvas_id: 'F0123456789', section_count: 0, sections: [] });
  });

  it('applies --fields to the sections and keeps the envelope', async () => {
    const out = await runJson(['F0123456789', '--type', 'h1', '--fields', 'id']);

    expect(out).toEqual({
      canvas_id: 'F0123456789',
      section_count: 2,
      sections: [{ id: 'temp:C:abc123' }, { id: 'temp:C:def456' }],
    });
  });

  it('needs --type or --contains, and fails before any Slack call', async () => {
    const error = await failJson(['F0123456789']);

    expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(error.message).toContain('Give --type, --contains or both');
    expect(getClient).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('refuses an unknown --type before any Slack call', async () => {
    const error = await failJson(['F0123456789', '--type', 'h1,h4']);

    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error.message).toContain('Unknown section type "h4"');
    expect(calls).toEqual([]);
  });

  it('refuses a blank --contains before any Slack call', async () => {
    const error = await failJson(['F0123456789', '--contains', '  ']);

    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it('refuses an argument that is not a canvas ID or URL', async () => {
    const error = await failJson(['C0123456789', '--type', 'h1']);

    expect(error.code).toBe('invalid_input');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('refuses browser session tokens with unsupported_auth_type and makes no request', async () => {
    const error = await failJson(['F0123456789', '--type', 'h1'], BROWSER);

    expect(error).toMatchObject({ code: 'unsupported_auth_type', retryable: false });
    expect(error.message).toContain('standard Slack app token (xoxb or xoxp)');
    expect(calls).toEqual([]);
  });

  it('reports a Slack refusal with its code', async () => {
    answer = Object.assign(new Error('Slack API error: canvas_not_found'), {
      slackData: { ok: false, error: 'canvas_not_found' },
    });
    const error = await failJson(['F0123456789', '--type', 'h1']);

    expect(error).toMatchObject({ code: 'not_found', slack_error: 'canvas_not_found', retryable: false });
  });

  it('says what failed in text mode', async () => {
    await run(['F0123456789']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Give --type, --contains or both');
  });
});
