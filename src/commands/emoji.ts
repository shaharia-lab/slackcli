import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { formatEmoji, formatEmojiList, writeJson } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { fetchCustomEmoji, filterEmojiByName, getCustomEmoji, parseEmojiLimit } from '../lib/emoji.ts';
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

        console.log('\n' + formatEmojiList(emojiList));
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

        console.log('\n' + formatEmoji(found));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch custom emoji' });
      }
    });

  return emoji;
}
