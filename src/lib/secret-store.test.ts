import { describe, expect, it } from 'bun:test';
import {
  FileSecretStore,
  MissingCredentialError,
  SecretStoreError,
  deleteCredentials,
  loadCredentials,
  metadataOf,
  parseSecretKey,
  secretKey,
  storeCredentials,
  type SecretStore,
} from './secret-store.ts';
import type {
  BrowserAuthConfig,
  StandardAuthConfig,
  WorkspaceConfig,
  WorkspacesData,
} from '../types/index.ts';

// Test builders --------------------------------------------------------------

function standard(overrides: Partial<StandardAuthConfig> = {}): StandardAuthConfig {
  return {
    workspace_id: 'T1',
    workspace_name: 'Acme',
    auth_type: 'standard',
    token: 'xoxb-abc',
    token_type: 'bot',
    ...overrides,
  };
}

function browser(overrides: Partial<BrowserAuthConfig> = {}): BrowserAuthConfig {
  return {
    workspace_id: 'T1',
    workspace_name: 'Acme',
    workspace_url: 'https://acme.slack.com',
    auth_type: 'browser',
    xoxd_token: 'xoxd-abc',
    xoxc_token: 'xoxc-abc',
    ...overrides,
  };
}

// In-memory backend with failure injection, standing in for a native store.
class MemoryStore implements SecretStore {
  public readonly backend = 'memory';
  public secrets = new Map<string, string>();
  public failWith?: SecretStoreError;

  private check(): void {
    if (this.failWith) throw this.failWith;
  }
  async get(key: string): Promise<string | null> {
    this.check();
    return this.secrets.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.check();
    this.secrets.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.check();
    this.secrets.delete(key);
  }
}

describe('secretKey / parseSecretKey', () => {
  it('round-trips a plain profile key', () => {
    expect(secretKey('T1', 'token')).toBe('T1:token');
    expect(parseSecretKey('T1:xoxc')).toEqual({ ref: 'T1', kind: 'xoxc' });
  });

  it('keeps separators that are part of the profile name', () => {
    const key = secretKey('work:bot', 'xoxd');
    expect(parseSecretKey(key)).toEqual({ ref: 'work:bot', kind: 'xoxd' });
  });

  it('rejects an empty reference', () => {
    expect(() => secretKey('', 'token')).toThrow('must not be empty');
  });

  it.each(['T1', 'T1:', ':token', 'T1:password', 'T1:toString', 'T1:__proto__', ''])(
    'rejects malformed key %p',
    (key) => {
      expect(() => parseSecretKey(key)).toThrow('Invalid secret key');
    },
  );
});

describe('metadataOf', () => {
  it('strips the standard token and keeps everything else', () => {
    const meta = metadataOf(standard({ profile: 'p', user_id: 'U1' }));
    expect(meta).toEqual({
      workspace_id: 'T1',
      workspace_name: 'Acme',
      profile: 'p',
      user_id: 'U1',
      auth_type: 'standard',
      token_type: 'bot',
    });
    expect(JSON.stringify(meta)).not.toContain('xoxb-abc');
  });

  it('strips both browser credentials', () => {
    const meta = metadataOf(browser());
    expect(meta).toEqual({
      workspace_id: 'T1',
      workspace_name: 'Acme',
      workspace_url: 'https://acme.slack.com',
      auth_type: 'browser',
    });
  });

  it('does not mutate the input config', () => {
    const config = standard();
    metadataOf(config);
    expect(config.token).toBe('xoxb-abc');
  });
});

describe('credential helpers over a backend', () => {
  it('stores one entry for standard auth and two for browser auth', async () => {
    const store = new MemoryStore();
    await storeCredentials(store, 'T1', standard());
    await storeCredentials(store, 'T2', browser({ workspace_id: 'T2' }));
    expect([...store.secrets.entries()]).toEqual([
      ['T1:token', 'xoxb-abc'],
      ['T2:xoxc', 'xoxc-abc'],
      ['T2:xoxd', 'xoxd-abc'],
    ]);
  });

  it('round-trips a config through metadata plus the store', async () => {
    const store = new MemoryStore();
    for (const config of [standard(), browser()] as WorkspaceConfig[]) {
      await storeCredentials(store, 'p', config);
      expect(await loadCredentials(store, 'p', metadataOf(config))).toEqual(config);
    }
  });

  it('isolates profiles within the same workspace', async () => {
    const store = new MemoryStore();
    await storeCredentials(store, 'T1', standard({ token: 'xoxb-bot' }));
    await storeCredentials(store, 'T1-2', standard({ token: 'xoxp-user', token_type: 'user' }));

    const first = await loadCredentials(store, 'T1', metadataOf(standard()));
    const second = await loadCredentials(store, 'T1-2', metadataOf(standard({ token_type: 'user' })));
    expect(first.auth_type === 'standard' && first.token).toBe('xoxb-bot');
    expect(second.auth_type === 'standard' && second.token).toBe('xoxp-user');

    await deleteCredentials(store, 'T1', 'standard');
    expect(store.secrets.get('T1-2:token')).toBe('xoxp-user');
  });

  it('replaces a token in place on re-store', async () => {
    const store = new MemoryStore();
    await storeCredentials(store, 'T1', standard({ token: 'old' }));
    await storeCredentials(store, 'T1', standard({ token: 'new' }));
    expect(store.secrets.get('T1:token')).toBe('new');
    expect(store.secrets.size).toBe(1);
  });

  it('reports a missing secret as MissingCredentialError naming the kind', async () => {
    const store = new MemoryStore();
    await store.set('T1:xoxc', 'xoxc-abc'); // xoxd never written
    const err = await loadCredentials(store, 'T1', metadataOf(browser())).catch((e) => e);
    expect(err).toBeInstanceOf(MissingCredentialError);
    expect(err.ref).toBe('T1');
    expect(err.kind).toBe('xoxd');
    expect(err.message).not.toContain('xoxc-abc');
  });

  it('propagates access denial distinctly from a missing secret', async () => {
    const store = new MemoryStore();
    await storeCredentials(store, 'T1', standard());
    store.failWith = new SecretStoreError('memory', 'access_denied', 'denied');
    const err = await loadCredentials(store, 'T1', metadataOf(standard())).catch((e) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect(err).not.toBeInstanceOf(MissingCredentialError);
    expect(err.reason).toBe('access_denied');
    expect(err.backend).toBe('memory');
  });

  it('propagates an unavailable backend on store and delete', async () => {
    const store = new MemoryStore();
    store.failWith = new SecretStoreError('memory', 'unavailable', 'down');
    await expect(storeCredentials(store, 'T1', standard())).rejects.toBeInstanceOf(SecretStoreError);
    await expect(deleteCredentials(store, 'T1', 'browser')).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('treats deleting absent credentials as a no-op', async () => {
    const store = new MemoryStore();
    await deleteCredentials(store, 'nope', 'browser');
    expect(store.secrets.size).toBe(0);
  });
});

describe('FileSecretStore', () => {
  function doc(): WorkspacesData {
    return {
      default_workspace: 'T1',
      workspaces: {
        T1: standard(),
        B1: browser({ workspace_id: 'B1' }),
      },
    };
  }

  it('reads the inline fields under their legacy names', async () => {
    const store = new FileSecretStore(doc());
    expect(store.backend).toBe('file');
    expect(await store.get('T1:token')).toBe('xoxb-abc');
    expect(await store.get('B1:xoxc')).toBe('xoxc-abc');
    expect(await store.get('B1:xoxd')).toBe('xoxd-abc');
  });

  it('returns null for an unknown profile, an absent field, or a kind the auth type lacks', async () => {
    const data = doc();
    delete (data.workspaces.B1 as Partial<BrowserAuthConfig>).xoxd_token;
    const store = new FileSecretStore(data);
    expect(await store.get('ghost:token')).toBeNull();
    expect(await store.get('B1:xoxd')).toBeNull();
    expect(await store.get('T1:xoxc')).toBeNull();
    expect(await store.get('B1:token')).toBeNull();
  });

  it('returns null for a non-string value rather than leaking it', async () => {
    const data = doc();
    (data.workspaces.T1 as unknown as Record<string, unknown>).token = 42;
    expect(await new FileSecretStore(data).get('T1:token')).toBeNull();
  });

  it('writes onto the record in place, so saving the document persists it', async () => {
    const data = doc();
    const store = new FileSecretStore(data);
    await store.set('T1:token', 'xoxb-new');
    await store.set('B1:xoxd', 'xoxd-new');
    expect((data.workspaces.T1 as StandardAuthConfig).token).toBe('xoxb-new');
    expect((data.workspaces.B1 as BrowserAuthConfig).xoxd_token).toBe('xoxd-new');
  });

  it('refuses to write for an unknown profile', async () => {
    const store = new FileSecretStore(doc());
    await expect(store.set('ghost:token', 'x')).rejects.toThrow('unknown profile "ghost"');
  });

  it('refuses a kind that does not match the profile auth type', async () => {
    const data = doc();
    const store = new FileSecretStore(data);
    await expect(store.set('T1:xoxc', 'x')).rejects.toThrow('cannot hold a xoxc credential');
    await expect(store.set('B1:token', 'x')).rejects.toThrow('cannot hold a token credential');
    expect(data.workspaces.T1).toEqual(standard());
  });

  it('deletes only the requested field and tolerates unknown profiles', async () => {
    const data = doc();
    const store = new FileSecretStore(data);
    await store.delete('B1:xoxc');
    await store.delete('ghost:token');
    expect(data.workspaces.B1).not.toHaveProperty('xoxc_token');
    expect((data.workspaces.B1 as BrowserAuthConfig).xoxd_token).toBe('xoxd-abc');
    expect((data.workspaces.T1 as StandardAuthConfig).token).toBe('xoxb-abc');
  });

  it('round-trips a config through metadata plus the inline store', async () => {
    const config = browser({ profile: 'work', user_id: 'U9' });
    const data: WorkspacesData = { workspaces: { work: metadataOf(config) as WorkspaceConfig } };
    const store = new FileSecretStore(data);
    await storeCredentials(store, 'work', config);
    expect(data.workspaces.work).toEqual(config);
    expect(await loadCredentials(store, 'work', metadataOf(data.workspaces.work))).toEqual(config);
  });
});
