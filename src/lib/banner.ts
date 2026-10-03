import { Chalk } from 'chalk';

// The welcome screen bare `slackcli` prints in an interactive terminal (#325).
// Everything here is pure: the entry point passes in the version, terminal
// width and capability flags, so every variant is testable without a terminal.

export const REPO_URL = 'https://github.com/shaharia-lab/slackcli';
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new/choose`;

// 7-bit ASCII only, so it renders the same in cmd, PowerShell and every
// POSIX terminal. String.raw keeps the backslashes and backticks literal.
export const LOGO_LINES: readonly string[] = [
  String.raw`   _____ _            _     _____ _      _____`,
  String.raw`  / ____| |          | |   / ____| |    |_   _|`,
  String.raw` | (___ | | __ _  ___| | _| |    | |      | |`,
  String.raw`  \___ \| |/ _${'`'} |/ __| |/ / |    | |      | |`,
  String.raw`  ____) | | (_| | (__|   <| |____| |____ _| |_`,
  String.raw` |_____/|_|\__,_|\___|_|\_\\_____|______|_____|`,
];

export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => line.length));

// Space between the logo's last line and the version beside it.
const VERSION_GAP = '   ';

export interface BannerOptions {
  version: string;
  /** Terminal width in columns. */
  columns: number;
  /** Whether the terminal can show the star emoji. */
  unicode: boolean;
  /** Whether to emit ANSI colour codes. */
  color: boolean;
}

/** True only for a bare `slackcli` (no arguments at all) writing to a terminal. */
export function shouldShowBanner({ args, isTTY }: { args: readonly string[]; isTTY: boolean | undefined }): boolean {
  return args.length === 0 && isTTY === true;
}

/**
 * Whether the terminal is known to render Unicode. The same rules as the
 * `is-unicode-supported` package `ora` uses, kept here rather than imported
 * because it is only a transitive dependency.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return env.TERM !== 'linux'; // the Linux kernel console
  }
  return Boolean(env.WT_SESSION) // Windows Terminal
    || Boolean(env.TERMINUS_SUBLIME)
    || env.ConEmuTask === '{cmd::Cmder}'
    || env.TERM_PROGRAM === 'Terminus-Sublime'
    || env.TERM_PROGRAM === 'vscode'
    || env.TERM === 'xterm-256color'
    || env.TERM === 'alacritty'
    || env.TERM === 'rxvt-unicode'
    || env.TERM === 'rxvt-unicode-256color'
    || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}

/**
 * Whether to colour the banner. chalk's own detection (`colorLevel`) honours
 * FORCE_COLOR and dumb terminals but not NO_COLOR, so that is checked here:
 * per no-color.org, a NO_COLOR that is present and non-empty disables colour.
 */
export function shouldUseColor(env: NodeJS.ProcessEnv, colorLevel: number): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return false;
  }
  return colorLevel > 0;
}

/** Builds the welcome screen, ending with a newline. */
export function renderBanner({ version, columns, unicode, color }: BannerOptions): string {
  const c = new Chalk({ level: color ? 1 : 0 });
  const versionLabel = `v${version}`;
  const lines: string[] = [];

  if (columns >= LOGO_WIDTH) {
    const logo = LOGO_LINES.map((line) => c.bold(line));
    if (LOGO_WIDTH + VERSION_GAP.length + versionLabel.length <= columns) {
      const last = LOGO_LINES[LOGO_LINES.length - 1].padEnd(LOGO_WIDTH);
      logo[logo.length - 1] = c.bold(last) + VERSION_GAP + c.dim(versionLabel);
    } else {
      logo.push(`  ${c.dim(versionLabel)}`);
    }
    lines.push(...logo);
  } else {
    lines.push(`  ${c.bold('SlackCLI')} ${c.dim(versionLabel)}`);
  }

  const bar = c.yellow('|');
  const star = unicode ? '⭐' : '*';
  const starText = `${star} Like SlackCLI? Star the repo to support it!`;
  lines.push(
    '',
    '  Slack from your terminal, for humans and AI agents.',
    `  Run  ${c.bold('slackcli --help')}  to see all commands.`,
    '',
    `  ${bar} ${c.bold(starText)}`,
    `  ${bar}    ${c.cyan(REPO_URL)}`,
    '',
    '  Report a bug or request a feature:',
    `  ${c.cyan(NEW_ISSUE_URL)}`,
  );

  return lines.join('\n') + '\n';
}
