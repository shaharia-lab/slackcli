#!/usr/bin/env bun

import { Command } from 'commander';
import { createAuthCommand } from './commands/auth.ts';
import { createConversationsCommand } from './commands/conversations.ts';
import { createMessagesCommand } from './commands/messages.ts';
import { createCanvasCommand } from './commands/canvas.ts';
import { createEmojiCommand } from './commands/emoji.ts';
import { createFilesCommand } from './commands/files.ts';
import { createUpdateCommand } from './commands/update.ts';
import { createSavedCommand } from './commands/saved.ts';
import { createSearchCommand } from './commands/search.ts';
import { createTeamCommand } from './commands/team.ts';
import { createUsergroupsCommand } from './commands/usergroups.ts';
import { createUsersCommand } from './commands/users.ts';
import { notifyIfUpdateAvailable } from './lib/updater.ts';
import { startLogging } from './lib/logger.ts';
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
program.hook('preAction', (_thisCommand, actionCommand) => {
  startLogging({ verbose: Boolean(program.opts().verbose), actionCommand });
});

// Add commands
program.addCommand(createAuthCommand());
program.addCommand(createCanvasCommand());
program.addCommand(createConversationsCommand());
program.addCommand(createEmojiCommand());
program.addCommand(createFilesCommand());
program.addCommand(createMessagesCommand());
program.addCommand(createSavedCommand());
program.addCommand(createSearchCommand());
program.addCommand(createTeamCommand());
program.addCommand(createUsergroupsCommand());
program.addCommand(createUsersCommand());
program.addCommand(createUpdateCommand());

// Show update notification after command output if a newer version is cached
notifyIfUpdateAvailable();

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
