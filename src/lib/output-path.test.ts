import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOutputPath } from './output-path.ts';

// A realpath()'d sandbox: /tmp is itself a symlink on some platforms, and the
// point of these tests is that the check compares canonical paths.
let sandbox: string;
let workdir: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'slackcli-output-path-')));
  workdir = join(sandbox, 'workdir');
  mkdirSync(join(workdir, 'nested'), { recursive: true });
  mkdirSync(join(sandbox, 'outside'), { recursive: true });
  // A sibling whose name starts with the working directory's name, to pin the
  // prefix-match trap.
  mkdirSync(join(sandbox, 'workdir-evil'), { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveOutputPath', () => {
  it('accepts a plain relative path in the working directory', () => {
    const target = resolveOutputPath('report.pdf', workdir);
    expect(target.outside).toBe(false);
    expect(target.resolved).toBe(join(workdir, 'report.pdf'));
    expect(target.real).toBe(target.resolved);
  });

  it('accepts a relative path in a subdirectory', () => {
    expect(resolveOutputPath('nested/report.pdf', workdir).outside).toBe(false);
    expect(resolveOutputPath('./nested/report.pdf', workdir).outside).toBe(false);
  });

  it('accepts an absolute path inside the working directory', () => {
    expect(resolveOutputPath(join(workdir, 'nested', 'report.pdf'), workdir).outside).toBe(false);
  });

  it('flags a .. traversal and reports the absolute path it lands on', () => {
    const target = resolveOutputPath('../outside/authorized_keys', workdir);
    expect(target.outside).toBe(true);
    expect(target.resolved).toBe(join(sandbox, 'outside', 'authorized_keys'));
  });

  it('flags a deep .. traversal of the kind SonarCloud reported', () => {
    const target = resolveOutputPath('../../../home/user/.ssh/authorized_keys', workdir);
    expect(target.outside).toBe(true);
    expect(target.resolved).not.toContain('..');
    expect(target.resolved.startsWith(sep)).toBe(true);
  });

  it('flags an absolute path outside the working directory', () => {
    expect(resolveOutputPath(join(sandbox, 'outside', 'x.desktop'), workdir).outside).toBe(true);
  });

  it('flags a sibling directory that merely shares the working directory prefix', () => {
    expect(resolveOutputPath(join(sandbox, 'workdir-evil', 'x'), workdir).outside).toBe(true);
    expect(resolveOutputPath('../workdir-evil/x', workdir).outside).toBe(true);
  });

  it('flags a path whose parent is a symlink pointing outside', () => {
    const link = join(workdir, 'escape');
    symlinkSync(join(sandbox, 'outside'), link, 'dir');
    try {
      const target = resolveOutputPath('escape/x.desktop', workdir);
      // The string form looks contained; only the resolved parent tells the truth.
      expect(target.resolved).toBe(join(link, 'x.desktop'));
      expect(target.real).toBe(join(sandbox, 'outside', 'x.desktop'));
      expect(target.outside).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('accepts a path whose parent is a symlink pointing back inside', () => {
    const link = join(workdir, 'inner-link');
    symlinkSync(join(workdir, 'nested'), link, 'dir');
    try {
      const target = resolveOutputPath('inner-link/report.pdf', workdir);
      expect(target.real).toBe(join(workdir, 'nested', 'report.pdf'));
      expect(target.outside).toBe(false);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('does not treat a working directory reached through a symlink as an escape', () => {
    const link = join(sandbox, 'workdir-link');
    symlinkSync(workdir, link, 'dir');
    try {
      const target = resolveOutputPath('report.pdf', link);
      expect(target.outside).toBe(false);
      expect(target.real).toBe(join(workdir, 'report.pdf'));
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('leaves a path whose parent does not exist resolvable and still contained', () => {
    const target = resolveOutputPath('missing/deeper/report.pdf', workdir);
    expect(target.outside).toBe(false);
    expect(target.real).toBe(join(workdir, 'missing', 'deeper', 'report.pdf'));
  });

  it('does not flag the working directory itself, which open() rejects as EISDIR', () => {
    expect(resolveOutputPath('.', workdir).outside).toBe(false);
    expect(resolveOutputPath(workdir, workdir).outside).toBe(false);
  });

  it('defaults to process.cwd() when no working directory is given', () => {
    expect(resolveOutputPath('report.pdf').resolved)
      .toBe(resolve(realpathSync(process.cwd()), 'report.pdf'));
    expect(resolveOutputPath('report.pdf').outside).toBe(false);
  });
});
