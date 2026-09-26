import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { configureLogging, LOG_FILE_NAME } from './logger';
import { handleFatalError } from './process-errors';

describe('handleFatalError', () => {
  afterEach(() => resetSync());

  function run(err: unknown) {
    const records: LogRecord[] = [];
    configureLogging({ level: 'info', verbose: false, sinks: { capture: (r) => records.push(r) } });
    const printed: string[] = [];
    const exits: number[] = [];
    handleFatalError('unhandledRejection', err, {
      print: (message) => printed.push(message),
      exit: (code) => exits.push(code),
    });
    return { records, printed, exits };
  }

  it('logs message and stack at error, prints the message, and exits 1', () => {
    const { records, printed, exits } = run(new TypeError('boom'));

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('error');
    expect(records[0].category).toEqual(['slackcli', 'process']);
    expect(records[0].properties).toMatchObject({
      kind: 'unhandledRejection',
      error: 'boom',
      error_name: 'TypeError',
    });
    expect(String(records[0].properties.stack)).toContain('TypeError: boom');
    expect(printed).toEqual(['boom']);
    expect(exits).toEqual([1]);
  });

  it('handles a rejection with a non-Error value', () => {
    const { records, printed, exits } = run('plain reason');

    expect(records[0].properties).toMatchObject({ error: 'plain reason', error_name: 'string' });
    expect(records[0].properties.stack).toBeUndefined();
    expect(printed).toEqual(['plain reason']);
    expect(exits).toEqual([1]);
  });
});

// The real thing, in a child process: an async action rejects with nothing
// awaiting it, as happens under `program.parse()`. The record must be on disk
// before the process exits, and the exit code must be 1.
describe('installProcessErrorHandlers (subprocess)', () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runFixture(body: string) {
    dir = await mkdtemp(join(tmpdir(), 'slackcli-fatal-'));
    const logDir = join(dir, 'logs');
    const script = join(dir, 'fixture.ts');
    const lib = resolve(import.meta.dir);
    await writeFile(script, [
      `import { configureLogging } from ${JSON.stringify(join(lib, 'logger.ts'))};`,
      `import { installProcessErrorHandlers } from ${JSON.stringify(join(lib, 'process-errors.ts'))};`,
      `configureLogging({ level: 'info', verbose: false, dir: ${JSON.stringify(logDir)} });`,
      'installProcessErrorHandlers();',
      'installProcessErrorHandlers();',
      body,
    ].join('\n'));

    const proc = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const lines = (await readFile(join(logDir, LOG_FILE_NAME), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    return { proc, lines };
  }

  it('logs an unhandled rejection with its stack and exits 1', async () => {
    const { proc, lines } = await runFixture(
      "(async () => { await Promise.resolve(); throw new Error('action failed'); })();",
    );

    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toBe('');
    expect(proc.stderr.toString()).toContain('action failed');
    const fatal = lines.filter((l) => l.logger === 'slackcli.process');
    expect(fatal).toHaveLength(1);
    expect(fatal[0].level).toBe('ERROR');
    expect(fatal[0].properties.kind).toBe('unhandledRejection');
    expect(fatal[0].properties.stack).toContain('action failed');
  });

  it('logs an uncaught exception and exits 1', async () => {
    const { proc, lines } = await runFixture("setTimeout(() => { throw new Error('timer failed'); }, 0);");

    expect(proc.exitCode).toBe(1);
    const fatal = lines.find((l) => l.logger === 'slackcli.process');
    expect(fatal?.properties.kind).toBe('uncaughtException');
    expect(fatal?.properties.error).toBe('timer failed');
  });
});
