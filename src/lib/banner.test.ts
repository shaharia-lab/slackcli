import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LOGO_LINES,
  LOGO_WIDTH,
  NEW_ISSUE_URL,
  REPO_URL,
  renderBanner,
  shouldShowBanner,
  shouldUseColor,
  supportsUnicode,
  type BannerOptions,
} from './banner.ts';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, '');
const render = (overrides: Partial<BannerOptions> = {}) =>
  renderBanner({ version: '0.13.0', columns: 80, unicode: true, color: false, ...overrides });

describe('renderBanner', () => {
  it('renders the agreed screen exactly', () => {
    expect(render()).toBe([
      String.raw`   _____ _            _     _____ _      _____`,
      String.raw`  / ____| |          | |   / ____| |    |_   _|`,
      String.raw` | (___ | | __ _  ___| | _| |    | |      | |`,
      String.raw`  \___ \| |/ _` + '`' + String.raw` |/ __| |/ / |    | |      | |`,
      String.raw`  ____) | | (_| | (__|   <| |____| |____ _| |_`,
      String.raw` |_____/|_|\__,_|\___|_|\_\\_____|______|_____|   v0.13.0`,
      '',
      '  Slack from your terminal, for humans and AI agents.',
      '  Run  slackcli --help  to see all commands.',
      '',
      '  | ⭐ Like SlackCLI? Star the repo to support it!',
      '  |    https://github.com/shaharia-lab/slackcli',
      '',
      '  Report a bug or request a feature:',
      '  https://github.com/shaharia-lab/slackcli/issues/new/choose',
      '',
    ].join('\n'));
  });

  it('points at the repository and the issue chooser', () => {
    expect(REPO_URL).toBe('https://github.com/shaharia-lab/slackcli');
    expect(NEW_ISSUE_URL).toBe('https://github.com/shaharia-lab/slackcli/issues/new/choose');
  });

  it('interpolates the version it is given', () => {
    const out = render({ version: '1.2.3-beta.4' });
    expect(out).toContain('v1.2.3-beta.4');
    expect(out).not.toContain('0.13.0');
  });

  it('keeps the logo and the bar 7-bit ASCII', () => {
    for (const line of LOGO_LINES) {
      expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
    for (const line of render().split('\n').filter((l) => l.startsWith('  |'))) {
      expect(line.slice(0, 4)).toBe('  | ');
    }
  });

  it('has the star emoji as its only non-ASCII character', () => {
    const nonAscii = [...render()].filter((ch) => ch.charCodeAt(0) > 0x7e && ch !== '\n');
    expect(nonAscii).toEqual(['⭐']);
  });

  it('falls back to * when Unicode is not supported', () => {
    const out = render({ unicode: false });
    expect(out).toContain('  | * Like SlackCLI? Star the repo to support it!');
    expect(out).toMatch(/^[\x00-\x7e]*$/);
  });

  it('emits no ANSI codes with colour off, and the same text with colour on', () => {
    const plain = render({ color: false });
    const coloured = render({ color: true });
    expect(plain).not.toMatch(ANSI);
    expect(coloured).toMatch(ANSI);
    expect(strip(coloured)).toBe(plain);
  });

  it('colours the bar yellow and the star line bold', () => {
    const lines = render({ color: true }).split('\n');
    const starLine = lines.find((l) => l.includes('Like SlackCLI'))!;
    expect(starLine).toContain('\u001b[33m|\u001b[39m');
    expect(starLine).toContain('\u001b[1m⭐ Like SlackCLI? Star the repo to support it!\u001b[22m');
  });

  it('measures the logo at its widest line', () => {
    expect(LOGO_WIDTH).toBe(47);
    expect(LOGO_LINES).toHaveLength(6);
  });

  it('shows the logo at exactly its width and a text title one column narrower', () => {
    const atWidth = render({ columns: LOGO_WIDTH });
    expect(atWidth).toContain(LOGO_LINES[0]);

    const narrow = render({ columns: LOGO_WIDTH - 1 });
    expect(narrow.split('\n')[0]).toBe('  SlackCLI v0.13.0');
    for (const line of LOGO_LINES) {
      expect(narrow).not.toContain(line);
    }
  });

  it('adds nothing wider than the logo-free text when the terminal is narrow', () => {
    const narrowLines = render({ columns: 20 }).split('\n');
    const textLines = render().split('\n').slice(LOGO_LINES.length);
    const widest = (lines: string[]) => Math.max(...lines.map((l) => l.length));
    expect(widest(narrowLines)).toBe(widest(textLines));
    expect(narrowLines.slice(1)).toEqual(textLines);
  });

  it('moves the version under the logo when it does not fit beside it', () => {
    const lines = render({ columns: LOGO_WIDTH + 2 }).split('\n');
    expect(lines[LOGO_LINES.length - 1]).toBe(LOGO_LINES[LOGO_LINES.length - 1]);
    expect(lines[LOGO_LINES.length]).toBe('  v0.13.0');
    expect(Math.max(...lines.slice(0, LOGO_LINES.length + 1).map((l) => l.length))).toBeLessThanOrEqual(LOGO_WIDTH + 2);
  });

  it('places the version beside the logo once there is exactly room for it', () => {
    const columns = LOGO_WIDTH + '   v0.13.0'.length;
    const lines = render({ columns }).split('\n');
    expect(lines[LOGO_LINES.length - 1]).toHaveLength(columns);
    expect(lines[LOGO_LINES.length - 1].endsWith('   v0.13.0')).toBe(true);
  });

  it('carries no workspace data or token-looking text', () => {
    expect(render()).not.toMatch(/xox[a-z]-|workspace_id|T0[0-9A-Z]{6,}/);
  });
});

describe('shouldShowBanner', () => {
  it.each([
    [[], true, true],
    [[], false, false],
    [[], undefined, false],
    [['--help'], true, false],
    [['help'], true, false],
    [['--version'], true, false],
    [['-v'], true, false],
    [['auth', 'list'], true, false],
    [[''], true, false],
  ] as const)('args=%j isTTY=%p → %p', (args, isTTY, expected) => {
    expect(shouldShowBanner({ args, isTTY })).toBe(expected);
  });
});

describe('supportsUnicode', () => {
  it('is on for POSIX terminals except the Linux kernel console', () => {
    expect(supportsUnicode({ TERM: 'xterm-256color' }, 'linux')).toBe(true);
    expect(supportsUnicode({}, 'darwin')).toBe(true);
    expect(supportsUnicode({ TERM: 'linux' }, 'linux')).toBe(false);
  });

  it('is off for a legacy Windows console', () => {
    expect(supportsUnicode({}, 'win32')).toBe(false);
    expect(supportsUnicode({ TERM_PROGRAM: 'other' }, 'win32')).toBe(false);
  });

  it.each([
    { WT_SESSION: 'abc' },
    { TERM_PROGRAM: 'vscode' },
    { TERM: 'xterm-256color' },
    { TERM: 'alacritty' },
    { ConEmuTask: '{cmd::Cmder}' },
    { TERMINAL_EMULATOR: 'JetBrains-JediTerm' },
  ])('is on for a known modern Windows terminal: %j', (env) => {
    expect(supportsUnicode(env, 'win32')).toBe(true);
  });
});

describe('shouldUseColor', () => {
  it('follows chalk\'s detected level', () => {
    expect(shouldUseColor({}, 0)).toBe(false);
    expect(shouldUseColor({}, 1)).toBe(true);
    expect(shouldUseColor({}, 3)).toBe(true);
  });

  it('turns colour off for a non-empty NO_COLOR, whatever its value', () => {
    expect(shouldUseColor({ NO_COLOR: '1' }, 3)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: '0' }, 3)).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(shouldUseColor({ NO_COLOR: '' }, 1)).toBe(true);
  });
});

// The entry point wiring, through real subprocesses: bare `slackcli` from a
// pipe must behave exactly as before, and only a terminal gets the banner.
describe('bare slackcli through the CLI', () => {
  const root = resolve(import.meta.dir, '../..');
  const entry = join(root, 'src/index.ts');
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slackcli-banner-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, HOME: home, SLACKCLI_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
  const run = (args: string[]) => {
    const result = Bun.spawnSync([process.execPath, 'run', entry, ...args], { cwd: root, stdin: 'ignore', env: env() });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  it('prints plain help to stderr and exits 1 when stdout is not a TTY', () => {
    const bare = run([]);
    const help = run(['--help']);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toBe(help.stdout);
    expect(bare.stderr).toStartWith('Usage: slackcli');
    expect(bare.stderr).not.toContain(REPO_URL);
  }, 30_000);

  it('keeps --help and help free of the banner', () => {
    for (const args of [['--help'], ['help']]) {
      const out = run(args);
      expect(out.stdout + out.stderr).toContain('Usage: slackcli');
      expect(out.stdout + out.stderr).not.toContain(LOGO_LINES[0]);
      expect(out.stdout + out.stderr).not.toContain('Star the repo');
    }
  }, 30_000);

  // `script` (util-linux) gives the child a pseudo-terminal, so stdout is a TTY.
  const hasScript = process.platform === 'linux' && Bun.which('script') !== null;
  it.skipIf(!hasScript)('prints the banner to stdout and exits 0 in a terminal', () => {
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const command = `${quote(process.execPath)} run ${quote(entry)}; echo "EXIT=$?"`;
    const result = Bun.spawnSync(['script', '-qec', command, '/dev/null'], { cwd: root, stdin: 'ignore', env: env() });
    const out = result.stdout.toString().replace(/\r\n/g, '\n');
    expect(out).toContain('Slack from your terminal, for humans and AI agents.');
    expect(out).toContain(NEW_ISSUE_URL);
    expect(out).not.toContain('Usage: slackcli');
    expect(out).not.toMatch(ANSI);
    expect(out).toContain('EXIT=0');
  }, 30_000);
});
