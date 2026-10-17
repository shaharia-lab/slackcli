// The canvases.* client methods (#431): the parameters sent, and the refusal on
// browser session tokens, which Slack answers with `not_allowed_token_type`.
import { describe, expect, it, spyOn } from 'bun:test';
import { CANVAS_AUTH_MESSAGE, SlackClient } from './slack-client.ts';
import { UnsupportedAuthTypeError } from './cli-errors.ts';
import { isReadMethod } from './retry.ts';
import type { WorkspaceConfig } from '../types/index.ts';

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'standard',
  token: 'xoxb-test',
  token_type: 'bot',
};

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'browser',
  xoxd_token: 'xoxd-test',
  xoxc_token: 'xoxc-test',
  workspace_url: 'https://example.slack.com',
};

type Call = { method: string; params: Record<string, unknown> };

function clientFor(config: WorkspaceConfig, answer: unknown = { ok: true }): { client: SlackClient; calls: Call[] } {
  const client = new SlackClient(config);
  const calls: Call[] = [];
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    return answer;
  });
  return { client, calls };
}

describe('lookupCanvasSections', () => {
  it('sends the canvas ID and the criteria as JSON', async () => {
    const answer = { ok: true, sections: [{ id: 'temp:C:abc' }] };
    const { client, calls } = clientFor(STANDARD, answer);

    const response = await client.lookupCanvasSections('F123', { section_types: ['h2'], contains_text: 'Status' });

    expect(response).toBe(answer);
    expect(calls).toStrictEqual([{
      method: 'canvases.sections.lookup',
      params: { canvas_id: 'F123', criteria: '{"section_types":["h2"],"contains_text":"Status"}' },
    }]);
  });

  it('refuses browser session tokens before making a request', async () => {
    const { client, calls } = clientFor(BROWSER);

    await expect(client.lookupCanvasSections('F123', { contains_text: 'x' })).rejects.toThrow(UnsupportedAuthTypeError);
    await expect(client.lookupCanvasSections('F123', { contains_text: 'x' })).rejects.toThrow(CANVAS_AUTH_MESSAGE);
    expect(calls).toEqual([]);
    expect(CANVAS_AUTH_MESSAGE).toContain('standard Slack app token (xoxb or xoxp)');
  });

  it('is safe to repeat after an ambiguous failure', () => {
    expect(isReadMethod('canvases.sections.lookup')).toBe(true);
  });

  it('reaches Slack through the SDK on an app token with the criteria serialized', async () => {
    const client = new SlackClient(STANDARD);
    const seen: Array<[string, Record<string, unknown>]> = [];
    (client as unknown as { webClient: { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> } }).webClient = {
      apiCall: async (method, params) => {
        seen.push([method, params]);
        return { ok: true, sections: [] };
      },
    };

    await client.lookupCanvasSections('F123', { section_types: ['any_header'] });

    expect(seen).toEqual([['canvases.sections.lookup', { canvas_id: 'F123', criteria: '{"section_types":["any_header"]}' }]]);
  });
});

describe('createCanvas', () => {
  it('sends the title, the Markdown as document_content and the channel, and returns the ID', async () => {
    const { client, calls } = clientFor(STANDARD, { ok: true, canvas_id: 'F0NEW' });

    const id = await client.createCanvas({ title: 'Notes', markdown: '# Hi\n', channelId: 'C123' });

    expect(id).toBe('F0NEW');
    expect(calls).toStrictEqual([{
      method: 'canvases.create',
      params: { title: 'Notes', document_content: '{"type":"markdown","markdown":"# Hi\\n"}', channel_id: 'C123' },
    }]);
  });

  it('leaves out what was not given', async () => {
    const { client, calls } = clientFor(STANDARD, { ok: true, canvas_id: 'F0NEW' });

    await client.createCanvas({ title: 'Notes' });
    await client.createCanvas({ markdown: 'x' });

    expect(calls.map((call) => call.params)).toStrictEqual([
      { title: 'Notes' },
      { document_content: '{"type":"markdown","markdown":"x"}' },
    ]);
  });

  it.each([[{ ok: true }], [{ ok: true, canvas_id: '' }], [{ ok: true, canvas_id: 7 }], [null]])(
    'fails when Slack answers %j without a canvas ID',
    async (answer) => {
      const { client } = clientFor(STANDARD, answer);
      await expect(client.createCanvas({ title: 'Notes' })).rejects.toThrow('returned no canvas ID');
    },
  );

  it('refuses browser session tokens before making a request', async () => {
    const { client, calls } = clientFor(BROWSER);

    await expect(client.createCanvas({ title: 'Notes' })).rejects.toThrow(CANVAS_AUTH_MESSAGE);
    expect(calls).toEqual([]);
  });

  it('is never repeated after an ambiguous failure', () => {
    expect(isReadMethod('canvases.create')).toBe(false);
  });
});

describe('editCanvas', () => {
  it('sends the canvas ID and the one change as a JSON array', async () => {
    const { client, calls } = clientFor(STANDARD);

    await client.editCanvas('F123', { operation: 'insert_after', section_id: 'temp:C:abc', document_content: { type: 'markdown', markdown: '- x' } });

    expect(calls).toStrictEqual([{
      method: 'canvases.edit',
      params: {
        canvas_id: 'F123',
        changes: '[{"operation":"insert_after","section_id":"temp:C:abc","document_content":{"type":"markdown","markdown":"- x"}}]',
      },
    }]);
  });

  it('refuses browser session tokens before making a request', async () => {
    const { client, calls } = clientFor(BROWSER);

    await expect(client.editCanvas('F123', { operation: 'delete', section_id: 'temp:C:abc' })).rejects.toThrow(UnsupportedAuthTypeError);
    expect(calls).toEqual([]);
  });

  it('is never repeated after an ambiguous failure', () => {
    expect(isReadMethod('canvases.edit')).toBe(false);
  });
});
