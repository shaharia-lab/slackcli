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

const COMMANDS_DIR = join(import.meta.dir, 'commands');

function commandSourceFiles(): string[] {
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(COMMANDS_DIR, name));
}

// Strip line and block comments so a comment that merely mentions console.log
// is not read as a call. Good enough for this source tree: it does not parse
// strings, but no command file contains the literal "console.log(" inside a
// string, and a new one would be a genuine smell worth failing on anyway.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('command output sink (#373)', () => {
  const files = commandSourceFiles();

  it('finds command source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(COMMANDS_DIR.length + 1), file] as const))(
    '%s routes result output through writeText(), not console.log',
    (name, file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const matches = code.match(/\bconsole\s*\.\s*log\s*\(/g) ?? [];
      expect({ name, consoleLogCalls: matches.length }).toEqual({ name, consoleLogCalls: 0 });
    },
  );
});
