// `--message-file -` through the real CLI (#329): the text is piped into a
// child process, and a local server standing in for Slack (the stored
// workspace URL) records what each command sends. POSIX-only: Windows does not
// take its home from HOME.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_STDIN_BYTES } from '../lib/message-input.ts';

const root = resolve(import.meta.dir, '../..');
const entry = join(root, 'src/index.ts');

// Quotes, backticks, $, a backslash and inner blank lines: everything a shell
// would mangle in --message "...".
const TEXT = 'Build `main` failed:\n  "tests" step, see $LOG\n\nit\'s \\ $(not) run';

function childEnv(home: string) {
  return {
    ...process.env,
    HOME: home,
    SLACKCLI_LOG_LEVEL: 'off',
    SLACKCLI_NO_UPDATE_NOTIFIER: '1',
    SLACKCLI_WORKSPACE: '',
    NO_COLOR: '1',
  };
}

describe.skipIf(process.platform === 'win32')('--message-file - through the CLI', () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let calls: Array<{ method: string; params: URLSearchParams }>;

  beforeEach(async () => {
    calls = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const method = new URL(request.url).pathname.replace('/api/', '');
        calls.push({ method, params: new URLSearchParams(await request.text()) });
        switch (method) {
          case 'chat.postMessage':
          case 'chat.update':
            return Response.json({ ok: true, channel: 'C0123456789', ts: '1712345678.123456' });
          case 'chat.getPermalink':
            return Response.json({ ok: true, permalink: 'https://acme.slack.com/archives/C0123456789/p1712345678123456' });
          case 'drafts.create':
            return Response.json({ ok: true, draft: { id: 'Dr0123456789' } });
          default:
            return Response.json({ ok: false, error: 'unknown_method' });
        }
      },
    });

    home = await mkdtemp(join(tmpdir(), 'slackcli-stdin-'));
    const configDir = join(home, '.config', 'slackcli');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T1',
        workspaces: {
          T1: {
            workspace_id: 'T1',
            workspace_name: 'acme',
            workspace_url: `http://127.0.0.1:${server.port}`,
            auth_type: 'browser',
            xoxd_token: 'xoxd-fake',
            xoxc_token: 'xoxc-fake',
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
  // The text is written to a real pipe (a Blob as stdin reaches the child empty).
  async function run(args: string[], stdin: string | Uint8Array) {
    const child = Bun.spawn([process.execPath, 'run', entry, 'messages', ...args], {
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(home),
    });
    // The child may stop reading early (the size limit); a broken pipe is expected then.
    try {
      child.stdin.write(stdin);
      await child.stdin.end();
    } catch {
      // nothing to do: the assertions below judge the outcome
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  // The failure a --json command reports: the last stderr line.
  function jsonError(stderr: string) {
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  function sent(method: string): URLSearchParams {
    const call = calls.find((candidate) => candidate.method === method);
    expect(call).toBeDefined();
    return call!.params;
  }

  it('messages send posts the piped text exactly, minus one trailing newline', async () => {
    const result = await run(['send', '--recipient-id', 'C0123456789', '--message-file', '-', '--json'], `${TEXT}\n`);
    expect(result.code).toBe(0);
    expect(sent('chat.postMessage').get('text')).toBe(TEXT);
    expect(JSON.parse(result.stdout)).toMatchObject({ channel_id: 'C0123456789', ts: '1712345678.123456' });
  }, 30_000);

  it('messages send keeps printf output with no trailing newline as is', async () => {
    const result = await run(['send', '--recipient-id', 'C0123456789', '--message-file=-'], 'a\nb');
    expect(result.code).toBe(0);
    expect(sent('chat.postMessage').get('text')).toBe('a\nb');
  }, 30_000);

  it('messages edit updates the message with the piped text', async () => {
    const result = await run(
      ['edit', '--channel-id', 'C0123456789', '--timestamp', '1712345678.123456', '--message-file', '-', '--json'],
      TEXT,
    );
    expect(result.code).toBe(0);
    expect(sent('chat.update').get('text')).toBe(TEXT);
  }, 30_000);

  it('messages draft creates the draft from the piped text', async () => {
    const result = await run(['draft', '--recipient-id', 'C0123456789', '--message-file', '-', '--json'], TEXT);
    expect(result.code).toBe(0);
    const blocks = sent('drafts.create').get('blocks') ?? '';
    for (const piece of ['Build ', 'main', 'failed:', String.raw`\"tests\" step, see $LOG`, String.raw`it's \\ $(not) run`]) {
      expect(blocks).toContain(piece);
    }
  }, 30_000);

  it('rejects empty stdin with invalid_input and calls Slack for nothing', async () => {
    const targets: Record<string, string[]> = {
      send: ['--recipient-id', 'C0123456789'],
      draft: ['--recipient-id', 'C0123456789'],
      edit: ['--channel-id', 'C0123456789', '--timestamp', '1712345678.123456'],
    };
    for (const [name, target] of Object.entries(targets)) {
      const result = await run([name, ...target, '--message-file', '-', '--json'], ' \n\t\n');
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(jsonError(result.stderr)).toMatchObject({
        code: 'invalid_input',
        message: 'Message file - (standard input) is empty',
      });
    }
    expect(calls).toEqual([]);
  }, 30_000);

  it('refuses more than 1 MB of stdin instead of buffering it, and sends nothing', async () => {
    const result = await run(
      ['send', '--recipient-id', 'C0123456789', '--message-file', '-', '--json'],
      new Uint8Array(MAX_STDIN_BYTES + 64 * 1024).fill(0x61),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(jsonError(result.stderr)).toMatchObject({
      code: 'invalid_input',
      message: `Cannot read message from standard input: input is larger than ${MAX_STDIN_BYTES} bytes`,
    });
    expect(calls).toEqual([]);
  }, 30_000);

  it('still reads a file literally named - when written as ./-', async () => {
    await writeFile(join(home, '-'), 'from the dash file\n');
    const child = Bun.spawn(
      [process.execPath, 'run', entry, 'messages', 'send', '--recipient-id', 'C0123456789', '--message-file', './-'],
      { cwd: home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: childEnv(home) },
    );
    expect(await child.exited).toBe(0);
    expect(sent('chat.postMessage').get('text')).toBe('from the dash file\n');
  }, 30_000);
});

// A real terminal on stdin: `script` (util-linux) gives the child a pty. The
// command must fail at once instead of waiting for typing.
//
// Three guards keep this test bounded, because a pty from `script` starts
// 0 columns wide and a spinner on such a terminal redraws without end:
// `stty` gives it a real size, `timeout` kills a hang (`--foreground`, or the
// child is not the terminal's foreground job and stops), and `head -c` caps the
// captured output whatever the child prints.
const hasPty =
  process.platform === 'linux' &&
  ['script', 'timeout', 'stty', 'head'].every((tool) => Bun.which(tool) !== null);
describe.skipIf(!hasPty)('--message-file - with a terminal on stdin', () => {
  it('fails immediately with a message to pipe the text in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'slackcli-stdin-tty-'));
    try {
      const quote = (s: string) => `'${s.replaceAll("'", String.raw`'\''`)}'`;
      const inPty =
        `stty cols 80 rows 24; timeout --foreground -s KILL 20 ${quote(process.execPath)} run ${quote(entry)} ` +
        'messages send --recipient-id C0123456789 --message-file -; echo "EXIT=$?"';
      const result = Bun.spawnSync(
        ['sh', '-c', `timeout -s KILL 25 script -qec ${quote(inPty)} /dev/null | head -c 65536`],
        { cwd: root, stdin: 'ignore', env: childEnv(home) },
      );
      const output = result.stdout.toString().replaceAll('\r\n', '\n');
      expect(output).toContain('stdin is a terminal; pipe the text in');
      expect(output).toContain('EXIT=1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
