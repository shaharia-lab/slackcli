import { Command } from 'commander';
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
import { installRootHelp, installUsageErrorHint } from './lib/help.ts';
import { installUsageErrorLogging, startLogging } from './lib/logger.ts';
import { installProcessErrorHandlers } from './lib/process-errors.ts';
import { setJsonErrorMode } from './lib/command-errors.ts';
import { getAppVersion } from './version.ts';

/**
 * Build the whole command tree. Kept apart from `src/index.ts`, which parses
 * at import time, so tests can build and walk the same tree the CLI runs.
 */
export function createProgram(): Command {
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
    // Before the action, so even an error no command caught is reported as JSON.
    setJsonErrorMode(actionCommand.opts().json === true);
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

  // After every addCommand(): both walk the tree as it is now. A usage error is
  // rejected before preAction runs, so it is logged from the failing command's
  // exit override instead, after the --help pointer has been printed.
  installRootHelp(program);
  installUsageErrorHint(program);
  installUsageErrorLogging(program, {
    verbose: () => Boolean(program.opts().verbose),
    loggingStarted: () => loggingStarted,
  });

  return program;
}
