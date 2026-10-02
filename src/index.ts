#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import { createAuthCommand } from './commands/auth.ts';
import { createConversationsCommand } from './commands/conversations.ts';
import { createMessagesCommand } from './commands/messages.ts';
import { createCanvasCommand } from './commands/canvas.ts';
import { createEmojiCommand } from './commands/emoji.ts';
import { createFilesCommand } from './commands/files.ts';
import { createLogsCommand } from './commands/logs.ts';
import { createUpdateCommand } from './commands/update.ts';
import { createSavedCommand } from './commands/saved.ts';
import { createSearchCommand } from './commands/search.ts';
import { createTeamCommand } from './commands/team.ts';
import { createUsergroupsCommand } from './commands/usergroups.ts';
import { createUsersCommand } from './commands/users.ts';
import { notifyIfUpdateAvailable } from './lib/updater.ts';
import { installUsageErrorLogging, startLogging } from './lib/logger.ts';
import { installProcessErrorHandlers } from './lib/process-errors.ts';
import { renderBanner, shouldShowBanner, shouldUseColor, supportsUnicode } from './lib/banner.ts';
import { getAppVersion } from './version.ts';

const program = new Command();

program
  .name('slackcli')
  .description('A fast, developer-friendly CLI tool for interacting with Slack workspaces')
  .version(getAppVersion())
  // Reserved globally: no subcommand may define its own -v.
  .option('-v, --verbose', 'Write debug logs to stderr (the log file is written either way)');

// Logging is configured once, right before the chosen command runs, so help and
// --version stay side-effect free. Libraries log through LogTape categories.
let loggingStarted = false;
program.hook('preAction', (_thisCommand, actionCommand) => {
  loggingStarted = true;
  startLogging({ verbose: Boolean(program.opts().verbose), actionCommand });
  // After logging is configured, so an unhandled error lands in the log file.
  installProcessErrorHandlers();
});

// Add commands
program.addCommand(createAuthCommand());
program.addCommand(createCanvasCommand());
program.addCommand(createConversationsCommand());
program.addCommand(createEmojiCommand());
program.addCommand(createFilesCommand());
program.addCommand(createLogsCommand());
program.addCommand(createMessagesCommand());
program.addCommand(createSavedCommand());
program.addCommand(createSearchCommand());
program.addCommand(createTeamCommand());
program.addCommand(createUsergroupsCommand());
program.addCommand(createUsersCommand());
program.addCommand(createUpdateCommand());

// After every addCommand(): a usage error is rejected before preAction runs, so
// it is logged from the failing command's exit override instead.
installUsageErrorLogging(program, {
  verbose: () => Boolean(program.opts().verbose),
  loggingStarted: () => loggingStarted,
});

// Show update notification after command output if a newer version is cached.
// Not awaited on purpose: the notice prints from a `beforeExit` handler, and
// awaiting would hold up the command on the background release check.
void notifyIfUpdateAvailable();

// Bare `slackcli` in a terminal gets the welcome screen and exits 0. Anything
// else, including a bare run from a script or pipe, goes to Commander, which
// prints help to stderr and exits 1 when no command is given.
if (shouldShowBanner({ args: process.argv.slice(2), isTTY: process.stdout.isTTY })) {
  process.stdout.write(renderBanner({
    version: getAppVersion(),
    columns: process.stdout.columns || 80,
    unicode: supportsUnicode(process.env, process.platform),
    color: shouldUseColor(process.env, chalk.level),
  }));
} else {
  program.parse(process.argv);
}
