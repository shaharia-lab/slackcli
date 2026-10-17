// canvas create and canvas edit (#431), in process. The client is a real
// SlackClient whose transport is replaced, so the auth guard, the parameters
// sent and the calls made are all checked at the one seam every Slack call
// goes through. stdin is not a terminal, as when an agent runs it.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const WRITES = ['canvases.create', 'canvases.edit'];
const SECTION = 'temp:C:abc123';

type Call = { method: string; params: Record<string, any> };
type Answer = Record<string, unknown> | Error;

let calls: Call[];
let answers: Record<string, Answer>;
let stdout: string;
let stderr: string;
let dir: string;
let markdownPath: string;

function clientFor(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    if (!(method in answers)) throw new Error(`unexpected Slack call ${method}`);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return client;
}

async function run(argv: string[], config: WorkspaceConfig = STANDARD): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor(config));
  await createCanvasCommand().parseAsync(argv, { from: 'user' });
}

async function runJson(argv: string[], config: WorkspaceConfig = STANDARD): Promise<any> {
  await run([...argv, '--json'], config);
  expect({ exitCode: process.exitCode ?? 0, stderr: stderr.includes('"error"') ? stderr : '' })
    .toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout);
}

async function failJson(argv: string[], config: WorkspaceConfig = STANDARD): Promise<any> {
  await run([...argv, '--json'], config);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe('');
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]).error;
}

const madeWrite = () => calls.some((call) => WRITES.includes(call.method));
const sentChange = () => JSON.parse(calls.find((call) => call.method === 'canvases.edit')!.params.changes);

describe('canvas create and edit (#431)', () => {
  const realIsTTY = process.stdin.isTTY;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    calls = [];
    answers = {
      'canvases.create': { ok: true, canvas_id: 'F0NEWCANVAS' },
      'canvases.edit': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C0123456789', name: 'deploys' }] },
    };
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    dir = await mkdtemp(join(tmpdir(), 'slackcli-canvas-write-'));
    markdownPath = join(dir, 'notes.md');
    await writeFile(markdownPath, '# Status\n\nAll green.\n');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
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

  afterEach(async () => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  describe('canvas create', () => {
    it('creates a canvas from a Markdown file and prints its ID', async () => {
      const out = await runJson(['create', '--title', 'Status', '--markdown-file', markdownPath]);

      expect(out).toEqual({ canvas_id: 'F0NEWCANVAS', title: 'Status' });
      expect(calls).toStrictEqual([{
        method: 'canvases.create',
        params: { title: 'Status', document_content: JSON.stringify({ type: 'markdown', markdown: '# Status\n\nAll green.\n' }) },
      }]);
    });

    it('adds it to a channel named by #name', async () => {
      const out = await runJson(['create', '--title', 'Status', '--channel', '#deploys']);

      expect(out).toEqual({ canvas_id: 'F0NEWCANVAS', title: 'Status', channel_id: 'C0123456789' });
      expect(calls.map((call) => call.method)).toEqual(['conversations.list', 'canvases.create']);
      expect(calls[1].params).toStrictEqual({ title: 'Status', channel_id: 'C0123456789' });
    });

    it('takes Markdown alone, with no title', async () => {
      const out = await runJson(['create', '--markdown-file', markdownPath]);

      expect(out).toEqual({ canvas_id: 'F0NEWCANVAS' });
      expect(Object.keys(calls[0].params)).toEqual(['document_content']);
    });

    it('says what it created in text mode', async () => {
      await run(['create', '--title', 'Status']);

      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('Created canvas F0NEWCANVAS');
    });

    it.each([
      [['create'], 'Give --title, --markdown-file or both'],
      [['create', '--title', '  '], '--title needs some text'],
      [['create', '--title', 'T', '--markdown-file', '/nonexistent/slackcli-canvas.md'], 'Cannot read Markdown file'],
      [['create', '--title', 'T', '--channel', 'https://acme.slack.com/team/U0123456789'], '--channel'],
    ])('%j fails with invalid_input before any Slack call', async (argv, message) => {
      const error = await failJson(argv);

      expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
      expect(error.message).toContain(message);
      expect(calls).toEqual([]);
    });

    it('refuses an empty Markdown file', async () => {
      await writeFile(markdownPath, '\n\n');
      const error = await failJson(['create', '--markdown-file', markdownPath]);

      expect(error.message).toContain('is empty');
      expect(calls).toEqual([]);
    });

    it('refuses browser session tokens before any Slack call, a channel lookup included', async () => {
      const error = await failJson(['create', '--title', 'Status', '--channel', '#deploys'], BROWSER);

      expect(error).toMatchObject({ code: 'unsupported_auth_type' });
      expect(calls).toEqual([]);
    });

    it('warns when a --channel link names another workspace than the profile', async () => {
      const other: WorkspaceConfig = { ...BROWSER, workspace_url: 'https://other.slack.com' };
      const error = await failJson(['create', '--title', 'T', '--channel', 'https://acme.slack.com/archives/C0123456789'], other);

      expect(stderr).toContain('This link belongs to the "acme" workspace but you are authenticated against "other"');
      expect(error.code).toBe('unsupported_auth_type');
      expect(calls).toEqual([]);
    });

    it('does not warn when the links match the profile workspace', async () => {
      await failJson(['create', '--title', 'T', '--channel', 'https://acme.slack.com/archives/C0123456789'], BROWSER);
      await failJson(['edit', 'https://acme.slack.com/docs/T0123456789/F0ABCDEF123', '--operation', 'rename', '--title', 'T'], BROWSER);

      expect(stderr).not.toContain('This link belongs to');
    });

    it('reports a free-team refusal as permission_denied', async () => {
      answers['canvases.create'] = Object.assign(new Error('Slack API error: free_teams_cannot_create_standalone_canvases'), {
        slackData: { ok: false, error: 'free_teams_cannot_create_standalone_canvases' },
      });
      const error = await failJson(['create', '--title', 'Status']);

      expect(error).toMatchObject({ code: 'permission_denied', slack_error: 'free_teams_cannot_create_standalone_canvases' });
    });

    it('previews with --dry-run, reads only, and shows what would be sent', async () => {
      const preview = await runJson(['create', '--title', 'Status', '--channel', '#deploys', '--markdown-file', markdownPath, '--dry-run']);

      expect(preview).toMatchObject({
        dry_run: true,
        action: 'create canvas',
        target: { kind: 'canvas', name: 'Status' },
        payload: { title: 'Status', channel_id: 'C0123456789', markdown: '# Status\n\nAll green.\n' },
      });
      expect(madeWrite()).toBe(false);
    });
  });

  describe('canvas edit', () => {
    it('inserts at the end without asking', async () => {
      const out = await runJson(['edit', 'F0123456789', '--operation', 'insert_at_end', '--markdown-file', markdownPath]);

      expect(out).toEqual({ canvas_id: 'F0123456789', operation: 'insert_at_end' });
      expect(calls.map((call) => call.params.canvas_id)).toEqual(['F0123456789']);
      expect(sentChange()).toStrictEqual([
        { operation: 'insert_at_end', document_content: { type: 'markdown', markdown: '# Status\n\nAll green.\n' } },
      ]);
      expect(stderr).not.toContain('[y/N]');
    });

    it('inserts after a section of a canvas given by URL', async () => {
      const out = await runJson([
        'edit', 'https://acme.slack.com/docs/T0123456789/F0ABCDEF123',
        '--operation', 'insert_after', '--section', SECTION, '--markdown-file', markdownPath,
      ]);

      expect(out).toEqual({ canvas_id: 'F0ABCDEF123', operation: 'insert_after', section_id: SECTION });
      expect(sentChange()[0]).toMatchObject({ operation: 'insert_after', section_id: SECTION });
    });

    it('renames without asking', async () => {
      await runJson(['edit', 'F0123456789', '--operation', 'rename', '--title', 'Q3 plan']);

      expect(sentChange()).toStrictEqual([{ operation: 'rename', title_content: { type: 'markdown', markdown: 'Q3 plan' } }]);
    });

    it.each([
      [['--operation', 'replace', '--section', SECTION, '--markdown-file', 'MD']],
      [['--operation', 'replace', '--markdown-file', 'MD']],
      [['--operation', 'delete', '--section', SECTION]],
    ])('refuses %j unattended without --yes and changes nothing', async (args) => {
      const error = await failJson(['edit', 'F0123456789', ...args.map((arg) => (arg === 'MD' ? markdownPath : arg))]);

      expect(error.code).toBe('confirmation_required');
      expect(madeWrite()).toBe(false);
    });

    it('says the canvas was not changed in text mode', async () => {
      await run(['edit', 'F0123456789', '--operation', 'delete', '--section', SECTION]);

      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('Canvas F0123456789 was not changed');
      expect(madeWrite()).toBe(false);
    });

    it('replaces the whole canvas with --yes', async () => {
      await run(['edit', 'F0123456789', '--operation', 'replace', '--markdown-file', markdownPath, '--yes']);

      expect(process.exitCode ?? 0).toBe(0);
      expect(stderr).toContain('Replaced the content of canvas F0123456789');
      expect(sentChange()[0]).not.toHaveProperty('section_id');
    });

    it('deletes a section with --yes', async () => {
      const out = await runJson(['edit', 'F0123456789', '--operation', 'delete', '--section', SECTION, '--yes']);

      expect(out).toEqual({ canvas_id: 'F0123456789', operation: 'delete', section_id: SECTION });
      expect(sentChange()).toStrictEqual([{ operation: 'delete', section_id: SECTION }]);
      expect(stderr).toContain(`Deleted section ${SECTION} from canvas F0123456789`);
    });

    it.each([
      [['--operation', 'insert_after', '--section', SECTION, '--markdown-file', 'MD'], `Applied insert_after to section ${SECTION} of canvas F0123456789`],
      [['--operation', 'insert_at_start', '--markdown-file', 'MD'], 'Applied insert_at_start to canvas F0123456789'],
      [['--operation', 'replace', '--section', SECTION, '--markdown-file', 'MD', '--yes'], `Applied replace to section ${SECTION} of canvas F0123456789`],
      [['--operation', 'rename', '--title', 'New'], 'Renamed canvas F0123456789'],
    ])('reports %j', async (args, line) => {
      await run(['edit', 'F0123456789', ...args.map((arg) => (arg === 'MD' ? markdownPath : arg))]);

      expect(process.exitCode ?? 0).toBe(0);
      expect(stderr).toContain(line);
    });

    it.each([
      [[], 'Give --operation'],
      [['--operation', 'append'], 'Unknown --operation "append"'],
      [['--operation', 'delete'], '--operation delete needs --section'],
      [['--operation', 'insert_at_end'], '--operation insert_at_end needs --markdown-file'],
      [['--operation', 'rename', '--title', 'T', '--section', SECTION], 'does not take --section'],
      [['--operation', 'replace', '--markdown-file', '/nonexistent/slackcli-canvas.md', '--yes'], 'Cannot read Markdown file'],
    ])('%j fails with invalid_input before any Slack call', async (args, message) => {
      const error = await failJson(['edit', 'F0123456789', ...args]);

      expect(error).toMatchObject({ code: 'invalid_input' });
      expect(error.message).toContain(message);
      expect(calls).toEqual([]);
    });

    it('refuses an argument that is not a canvas ID or URL', async () => {
      const error = await failJson(['edit', 'C0123456789', '--operation', 'rename', '--title', 'T']);

      expect(error.code).toBe('invalid_input');
      expect(calls).toEqual([]);
    });

    it('refuses browser session tokens before any Slack call', async () => {
      const error = await failJson(['edit', 'F0123456789', '--operation', 'delete', '--section', SECTION, '--yes'], BROWSER);

      expect(error).toMatchObject({ code: 'unsupported_auth_type' });
      expect(calls).toEqual([]);
    });

    it('warns when a canvas link names another workspace than the profile', async () => {
      // Only a browser profile stores its workspace URL, so only there can a
      // mismatch be seen; the auth refusal still follows, with no Slack call.
      const other: WorkspaceConfig = { ...BROWSER, workspace_url: 'https://other.slack.com' };
      const error = await failJson(
        ['edit', 'https://acme.slack.com/docs/T0123456789/F0ABCDEF123', '--operation', 'rename', '--title', 'T'],
        other,
      );

      expect(stderr).toContain('This link belongs to the "acme" workspace but you are authenticated against "other"');
      expect(error.code).toBe('unsupported_auth_type');
      expect(calls).toEqual([]);
    });

    it('reports Slack refusing the Markdown as invalid_input', async () => {
      answers['canvases.edit'] = Object.assign(new Error('Slack API error: canvas_editing_failed'), {
        slackData: { ok: false, error: 'canvas_editing_failed' },
      });
      const error = await failJson(['edit', 'F0123456789', '--operation', 'insert_at_end', '--markdown-file', markdownPath]);

      expect(error).toMatchObject({ code: 'invalid_input', slack_error: 'canvas_editing_failed' });
    });

    it('previews a delete with --dry-run, without asking and without writing', async () => {
      const preview = await runJson(['edit', 'F0123456789', '--operation', 'delete', '--section', SECTION, '--dry-run']);

      expect(preview).toMatchObject({
        dry_run: true,
        action: 'edit canvas',
        target: { kind: 'canvas', id: 'F0123456789' },
        payload: { operation: 'delete', section_id: SECTION },
      });
      expect(calls).toEqual([]);
      expect(stderr).not.toContain('[y/N]');
    });

    it('previews a replace as text', async () => {
      await run(['edit', 'F0123456789', '--operation', 'replace', '--section', SECTION, '--markdown-file', markdownPath, '--dry-run']);

      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout).toContain('Dry run: nothing was sent.');
      expect(stdout).toContain('edit canvas');
      expect(stdout).toContain('Markdown:');
      expect(madeWrite()).toBe(false);
    });
  });
});
