import { getLogger } from '@logtape/logtape';
import type { SlackClient } from './slack-client.ts';
import { formatDryRun, writeJson } from './formatter.ts';
import type { DryRunPreview, DryRunTarget } from '../types/index.ts';

// `--dry-run` on the write commands (#328): the command resolves and validates
// everything as usual, then hands the result here instead of making the write.
// Building, printing and logging the preview in one place keeps every command
// reporting the same fields.

const logger = getLogger(['slackcli', 'dry-run']);

/** The option every Slack-writing command registers. */
export const DRY_RUN_FLAG = '--dry-run';
export const DRY_RUN_DESCRIPTION = 'Show what would be done without doing it';

type NameLookupClient = Pick<SlackClient, 'getConversationInfo' | 'getUserInfo'>;

/**
 * A display name for a channel or user ID: `#general`, `@alice`. Best effort:
 * these are read calls made only so a human can check the target, so any
 * failure (no scope, not found, a DM channel with no name) gives undefined
 * rather than failing the preview. The write itself never needed them.
 */
export async function lookupTargetName(client: NameLookupClient, id: string): Promise<string | undefined> {
  try {
    if (/^[UW]/.test(id)) {
      const user = (await client.getUserInfo(id))?.user;
      return typeof user?.name === 'string' && user.name ? `@${user.name}` : undefined;
    }
    if (/^[CGD]/.test(id)) {
      const channel = (await client.getConversationInfo(id))?.channel;
      return typeof channel?.name === 'string' && channel.name ? `#${channel.name}` : undefined;
    }
  } catch {
    // A failed lookup only costs the preview its display name.
  }
  return undefined;
}

/**
 * Assemble a preview. With `lookupName`, the target's display name is looked
 * up (read calls only); a name already set on the target is kept. Payload
 * fields that are undefined are dropped, so text and JSON show only what
 * would actually be sent.
 */
export async function buildPreview(
  client: Pick<SlackClient, 'workspaceIdentity'> & NameLookupClient,
  action: string,
  target: DryRunTarget,
  payload: Record<string, unknown> = {},
  options: { lookupName?: boolean } = {},
): Promise<DryRunPreview> {
  let name = target.name;
  if (name === undefined && options.lookupName && target.id) {
    name = await lookupTargetName(client, target.id);
  }
  return {
    dry_run: true,
    action,
    workspace: client.workspaceIdentity,
    target: withoutUndefined({ ...target, name }),
    payload: withoutUndefined(payload),
  };
}

/**
 * Print the preview on stdout (one JSON object under --json) and log that a
 * dry run happened. The log carries the action and counts only, never the
 * target or the content.
 */
export function emitDryRun(preview: DryRunPreview, json: boolean | undefined): void {
  logger.info('Dry run of {action}', {
    dry_run: true,
    action: preview.action,
    payload_fields: Object.keys(preview.payload).length,
  });
  if (json) {
    writeJson(preview);
  } else {
    console.log(formatDryRun(preview));
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
