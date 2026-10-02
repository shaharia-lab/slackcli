import { describe, expect, it } from 'bun:test';
import {
  AUTH_ERROR_CODES,
  SlackAuthError,
  authErrorProfile,
  describeAuthError,
  describeRejectedLogin,
  formatAuthError,
  isAuthErrorCode,
  type AuthErrorProfile,
} from './auth-errors.ts';
import type { BrowserAuthConfig, StandardAuthConfig } from '../types/index.ts';

const browserProfile: AuthErrorProfile = {
  profileKey: 'acme',
  workspaceName: 'Acme Corp',
  authType: 'browser',
  workspaceUrl: 'https://acme.slack.com',
};

const standardProfile: AuthErrorProfile = {
  profileKey: 'T0ACME',
  workspaceName: 'Acme Corp',
  authType: 'standard',
};

const RELOGIN_CODES = AUTH_ERROR_CODES.filter((code) => code !== 'account_inactive');

describe('isAuthErrorCode', () => {
  it.each([...AUTH_ERROR_CODES])('recognises %s', (code) => {
    expect(isAuthErrorCode(code)).toBe(true);
  });

  it.each([
    'channel_not_found',
    'enterprise_is_restricted',
    'missing_scope',
    'not_in_channel',
    'not_allowed_token_type',
    'ratelimited',
    'INVALID_AUTH',
    ' invalid_auth',
    'invalid_auth ',
    '',
  ])('does not treat %p as an authentication failure', (code) => {
    expect(isAuthErrorCode(code)).toBe(false);
  });

  it.each([[undefined], [null], [0], [{}], [['invalid_auth']]])('rejects the non-string %p', (code) => {
    expect(isAuthErrorCode(code)).toBe(false);
  });
});

describe('describeAuthError', () => {
  it('covers exactly the five authentication codes', () => {
    expect([...AUTH_ERROR_CODES].sort()).toEqual([
      'account_inactive',
      'invalid_auth',
      'not_authed',
      'token_expired',
      'token_revoked',
    ]);
  });

  it.each([...AUTH_ERROR_CODES])('keeps %s verbatim and gives it a meaning and a fix', (code) => {
    for (const profile of [browserProfile, standardProfile]) {
      const description = describeAuthError(code, profile);
      expect(description.code).toBe(code);
      expect(description.meaning.length).toBeGreaterThan(0);
      expect(description.meaning).not.toContain('\n');
      expect(description.fix.length).toBeGreaterThan(0);
      expect(description.fix).not.toContain('\n');
    }
  });

  it('gives each code its own meaning', () => {
    for (const profile of [browserProfile, standardProfile]) {
      const meanings = AUTH_ERROR_CODES.map((code) => describeAuthError(code, profile).meaning);
      expect(new Set(meanings).size).toBe(AUTH_ERROR_CODES.length);
    }
  });

  it('explains invalid_auth as an expired session for a browser profile', () => {
    expect(describeAuthError('invalid_auth', browserProfile)).toEqual({
      code: 'invalid_auth',
      meaning: 'The stored browser session is no longer valid. Browser sessions expire when you sign out or Slack rotates the session.',
      fix: 'slackcli auth login-auto --workspace-url https://acme.slack.com',
    });
  });

  it('explains invalid_auth as an invalid token for a standard profile', () => {
    expect(describeAuthError('invalid_auth', standardProfile)).toEqual({
      code: 'invalid_auth',
      meaning: 'The stored token is invalid or has expired.',
      fix: 'slackcli auth login --token <token> --workspace-name <name>',
    });
  });

  it.each(RELOGIN_CODES)('suggests login-auto with the stored URL for a browser profile on %s', (code) => {
    expect(describeAuthError(code, browserProfile).fix).toBe(
      'slackcli auth login-auto --workspace-url https://acme.slack.com',
    );
  });

  it.each(RELOGIN_CODES)('suggests auth login for a standard profile on %s', (code) => {
    const { fix } = describeAuthError(code, standardProfile);
    expect(fix.startsWith('slackcli auth login --token <token> --workspace-name <name>')).toBe(true);
    expect(fix).not.toContain('login-auto');
  });

  it('says a revoked standard token needs a new one', () => {
    expect(describeAuthError('token_revoked', standardProfile).fix).toContain('with a new token');
    expect(describeAuthError('token_revoked', standardProfile).meaning).toContain('revoked');
    expect(describeAuthError('token_revoked', browserProfile).meaning).toContain('revoked');
  });

  it('says not_authed means the stored credentials are missing', () => {
    expect(describeAuthError('not_authed', standardProfile).meaning).toBe(
      'No token was sent: the stored credentials for this profile are missing.',
    );
  });

  it.each([browserProfile, standardProfile])(
    'tells an inactive account that logging in again will not help ($authType)',
    (profile) => {
      const description = describeAuthError('account_inactive', profile);
      expect(description.meaning).toBe('The user was deactivated or removed from the workspace.');
      expect(description.fix).toBe('logging in again will not help; contact a workspace admin.');
      expect(description.fix).not.toContain('slackcli auth');
    },
  );

  it('falls back to a bare login-auto when the browser profile has no stored URL', () => {
    const { workspaceUrl: _dropped, ...withoutUrl } = browserProfile;
    expect(describeAuthError('invalid_auth', withoutUrl).fix).toBe('slackcli auth login-auto');
    expect(describeAuthError('invalid_auth', { ...browserProfile, workspaceUrl: '' }).fix).toBe(
      'slackcli auth login-auto',
    );
  });

  it.each([
    'not a url',
    'http://acme.slack.com',
    'javascript:alert(1)',
    'https://evil.example.com',
    'https://acme.slack.com.evil.net',
    'https://app.slack.com',
    'https://acme.slack.com:8443',
    'https://a$(id).slack.com',
    'https://a`id`.slack.com',
    'https://a;id.slack.com',
    "https://a'b.slack.com",
    'https://a b.slack.com',
  ])('does not put the unusable stored URL %p into the command', (workspaceUrl) => {
    expect(describeAuthError('invalid_auth', { ...browserProfile, workspaceUrl }).fix).toBe(
      'slackcli auth login-auto',
    );
  });

  it('keeps only the origin of the stored URL', () => {
    const fix = describeAuthError('token_expired', {
      ...browserProfile,
      workspaceUrl: 'https://user:pw@ACME.slack.com/client/T1?x=1; rm -rf ~#$(id)',
    }).fix;
    expect(fix).toBe('slackcli auth login-auto --workspace-url https://acme.slack.com');
  });

  it('accepts an Enterprise Grid host', () => {
    expect(describeAuthError('invalid_auth', { ...browserProfile, workspaceUrl: 'https://acme.enterprise.slack.com' }).fix)
      .toBe('slackcli auth login-auto --workspace-url https://acme.enterprise.slack.com');
  });
});

describe('formatAuthError', () => {
  it('renders the profile, the code, the meaning and the fix on three lines', () => {
    const message = formatAuthError(describeAuthError('invalid_auth', browserProfile), browserProfile);
    expect(message.split('\n')).toEqual([
      'Authentication failed for profile "acme" (Acme Corp, browser auth): invalid_auth',
      '   The stored browser session is no longer valid. Browser sessions expire when you sign out or Slack rotates the session.',
      '   To fix: slackcli auth login-auto --workspace-url https://acme.slack.com',
    ]);
  });

  it('names a profile keyed by its team id, with standard auth', () => {
    const message = formatAuthError(describeAuthError('token_expired', standardProfile), standardProfile);
    expect(message.split('\n')[0]).toBe(
      'Authentication failed for profile "T0ACME" (Acme Corp, standard auth): token_expired',
    );
  });

  it('still reads well when the workspace has no name', () => {
    const profile = { ...standardProfile, workspaceName: '' };
    const message = formatAuthError(describeAuthError('not_authed', profile), profile);
    expect(message.split('\n')[0]).toBe('Authentication failed for profile "T0ACME" (standard auth): not_authed');
  });

  it('strips control characters from stored names', () => {
    const profile = { ...browserProfile, profileKey: 'ac\u001b[31mme', workspaceName: 'Acme\r\nCorp\u0007' };
    const message = formatAuthError(describeAuthError('invalid_auth', profile), profile);
    expect(message.split('\n')).toHaveLength(3);
    expect(message.split('\n')[0]).toBe(
      'Authentication failed for profile "ac[31mme" (AcmeCorp, browser auth): invalid_auth',
    );
  });
});

describe('authErrorProfile', () => {
  const browserConfig: BrowserAuthConfig = {
    workspace_id: 'T0ACME',
    workspace_name: 'Acme Corp',
    workspace_url: 'https://acme.slack.com',
    auth_type: 'browser',
    xoxd_token: 'xoxd-secret-cookie',
    xoxc_token: 'xoxc-secret-token',
  };
  const standardConfig: StandardAuthConfig = {
    workspace_id: 'T0ACME',
    workspace_name: 'Acme Corp',
    auth_type: 'standard',
    token: 'xoxb-secret-token',
    token_type: 'bot',
  };

  it('uses the team id as the key of an unnamed profile', () => {
    expect(authErrorProfile(browserConfig)).toEqual({
      profileKey: 'T0ACME',
      workspaceName: 'Acme Corp',
      authType: 'browser',
      workspaceUrl: 'https://acme.slack.com',
    });
  });

  it('uses the profile name when there is one', () => {
    expect(authErrorProfile({ ...standardConfig, profile: 'work-bot' })).toEqual({
      profileKey: 'work-bot',
      workspaceName: 'Acme Corp',
      authType: 'standard',
    });
  });

  it('carries no credential', () => {
    for (const config of [browserConfig, standardConfig]) {
      expect(JSON.stringify(authErrorProfile(config))).not.toContain('secret');
    }
  });
});

describe('SlackAuthError', () => {
  it('exposes the code, meaning, fix and the original Slack payload', () => {
    const slackData = { ok: false, error: 'token_revoked', extra: 1 };
    const error = new SlackAuthError('token_revoked', browserProfile, slackData);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SlackAuthError');
    expect(error.code).toBe('token_revoked');
    expect(error.meaning).toBe('The stored browser session was revoked by the user or a workspace admin.');
    expect(error.fix).toBe('slackcli auth login-auto --workspace-url https://acme.slack.com');
    expect(error.slackData).toBe(slackData);
    expect(error.message).toBe(formatAuthError(describeAuthError('token_revoked', browserProfile), browserProfile));
  });
});

describe('describeRejectedLogin', () => {
  it.each([...AUTH_ERROR_CODES])('never tells a failed login to log in again (%s)', (code) => {
    for (const authType of ['browser', 'standard'] as const) {
      const text = describeRejectedLogin(code, authType);
      expect(text).toContain(`(${code})`);
      expect(text).toContain('rejected by Slack');
      expect(text.toLowerCase()).not.toContain('log in again');
      expect(text).not.toContain('slackcli auth');
      expect(text).not.toContain('To fix');
      expect(text).not.toContain('stored');
    }
  });

  // `login-auto` captures the tokens itself, so the browser wording must not
  // tell the user they supplied or should copy anything.
  it.each([...AUTH_ERROR_CODES])('does not assume the user typed the browser tokens (%s)', (code) => {
    const text = describeRejectedLogin(code, 'browser');
    expect(text).not.toContain('supplied');
    expect(text.toLowerCase()).not.toContain('copy');
    expect(text).not.toContain('xoxd');
  });

  it('words the rejection for the kind of credential supplied', () => {
    expect(describeRejectedLogin('invalid_auth', 'standard')).toBe(
      'the supplied token was rejected by Slack (invalid_auth). Check that it was copied in full and has not been revoked or rotated.',
    );
    expect(describeRejectedLogin('invalid_auth', 'browser')).toBe(
      'the browser session tokens were rejected by Slack (invalid_auth). They must come from a browser that is signed in to this workspace: sign in there, then try again.',
    );
  });

  it('says an inactive account needs an admin, not fresh tokens', () => {
    for (const authType of ['browser', 'standard'] as const) {
      const text = describeRejectedLogin('account_inactive', authType);
      expect(text).toContain('contact a workspace admin');
      expect(text).not.toContain('sign in there');
      expect(text).not.toContain('copied in full');
    }
  });
});
