import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The command text-output guard for issue #373.
//
// Every command result print must go through writeText()/writeJson() in
// formatter.ts (which use process.stdout.write and respect backpressure), never
// through console.log. console.log routes stdout through Bun's async
// Node-compat WriteStream, which silently drops everything past the 64 KiB pipe
// buffer when the process exits before the stream drains — truncating a large
// result into a slow reader with exit code 0. See the comment above writeText()
// in src/lib/formatter.ts and docs/development/architecture.md.
//
// This test fails the build if a command file reintroduces console.log, so the
// bug cannot creep back one call site at a time. Diagnostics that must not land
// on stdout (error hints, warnings) use console.error / the formatter's
// error()/warning(), which this guard deliberately does not touch.
//
// It scans every non-test file in src/commands/ AND src/lib/, because a command
// result does not stop being a result when the print lives in a shared lib
// helper the command calls — emitDryRun() in src/lib/dry-run.ts prints the
// --dry-run preview and carries the same large-payload truncation risk (#377,
// the follow-up to #373). The scan is default-on with a by-name EXEMPT list, not
// an opt-in include list: a new shared helper is covered the moment it lands, so
// the hazard cannot return through a file nobody remembered to enroll.

const SRC_DIR = import.meta.dir;
const SCANNED_DIRS = ['commands', 'lib'];

// Files that legitimately call console.log and are NOT command result output, so
// the guard skips them by name. Keep this list tiny and justify every entry.
// interactive-input.ts: interactive prompts, not a command result on stdout.
// (formatter.ts needs no entry — its only console.log hits are explanatory
// comments, which stripComments() drops before the check.)
const EXEMPT_FILES = new Set(['lib/interactive-input.ts']);

// Every source file the guard scans, keyed by a src/-relative name for a
// readable test label: all non-test .ts under the scanned dirs, minus exemptions.
function scannedFiles(): Array<readonly [string, string]> {
  const result: Array<readonly [string, string]> = [];
  for (const dir of SCANNED_DIRS) {
    const dirPath = join(SRC_DIR, dir);
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const rel = dir + '/' + entry;
      if (EXEMPT_FILES.has(rel)) continue;
      result.push([rel, join(dirPath, entry)] as const);
    }
  }
  return result;
}

// Strip line and block comments so a comment that merely mentions console.log
// is not read as a call. Good enough for this source tree: it does not parse
// strings, but no scanned file contains the literal "console.log(" inside a
// string, and a new one would be a genuine smell worth failing on anyway.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('command output sink (#373, #377)', () => {
  const files = scannedFiles();

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)(
    '%s routes result output through writeText(), not console.log',
    (name, file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const matches = code.match(/\bconsole\s*\.\s*log\s*\(/g) ?? [];
      expect({ name, consoleLogCalls: matches.length }).toEqual({ name, consoleLogCalls: 0 });
    },
  );
});
