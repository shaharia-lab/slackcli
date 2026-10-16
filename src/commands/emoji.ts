import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatEmoji, formatEmojiList, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import {
  addCustomEmoji,
  addCustomEmojiAlias,
  EMOJI_MAX_BYTES,
  fetchCustomEmoji,
  filterEmojiByName,
  getCustomEmoji,
  parseEmojiLimit,
  removeCustomEmoji,
  resolveAddMode,
  validateEmojiName,
} from '../lib/emoji.ts';
import { checkUploadFile, EMOJI_WRITE_AUTH_MESSAGE } from '../lib/slack-client.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import { confirmWrite } from './usergroups.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError, NotFoundError } from '../lib/cli-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'View a workspace\'s custom emoji',
    description:
      'View the workspace\'s custom emoji (the uploaded ones, not the built-in Unicode set). ' +
      'Works with both auth types.',
  },
  list: {
    summary: 'List the workspace\'s custom emoji',
    fields: 'each item of emoji',
    description:
      'List every custom emoji in the workspace, sorted by name, originals and aliases. Use ' +
      '"emoji get" to look up one emoji by name.',
    examples: [
      'slackcli emoji list',
      'slackcli emoji list --filter party',
      'slackcli emoji list --no-aliases --limit 50',
      'slackcli emoji list --json',
    ],
    json:
      '{ emoji_count, emoji: [{ name, is_alias, url, alias_for }] } — url for an original, ' +
      'alias_for (the target name) for an alias.',
    notes: [
      'The whole list is fetched in one call; --no-aliases, then --filter, then --limit are applied locally.',
      '--filter keeps emoji whose name contains the substring, case-insensitive (not a Slack search). Slack has no emoji search, so this is a local match over the full list — the same thing the composer\'s :name… autocomplete does. Surrounding colons are stripped (--filter :kiro: == --filter kiro); an empty value is rejected.',
      'A workspace with no custom emoji prints nothing on stdout, even with --json (exit 0).',
    ],
  },
  get: {
    summary: 'Show details for a single custom emoji',
    fields: 'the emoji record',
    description:
      'Show one custom emoji: an original with its image URL, or an alias with the emoji it ' +
      'points at. Use "emoji list" to browse them all.',
    examples: [
      'slackcli emoji get party-parrot',
      'slackcli emoji get :party-parrot: --json',
    ],
    json: '{ name, is_alias, url, alias_for } — the emoji; url for an original, alias_for for an alias.',
    notes: [
      'The name matches exactly, with or without the surrounding colons. Built-in emoji are not found.',
      'No custom emoji by that name: exits 1.',
    ],
  },
  add: {
    summary: 'Add a custom emoji or an alias',
    description:
      'Upload a local image as a new custom emoji (--file), or create an alias of an existing ' +
      'emoji (--alias-for). Requires browser authentication — Slack has no app-token path for ' +
      'custom-emoji writes.',
    examples: [
      'slackcli emoji add party-kiro --file ./party-kiro.png',
      'slackcli emoji add r7 --alias-for rapid7',
      'slackcli emoji add party-kiro --file ./party-kiro.png --json',
    ],
    json: '{ name, is_alias, alias_for? } — the added emoji; alias_for only for an alias.',
    dryRun: true,
    browserOnly: true,
    notes: [
      '--file and --alias-for are mutually exclusive; exactly one is required.',
      'The name may use only lower-case letters, digits, dashes and underscores.',
      'A --file image over 128×128 / 64 KB is warned about (not blocked); Slack downscales.',
    ],
  },
  remove: {
    summary: 'Remove a custom emoji',
    description:
      'Delete a custom emoji by name. Idempotent: removing one that does not exist succeeds as ' +
      'a no-op. Requires browser authentication.',
    examples: [
      'slackcli emoji remove party-kiro',
      'slackcli emoji remove party-kiro --yes',
      'slackcli emoji remove :party-kiro: --json',
    ],
    json: '{ name, removed, already_removed } — removed true on a real delete, already_removed true when it was already gone.',
    dryRun: true,
    browserOnly: true,
    confirms: true,
    notes: [
      'The name matches with or without the surrounding colons.',
      'Removal affects the whole workspace, so it prompts to confirm unless --yes is given.',
      'Removing a non-existent emoji still exits 0 (idempotent). A policy denial (e.g. enterprise_is_restricted) is a real permission error, not a no-op.',
    ],
  },
} satisfies Record<string, CommandHelp>;

export function createEmojiCommand(): Command {
  const emoji = describeCommand(new Command('emoji'), HELP.group);

  describeCommand(emoji.command('list'), HELP.list)
    .option('--limit <number>', 'Maximum number of emoji to return (a positive integer)')
    .option('--filter <substring>', 'Only emoji whose name contains this substring (case-insensitive)')
    .option('--no-aliases', 'Exclude alias emoji, showing only originals')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options) => {
      const spinner = ora('Fetching custom emoji...').start();

      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);

        let emojiList = await fetchCustomEmoji(client, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        // `--no-aliases` sets options.aliases to false (Commander convention).
        if (options.aliases === false) {
          emojiList = emojiList.filter(e => !e.is_alias);
        }

        // `--filter` narrows by name substring (case-insensitive) before the
        // limit, so `--limit` means "top N of the matches". An empty value is
        // rejected the same way a bad `--limit` is.
        if (options.filter !== undefined) {
          const { emoji: filtered, error: filterError } = filterEmojiByName(emojiList, options.filter);
          if (filterError !== undefined || filtered === undefined) {
            failCommand(new InvalidInputError(filterError ?? 'Invalid filter'), { json: options.json, spinner, context: 'Invalid filter' });
            return;
          }
          emojiList = filtered;
        }

        if (options.limit !== undefined) {
          const { limit, error: limitError } = parseEmojiLimit(options.limit);
          if (limitError !== undefined) {
            failCommand(new InvalidInputError(limitError), { json: options.json, spinner, context: 'Invalid limit' });
            return;
          }
          emojiList = emojiList.slice(0, limit);
        }

        if (emojiList.length === 0) {
          spinner.succeed('No custom emoji found');
          return;
        }

        spinner.succeed(`Found ${emojiList.length} custom emoji`);

        if (options.json) {
          writeJson(applyFields('emoji list', { emoji_count: emojiList.length, emoji: emojiList }, fields));
          return;
        }

        writeText('\n' + formatEmojiList(emojiList));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch custom emoji' });
      }
    });

  describeCommand(emoji.command('get'), HELP.get)
    .argument('<name>', 'Emoji name, with or without surrounding colons')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (name, options) => {
      const spinner = ora('Fetching custom emoji...').start();

      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);

        const found = await getCustomEmoji(client, name, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        if (!found) {
          failCommand(new NotFoundError(`No custom emoji named :${name.replace(/^:|:$/g, '')}:`), {
            json: options.json,
            spinner,
          });
          return;
        }

        spinner.succeed(`Found :${found.name}:`);

        if (options.json) {
          writeJson(applyFields('emoji get', found, fields));
          return;
        }

        writeText('\n' + formatEmoji(found));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch custom emoji' });
      }
    });

  describeCommand(emoji.command('add'), HELP.add)
    .argument('<name>', 'Emoji name, with or without surrounding colons')
    .option('--file <path>', 'Local image file to upload as a new emoji')
    .option('--alias-for <existing>', 'Create an alias of this existing emoji')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (name, options) => {
      const spinner = ora('Adding custom emoji...').start();

      try {
        const { name: validName, error: nameError } = validateEmojiName(name);
        if (nameError !== undefined || validName === undefined) {
          failCommand(new InvalidInputError(nameError ?? 'Invalid emoji name'), { json: options.json, spinner, context: 'Invalid emoji name' });
          return;
        }

        const { mode, error: modeError } = resolveAddMode(options);
        if (modeError !== undefined || mode === undefined) {
          failCommand(new InvalidInputError(modeError ?? 'Invalid arguments'), { json: options.json, spinner, context: 'Invalid arguments' });
          return;
        }

        const aliasTarget = mode === 'alias' ? options.aliasFor.replace(/^:|:$/g, '') : undefined;
        let fileSize: number | undefined;
        if (mode === 'data') {
          const checked = await checkUploadFile(options.file);
          fileSize = checked.size;
        }

        const client = await getAuthenticatedClient(options.workspace);
        client.requireBrowserAuth(EMOJI_WRITE_AUTH_MESSAGE);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              mode === 'data' ? 'add emoji' : 'add emoji alias',
              { kind: 'emoji', id: validName, name: validName },
              mode === 'data' ? { file: options.file, bytes: fileSize } : { alias_for: aliasTarget },
            ),
            options.json,
          );
          return;
        }

        spinner.start('Adding custom emoji...');
        if (mode === 'data' && fileSize !== undefined && fileSize > EMOJI_MAX_BYTES) {
          spinner.warn(`Image is ${Math.round(fileSize / 1024)} KB; Slack's guidance is 128×128 / 64 KB — it may be downscaled.`);
          spinner.start('Adding custom emoji...');
        }

        const result = mode === 'data'
          ? await addCustomEmoji(client, validName, options.file)
          : await addCustomEmojiAlias(client, validName, aliasTarget as string);

        if (result.is_alias) {
          spinner.succeed(`Added alias :${result.name}: → :${result.alias_for}:`);
        } else {
          spinner.succeed(`Added :${result.name}:`);
        }

        if (options.json) {
          writeJson(result);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to add custom emoji' });
      }
    });

  describeCommand(emoji.command('remove'), HELP.remove)
    .argument('<name>', 'Emoji name, with or without surrounding colons')
    .option('--yes', 'Confirm removal without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (name, options) => {
      const spinner = ora('Removing custom emoji...').start();

      try {
        const { name: validName, error: nameError } = validateEmojiName(name);
        if (nameError !== undefined || validName === undefined) {
          failCommand(new InvalidInputError(nameError ?? 'Invalid emoji name'), { json: options.json, spinner, context: 'Invalid emoji name' });
          return;
        }

        const client = await getAuthenticatedClient(options.workspace);
        client.requireBrowserAuth(EMOJI_WRITE_AUTH_MESSAGE);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(client, 'remove emoji', { kind: 'emoji', id: validName, name: validName }),
            options.json,
          );
          return;
        }

        // Removal affects the whole workspace, so confirm it like messages delete.
        if (!(await confirmWrite(`Remove :${validName}: for the whole workspace?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          if (!options.json) error(`:${validName}: was not removed`);
          return;
        }

        spinner.start('Removing custom emoji...');
        const result = await removeCustomEmoji(client, validName);

        if (result.already_removed) {
          spinner.succeed(`:${result.name}: did not exist (nothing to remove)`);
        } else {
          spinner.succeed(`Removed :${result.name}:`);
        }

        if (options.json) {
          writeJson(result);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to remove custom emoji' });
      }
    });

  return emoji;
}
