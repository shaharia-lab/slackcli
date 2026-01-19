#!/usr/bin/env bun

import { Command } from 'commander';
import { createAuthCommand } from './commands/auth.ts';
import { createConversationsCommand } from './commands/conversations.ts';
import { createDraftsCommand } from './commands/drafts.ts';
import { createFilesCommand } from './commands/files.ts';
import { createMessagesCommand } from './commands/messages.ts';
import { createSearchCommand } from './commands/search.ts';
import { createUpdateCommand } from './commands/update.ts';
import { checkForUpdates } from './lib/updater.ts';
import chalk from 'chalk';

const program = new Command();

program
  .name('slackcli')
  .description('A fast, developer-friendly CLI tool for interacting with Slack workspaces')
  .version('0.1.2');

// Add commands
program.addCommand(createAuthCommand());
program.addCommand(createConversationsCommand());
program.addCommand(createDraftsCommand());
program.addCommand(createFilesCommand());
program.addCommand(createMessagesCommand());
program.addCommand(createSearchCommand());
program.addCommand(createUpdateCommand());

// Check for updates asynchronously (non-blocking)
checkForUpdates(true).catch(() => {
  // Silently fail update check
});

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

