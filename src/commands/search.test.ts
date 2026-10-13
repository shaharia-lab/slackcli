import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createSearchCommand } from './search.ts';
import * as authLib from '../lib/auth.ts';

function subcommand(name: string) {
  return createSearchCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

function argumentNames(name: string): Array<{ name: string; required: boolean }> {
  return (subcommand(name)?.registeredArguments ?? []).map((argument) => ({
    name: argument.name(),
    required: argument.required,
  }));
}

describe('search command', () => {
  it('exposes the messages, channels and people subcommands', () => {
    const names = createSearchCommand().commands.map((command) => command.name());
    expect(names).toContain('messages');
    expect(names).toContain('channels');
    expect(names).toContain('people');
  });

  it('makes query OPTIONAL on messages (filter flags can stand in for it)', () => {
    // messages has --in / --from, which become in:/from: query operators, so a
    // search specified entirely by filters is a complete query. The positional
    // is therefore optional; the action rejects a call with neither a query nor
    // a filter.
    expect(argumentNames('messages')).toEqual([{ name: 'query', required: false }]);
    const opts = longOptions('messages');
    expect(opts).toContain('--in');
    expect(opts).toContain('--from');
  });

  it('keeps query REQUIRED on channels and people (no filter flags to stand in)', () => {
    // channels and people have no filter flags; the positional IS the search,
    // so an empty query would degenerate into "list everything" (already served
    // by conversations list / users list). Required positional is intentional.
    expect(argumentNames('channels')).toEqual([{ name: 'query', required: true }]);
    expect(argumentNames('people')).toEqual([{ name: 'query', required: true }]);
    expect(longOptions('channels')).not.toContain('--from');
    expect(longOptions('people')).not.toContain('--from');
  });
});

describe('search messages — filter-only query', () => {
  let stderr: string;
  let authSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderr = '';
    spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    process.exitCode = 0;
    // The empty-input check runs before any Slack call. If the action ever
    // reached auth, that is the bug this test guards against.
    authSpy = spyOn(authLib, 'getAuthenticatedClient').mockImplementation(() => {
      throw new Error('search messages reached Slack with no query');
    });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = 0;
  });

  async function run(argv: string[]): Promise<void> {
    await createSearchCommand().parseAsync(['messages', ...argv], { from: 'user' });
  }

  it('rejects a call with neither a query nor a filter (--json invalid_input)', async () => {
    await run(['--json']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'invalid_input' } });
    expect(authSpy).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only positional as empty', async () => {
    await run(['   ', '--json']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'invalid_input' } });
    expect(authSpy).not.toHaveBeenCalled();
  });
});
