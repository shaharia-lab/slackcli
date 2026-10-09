import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import {
  BROWSER_ONLY_NOTE,
  CONFIRM_NOTE,
  FIELDS_NOTE,
  STANDARD_ONLY_NOTE,
  commandPath,
  describeCommand,
  formatHelpSections,
  helpNotes,
  helpOf,
  installRootHelp,
  installUsageErrorHint,
  isRunnable,
  renderCommandTree,
  renderRootFooter,
  wrapText,
} from './help.ts';

function capture(cmd: Command): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  cmd.configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { err += s; } });
  return { out: () => out, err: () => err };
}

function helpText(cmd: Command): string {
  const io = capture(cmd);
  cmd.outputHelp();
  return io.out();
}

describe('wrapText', () => {
  it('leaves a short line alone', () => {
    expect(wrapText('a short note', 80, '  - ', '    ')).toBe('  - a short note');
  });

  it('wraps at the width with a hanging indent', () => {
    const text = 'one two three four five six seven eight nine ten';
    const wrapped = wrapText(text, 20, '  - ', '    ');
    const lines = wrapped.split('\n');
    expect(lines[0]).toBe('  - one two three');
    expect(lines.slice(1).every((line) => line.startsWith('    ') && !line.startsWith('     '))).toBe(true);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(wrapped.replace(/\s+/g, ' ').replace(/^ - /, '')).toBe(text);
  });

  it('keeps a word longer than the line whole', () => {
    const url = 'https://acme.slack.com/archives/C0123456789/p1712345678123456';
    const lines = wrapText(`see ${url} now`, 30, '- ', '  ').split('\n');
    expect(lines).toEqual(['- see', `  ${url}`, '  now']);
  });

  it('collapses runs of whitespace and handles empty text', () => {
    expect(wrapText('a \n  b', 80)).toBe('a b');
    expect(wrapText('', 80, '  - ')).toBe('  - ');
  });
});

describe('formatHelpSections', () => {
  it('is empty when there is nothing to add', () => {
    expect(formatHelpSections({ summary: 'Do a thing' })).toBe('');
  });

  it('renders examples only, unwrapped', () => {
    const long = `slackcli messages send --recipient-id C0123456789 --message "${'x'.repeat(90)}"`;
    expect(formatHelpSections({ summary: 's', examples: ['slackcli a', long] }))
      .toBe(`\nExamples:\n  slackcli a\n  ${long}\n`);
  });

  it('renders notes only', () => {
    expect(formatHelpSections({ summary: 's', notes: ['first', 'second'] }))
      .toBe('\nNotes:\n  - first\n  - second\n');
  });

  it('puts the standard notes first: json, browser-only, confirmation', () => {
    const help = { summary: 's', json: '{ ok }', browserOnly: true, confirms: true, notes: ['own note'] };
    expect(helpNotes(help)).toEqual([
      'With --json, stdout is one JSON object: { ok }',
      BROWSER_ONLY_NOTE,
      CONFIRM_NOTE,
      'own note',
    ]);
  });

  it('puts the standard-only note where the browser-only one goes', () => {
    const help = { summary: 's', json: '{ ok }', standardOnly: true, confirms: true, dryRun: true, notes: ['own note'] };
    expect(helpNotes(help).slice(0, 3)).toEqual([
      'With --json, stdout is one JSON object: { ok }',
      STANDARD_ONLY_NOTE,
      CONFIRM_NOTE,
    ]);
    expect(helpNotes(help).at(-1)).toBe('own note');
    expect(STANDARD_ONLY_NOTE).toContain('xoxb or xoxp');
    expect(helpNotes({ summary: 's' })).toEqual([]);
  });

  it('adds the --fields note after the other standard notes', () => {
    const help = { summary: 's', json: '{ ok }', fields: 'each item of messages', notes: ['own note'] };
    expect(helpNotes(help)).toEqual(['With --json, stdout is one JSON object: { ok }', FIELDS_NOTE('each item of messages'), 'own note']);
  });

  it('says the envelope is kept for a list, and not for a record', () => {
    expect(FIELDS_NOTE('each item of messages')).toContain('keeps only the named fields of each item of messages');
    expect(FIELDS_NOTE('each item of messages')).toContain('The other top-level keys are kept as they are.');
    expect(FIELDS_NOTE('the user record')).not.toContain('top-level keys');
    expect(FIELDS_NOTE('the user record')).toContain('needs --json');
  });

  it('separates sections with one blank line and wraps long notes', () => {
    const text = formatHelpSections({ summary: 's', examples: ['slackcli a'], notes: ['word '.repeat(40).trim()] }, 40);
    expect(text.startsWith('\nExamples:\n  slackcli a\n\nNotes:\n  - word')).toBe(true);
    expect(text.split('\n').every((line) => line.length <= 40)).toBe(true);
  });
});

describe('describeCommand', () => {
  it('sets summary, description and appended help, and records the content', () => {
    const cmd = new Command('send');
    const help = { summary: 'Send a message', description: 'Send a message. Longer.', examples: ['slackcli send'] };
    expect(describeCommand(cmd, help)).toBe(cmd);
    expect(cmd.summary()).toBe('Send a message');
    expect(cmd.description()).toBe('Send a message. Longer.');
    expect(helpOf(cmd)).toBe(help);
    const text = helpText(cmd);
    expect(text).toContain('Send a message. Longer.');
    expect(text).toContain('\nExamples:\n  slackcli send\n');
  });

  it('defaults the description to the summary', () => {
    const cmd = describeCommand(new Command('x'), { summary: 'Only a summary' });
    expect(cmd.description()).toBe('Only a summary');
    expect(helpText(cmd)).not.toContain('Examples:');
  });

  it('shows the summary, not the description, in the parent list', () => {
    const parent = new Command('group');
    describeCommand(parent.command('child'), { summary: 'Short', description: 'A much longer description' });
    const text = helpText(parent);
    expect(text).toMatch(/child\s+Short/);
    expect(text).not.toContain('A much longer description');
  });

  it('returns undefined for a command it never saw', () => {
    expect(helpOf(new Command('bare'))).toBeUndefined();
  });
});

describe('commandPath and isRunnable', () => {
  it('builds the full path and tells groups from commands', () => {
    const root = new Command('slackcli');
    const group = root.command('conversations');
    const sub = group.command('members');
    const leaf = sub.command('list').action(() => {});
    expect(commandPath(leaf)).toBe('slackcli conversations members list');
    expect(isRunnable(leaf)).toBe(true);
    expect(isRunnable(group)).toBe(false);
    // A group with its own action (like `update`) also runs.
    const update = root.command('update').action(() => {});
    update.command('check').action(() => {});
    expect(isRunnable(update)).toBe(true);
  });
});

function fixture(): Command {
  const program = new Command('slackcli');
  const auth = describeCommand(new Command('auth'), { summary: 'Manage authentication' });
  describeCommand(auth.command('login'), { summary: 'Log in with an app token' });
  const conversations = describeCommand(new Command('conversations'), { summary: 'Conversations' });
  const members = describeCommand(conversations.command('members'), { summary: 'Membership' });
  describeCommand(members.command('list'), { summary: 'List members' });
  program.addCommand(auth);
  program.addCommand(conversations);
  return program;
}

describe('renderCommandTree', () => {
  it('lists every command by full path, grouped, with its summary', () => {
    const tree = renderCommandTree(fixture());
    expect(tree.split('\n')).toEqual([
      'Commands:',
      '  auth                        Manage authentication',
      '  auth login                  Log in with an app token',
      '',
      '  conversations               Conversations',
      '  conversations members       Membership',
      '  conversations members list  List members',
    ]);
  });

  it('follows commands added later, because it reads the live tree', () => {
    const program = fixture();
    describeCommand(program.commands[0]!.command('whoami'), { summary: 'Show the identity' });
    expect(renderCommandTree(program)).toContain('  auth whoami                 Show the identity');
  });

  it('wraps a long summary under its column', () => {
    const program = new Command('slackcli');
    describeCommand(program.command('a'), { summary: 'word '.repeat(30).trim() });
    const lines = renderCommandTree(program, 40).split('\n').slice(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith('     '))).toBe(true);
  });
});

describe('renderRootFooter', () => {
  it('covers workspace selection, environment variables, --json and help', () => {
    const footer = renderRootFooter();
    for (const text of [
      '--workspace <id|name>',
      'auth set-default',
      'SLACKCLI_WORKSPACE',
      'SLACKCLI_LOG_LEVEL',
      'SLACKCLI_LOG_DIR',
      'SLACKCLI_BROWSER',
      'SLACKCLI_BROWSER_PROFILE',
      'SLACKCLI_NO_UPDATE_NOTIFIER',
      '--json',
      'slackcli <command> --help',
    ]) {
      expect(footer).toContain(text);
    }
    expect(footer.split('\n').every((line) => line.length <= 80)).toBe(true);
  });

  it('aligns the environment variable descriptions in one column', () => {
    const lines = renderRootFooter().split('\n');
    const start = lines.indexOf('Environment:') + 1;
    const end = lines.indexOf('', start);
    const block = lines.slice(start, end);
    expect(block.length).toBeGreaterThanOrEqual(6);
    for (const line of block) {
      // A variable line or its continuation: the description starts at column 32.
      expect(line.slice(0, 32)).toMatch(/^( {2}SLACKCLI_[A-Z_]+ +| {32})$/);
      expect(line[32]).toMatch(/\S/);
    }
  });

  it('contains no token-looking value', () => {
    expect(renderRootFooter()).not.toMatch(/xox[a-z]-/);
  });
});

describe('installRootHelp', () => {
  it('replaces the root list of groups with the tree and footer', () => {
    const program = fixture();
    installRootHelp(program);
    const text = helpText(program);
    expect(text.match(/^Commands:/gm)).toHaveLength(1);
    expect(text).toContain('  conversations members list  List members');
    expect(text).toContain('Environment:');
    expect(text).not.toMatch(/^ {2}help \[command\]/m);
  });

  it('leaves a group\'s own help untouched', () => {
    const program = fixture();
    installRootHelp(program);
    const text = helpText(program.commands[1]!);
    expect(text).toMatch(/^Commands:\n {2}members\s+Membership/m);
    expect(text).not.toContain('Environment:');
  });
});

describe('installUsageErrorHint', () => {
  class Exited extends Error {}

  function tree(): Command {
    const program = fixture();
    program.commands[0]!.commands[0]!.requiredOption('--token <token>', 'Token').action(() => {});
    installUsageErrorHint(program);
    const silence = (cmd: Command) => {
      cmd.exitOverride(() => { throw new Exited(); });
      cmd.commands.forEach(silence);
    };
    silence(program);
    return program;
  }

  function run(program: Command, args: string[], failing: (p: Command) => Command): string {
    const io = capture(failing(program));
    expect(() => program.parse(['node', 'slackcli', ...args])).toThrow(Exited);
    return io.err();
  }

  it('points to the failing command\'s help on an unknown option', () => {
    const program = tree();
    const err = run(program, ['auth', 'login', '--token', 't', '--nope'], (p) => p.commands[0]!.commands[0]!);
    expect(err).toBe('error: unknown option \'--nope\'\n(run "slackcli auth login --help" for usage and examples)\n');
  });

  it('points to the command\'s help on a missing mandatory option', () => {
    const program = tree();
    const err = run(program, ['auth', 'login'], (p) => p.commands[0]!.commands[0]!);
    expect(err).toContain("required option '--token <token>' not specified");
    expect(err).toContain('(run "slackcli auth login --help" for usage and examples)');
  });

  it('reaches commands nested two levels down and added with addCommand()', () => {
    const program = tree();
    const err = run(program, ['conversations', 'members', 'list', '--nope'], (p) => p.commands[1]!.commands[0]!.commands[0]!);
    expect(err).toContain('(run "slackcli conversations members list --help" for usage and examples)');
  });
});
