import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatEmoji, formatEmojiList, writeJson } from '../lib/formatter.ts';
import { fetchCustomEmoji, getCustomEmoji, parseEmojiLimit } from '../lib/emoji.ts';

export function createEmojiCommand(): Command {
  const emoji = new Command('emoji')
    .description('View a workspace\'s custom emoji');

  emoji
    .command('list')
    .description('List the workspace\'s custom emoji')
    .option('--limit <number>', 'Maximum number of emoji to return')
    .option('--no-aliases', 'Exclude alias emoji, showing only originals')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching custom emoji...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let emojiList = await fetchCustomEmoji(client, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        // `--no-aliases` sets options.aliases to false (Commander convention).
        if (options.aliases === false) {
          emojiList = emojiList.filter(e => !e.is_alias);
        }

        if (options.limit !== undefined) {
          const { limit, error: limitError } = parseEmojiLimit(options.limit);
          if (limitError !== undefined) {
            spinner.fail('Invalid limit');
            error(limitError);
            process.exit(1);
          }
          emojiList = emojiList.slice(0, limit);
        }

        if (emojiList.length === 0) {
          spinner.succeed('No custom emoji found');
          return;
        }

        spinner.succeed(`Found ${emojiList.length} custom emoji`);

        if (options.json) {
          writeJson({ emoji_count: emojiList.length, emoji: emojiList });
          return;
        }

        console.log('\n' + formatEmojiList(emojiList));
      } catch (err: any) {
        spinner.fail('Failed to fetch custom emoji');
        error(err.message);
        process.exit(1);
      }
    });

  emoji
    .command('get')
    .description('Show details for a single custom emoji')
    .argument('<name>', 'Emoji name, with or without surrounding colons')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (name, options) => {
      const spinner = ora('Fetching custom emoji...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const found = await getCustomEmoji(client, name, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        if (!found) {
          spinner.fail(`No custom emoji named :${name.replace(/^:|:$/g, '')}:`);
          process.exit(1);
        }

        spinner.succeed(`Found :${found.name}:`);

        if (options.json) {
          writeJson(found);
          return;
        }

        console.log('\n' + formatEmoji(found));
      } catch (err: any) {
        spinner.fail('Failed to fetch custom emoji');
        error(err.message);
        process.exit(1);
      }
    });

  return emoji;
}
