import { Command, Help } from 'commander';
import { LOG_LEVEL_SETTINGS } from './logger.ts';

/**
 * The help layout every command follows (#324): a one-line summary for the
 * parent's command list, a fuller description for the command's own help, and
 * `Examples` / `Notes` sections appended after the options.
 *
 * Help text is static. It must never carry a token value or real workspace
 * data: examples use placeholder IDs (C0123456789, U0123456789) and
 * acme.slack.com.
 */
export interface CommandHelp {
  /** One line, shown in the parent's command list and the root command tree. */
  summary: string;
  /** Shown at the top of the command's own help. Defaults to the summary. */
  description?: string;
  /** Complete command lines, each starting with `slackcli <command path>`. */
  examples?: string[];
  /** The top-level shape of the `--json` output, rendered as the first note. */
  json?: string;
  /** Rendered as a standard note: the command needs browser session tokens. */
  browserOnly?: boolean;
  /** Rendered as the standard confirmation-rule note for gated writes. */
  confirms?: boolean;
  notes?: string[];
}

/** Help text wraps at this width, whatever the terminal: output stays stable. */
export const HELP_WIDTH = 80;

export const BROWSER_ONLY_NOTE =
  'Browser session tokens only (auth login-auto, login-browser or parse-curl). ' +
  'With an app token (xoxb/xoxp) it fails, because Slack offers no app API for it.';

export const CONFIRM_NOTE =
  'Asks for confirmation (y/N on stderr) in a terminal. --yes skips the prompt. ' +
  'Without a terminal on stdin and without --yes it refuses and exits 1 without making the change.';

export const USAGE_ERROR_HINT = (commandPath: string) =>
  `(run "${commandPath} --help" for usage and examples)`;

const helpByCommand = new WeakMap<Command, CommandHelp>();

/** The help content registered with describeCommand(), for tests and tooling. */
export function helpOf(cmd: Command): CommandHelp | undefined {
  return helpByCommand.get(cmd);
}

/**
 * Apply the layout to a command: `.summary()`, `.description()` and an
 * `Examples` / `Notes` section after the options.
 */
export function describeCommand(cmd: Command, help: CommandHelp): Command {
  helpByCommand.set(cmd, help);
  cmd.summary(help.summary);
  cmd.description(help.description ?? help.summary);
  const after = formatHelpSections(help);
  if (after) cmd.addHelpText('after', after);
  return cmd;
}

/** The notes as rendered, standard ones first. */
export function helpNotes(help: CommandHelp): string[] {
  const notes: string[] = [];
  if (help.json) notes.push(`With --json, stdout is one JSON object: ${help.json}`);
  if (help.browserOnly) notes.push(BROWSER_ONLY_NOTE);
  if (help.confirms) notes.push(CONFIRM_NOTE);
  return notes.concat(help.notes ?? []);
}

/**
 * The text appended after the options, starting with a blank line; '' when
 * there is nothing to add. Examples are never wrapped, so each stays one
 * copy-pasteable line; notes wrap with a hanging indent.
 */
export function formatHelpSections(help: CommandHelp, width = HELP_WIDTH): string {
  const sections: string[] = [];
  const examples = help.examples ?? [];
  if (examples.length > 0) {
    sections.push(['Examples:', ...examples.map((example) => `  ${example}`)].join('\n'));
  }
  const notes = helpNotes(help);
  if (notes.length > 0) {
    sections.push(['Notes:', ...notes.map((note) => wrapText(note, width, '  - ', '    '))].join('\n'));
  }
  return sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '';
}

/**
 * Word-wrap `text` to `width` columns. The first line starts with `first`,
 * the rest with `rest`. A word longer than the line (a URL) is kept whole.
 */
export function wrapText(text: string, width: number, first = '', rest = first): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of words) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (empty ? '' : ' ') + word;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join('\n');
}

/** Full command path as typed, e.g. `slackcli conversations members list`. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** True when the command does something itself, rather than only grouping others. */
export function isRunnable(cmd: Command): boolean {
  return cmd.commands.length === 0 || Boolean((cmd as unknown as { _actionHandler?: unknown })._actionHandler);
}

/**
 * Every subcommand under its group, one line each, built from the registered
 * commands so it cannot go stale.
 */
export function renderCommandTree(program: Command, width = HELP_WIDTH): string {
  const helper = new Help();
  const rows: Array<{ term: string; text: string } | null> = [];
  const visit = (cmd: Command) => {
    rows.push({ term: commandPath(cmd).replace(/^\S+ /, ''), text: helper.subcommandDescription(cmd) });
    cmd.commands.forEach(visit);
  };
  program.commands.forEach((group, i) => {
    if (i > 0) rows.push(null);
    visit(group);
  });
  const pad = Math.max(...rows.map((row) => row?.term.length ?? 0)) + 2;
  const lines = rows.map((row) => {
    if (!row) return '';
    const term = `  ${row.term.padEnd(pad)}`;
    return wrapText(row.text, width, term, ' '.repeat(term.length));
  });
  return ['Commands:', ...lines].join('\n');
}

export function renderRootFooter(width = HELP_WIDTH): string {
  const item = (text: string) => wrapText(text, width, '  ', '  ');
  const env = (name: string, text: string) => wrapText(`${name.padEnd(28)}${text}`, width, '  ', ' '.repeat(30));
  return [
    'Workspace:',
    item(
      'Commands act on the stored default workspace (the first one you log in to; change it with ' +
        '"slackcli auth set-default"). Pick another for one call with --workspace <id|name>, ' +
        'or for a whole shell with SLACKCLI_WORKSPACE. The flag wins over the variable.',
    ),
    '',
    'Environment:',
    env('SLACKCLI_WORKSPACE', 'Workspace to use when --workspace is not given'),
    env('SLACKCLI_LOG_LEVEL', `Log level: ${LOG_LEVEL_SETTINGS.join(', ')} (default info)`),
    env('SLACKCLI_LOG_DIR', 'Directory for the diagnostic log (see "slackcli logs path")'),
    env('SLACKCLI_BROWSER', 'Browser executable for "auth login-auto"'),
    env('SLACKCLI_BROWSER_PROFILE', 'Browser profile directory for "auth login-auto"'),
    env('SLACKCLI_NO_UPDATE_NOTIFIER', 'Set to 1 to turn off the update notice (also off when CI is set)'),
    '',
    'Output:',
    item(
      'Every command that returns data accepts --json: stdout then carries exactly one JSON object, ' +
        'and progress and errors go to stderr. Failures exit 1.',
    ),
    '',
    'Help:',
    item('Run "slackcli <command> --help" for its options, examples and notes.'),
  ].join('\n');
}

/**
 * Root help: replace the default list of 13 groups with the full command tree,
 * then the footer. Only the root changes; groups keep Commander's own list.
 */
export function installRootHelp(program: Command): void {
  program.configureHelp({
    visibleCommands: (cmd: Command) => (cmd === program ? [] : new Help().visibleCommands(cmd)),
  });
  program.addHelpText('after', () => `\n${renderCommandTree(program)}\n\n${renderRootFooter()}\n`);
}

/**
 * Point at the failing command's help after a usage error (unknown option,
 * missing argument). Applied to every command in the tree, because
 * `addCommand()` does not pass the setting down.
 */
export function installUsageErrorHint(root: Command): void {
  const install = (cmd: Command) => {
    cmd.showHelpAfterError(USAGE_ERROR_HINT(commandPath(cmd)));
    cmd.commands.forEach(install);
  };
  install(root);
}
