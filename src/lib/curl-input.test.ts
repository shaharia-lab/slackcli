import { describe, expect, it } from 'bun:test';
import { resolveCurlInput, type CurlInputDeps, type CurlInputProgress } from './curl-input.ts';
import type { ClipboardResult } from './clipboard.ts';

const CURL = "curl 'https://acme.slack.com/api/conversations.list' -H 'cookie: d=xoxd-abc'";

interface StubOptions {
  clipboard?: ClipboardResult;
  piped?: boolean;
  tty?: boolean;
  stdin?: string;
  interactive?: string;
}

interface StubDeps extends CurlInputDeps {
  calls: string[];
}

// Every dep records its own call, so tests can assert which sources were
// consulted — not just which one won.
function makeDeps(opts: StubOptions = {}): StubDeps {
  const calls: string[] = [];
  return {
    calls,
    readClipboard: async () => {
      calls.push('readClipboard');
      return opts.clipboard ?? { success: true, content: CURL };
    },
    hasPipedInput: () => {
      calls.push('hasPipedInput');
      return opts.piped ?? false;
    },
    isInteractiveTerminal: () => {
      calls.push('isInteractiveTerminal');
      return opts.tty ?? false;
    },
    readStdin: async () => {
      calls.push('readStdin');
      return opts.stdin ?? CURL;
    },
    readInteractive: async () => {
      calls.push('readInteractive');
      return opts.interactive ?? CURL;
    },
  };
}

describe('resolveCurlInput — source priority', () => {
  it('uses the argument and touches no other source', async () => {
    const deps = makeDeps({ piped: true, tty: true });
    const events: CurlInputProgress[] = [];
    const result = await resolveCurlInput(CURL, { fromClipboard: true, onProgress: (e) => events.push(e) }, deps);

    expect(result).toEqual({ ok: true, input: CURL, source: 'argument' });
    expect(deps.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('prefers --from-clipboard over piped stdin', async () => {
    const deps = makeDeps({ piped: true, stdin: 'curl piped' });
    const result = await resolveCurlInput(undefined, { fromClipboard: true }, deps);

    expect(result).toEqual({ ok: true, input: CURL, source: 'clipboard' });
    expect(deps.calls).toEqual(['readClipboard']);
  });

  it('reads piped stdin when there is no argument and no --from-clipboard', async () => {
    const deps = makeDeps({ piped: true, tty: true });
    const result = await resolveCurlInput(undefined, {}, deps);

    expect(result).toEqual({ ok: true, input: CURL, source: 'stdin' });
    expect(deps.calls).toEqual(['hasPipedInput', 'readStdin']);
  });

  it('prompts interactively only on a TTY with nothing piped', async () => {
    const deps = makeDeps({ piped: false, tty: true });
    const result = await resolveCurlInput(undefined, {}, deps);

    expect(result).toEqual({ ok: true, input: CURL, source: 'interactive' });
    expect(deps.calls).toEqual(['hasPipedInput', 'isInteractiveTerminal', 'readInteractive']);
  });

  it('treats an empty-string argument as absent, like the original truthiness check', async () => {
    const deps = makeDeps({ piped: true });
    const result = await resolveCurlInput('', {}, deps);

    expect(result).toEqual({ ok: true, input: CURL, source: 'stdin' });
  });

  it('reports empty with no source when nothing applies', async () => {
    const deps = makeDeps({ piped: false, tty: false });
    const result = await resolveCurlInput(undefined, {}, deps);

    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(deps.calls).toEqual(['hasPipedInput', 'isInteractiveTerminal']);
  });
});

describe('resolveCurlInput — clipboard', () => {
  it('emits clipboard-read-start before reading the clipboard', async () => {
    const order: string[] = [];
    const deps = makeDeps();
    const readClipboard = deps.readClipboard;
    deps.readClipboard = async () => {
      order.push('read');
      return readClipboard();
    };
    await resolveCurlInput(undefined, { fromClipboard: true, onProgress: (e) => order.push(e) }, deps);

    expect(order).toEqual(['clipboard-read-start', 'read']);
  });

  it('keeps the clipboard error text on failure', async () => {
    const deps = makeDeps({ clipboard: { success: false, error: 'xclip not installed' } });
    const result = await resolveCurlInput(undefined, { fromClipboard: true }, deps);

    expect(result).toEqual({
      ok: false,
      reason: 'clipboard-failed',
      source: 'clipboard',
      message: 'xclip not installed',
    });
  });

  it('falls back to a generic message when the clipboard gives no error text', async () => {
    const deps = makeDeps({ clipboard: { success: false } });
    const result = await resolveCurlInput(undefined, { fromClipboard: true }, deps);

    expect(result).toMatchObject({ reason: 'clipboard-failed', message: 'Unknown clipboard error' });
  });

  it('rejects clipboard content that is not a cURL command', async () => {
    const deps = makeDeps({ clipboard: { success: true, content: 'hello world' } });
    const result = await resolveCurlInput(undefined, { fromClipboard: true }, deps);

    expect(result).toEqual({ ok: false, reason: 'not-curl', source: 'clipboard' });
  });

  it.each([
    ['missing content', undefined],
    ['empty content', ''],
    ['whitespace-only content', '  \n\t '],
  ])('reports not-curl for %s', async (_label, content) => {
    const deps = makeDeps({ clipboard: { success: true, content } });
    const result = await resolveCurlInput(undefined, { fromClipboard: true }, deps);

    expect(result).toEqual({ ok: false, reason: 'not-curl', source: 'clipboard' });
  });

  it('never emits progress on non-clipboard paths', async () => {
    const events: CurlInputProgress[] = [];
    const onProgress = (e: CurlInputProgress) => events.push(e);
    await resolveCurlInput(undefined, { onProgress }, makeDeps({ piped: true }));
    await resolveCurlInput(undefined, { onProgress }, makeDeps({ tty: true }));
    await resolveCurlInput(undefined, { onProgress }, makeDeps());

    expect(events).toEqual([]);
  });
});

describe('resolveCurlInput — empty input', () => {
  it.each(['', '   ', '\n\n', ' \t\n '])('reports empty for piped stdin %j', async (stdin) => {
    const result = await resolveCurlInput(undefined, {}, makeDeps({ piped: true, stdin }));
    expect(result).toEqual({ ok: false, reason: 'empty', source: 'stdin' });
  });

  it.each(['', '   ', '\n\n'])('reports empty for interactive input %j', async (interactive) => {
    const result = await resolveCurlInput(undefined, {}, makeDeps({ tty: true, interactive }));
    expect(result).toEqual({ ok: false, reason: 'empty', source: 'interactive' });
  });

  it.each(['   ', '\n', '\t '])('reports empty for a whitespace-only argument %j', async (arg) => {
    const deps = makeDeps({ piped: true });
    const result = await resolveCurlInput(arg, {}, deps);

    expect(result).toEqual({ ok: false, reason: 'empty', source: 'argument' });
    // A whitespace argument is still "given", so no fallback source is read.
    expect(deps.calls).toEqual([]);
  });

  it('passes non-empty input through untrimmed', async () => {
    const padded = `  ${CURL}\n`;
    const result = await resolveCurlInput(undefined, {}, makeDeps({ piped: true, stdin: padded }));
    expect(result).toEqual({ ok: true, input: padded, source: 'stdin' });
  });
});
