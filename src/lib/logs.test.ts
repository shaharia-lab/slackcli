import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearLogs,
  formatRunsText,
  listLogFiles,
  logFilePath,
  parseLastOption,
  readRuns,
  redactText,
  selectRuns,
} from './logs.ts';
import type { LogRun } from './logs.ts';

// Assembled at runtime so secret scanning does not flag the fixtures.
const token = (...parts: string[]) => parts.join('-');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slackcli-logs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(runId: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    '@timestamp': '2026-09-27T10:00:00.000Z',
    level: 'INFO',
    message,
    logger: 'slackcli.test',
    properties: { run_id: runId, ...extra },
  });
}

function header(runId: string, command: string): string {
  return JSON.stringify({
    '@timestamp': '2026-09-27T09:59:59.000Z',
    level: 'INFO',
    message: `session_start "${command}"`,
    logger: 'slackcli.session',
    properties: { run_id: runId, event: 'session_start', version: '0.13.0', os: 'linux', command },
  });
}

function write(name: string, lines: string[]): void {
  writeFileSync(join(dir, name), lines.map((line) => `${line}\n`).join(''));
}

function messages(run: LogRun): unknown[] {
  return run.records.map((r) => r.message);
}

describe('parseLastOption', () => {
  it('accepts positive integers', () => {
    expect(parseLastOption('1')).toBe(1);
    expect(parseLastOption('25')).toBe(25);
  });

  it.each(['0', '-1', '1.5', 'abc', '', ' 2', '2x', '01', '99999999999999999999'])('rejects %p', (value) => {
    expect(() => parseLastOption(value)).toThrow('--last must be a positive integer');
  });
});

describe('listLogFiles', () => {
  it('returns rotations oldest first, then the live file, ignoring everything else', () => {
    for (const name of ['slackcli.log', 'slackcli.log.1', 'slackcli.log.10', 'slackcli.log.2',
      'other.log', 'slackcli.log.bak', 'slackcli.log.0', 'slackcli.logx', 'notes.txt']) {
      writeFileSync(join(dir, name), '');
    }
    mkdirSync(join(dir, 'slackcli.log.3'));

    expect(listLogFiles(dir)).toEqual([
      join(dir, 'slackcli.log.10'),
      join(dir, 'slackcli.log.2'),
      join(dir, 'slackcli.log.1'),
      join(dir, 'slackcli.log'),
    ]);
  });

  it.skipIf(process.platform === 'win32')('skips a file that disappears between listing and stat', () => {
    writeFileSync(join(dir, 'slackcli.log'), '');
    // A dangling symlink is listed by readdir but fails stat with ENOENT, the
    // same as a rotation by another process in between.
    symlinkSync(join(dir, 'gone'), join(dir, 'slackcli.log.4'));

    expect(listLogFiles(dir)).toEqual([join(dir, 'slackcli.log')]);
    expect(clearLogs(dir)).toEqual({ deleted: 1 });
  });

  it('treats a missing directory as having no logs', () => {
    expect(listLogFiles(join(dir, 'missing'))).toEqual([]);
  });
});

describe('readRuns', () => {
  it('rebuilds a run whose records span a rotation boundary', async () => {
    write('slackcli.log.2', [header('a', 'auth list'), record('a', 'a1')]);
    write('slackcli.log.1', [record('a', 'a2'), header('b', 'team info'), record('b', 'b1')]);
    write('slackcli.log', [record('b', 'b2'), header('c', 'search messages')]);

    const { runs, skipped } = await readRuns(dir);

    expect(skipped).toBe(0);
    expect(runs.map((run) => run.run_id)).toEqual(['a', 'b', 'c']);
    expect(messages(runs[0]!)).toEqual(['session_start "auth list"', 'a1', 'a2']);
    expect(messages(runs[1]!)).toEqual(['session_start "team info"', 'b1', 'b2']);
  });

  it('skips and counts malformed lines and lines without a run_id, ignoring blank ones', async () => {
    write('slackcli.log', [
      header('a', 'auth list'),
      '{not json',
      '',
      '   ',
      '[1,2]',
      '"string"',
      'null',
      JSON.stringify({ message: 'no properties' }),
      JSON.stringify({ properties: { run_id: 42 } }),
      JSON.stringify({ properties: { run_id: '' } }),
      record('a', 'kept'),
    ]);

    const { runs, skipped } = await readRuns(dir);

    expect(skipped).toBe(7);
    expect(runs).toHaveLength(1);
    expect(messages(runs[0]!)).toEqual(['session_start "auth list"', 'kept']);
  });

  it('handles a file without a trailing newline and CRLF line endings', async () => {
    writeFileSync(join(dir, 'slackcli.log'), `${record('a', 'one')}\r\n${record('a', 'two')}`);

    const { runs, skipped } = await readRuns(dir);

    expect(skipped).toBe(0);
    expect(messages(runs[0]!)).toEqual(['one', 'two']);
  });

  it('returns no runs for a missing or empty directory', async () => {
    expect(await readRuns(join(dir, 'missing'))).toEqual({ runs: [], skipped: 0 });
    expect(await readRuns(dir)).toEqual({ runs: [], skipped: 0 });
  });

  it('redacts a token planted in the file before returning it', async () => {
    const userToken = token('xoxp', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOp');
    const cookie = token('xoxd', 'abc/def+ghi==');
    write('slackcli.log', [
      record('a', `leaked ${userToken}`, { header: `Cookie: d=${cookie}; x=1`, nested: { t: userToken } }),
    ]);

    const { runs } = await readRuns(dir);
    const text = JSON.stringify(runs);

    expect(text).not.toContain('1234567890123');
    expect(text).not.toContain('AbCdEfGhIjKlMnOp');
    expect(text).not.toContain('abc/def+ghi');
    expect(runs[0]!.records[0]!.message).toBe('leaked xox?-[REDACTED]');
    expect(runs[0]!.records[0]!.properties).toEqual({
      run_id: 'a',
      header: 'Cookie: d=[REDACTED]; x=1',
      nested: { t: 'xox?-[REDACTED]' },
    });
  });
});

describe('readRuns redaction of escaped input', () => {
  it('redacts a token and a d cookie written as JSON unicode escapes', async () => {
    const escaped = String.raw`xox\u0070-1234567890-ABCDEFGHIJ`;
    const line = String.raw`{"message":"leak ESCAPED","properties":{"run_id":"a","h":"Cookie: \u0064=xyzSECRET"}}`
      .replace('ESCAPED', escaped);
    writeFileSync(join(dir, 'slackcli.log'), `${line}\n`);

    const { runs, skipped } = await readRuns(dir);
    const text = JSON.stringify(runs);

    expect(skipped).toBe(0);
    expect(text).not.toContain('ABCDEFGHIJ');
    expect(text).not.toContain('xyzSECRET');
    expect(runs[0]!.records[0]!.message).toBe('leak xox?-[REDACTED]');
    expect((runs[0]!.records[0]!.properties as Record<string, unknown>).h).toBe('Cookie: d=[REDACTED]');
  });
});

describe('redactText', () => {
  it('applies the sink patterns: tokens, the d cookie and JWTs', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
    const input = `${token('xoxb', '1', 'abc')} d=${token('xoxd', 'a%2Fb')} ${jwt} channel_id=C1`;

    const output = redactText(input);

    expect(output).not.toContain('abc');
    expect(output).not.toContain('a%2Fb');
    expect(output).not.toContain(jwt);
    expect(output).toContain('channel_id=C1');
  });
});

describe('selectRuns', () => {
  const runs: LogRun[] = ['a', 'b', 'c'].map((run_id) => ({ run_id, records: [] }));

  it('defaults to the most recent run', () => {
    expect(selectRuns(runs).map((run) => run.run_id)).toEqual(['c']);
  });

  it('returns the last N runs oldest first, and all of them when N exceeds the count', () => {
    expect(selectRuns(runs, { last: 2 }).map((run) => run.run_id)).toEqual(['b', 'c']);
    expect(selectRuns(runs, { last: 10 }).map((run) => run.run_id)).toEqual(['a', 'b', 'c']);
  });

  it('picks one run by id, or nothing for an unknown id', () => {
    expect(selectRuns(runs, { runId: 'b' }).map((run) => run.run_id)).toEqual(['b']);
    expect(selectRuns(runs, { runId: 'zzz' })).toEqual([]);
  });

  it('returns nothing when there are no runs', () => {
    expect(selectRuns([], { last: 3 })).toEqual([]);
  });
});

describe('formatRunsText', () => {
  it('prints the header as key: value lines, then one line per record', async () => {
    write('slackcli.log', [header('a', 'team info'), record('a', 'call done', { method: 'team.info', ok: true })]);
    const { runs } = await readRuns(dir);

    expect(formatRunsText(runs)).toBe([
      '=== run a ===',
      'started: 2026-09-27T09:59:59.000Z',
      'version: 0.13.0',
      'os: linux',
      'command: team info',
      '',
      '2026-09-27T10:00:00.000Z INFO slackcli.test call done {"method":"team.info","ok":true}',
    ].join('\n'));
  });

  it('says so when a run lost its header to rotation, and separates runs', async () => {
    write('slackcli.log', [record('a', 'orphan'), header('b', 'auth list')]);
    const { runs } = await readRuns(dir);

    expect(formatRunsText(runs)).toBe([
      '=== run a ===',
      '(no session_start header: the start of this run was rotated out)',
      '',
      '2026-09-27T10:00:00.000Z INFO slackcli.test orphan',
      '',
      '=== run b ===',
      'started: 2026-09-27T09:59:59.000Z',
      'version: 0.13.0',
      'os: linux',
      'command: auth list',
      '',
    ].join('\n'));
  });

  it('prints placeholders for missing fields', () => {
    expect(formatRunsText([{ run_id: 'x', records: [{ properties: { run_id: 'x' } }] }]))
      .toContain('\n- - - ');
  });
});

describe('clearLogs', () => {
  it('deletes only the log file and its rotations', () => {
    for (const name of ['slackcli.log', 'slackcli.log.1', 'slackcli.log.5', 'other.log', 'slackcli.log.bak', 'notes.txt']) {
      writeFileSync(join(dir, name), 'x');
    }

    expect(clearLogs(dir)).toEqual({ deleted: 3 });
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'other.log', 'slackcli.log.bak']);
  });

  it('succeeds with nothing to delete on a missing or empty directory', () => {
    expect(clearLogs(join(dir, 'missing'))).toEqual({ deleted: 0 });
    expect(clearLogs(dir)).toEqual({ deleted: 0 });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('logFilePath', () => {
  it('is the live log file inside the directory', () => {
    expect(logFilePath(dir)).toBe(join(dir, 'slackcli.log'));
  });
});
