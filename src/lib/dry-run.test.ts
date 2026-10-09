import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { buildPreview, emitDryRun, lookupTargetName } from './dry-run.ts';
import { formatDryRun } from './formatter.ts';
import type { DryRunPreview } from '../types/index.ts';

const WORKSPACE = { name: 'Acme Corp', id: 'T0123456789', profile: 'acme' };

// A client stub answering the two display-name lookups.
function lookupClient(answers: { channel?: () => unknown; user?: () => unknown } = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      workspaceIdentity: WORKSPACE,
      getConversationInfo: async (id: string) => {
        calls.push(`conversations.info ${id}`);
        return (answers.channel ?? (() => ({ channel: { id, name: 'deploys' } })))();
      },
      getUserInfo: async (id: string) => {
        calls.push(`users.info ${id}`);
        return (answers.user ?? (() => ({ user: { id, name: 'alice' } })))();
      },
    } as any,
  };
}

describe('lookupTargetName', () => {
  it.each([
    ['C0123456789', '#deploys', 'conversations.info'],
    ['G0123456789', '#deploys', 'conversations.info'],
    ['D0123456789', '#deploys', 'conversations.info'],
    ['U0123456789', '@alice', 'users.info'],
    ['W0123456789', '@alice', 'users.info'],
  ])('names %s as %s', async (id, name, method) => {
    const { client, calls } = lookupClient();
    expect(await lookupTargetName(client, id)).toBe(name);
    expect(calls).toEqual([`${method} ${id}`]);
  });

  it('makes no call for an ID it cannot name', async () => {
    const { client, calls } = lookupClient();
    expect(await lookupTargetName(client, 'S0123456789')).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('gives undefined when the lookup fails or returns no name', async () => {
    const failing = lookupClient({
      channel: () => { throw new Error('Slack API error: channel_not_found'); },
      user: () => { throw new Error('Slack API error: user_not_found'); },
    });
    expect(await lookupTargetName(failing.client, 'C0123456789')).toBeUndefined();
    expect(await lookupTargetName(failing.client, 'U0123456789')).toBeUndefined();

    const nameless = lookupClient({ channel: () => ({ channel: { id: 'D1' } }), user: () => ({ user: { name: '' } }) });
    expect(await lookupTargetName(nameless.client, 'D0123456789')).toBeUndefined();
    expect(await lookupTargetName(nameless.client, 'U0123456789')).toBeUndefined();

    const empty = lookupClient({ channel: () => undefined, user: () => undefined });
    expect(await lookupTargetName(empty.client, 'C0123456789')).toBeUndefined();
    expect(await lookupTargetName(empty.client, 'U0123456789')).toBeUndefined();
  });
});

describe('buildPreview', () => {
  it('builds the --json contract: dry_run, action, workspace, target, payload', async () => {
    const { client, calls } = lookupClient();
    const preview = await buildPreview(
      client,
      'send message',
      { kind: 'channel', id: 'C0123456789', thread_ts: undefined },
      { text: 'Deploy done', blocks: undefined },
      { lookupName: true },
    );
    expect(preview).toEqual({
      dry_run: true,
      action: 'send message',
      workspace: WORKSPACE,
      target: { kind: 'channel', id: 'C0123456789', name: '#deploys' },
      payload: { text: 'Deploy done' },
    });
    expect(calls).toEqual(['conversations.info C0123456789']);
  });

  it('makes no lookup unless asked, nor when the target already has a name or no ID', async () => {
    const { client, calls } = lookupClient();
    expect((await buildPreview(client, 'join channel', { kind: 'channel', id: 'C0123456789' })).target)
      .toEqual({ kind: 'channel', id: 'C0123456789' });
    await buildPreview(client, 'enable user group', { kind: 'usergroup', id: 'S1', name: 'Platform' }, {}, { lookupName: true });
    await buildPreview(client, 'create user group', { kind: 'usergroup', name: 'Platform' }, {}, { lookupName: true });
    expect(calls).toEqual([]);
  });

  it('keeps falsy payload values that would be sent', async () => {
    const { client } = lookupClient();
    const preview = await buildPreview(client, 'x', { kind: 'channel', id: 'C1' }, { text: '', add: [], noop: false });
    expect(preview.payload).toEqual({ text: '', add: [], noop: false });
  });
});

describe('formatDryRun', () => {
  const preview = (overrides: Partial<DryRunPreview> = {}): DryRunPreview => ({
    dry_run: true,
    action: 'send message',
    workspace: WORKSPACE,
    target: { kind: 'channel', id: 'C0123456789', name: '#deploys' },
    payload: { text: 'Deploy done' },
    ...overrides,
  });
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

  it('renders the issue example', () => {
    expect(plain(formatDryRun(preview()))).toBe([
      'Dry run: nothing was sent.',
      '  Workspace: Acme Corp (acme)',
      '  Action:    send message',
      '  Target:    C0123456789 (#deploys)',
      '  Text:      Deploy done',
    ].join('\n'));
  });

  it('indents every line of multi-line text under its label', () => {
    const text = plain(formatDryRun(preview({ payload: { text: 'line one\nline two' } })));
    expect(text).toContain('  Text:      line one\n             line two');
  });

  it('widens the label column for a long payload key', () => {
    const text = plain(formatDryRun(preview({ payload: { file: './a.txt', file_size: 16, comment: 'hi' } })));
    expect(text).toContain('  Workspace: Acme Corp (acme)');
    expect(text).toContain('  File size: 16');
    expect(text).toContain('  Comment:   hi');
  });

  it('lists IDs, says (none) for an empty list and shows objects as JSON', () => {
    const text = plain(formatDryRun(preview({
      payload: { added: ['U1', 'U2'], removed: [], noop: false, blocks: [{ type: 'divider' }] },
    })));
    expect(text).toContain('Added:     U1, U2');
    expect(text).toContain('Removed:   (none)');
    expect(text).toContain('Noop:      false');
    expect(text).toContain('Blocks:    [{"type":"divider"}]');
  });

  it.each([
    [{ kind: 'user', id: 'U0123456789', name: '@alice' }, 'U0123456789 (@alice), direct message'],
    [{ kind: 'user', id: 'U0123456789' }, 'U0123456789, direct message'],
    [{ kind: 'message', id: 'C0123456789', ts: '1712345678.123456' }, 'C0123456789, message 1712345678.123456'],
    [{ kind: 'draft', id: 'Dr0123456789' }, 'draft Dr0123456789'],
    [{ kind: 'usergroup', name: 'Platform' }, 'Platform'],
    [{ kind: 'usergroup' }, '(new)'],
  ])('renders target %j', (target, expected) => {
    expect(plain(formatDryRun(preview({ target, payload: {} })))).toContain(`  Target:    ${expected}`);
  });

  it('shows the thread on its own line', () => {
    const text = plain(formatDryRun(preview({ target: { kind: 'channel', id: 'C1', thread_ts: '1712345678.123456' } })));
    expect(text).toContain('  Thread:    1712345678.123456');
  });
});

describe('emitDryRun', () => {
  afterEach(() => mock.restore());

  it('writes one JSON object to stdout under --json', () => {
    let out = '';
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += chunk; return true; }) as any);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const value: DryRunPreview = {
      dry_run: true, action: 'leave channel', workspace: WORKSPACE, target: { kind: 'channel', id: 'C1' }, payload: {},
    };
    emitDryRun(value, true);
    expect(JSON.parse(out)).toEqual(value);
    expect(log).not.toHaveBeenCalled();
  });

  it('prints the text preview otherwise', () => {
    let out = '';
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += chunk; return true; }) as any);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    emitDryRun({
      dry_run: true, action: 'leave channel', workspace: WORKSPACE, target: { kind: 'channel', id: 'C1' }, payload: {},
    }, false);
    expect(out).toContain('Dry run: nothing was sent.');
    expect(log).not.toHaveBeenCalled();
  });
});
