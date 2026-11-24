// users set-status / clear-status at the client: the profile users.profile.set
// receives, and the bot-token refusal before any request.
import { describe, expect, it, spyOn } from 'bun:test';
import {
  PROFILE_STATUS_AUTH_MESSAGE,
  SlackClient,
  checkStatusText,
  type ProfileStatusFields,
} from './slack-client.ts';
import { InvalidInputError, UnsupportedAuthTypeError } from './cli-errors.ts';
import { isReadMethod } from './retry.ts';
import type { WorkspaceConfig } from '../types/index.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-test',
  xoxc_token: 'xoxc-test',
  workspace_url: 'https://acme.slack.com',
};

const USER: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Acme',
  auth_type: 'standard',
  token: 'xoxp-test',
  token_type: 'user',
};

const BOT: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Acme',
  auth_type: 'standard',
  token: 'xoxb-test',
  token_type: 'bot',
};

const FIELDS: ProfileStatusFields = {
  status_text: 'Out of office',
  status_emoji: ':palm_tree:',
  status_expiration: 0,
};

type Call = { method: string; params: Record<string, unknown> };

function clientFor(config: WorkspaceConfig): { client: SlackClient; calls: Call[] } {
  const client = new SlackClient(config);
  const calls: Call[] = [];
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    return { ok: true };
  });
  return { client, calls };
}

describe('setOwnStatus', () => {
  it('sends status text, emoji, and no expiry on a user token', async () => {
    const { client, calls } = clientFor(USER);

    const result = await client.setOwnStatus({ status_text: 'Out of office', status_emoji: ':palm_tree:' });

    expect(result).toEqual(FIELDS);
    expect(calls).toEqual([{
      method: 'users.profile.set',
      params: { profile: JSON.stringify(FIELDS) },
    }]);
  });

  it('sends the same profile on a browser session', async () => {
    const { client, calls } = clientFor(BROWSER);

    await client.setOwnStatus({ status_text: 'Out of office', status_emoji: ':palm_tree:' });

    expect(calls).toEqual([{
      method: 'users.profile.set',
      params: { profile: JSON.stringify(FIELDS) },
    }]);
  });

  it('clears by sending empty text and emoji', async () => {
    const { client, calls } = clientFor(USER);
    const cleared: ProfileStatusFields = { status_text: '', status_emoji: '', status_expiration: 0 };

    const result = await client.setOwnStatus({ status_text: '', status_emoji: '' });

    expect(result).toEqual(cleared);
    expect(calls).toEqual([{
      method: 'users.profile.set',
      params: { profile: JSON.stringify(cleared) },
    }]);
  });

  it('refuses a bot token before making a request', async () => {
    const { client, calls } = clientFor(BOT);

    await expect(client.setOwnStatus({ status_text: 'Out', status_emoji: ':palm_tree:' }))
      .rejects.toThrow(UnsupportedAuthTypeError);
    await expect(client.setOwnStatus({ status_text: 'Out', status_emoji: ':palm_tree:' }))
      .rejects.toThrow(PROFILE_STATUS_AUTH_MESSAGE);
    expect(calls).toEqual([]);
    expect(PROFILE_STATUS_AUTH_MESSAGE).toContain('bot token');
  });

  it('is not retried after an ambiguous failure', () => {
    expect(isReadMethod('users.profile.set')).toBe(false);
  });
});

describe('checkStatusText', () => {
  it('accepts 100 characters and a string whose code points fit', () => {
    expect(() => checkStatusText('a'.repeat(100))).not.toThrow();
    expect(() => checkStatusText('👍'.repeat(60))).not.toThrow();
  });

  it('rejects text past 100 characters', () => {
    expect(() => checkStatusText('a'.repeat(101))).toThrow(InvalidInputError);
  });
});
