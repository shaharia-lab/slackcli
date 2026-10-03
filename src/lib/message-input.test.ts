import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InvalidInputError } from './cli-errors.ts';
import {
  MAX_STDIN_BYTES,
  STDIN_TIMEOUT_MS,
  readStreamText,
  resolveMessageText,
  type MessageInputDeps,
} from './message-input.ts';

// Stub stdin; file reads go to the real filesystem unless a test overrides them.
function deps(overrides: Partial<MessageInputDeps> = {}): MessageInputDeps & { stdinReads: number } {
  const state = {
    stdinReads: 0,
    isStdinTTY: () => false,
    readStdin: async () => '',
    readFile: (path: string) => Bun.file(path).text(),
    ...overrides,
  };
  const readStdin = state.readStdin;
  state.readStdin = async () => {
    state.stdinReads++;
    return readStdin();
  };
  return state;
}

function piped(text: string) {
  return deps({ readStdin: async () => text });
}

async function withTempFile(
  name: string,
  contents: string,
  run: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slackcli-message-'));
  const path = join(dir, name);
  await Bun.write(path, contents);
  try {
    await run(dir, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A stream the test drives by hand, recording whether it was destroyed.
class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
  listenerTotal() {
    return ['data', 'end', 'close', 'error'].reduce((sum, name) => sum + this.listenerCount(name), 0);
  }
}

const LIMITS = { maxBytes: 16, timeoutMs: 5_000 };

describe('readStreamText', () => {
  it('joins chunks, including a multi-byte character split across two', async () => {
    const stream = new FakeStream();
    const read = readStreamText(stream, LIMITS);
    const coffee = Buffer.from('☕');
    stream.emit('data', Buffer.from('a\n'));
    stream.emit('data', coffee.subarray(0, 1));
    stream.emit('data', coffee.subarray(1));
    stream.emit('data', 'b');
    stream.emit('end');
    expect(await read).toBe('a\n☕b');
  });

  it('detaches its listeners and destroys the stream once input ends', async () => {
    const stream = new FakeStream();
    const read = readStreamText(stream, LIMITS);
    expect(stream.listenerTotal()).toBe(4);
    stream.emit('data', Buffer.from('done'));
    stream.emit('end');
    expect(await read).toBe('done');
    expect(stream.listenerTotal()).toBe(0);
    expect(stream.destroyed).toBe(true);
  });

  it('treats a zero-length chunk as end of input and stops listening', async () => {
    for (const empty of [Buffer.alloc(0), '']) {
      const stream = new FakeStream();
      const read = readStreamText(stream, LIMITS);
      stream.emit('data', Buffer.from('kept'));
      stream.emit('data', empty);
      expect(await read).toBe('kept');
      // A runtime that keeps delivering empty reads can no longer reach the buffer.
      expect(stream.listenerTotal()).toBe(0);
      expect(stream.destroyed).toBe(true);
    }
  });

  it('resolves on close when no end event arrives', async () => {
    const stream = new FakeStream();
    const read = readStreamText(stream, LIMITS);
    stream.emit('data', Buffer.from('x'));
    stream.emit('close');
    expect(await read).toBe('x');
  });

  it('resolves with an empty string for a stream that ends at once', async () => {
    const stream = new FakeStream();
    const read = readStreamText(stream, LIMITS);
    stream.emit('end');
    expect(await read).toBe('');
  });

  it('accepts exactly the limit and fails one byte past it, without buffering more', async () => {
    const atLimit = new FakeStream();
    const ok = readStreamText(atLimit, LIMITS);
    atLimit.emit('data', Buffer.alloc(16, 'a'));
    atLimit.emit('end');
    expect(await ok).toBe('a'.repeat(16));

    const over = new FakeStream();
    const failed = readStreamText(over, LIMITS);
    over.emit('data', Buffer.alloc(10, 'a'));
    over.emit('data', Buffer.alloc(7, 'a'));
    await expect(failed).rejects.toThrow('input is larger than 16 bytes');
    expect(over.listenerTotal()).toBe(0);
    expect(over.destroyed).toBe(true);
  });

  it('counts bytes, not characters, against the limit', async () => {
    const stream = new FakeStream();
    const failed = readStreamText(stream, { maxBytes: 4, timeoutMs: 5_000 });
    stream.emit('data', '☕☕'); // 2 characters, 6 bytes
    await expect(failed).rejects.toThrow('input is larger than 4 bytes');
  });

  it('gives up when the input never ends', async () => {
    const stream = new FakeStream();
    const started = Date.now();
    const failed = readStreamText(stream, { maxBytes: 16, timeoutMs: 40 });
    stream.emit('data', Buffer.from('partial'));
    await expect(failed).rejects.toThrow('no end of input after 0.04 s');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stream.listenerTotal()).toBe(0);
    expect(stream.destroyed).toBe(true);
  });

  it('rejects on a stream error, wrapping a non-Error value', async () => {
    const stream = new FakeStream();
    const failed = readStreamText(stream, LIMITS);
    stream.emit('error', new Error('EIO'));
    await expect(failed).rejects.toThrow('EIO');

    const other = new FakeStream();
    const failedString = readStreamText(other, LIMITS);
    other.emit('error', 'broken');
    await expect(failedString).rejects.toThrow('broken');
  });

  it('settles once: events after the end change nothing', async () => {
    const stream = new FakeStream();
    const read = readStreamText(stream, LIMITS);
    const stray = (chunk: Buffer) => chunk; // keeps a late emit from being unhandled
    stream.emit('data', Buffer.from('first'));
    stream.emit('end');
    stream.on('data', stray);
    stream.emit('data', Buffer.from('late'));
    stream.emit('close');
    expect(await read).toBe('first');
  });

  it('works without a destroy method', async () => {
    const stream = new EventEmitter();
    const read = readStreamText(stream, LIMITS);
    stream.emit('data', Buffer.from('plain'));
    stream.emit('end');
    expect(await read).toBe('plain');
  });

  it('defaults to 1 MB and 30 seconds', () => {
    expect(MAX_STDIN_BYTES).toBe(1024 * 1024);
    expect(STDIN_TIMEOUT_MS).toBe(30_000);
  });
});

describe('resolveMessageText', () => {
  it('returns --message unchanged, including an intentionally empty one', async () => {
    expect(await resolveMessageText({ message: 'Deploy green' }, deps())).toBe('Deploy green');
    expect(await resolveMessageText({ message: '' }, deps())).toBe('');
  });

  it('reads the message from --message-file as UTF-8, preserving mrkdwn and newlines', async () => {
    const body = '*Release 1.2*\n\n- <https://example.com|runbook>\n- café ☕\n';
    await withTempFile('body.txt', body, async (_dir, path) => {
      expect(await resolveMessageText({ messageFile: path }, deps())).toBe(body);
    });
  });

  it('reads a real file through the default dependencies', async () => {
    await withTempFile('body.txt', 'from disk\n', async (_dir, path) => {
      expect(await resolveMessageText({ messageFile: path })).toBe('from disk\n');
    });
  });

  it('rejects a file that is missing, empty, or only whitespace before sending', async () => {
    await expect(resolveMessageText({ messageFile: '' }, deps()))
      .rejects.toThrow('--message-file path cannot be empty');

    await expect(resolveMessageText({ messageFile: '/nonexistent/body.txt' }, deps()))
      .rejects.toThrow('Cannot read message file /nonexistent/body.txt');

    await withTempFile('body.txt', '', async (_dir, path) => {
      await expect(resolveMessageText({ messageFile: path }, deps())).rejects.toThrow('is empty');
    });
    await withTempFile('body.txt', '   \n\t\n', async (_dir, path) => {
      await expect(resolveMessageText({ messageFile: path }, deps())).rejects.toThrow('is empty');
    });
  });

  it('reports a non-Error thrown by the file reader', async () => {
    const failing = deps({ readFile: async () => { throw 'EIO'; } });
    await expect(resolveMessageText({ messageFile: 'body.txt' }, failing))
      .rejects.toThrow('Cannot read message file body.txt: EIO');
  });

  it('rejects an invocation supplying neither flag', async () => {
    await expect(resolveMessageText({}, deps()))
      .rejects.toThrow('Either --message or --message-file is required');
  });

  it('reports every failure as invalid input', async () => {
    const failures = [
      () => resolveMessageText({}, deps()),
      () => resolveMessageText({ messageFile: '' }, deps()),
      () => resolveMessageText({ messageFile: '/nonexistent/body.txt' }, deps()),
      () => resolveMessageText({ messageFile: '-' }, piped('')),
      () => resolveMessageText({ messageFile: '-' }, deps({ isStdinTTY: () => true })),
      () => resolveMessageText({ messageFile: '-' }, deps({ readStdin: async () => { throw new Error('x'); } })),
    ];
    for (const failure of failures) {
      await expect(failure()).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  describe('--message-file - (standard input)', () => {
    it('returns piped text byte for byte: quotes, backticks, $ and newlines', async () => {
      const text = 'Build `main` failed:\n  "tests" step, see $LOG\n\tit\'s $(not) run\n\\n stays literal';
      expect(await resolveMessageText({ messageFile: '-' }, piped(text))).toBe(text);
    });

    it('sends printf \'a\\nb\' as exactly a\\nb', async () => {
      expect(await resolveMessageText({ messageFile: '-' }, piped('a\nb'))).toBe('a\nb');
    });

    it('drops exactly one trailing newline, as a heredoc or echo adds', async () => {
      expect(await resolveMessageText({ messageFile: '-' }, piped('line one\nline two\n'))).toBe('line one\nline two');
      expect(await resolveMessageText({ messageFile: '-' }, piped('one\r\n'))).toBe('one');
      expect(await resolveMessageText({ messageFile: '-' }, piped('one\n\n'))).toBe('one\n');
      expect(await resolveMessageText({ messageFile: '-' }, piped('one\n\n\n'))).toBe('one\n\n');
    });

    it('keeps leading and inner whitespace and a trailing space', async () => {
      expect(await resolveMessageText({ messageFile: '-' }, piped('  indented\n\n  code  '))).toBe('  indented\n\n  code  ');
    });

    it('rejects empty or whitespace-only stdin with the empty-file error', async () => {
      for (const text of ['', '\n', '   \n\t\n']) {
        await expect(resolveMessageText({ messageFile: '-' }, piped(text)))
          .rejects.toThrow('Message file - (standard input) is empty');
      }
    });

    it('refuses a terminal on stdin without reading from it', async () => {
      const terminal = deps({ isStdinTTY: () => true, readStdin: async () => 'never read' });
      await expect(resolveMessageText({ messageFile: '-' }, terminal))
        .rejects.toThrow('stdin is a terminal; pipe the text in');
      expect(terminal.stdinReads).toBe(0);
    });

    it('carries a piping hint for --json output', async () => {
      const failure = await resolveMessageText({ messageFile: '-' }, deps({ isStdinTTY: () => true }))
        .catch((err: InvalidInputError) => err);
      expect(failure).toBeInstanceOf(InvalidInputError);
      expect((failure as InvalidInputError).hint).toContain('| slackcli messages send');
    });

    it('reports oversized and never-ending input from the bounded reader', async () => {
      const tooBig = new FakeStream();
      const big = resolveMessageText(
        { messageFile: '-' },
        deps({ readStdin: () => readStreamText(tooBig, { maxBytes: 8, timeoutMs: 5_000 }) }),
      );
      tooBig.emit('data', Buffer.alloc(9, 'a'));
      await expect(big).rejects.toThrow('Cannot read message from standard input: input is larger than 8 bytes');

      const open = new FakeStream();
      const stuck = resolveMessageText(
        { messageFile: '-' },
        deps({ readStdin: () => readStreamText(open, { maxBytes: 8, timeoutMs: 30 }) }),
      );
      await expect(stuck).rejects.toThrow('Cannot read message from standard input: no end of input after 0.03 s');
    });

    it('wraps a stdin read failure as invalid input', async () => {
      const broken = deps({ readStdin: async () => { throw new Error('EPIPE'); } });
      await expect(resolveMessageText({ messageFile: '-' }, broken))
        .rejects.toThrow('Cannot read message from standard input: EPIPE');
      const brokenString = deps({ readStdin: async () => { throw 'closed'; } });
      await expect(resolveMessageText({ messageFile: '-' }, brokenString))
        .rejects.toThrow('Cannot read message from standard input: closed');
    });

    it('does not read stdin for --message or a file path', async () => {
      const stdin = piped('from stdin');
      expect(await resolveMessageText({ message: 'from flag' }, stdin)).toBe('from flag');
      await withTempFile('body.txt', 'from file\n', async (_dir, path) => {
        expect(await resolveMessageText({ messageFile: path }, stdin)).toBe('from file\n');
      });
      expect(stdin.stdinReads).toBe(0);
    });

    it('treats ./- as a file named "-", not as stdin', async () => {
      await withTempFile('-', 'a file called dash\n', async (dir) => {
        const stdin = piped('from stdin');
        const readPaths: string[] = [];
        const reader: MessageInputDeps = {
          ...stdin,
          readFile: async (path) => {
            readPaths.push(path);
            return Bun.file(join(dir, path)).text();
          },
        };
        expect(await resolveMessageText({ messageFile: './-' }, reader)).toBe('a file called dash\n');
        expect(readPaths).toEqual(['./-']);
        expect(stdin.stdinReads).toBe(0);
      });
    });
  });
});
