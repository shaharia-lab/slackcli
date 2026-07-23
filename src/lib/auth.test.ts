import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { BrowserAuthConfig, WorkspaceConfig } from '../types/index.ts';

const addWorkspace = mock(async (_config: WorkspaceConfig): Promise<void> => {});
const getWorkspace = mock(async (): Promise<WorkspaceConfig | null> => null);

mock.module('./workspaces.ts', () => ({
  addWorkspace,
  getWorkspace,
}));

const { authenticateBrowser, getAuthenticatedClient } = await import('./auth.ts');
const originalFetch = globalThis.fetch;

beforeEach(() => {
  mock.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('authenticateBrowser', () => {
  it('rejects a non-Slack URL before sending browser credentials', async () => {
    const fetchMock = mock(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({
      ok: true,
      team_id: 'T123',
      team: 'Attacker',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      authenticateBrowser(
        'xoxd-secret',
        'xoxc-secret',
        'https://attacker.example',
      ),
    ).rejects.toThrow('Invalid Slack workspace URL');

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(addWorkspace).toHaveBeenCalledTimes(0);
  });

  it('uses and stores the normalized Slack origin', async () => {
    const fetchMock = mock(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({
      ok: true,
      team_id: 'T123',
      team: 'Example',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = await authenticateBrowser(
      'xoxd-secret',
      'xoxc-secret',
      'HTTPS://EXAMPLE.SLACK.COM/',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.slack.com/api/auth.test',
    );
    expect(config).toMatchObject({
      workspace_url: 'https://example.slack.com',
      workspace_name: 'Example',
    });
    expect(addWorkspace).toHaveBeenCalledWith(config);
  });
});

describe('getAuthenticatedClient', () => {
  it('rejects an unsafe persisted browser URL before sending credentials', async () => {
    const persistedConfig: BrowserAuthConfig = {
      workspace_id: 'T123',
      workspace_name: 'Persisted workspace',
      auth_type: 'browser',
      workspace_url: 'https://attacker.example',
      xoxd_token: 'xoxd-secret',
      xoxc_token: 'xoxc-secret',
    };
    getWorkspace.mockResolvedValueOnce(persistedConfig);

    const fetchMock = mock(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect((async () => {
      const client = await getAuthenticatedClient();
      await client.testAuth();
    })()).rejects.toThrow('Invalid Slack workspace URL');

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
