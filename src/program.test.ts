import { describe, expect, it } from 'bun:test';
import type { Command } from 'commander';
import { commandPath, helpOf, isRunnable } from './lib/help.ts';
import { createProgram } from './program.ts';

// The help rules from #324, checked for every command in the real tree. A new
// command that skips describeCommand(), an example or an option description
// fails here, so help cannot drift back to one-liners.

// Commands that only work with browser session tokens (Slack has no app API
// for drafts). Their help must say so.
const BROWSER_ONLY = new Set([
  'slackcli messages list-drafts',
  'slackcli messages draft',
  'slackcli messages send-draft',
  'slackcli messages delete-draft',
]);

// Every command that writes to Slack takes --dry-run (#328). A new write
// command belongs here; commands that only change local state do not.
const SLACK_WRITES = new Set([
  'slackcli messages send',
  'slackcli messages edit',
  'slackcli messages react',
  'slackcli messages draft',
  'slackcli messages send-draft',
  'slackcli messages delete-draft',
  'slackcli conversations members add',
  'slackcli conversations members remove',
  'slackcli conversations join',
  'slackcli conversations leave',
  'slackcli usergroups create',
  'slackcli usergroups update',
  'slackcli usergroups add',
  'slackcli usergroups remove',
  'slackcli usergroups enable',
  'slackcli usergroups disable',
]);

const SUMMARY_MAX = 48;

function allCommands(root: Command): Command[] {
  const out: Command[] = [];
  const visit = (cmd: Command) => {
    out.push(cmd);
    cmd.commands.forEach(visit);
  };
  root.commands.forEach(visit);
  return out;
}

const program = createProgram();
const commands = allCommands(program);
const runnable = commands.filter(isRunnable);

function longFlags(cmd: Command): Set<string> {
  const flags = new Set(['--help']);
  for (const option of cmd.options) {
    if (option.long) flags.add(option.long);
  }
  // Global options are accepted anywhere.
  for (const option of program.options) {
    if (option.long) flags.add(option.long);
  }
  return flags;
}

function has(cmd: Command, flag: string): boolean {
  return cmd.options.some((option) => option.long === flag);
}

describe('command tree help (#324)', () => {
  it('covers the whole tree', () => {
    // 13 groups; 53 commands at the time #324 landed. Fewer means a group
    // was dropped from createProgram().
    expect(program.commands.length).toBeGreaterThanOrEqual(13);
    expect(runnable.length).toBeGreaterThanOrEqual(53);
  });

  it.each(commands.map((cmd) => [commandPath(cmd), cmd] as const))('%s has a summary and description', (_path, cmd) => {
    const help = helpOf(cmd);
    expect(help).toBeDefined();
    expect(cmd.summary().length).toBeGreaterThan(0);
    expect(cmd.summary().length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(cmd.summary()).not.toMatch(/\.$/);
    expect(cmd.description().length).toBeGreaterThan(0);
  });

  it.each(runnable.map((cmd) => [commandPath(cmd), cmd] as const))('%s has examples, notes and described options', (path, cmd) => {
    const help = helpOf(cmd)!;
    expect(help).toBeDefined();

    const examples = help.examples ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(1);
    const flags = longFlags(cmd);
    for (const example of examples) {
      // Runnable as written: starts with this command's path, and every flag
      // it uses exists on this command.
      expect(example === path || example.startsWith(`${path} `)).toBe(true);
      for (const flag of example.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
        expect({ example, flag, known: flags.has(flag) }).toEqual({ example, flag, known: true });
      }
      // Placeholder data only.
      expect(example).not.toMatch(/xox[a-z]-[0-9]/);
    }

    for (const option of cmd.options) {
      expect({ flags: option.flags, description: option.description.length > 0 })
        .toEqual({ flags: option.flags, description: true });
    }
    for (const argument of cmd.registeredArguments) {
      expect({ argument: argument.name(), description: argument.description.length > 0 })
        .toEqual({ argument: argument.name(), description: true });
    }

    if (has(cmd, '--json')) {
      expect(examples.some((example) => /\s--json\b/.test(example))).toBe(true);
      expect(help.json?.length ?? 0).toBeGreaterThan(0);
    } else {
      expect(help.json).toBeUndefined();
    }

    // A --yes flag means the command gates on confirmation.
    expect(Boolean(help.confirms)).toBe(has(cmd, '--yes'));
    expect(Boolean(help.browserOnly)).toBe(BROWSER_ONLY.has(path));
    // The Slack writes, and only they, take --dry-run and say so in help.
    expect({ path, dryRun: has(cmd, '--dry-run') }).toEqual({ path, dryRun: SLACK_WRITES.has(path) });
    expect(Boolean(help.dryRun)).toBe(SLACK_WRITES.has(path));
  });

  it('names every Slack write in the dry-run list', () => {
    const paths = new Set(runnable.map(commandPath));
    for (const path of SLACK_WRITES) expect({ path, exists: paths.has(path) }).toEqual({ path, exists: true });
  });

  it('renders Examples and Notes in every runnable command\'s --help', () => {
    for (const cmd of runnable) {
      const text = renderHelp(cmd);
      expect({ path: commandPath(cmd), examples: text.includes('\nExamples:\n') })
        .toEqual({ path: commandPath(cmd), examples: true });
    }
  });

  it('lists every command in the root help, plus the footer', () => {
    const text = renderHelp(program);
    for (const cmd of commands) {
      const term = commandPath(cmd).replace(/^slackcli /, '');
      expect(text).toMatch(new RegExp(`^  ${term.replace(/ /g, ' ')}\\s{2,}\\S`, 'm'));
    }
    expect(text).toContain('SLACKCLI_WORKSPACE');
    expect(text).toContain('--workspace <id|name>');
    expect(text).toContain('--json');
    // The default list of groups is replaced, not repeated.
    expect(text.match(/^Commands:/gm)).toHaveLength(1);
  });

  it('keeps Commander\'s own command list on a group\'s help', () => {
    const conversations = program.commands.find((cmd) => cmd.name() === 'conversations')!;
    const text = renderHelp(conversations);
    expect(text).toContain('Commands:\n');
    expect(text).toMatch(/^  members\s/m);
  });

  it('points to the failing command\'s help on every command', () => {
    for (const cmd of [program, ...commands]) {
      expect((cmd as unknown as { _showHelpAfterError: unknown })._showHelpAfterError)
        .toBe(`(run "${commandPath(cmd)} --help" for usage and examples)`);
    }
  });
});

/** The full --help text of a command, as the CLI prints it. */
function renderHelp(cmd: Command): string {
  let out = '';
  cmd.configureOutput({ writeOut: (str) => { out += str; }, writeErr: (str) => { out += str; } });
  cmd.outputHelp();
  return out;
}
