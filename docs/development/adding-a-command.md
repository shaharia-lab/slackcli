# Adding a command

A worked example: adding `slackcli conversations members <channel-id>`.

Before writing anything, satisfy the policy: open an issue describing WHAT, WHY
and optionally HOW, and wait for the **`ready-for-pr`** label. See
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## 1. Types first

`src/types/index.ts` — model the data instead of passing `any` around.

```ts
export interface ChannelMember {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
}
```

## 2. Add the API call to `SlackClient`

`src/lib/slack-client.ts`. Go through `this.request()` so both auth types work
for free:

```ts
async listConversationMembers(channel: string, options: {
  cursor?: string;
  limit?: number;
} = {}): Promise<any> {
  const params: Record<string, any> = { channel };
  if (options.cursor) params.cursor = options.cursor;
  if (options.limit) params.limit = options.limit;
  return this.request('conversations.members', params);
}
```

Only branch on `this.config.auth_type` if Slack genuinely offers different
endpoints for the two. If it does, document the divergence in the method, in
`--help`, and in the [user guide](../user-guide/README.md).

## 3. Put the logic in `src/lib/`

If the command needs more than one call — here, resolving member IDs to names —
that belongs in a lib module, not the command file. It keeps the command thin
and makes the logic testable.

```ts
// src/lib/members.ts
export async function fetchChannelMembers(
  client: SlackClient,
  channelId: string,
  options: { limit?: number; onProgress?: (message: string) => void } = {},
): Promise<ChannelMember[]> { /* … */ }
```

The `onProgress` callback is the house convention for feeding spinner text back
to the command layer without the lib knowing about `ora` — see `unread.ts` and
`saved.ts`.

## 4. Add a formatter

`src/lib/formatter.ts`, next to its siblings:

```ts
export function formatChannelMembers(members: ChannelMember[]): string { /* … */ }
```

## 5. Wire up the command

`src/commands/conversations.ts`:

```ts
conversations
  .command('members')
  .description('List the members of a channel')
  .argument('[channel-id]', 'Channel ID or Slack URL')
  .option('--limit <number>', 'Number of members to return', '100')
  .option('--workspace <id|name>', 'Workspace to use')
  .option('--json', 'Output in JSON format', false)
  .action(async (channelIdArg, options) => {
    const spinner = ora('Fetching members...').start();
    try {
      const channelId = normalizeIdentifier(channelIdArg, 'channel', '<channel-id>');
      const client = await getAuthenticatedClient(options.workspace);
      warnOnWorkspaceMismatch(client, workspaceOf(channelIdArg));

      const members = await fetchChannelMembers(client, channelId, {
        limit: parseInt(options.limit),
        onProgress: (msg) => { spinner.text = msg; },
      });

      spinner.succeed(`Found ${members.length} members`);

      if (options.json) {
        writeJson({ channel_id: channelId, member_count: members.length, members });
        return;                          // never process.exit() after writeJson
      }
      console.log('\n' + formatChannelMembers(members));
    } catch (err: any) {
      spinner.fail('Failed to fetch members');
      error(err.message);
      process.exit(1);
    }
  });
```

A new **group** (rather than a subcommand) also needs a
`create<Group>Command()` factory and a `program.addCommand()` line in
`src/index.ts`.

## 6. Tests

`src/lib/members.test.ts`, using a `SlackClient` subclass that overrides
`request()` and records calls. Cover both auth types if the method branches. See
[testing](testing.md).

## 7. Documentation

Update the relevant page under `docs/user-guide/`, and the README if the feature
belongs in the overview. A command that ships undocumented is not finished.

## Checklist

Conventions this codebase holds to — deviating from any of them will come up in
review:

- [ ] Accept a Slack URL wherever an ID is accepted (`normalizeIdentifier`), and
      warn on workspace mismatch.
- [ ] Support `--workspace <id|name>`.
- [ ] Support `--json` on any command that returns data.
- [ ] **Never call `process.exit()` after `writeJson()`** — set
      `process.exitCode` and return. See
      [architecture](architecture.md#output).
- [ ] Spinner via `ora`; libs report progress through an `onProgress` callback.
- [ ] Errors: `spinner.fail(...)`, `error(message)`, `process.exit(1)`.
- [ ] Never print a token value.
- [ ] `bun run type-check` and `bun test` pass; commits are signed.
- [ ] The PR links a `ready-for-pr` issue.
