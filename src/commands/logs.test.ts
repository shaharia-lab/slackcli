import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogsCommand } from './logs.ts';

const root = resolve(import.meta.dir, '../..');
const entry = join(root, 'src/index.ts');

let home: string;
let logDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slackcli-logs-cmd-'));
  logDir = join(home, 'logs');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// The command resolves its directory from the environment, so it is exercised
// as a subprocess under a temporary HOME, like the logger's own stdout tests.
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, 'run', entry, ...args], {
    cwd: root,
    stdin: 'ignore',
    env: { ...process.env, HOME: home, SLACKCLI_LOG_DIR: logDir, SLACKCLI_LOG_LEVEL: 'info', ...env },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe('logs command', () => {
  it('exposes path, show and clear with the documented options', () => {
    const logs = createLogsCommand();
    const options = (name: string) =>
      logs.commands.find((c) => c.name() === name)?.options.map((o) => o.long) ?? [];

    expect(logs.commands.map((c) => c.name())).toEqual(['path', 'show', 'clear']);
    expect(options('path')).toEqual(['--json']);
    expect(options('show')).toEqual(['--last', '--run', '--json']);
    expect(options('clear')).toEqual(['--yes']);
  });
});

describe('logs path', () => {
  it('prints the location even when logging is off and nothing exists', () => {
    const text = run(['logs', 'path'], { SLACKCLI_LOG_LEVEL: 'off' });
    expect(text.code).toBe(0);
    expect(text.stdout.trim()).toBe(join(logDir, 'slackcli.log'));
    expect(text.stderr).toContain('SLACKCLI_LOG_LEVEL=off');

    const json = run(['logs', 'path', '--json'], { SLACKCLI_LOG_LEVEL: 'off' });
    expect(JSON.parse(json.stdout)).toEqual({ log_path: join(logDir, 'slackcli.log'), log_dir: logDir, exists: false });
  });
});

describe('logs show', () => {
  it('shows the last real command, not its own run, and never writes the log itself', () => {
    run(['team', 'info']);
    run(['auth', 'list']);
    const before = readdirSync(logDir);

    const result = run(['logs', 'show']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('command: auth list');
    expect(result.stdout).not.toContain('command: team info');
    expect(result.stdout).not.toContain('logs show');
    expect(readdirSync(logDir)).toEqual(before);
    expect(run(['logs', 'show', '--json']).stdout).not.toContain('logs show');
  });

  it('emits one JSON object with the selected runs', () => {
    run(['team', 'info']);
    run(['auth', 'list']);

    const result = run(['logs', 'show', '--last', '5', '--json']);
    const body = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(body.log_path).toBe(join(logDir, 'slackcli.log'));
    expect(body.skipped_lines).toBe(0);
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r: any) => r.records[0].properties.command)).toEqual(['team info', 'auth list']);

    const one = JSON.parse(run(['logs', 'show', '--run', body.runs[0].run_id, '--json']).stdout);
    expect(one.runs.map((r: any) => r.run_id)).toEqual([body.runs[0].run_id]);
  });

  it('prints a helpful message and exits 0 when there are no logs', () => {
    const missing = run(['logs', 'show']);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain('No logs yet');

    const off = run(['logs', 'show'], { SLACKCLI_LOG_LEVEL: 'off' });
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('logging is turned off');

    expect(JSON.parse(run(['logs', 'show', '--json']).stdout).runs).toEqual([]);
  });

  it('exits 1 for an unknown --run, with nothing on stdout', () => {
    run(['auth', 'list']);
    const result = run(['logs', 'show', '--run', 'no-such-run', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'not_found',
        message: 'No run with run_id "no-such-run" in the log.',
        hint: 'List recent runs with: slackcli logs show --last 10',
        retryable: false,
      },
    });

    const text = run(['logs', 'show', '--run', 'no-such-run']);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain('No run with run_id "no-such-run"');
  });

  it.each([
    [['--last=0'], '--last must be a positive integer'],
    [['--last', '2', '--run', 'x'], 'Use either --last or --run, not both.'],
  ])('reports %j as invalid_input under --json', (args, message) => {
    const result = run(['logs', 'show', ...args, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const { error } = JSON.parse(result.stderr);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5']])('rejects --last %p', (value) => {
    const result = run(['logs', 'show', `--last=${value}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--last must be a positive integer');
  });

  it('rejects --last together with --run', () => {
    const result = run(['logs', 'show', '--last', '2', '--run', 'x']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('either --last or --run');
  });

  it('reports skipped lines on stderr, keeping stdout parseable', () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'slackcli.log'), 'garbage\n');

    const result = run(['logs', 'show', '--json']);
    expect(JSON.parse(result.stdout).skipped_lines).toBe(1);
    expect(result.stderr).toContain('Skipped 1 unreadable log line');
  });
});

describe('logs clear', () => {
  function seed(): void {
    mkdirSync(logDir, { recursive: true });
    for (const name of ['slackcli.log', 'slackcli.log.1', 'keep.txt']) writeFileSync(join(logDir, name), 'x');
  }

  it('refuses without --yes when stdin is not a terminal, deleting nothing', () => {
    seed();
    const result = run(['logs', 'clear']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Re-run with --yes');
    expect(existsSync(join(logDir, 'slackcli.log'))).toBe(true);
  });

  it('deletes only the log files with --yes', () => {
    seed();
    const result = run(['logs', 'clear', '--yes']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Deleted 2 log file(s)');
    expect(readdirSync(logDir)).toEqual(['keep.txt']);
  });

  it('succeeds with an "already empty" message when there is nothing to delete', () => {
    const result = run(['logs', 'clear', '--yes']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already empty');
    expect(existsSync(logDir)).toBe(false);
  });
});
