import { describe, expect, it } from 'bun:test';
import {
  resolveWorkspace,
  deriveStorageKey,
  AmbiguousWorkspaceError,
} from './workspaces.ts';
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
