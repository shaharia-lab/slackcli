import { describe, expect, it } from 'bun:test';
import {
  resolveWorkspace,
  deriveStorageKey,
  AmbiguousWorkspaceError,
  putWorkspace,
  readWorkspace,
  dropWorkspace,
  dropAllWorkspaces,
} from './workspaces.ts';
import {
  FileSecretStore,
  MissingCredentialError,
  SecretStoreError,
  type SecretStore,
} from './secret-store.ts';
import type {
  WorkspacesData,
  StandardAuthConfig,
  BrowserAuthConfig,
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

// A pre-profiles config: keyed by team_id, no `profile` or `user_id` fields.
function legacyData(): WorkspacesData {
  return {
    default_workspace: 'T1',
    workspaces: {
      T1: standard(),
    },
  };
}

describe('resolveWorkspace', () => {
  it('returns the default workspace when no identifier is given', () => {
    const resolved = resolveWorkspace(legacyData());
    expect(resolved?.key).toBe('T1');
    expect(resolved?.config.workspace_name).toBe('Acme');
  });

  it('returns null when there is no default and no identifier', () => {
    expect(resolveWorkspace({ workspaces: {} })).toBeNull();
  });

  // Backward compatibility: legacy files keyed by team_id keep resolving by id
  // and by name exactly as before profiles existed.
  it('resolves a legacy record by workspace id', () => {
    expect(resolveWorkspace(legacyData(), 'T1')?.key).toBe('T1');
  });

  it('resolves a legacy record by workspace name', () => {
    expect(resolveWorkspace(legacyData(), 'Acme')?.key).toBe('T1');
  });

  it('returns null for an unknown identifier', () => {
    expect(resolveWorkspace(legacyData(), 'nope')).toBeNull();
  });

  it('resolves two profiles in one team by their profile keys', () => {
    const data: WorkspacesData = {
      default_workspace: 'rafael',
      workspaces: {
        rafael: browser({ profile: 'rafael', user_id: 'U1' }),
        'automation-bot': standard({ profile: 'automation-bot', user_id: 'U2' }),
      },
    };

    expect(resolveWorkspace(data, 'rafael')?.config.auth_type).toBe('browser');
    expect(resolveWorkspace(data, 'automation-bot')?.config.auth_type).toBe('standard');
  });

  it('throws an ambiguity error when a workspace id maps to multiple profiles', () => {
    const data: WorkspacesData = {
      default_workspace: 'rafael',
      workspaces: {
        rafael: browser({ profile: 'rafael', user_id: 'U1' }),
        'automation-bot': standard({ profile: 'automation-bot', user_id: 'U2' }),
      },
    };

    expect(() => resolveWorkspace(data, 'T1')).toThrow(AmbiguousWorkspaceError);
    try {
      resolveWorkspace(data, 'T1');
    } catch (err) {
      expect((err as AmbiguousWorkspaceError).keys.sort()).toEqual(['automation-bot', 'rafael']);
    }
  });

  it('throws an ambiguity error when a workspace name maps to multiple profiles', () => {
    const data: WorkspacesData = {
      workspaces: {
        rafael: browser({ profile: 'rafael', user_id: 'U1' }),
        'automation-bot': standard({ profile: 'automation-bot', user_id: 'U2' }),
      },
    };

    expect(() => resolveWorkspace(data, 'Acme')).toThrow(AmbiguousWorkspaceError);
  });

  it('prefers an exact profile key over an id/name collision', () => {
    // A record whose key happens to equal another record's workspace_id must
    // still resolve by the exact key first.
    const data: WorkspacesData = {
      workspaces: {
        rafael: browser({ profile: 'rafael', user_id: 'U1' }),
        'automation-bot': standard({ profile: 'automation-bot', user_id: 'U2' }),
      },
    };
    expect(resolveWorkspace(data, 'rafael')?.config.user_id).toBe('U1');
  });
});

describe('deriveStorageKey', () => {
  it('keeps the team_id key for the first identity of a team', () => {
    const data: WorkspacesData = { workspaces: {} };
    expect(deriveStorageKey(data, standard())).toBe('T1');
  });

  // Backward compatibility: re-authenticating the same identity (e.g. rotating a
  // token) updates the existing record in place instead of duplicating it.
  it('refreshes a legacy record in place when no profile is given', () => {
    const data = legacyData();
    const rotated = standard({ token: 'xoxb-new' });
    expect(deriveStorageKey(data, rotated)).toBe('T1');
  });

  it('refreshes the same identity in place when user_id matches', () => {
    const data: WorkspacesData = {
      workspaces: { T1: standard({ user_id: 'U1' }) },
    };
    expect(deriveStorageKey(data, standard({ user_id: 'U1', token: 'xoxb-new' }))).toBe('T1');
  });

  // The core guarantee: a second, different identity for the same team must not
  // overwrite the first when no --profile is supplied.
  it('auto-generates a suffixed key for a different identity in the same team', () => {
    const data: WorkspacesData = {
      workspaces: { T1: standard({ user_id: 'U1' }) },
    };
    const other = browser({ user_id: 'U2' });
    expect(deriveStorageKey(data, other)).toBe('T1-2');
  });

  it('increments the suffix until it finds a free key', () => {
    const data: WorkspacesData = {
      workspaces: {
        T1: standard({ user_id: 'U1' }),
        'T1-2': browser({ profile: 'T1-2', user_id: 'U2' }),
      },
    };
    expect(deriveStorageKey(data, standard({ user_id: 'U3', token_type: 'user' }))).toBe('T1-3');
  });

  it('does not treat a different token_type as the same identity', () => {
    // Legacy bot record; logging in with a user token is a distinct identity.
    const data: WorkspacesData = {
      workspaces: { T1: standard({ token_type: 'bot' }) },
    };
    const userToken = standard({ token_type: 'user', token: 'xoxp-x', user_id: 'U9' });
    expect(deriveStorageKey(data, userToken)).toBe('T1-2');
  });

  it('uses an explicit profile name as the key', () => {
    const data: WorkspacesData = { workspaces: { T1: standard() } };
    expect(deriveStorageKey(data, browser({ user_id: 'U2' }), 'rafael')).toBe('rafael');
  });

  it('reuses an explicit profile key when it belongs to the same team (refresh)', () => {
    const data: WorkspacesData = {
      workspaces: { rafael: browser({ profile: 'rafael', user_id: 'U1' }) },
    };
    expect(deriveStorageKey(data, browser({ user_id: 'U1' }), 'rafael')).toBe('rafael');
  });

  it('refuses an explicit profile key already used by a different team', () => {
    const data: WorkspacesData = {
      workspaces: { rafael: browser({ workspace_id: 'T9', profile: 'rafael' }) },
    };
    expect(() => deriveStorageKey(data, standard({ workspace_id: 'T1' }), 'rafael')).toThrow(
      /already belongs to workspace/,
    );
  });
});

// Credential routing (#219) -------------------------------------------------

// A separate backend, so tests can see which data went to the store and which
// stayed on the record. `failOn` injects a backend failure for one operation.
class MemoryStore implements SecretStore {
  public readonly backend = 'memory';
  public secrets = new Map<string, string>();
  public failOn?: 'get' | 'set' | 'delete';

  private check(op: 'get' | 'set' | 'delete'): void {
    if (this.failOn === op) throw new SecretStoreError('memory', 'access_denied', `${op} denied`);
  }
  async get(key: string): Promise<string | null> {
    this.check('get');
    return this.secrets.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.check('set');
    this.secrets.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.check('delete');
    this.secrets.delete(key);
  }
}

const serialize = (data: WorkspacesData) => JSON.parse(JSON.stringify(data));

describe('putWorkspace', () => {
  // With the file backend the document must come out exactly as before the
  // seam existed: secrets inline, legacy field names, no extra fields.
  it('keeps the legacy inline file shape for a first identity', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const key = await putWorkspace(data, new FileSecretStore(data), standard());
    expect(key).toBe('T1');
    expect(serialize(data)).toEqual({ default_workspace: 'T1', workspaces: { T1: standard() } });
  });

  it('keeps the legacy inline file shape for a named browser profile', async () => {
    const data: WorkspacesData = { workspaces: {} };
    await putWorkspace(data, new FileSecretStore(data), browser({ user_id: 'U1' }), 'work');
    expect(serialize(data)).toEqual({
      default_workspace: 'work',
      workspaces: { work: browser({ user_id: 'U1', profile: 'work' }) },
    });
  });

  it('refreshes a token in place with the file backend', async () => {
    const data = legacyData();
    await putWorkspace(data, new FileSecretStore(data), standard({ token: 'xoxb-new' }));
    expect(serialize(data)).toEqual({
      default_workspace: 'T1',
      workspaces: { T1: standard({ token: 'xoxb-new' }) },
    });
  });

  it('routes secrets to the store and leaves only metadata on the record', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, browser({ user_id: 'U1' }));
    expect(data.workspaces.T1).toEqual({
      workspace_id: 'T1',
      workspace_name: 'Acme',
      workspace_url: 'https://acme.slack.com',
      user_id: 'U1',
      auth_type: 'browser',
    } as never);
    expect(JSON.stringify(data)).not.toContain('xox');
    expect(store.secrets.get('T1:xoxc')).toBe('xoxc-abc');
    expect(store.secrets.get('T1:xoxd')).toBe('xoxd-abc');
  });

  it('keeps two identities of one team under separate references', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard({ user_id: 'U1', token: 'xoxb-1' }));
    const second = await putWorkspace(data, store, standard({ user_id: 'U2', token: 'xoxb-2' }));
    expect(second).toBe('T1-2');
    expect(store.secrets.get('T1:token')).toBe('xoxb-1');
    expect(store.secrets.get('T1-2:token')).toBe('xoxb-2');
  });

  it('drops the old credentials when a profile switches auth type', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, browser(), 'work');
    await putWorkspace(data, store, standard({ token: 'xoxp-u', token_type: 'user' }), 'work');
    expect([...store.secrets.keys()]).toEqual(['work:token']);
    expect(data.workspaces.work.auth_type).toBe('standard');
  });

  it('keeps the old credentials when storing the new auth type fails', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, browser(), 'work');
    store.failOn = 'set';
    await expect(
      putWorkspace(data, store, standard({ token_type: 'user' }), 'work'),
    ).rejects.toBeInstanceOf(SecretStoreError);
    expect(store.secrets.get('work:xoxc')).toBe('xoxc-abc');
    expect(store.secrets.get('work:xoxd')).toBe('xoxd-abc');
  });

  it('propagates a store failure', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    store.failOn = 'set';
    await expect(putWorkspace(data, store, standard())).rejects.toBeInstanceOf(SecretStoreError);
  });
});

describe('readWorkspace', () => {
  it('returns the full config from a legacy inline file', async () => {
    const data = legacyData();
    expect(await readWorkspace(data, new FileSecretStore(data))).toEqual(standard());
    expect(await readWorkspace(data, new FileSecretStore(data), 'Acme')).toEqual(standard());
  });

  it('rebuilds the full config from metadata plus a separate store', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, browser({ user_id: 'U1' }), 'work');
    expect(await readWorkspace(data, store, 'work')).toEqual(
      browser({ user_id: 'U1', profile: 'work' }),
    );
  });

  it('returns null without touching the store when nothing matches', async () => {
    const store = new MemoryStore();
    store.failOn = 'get';
    expect(await readWorkspace({ workspaces: {} }, store, 'nope')).toBeNull();
  });

  it('reports a record whose secret is missing', async () => {
    const data = legacyData();
    delete (data.workspaces.T1 as Partial<StandardAuthConfig>).token;
    await expect(readWorkspace(data, new FileSecretStore(data))).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });

  it('reports denied access as a store error, not as missing', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard());
    store.failOn = 'get';
    await expect(readWorkspace(data, store)).rejects.toMatchObject({ reason: 'access_denied' });
  });
});

describe('dropWorkspace', () => {
  it('removes the record, its credentials, and moves the default', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard({ user_id: 'U1' }));
    await putWorkspace(data, store, standard({ user_id: 'U2', token: 'xoxb-2' }));
    await dropWorkspace(data, store, 'T1');
    expect(Object.keys(data.workspaces)).toEqual(['T1-2']);
    expect(data.default_workspace).toBe('T1-2');
    expect([...store.secrets.keys()]).toEqual(['T1-2:token']);
  });

  it('matches the legacy file result with the file backend', async () => {
    const data: WorkspacesData = {
      default_workspace: 'T1',
      workspaces: { T1: standard(), T2: browser({ workspace_id: 'T2', workspace_name: 'Beta' }) },
    };
    await dropWorkspace(data, new FileSecretStore(data), 'Acme');
    expect(serialize(data)).toEqual({
      default_workspace: 'T2',
      workspaces: { T2: browser({ workspace_id: 'T2', workspace_name: 'Beta' }) },
    });
  });

  it('throws for an unknown workspace', async () => {
    await expect(dropWorkspace({ workspaces: {} }, new MemoryStore(), 'nope')).rejects.toThrow(
      'Workspace nope not found',
    );
  });

  it('keeps the profile when credential deletion fails, so removal can be retried', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard());
    store.failOn = 'delete';
    await expect(dropWorkspace(data, store, 'T1')).rejects.toBeInstanceOf(SecretStoreError);
    expect(data.workspaces.T1).toBeDefined();
    expect(data.default_workspace).toBe('T1');
    expect(store.secrets.get('T1:token')).toBe('xoxb-abc');
  });
});

// A hand-edited or damaged record: no usable auth_type.
function damagedData(): WorkspacesData {
  const record = { ...browser({ workspace_id: 'TX', workspace_name: 'Broken' }) } as Record<string, unknown>;
  delete record.auth_type;
  return {
    default_workspace: 'T1',
    workspaces: { T1: standard(), TX: record as never },
  };
}

describe('damaged records', () => {
  it('can still be removed, and every credential field goes with them', async () => {
    const data = damagedData();
    const store = new MemoryStore();
    store.secrets.set('TX:xoxc', 'c');
    store.secrets.set('TX:xoxd', 'd');
    store.secrets.set('TX:token', 't');
    await dropWorkspace(data, store, 'TX');
    expect(Object.keys(data.workspaces)).toEqual(['T1']);
    expect(store.secrets.size).toBe(0);
  });

  it('do not stop logout from clearing the file', async () => {
    const data = damagedData();
    await dropAllWorkspaces(data, new FileSecretStore(data));
    expect(serialize(data)).toEqual({ workspaces: {} });
  });

  it('fail to load with a clear error instead of a TypeError', async () => {
    const data = damagedData();
    const err = await readWorkspace(data, new FileSecretStore(data), 'TX').catch((e) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toContain('unknown auth type');
    expect(err.message).not.toContain('xoxc-abc');
  });
});

describe('dropAllWorkspaces', () => {
  it('deletes every profile\'s credentials and empties the document', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard());
    await putWorkspace(data, store, browser({ workspace_id: 'T2' }));
    await dropAllWorkspaces(data, store);
    expect(store.secrets.size).toBe(0);
    expect(serialize(data)).toEqual({ workspaces: {} });
  });

  it('propagates a deletion failure', async () => {
    const data: WorkspacesData = { workspaces: {} };
    const store = new MemoryStore();
    await putWorkspace(data, store, standard());
    store.failOn = 'delete';
    await expect(dropAllWorkspaces(data, store)).rejects.toBeInstanceOf(SecretStoreError);
  });
});
