import { describe, expect, it } from 'bun:test';
import {
  captureSlackTokens,
  extractWorkspacesFromLocalConfig,
  extractXoxcFromPostData,
  extractXoxdFromCookies,
  mergeWorkspaces,
  slackOriginFromApiUrl,
  SLACK_CLIENT_URL,
} from './browser-auth';
import type { CdpSession } from './cdp-client';

// Anonymized bodies matching the three encodings Slack's web client uses.
const MULTIPART_BODY =
  '------WebKitFormBoundaryAbc\r\n' +
  'Content-Disposition: form-data; name="token"\r\n\r\n' +
  'xoxc-111222333-444555666-abcdefghij\r\n' +
  '------WebKitFormBoundaryAbc\r\n' +
  'Content-Disposition: form-data; name="channel"\r\n\r\n' +
  'C038K56TGNB\r\n' +
  '------WebKitFormBoundaryAbc--\r\n';

const JSON_BODY = '{"token":"xoxc-json-test-111-222","as_admin":false}';

const URLENCODED_BODY =
  'token=xoxc-urlencoded-999-888&channel=C123456&limit=100';

const LOCAL_CONFIG = JSON.stringify({
  teams: {
    T111: {
      id: 'T111',
      name: 'Alpha Team',
      domain: 'alpha',
      url: 'https://alpha.slack.com/',
      token: 'xoxc-alpha-token-111',
    },
    T222: {
      id: 'T222',
      name: 'Beta Team',
      domain: 'beta',
      token: 'xoxc-beta-token-222',
    },
  },
});

describe('extractXoxcFromPostData', () => {
  it('extracts a token from a multipart/form-data body', () => {
    expect(extractXoxcFromPostData(MULTIPART_BODY)).toBe(
      'xoxc-111222333-444555666-abcdefghij'
    );
  });

  it('extracts a token from a JSON body', () => {
    expect(extractXoxcFromPostData(JSON_BODY)).toBe('xoxc-json-test-111-222');
  });

  it('extracts a token from a urlencoded body', () => {
    expect(extractXoxcFromPostData(URLENCODED_BODY)).toBe(
      'xoxc-urlencoded-999-888'
    );
  });

  it('extracts a urlencoded token that is not the first field', () => {
    expect(extractXoxcFromPostData('channel=C1&token=xoxc-second-field-1')).toBe(
      'xoxc-second-field-1'
    );
  });

  it('returns null when the body carries no token', () => {
    expect(extractXoxcFromPostData('channel=C123456&limit=100')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(extractXoxcFromPostData('')).toBeNull();
  });

  it('does not mistake an xoxb token for a browser token', () => {
    expect(extractXoxcFromPostData('token=xoxb-bot-token-123')).toBeNull();
  });
});

describe('extractXoxdFromCookies', () => {
  it('finds and decodes the d cookie', () => {
    const cookies = [
      { name: 'lc', domain: '.slack.com', value: '1770041685' },
      { name: 'd', domain: '.slack.com', value: 'xoxd-plain-token-123' },
    ];
    expect(extractXoxdFromCookies(cookies)).toBe('xoxd-plain-token-123');
  });

  it('percent-decodes an encoded cookie value', () => {
    const cookies = [
      { name: 'd', domain: '.slack.com', value: 'xoxd-encoded%2Btoken%2Fwith%3Dspecial' },
    ];
    expect(extractXoxdFromCookies(cookies)).toBe('xoxd-encoded+token/with=special');
  });

  it('ignores a d cookie set on a non-Slack domain', () => {
    const cookies = [{ name: 'd', domain: '.example.com', value: 'xoxd-not-slack' }];
    expect(extractXoxdFromCookies(cookies)).toBeNull();
  });

  it('ignores a d cookie whose value is not an xoxd token', () => {
    const cookies = [{ name: 'd', domain: '.slack.com', value: 'something-else' }];
    expect(extractXoxdFromCookies(cookies)).toBeNull();
  });

  it('returns null when no cookies are present', () => {
    expect(extractXoxdFromCookies([])).toBeNull();
  });
});

describe('extractWorkspacesFromLocalConfig', () => {
  it('reads every team, deriving the URL from domain when url is absent', () => {
    const workspaces = extractWorkspacesFromLocalConfig(LOCAL_CONFIG);
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toEqual({
      workspaceUrl: 'https://alpha.slack.com',
      xoxc: 'xoxc-alpha-token-111',
      teamId: 'T111',
      teamName: 'Alpha Team',
    });
    expect(workspaces[1].workspaceUrl).toBe('https://beta.slack.com');
  });

  it('skips teams without a browser token', () => {
    const raw = JSON.stringify({
      teams: { T1: { id: 'T1', domain: 'a' }, T2: { id: 'T2', domain: 'b', token: 'xoxc-ok-1' } },
    });
    expect(extractWorkspacesFromLocalConfig(raw)).toHaveLength(1);
  });

  it('degrades to empty on malformed JSON rather than throwing', () => {
    expect(extractWorkspacesFromLocalConfig('not json at all')).toEqual([]);
  });

  it('degrades to empty when the teams key is missing', () => {
    expect(extractWorkspacesFromLocalConfig('{"other":true}')).toEqual([]);
  });
});

describe('mergeWorkspaces', () => {
  it('unions both sources', () => {
    const merged = mergeWorkspaces(
      [{ workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-a' }],
      [{ workspaceUrl: 'https://beta.slack.com', xoxc: 'xoxc-b' }]
    );
    expect(merged).toHaveLength(2);
  });

  it('prefers the intercepted token but keeps localConfig metadata', () => {
    const merged = mergeWorkspaces(
      [{ workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-live' }],
      [
        {
          workspaceUrl: 'https://alpha.slack.com',
          xoxc: 'xoxc-stale',
          teamId: 'T111',
          teamName: 'Alpha Team',
        },
      ]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].xoxc).toBe('xoxc-live');
    expect(merged[0].teamName).toBe('Alpha Team');
  });
});

describe('slackOriginFromApiUrl', () => {
  it('matches a standard workspace API call', () => {
    expect(slackOriginFromApiUrl('https://alpha.slack.com/api/conversations.view?x=1')).toBe(
      'https://alpha.slack.com'
    );
  });

  it('matches an enterprise grid host', () => {
    expect(slackOriginFromApiUrl('https://myorg.enterprise.slack.com/api/users.list')).toBe(
      'https://myorg.enterprise.slack.com'
    );
  });

  it('rejects a non-API Slack URL', () => {
    expect(slackOriginFromApiUrl('https://alpha.slack.com/client/T1/C1')).toBeNull();
  });

  it('rejects a non-Slack host', () => {
    expect(slackOriginFromApiUrl('https://evil.example.com/api/x')).toBeNull();
  });
});

// A fake CDP session: emits queued requests when the page navigates, and
// answers the three commands the capture depends on.
interface FakeOptions {
  requests?: Array<{ url: string; postData?: string }>;
  cookies?: Array<{ name?: string; domain?: string; value?: string }>;
  localConfig?: string | null;
  throwOn?: string;
}

function makeFakeSession(options: FakeOptions = {}): CdpSession {
  const handlers = new Map<string, Array<(params: any) => void>>();
  return {
    on(method, handler) {
      const list = handlers.get(method);
      if (list) list.push(handler);
      else handlers.set(method, [handler]);
    },
    async send<T>(method: string): Promise<T> {
      if (options.throwOn === method) throw new Error('boom');
      if (method === 'Page.navigate') {
        for (const request of options.requests ?? []) {
          for (const handler of handlers.get('Network.requestWillBeSent') ?? []) {
            handler({ request });
          }
        }
      }
      if (method === 'Network.getCookies') {
        return { cookies: options.cookies ?? [] } as T;
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: options.localConfig ?? undefined } } as T;
      }
      return {} as T;
    },
    close() {},
  };
}

// Capture polls a clock; advancing it per call keeps the settle loop bounded.
const advancingClock = (step = 1000) => {
  let t = 0;
  return () => (t += step);
};

const captureDeps = {
  sleep: async () => {},
  now: advancingClock(),
};

describe('SLACK_CLIENT_URL', () => {
  // Regression guard. `https://app.slack.com/` (no /client) sends a returning
  // user to the marketing site, which makes no API calls — capture then times
  // out on a perfectly valid session. Verified against live Slack 2026-08-01.
  it('targets the client, not the Slack home page', () => {
    expect(SLACK_CLIENT_URL).toBe('https://app.slack.com/client');
  });
});

describe('captureSlackTokens', () => {
  const SLACK_COOKIES = [{ name: 'd', domain: '.slack.com', value: 'xoxd-session-abc' }];

  it('navigates to the client URL by default', async () => {
    const navigated: string[] = [];
    const base = makeFakeSession({
      requests: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }],
      cookies: SLACK_COOKIES,
    });
    const session: CdpSession = {
      ...base,
      async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === 'Page.navigate') navigated.push(String(params?.url));
        return base.send<T>(method, params);
      },
    };

    await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(navigated).toEqual([SLACK_CLIENT_URL]);
  });

  it('captures the cookie and an intercepted workspace', async () => {
    const session = makeFakeSession({
      requests: [
        { url: 'https://alpha.slack.com/api/conversations.view', postData: MULTIPART_BODY },
      ],
      cookies: SLACK_COOKIES,
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xoxd).toBe('xoxd-session-abc');
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].workspaceUrl).toBe('https://alpha.slack.com');
  });

  it('unions intercepted workspaces with those only in localConfig', async () => {
    const session = makeFakeSession({
      requests: [
        { url: 'https://alpha.slack.com/api/conversations.view', postData: MULTIPART_BODY },
      ],
      cookies: SLACK_COOKIES,
      localConfig: LOCAL_CONFIG,
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const urls = result.workspaces.map((w) => w.workspaceUrl).sort();
    expect(urls).toEqual(['https://alpha.slack.com', 'https://beta.slack.com']);
  });

  it('times out when no Slack request is ever seen', async () => {
    const session = makeFakeSession({ cookies: SLACK_COOKIES });

    const result = await captureSlackTokens(session, {
      ...captureDeps,
      now: advancingClock(),
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capture_timeout');
  });

  it('reports no_cookie when a session is found but the d cookie is missing', async () => {
    const session = makeFakeSession({
      requests: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }],
      cookies: [],
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_cookie');
  });

  it('reports devtools_unreachable when the session breaks during setup', async () => {
    const session = makeFakeSession({ throwOn: 'Network.enable' });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('devtools_unreachable');
  });

  it('still succeeds when localStorage cannot be read', async () => {
    const session = makeFakeSession({
      requests: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }],
      cookies: SLACK_COOKIES,
      throwOn: 'Runtime.evaluate',
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces).toHaveLength(1);
  });

  it('ignores non-Slack traffic', async () => {
    const session = makeFakeSession({
      requests: [
        { url: 'https://analytics.example.com/api/track', postData: 'token=xoxc-decoy-1' },
      ],
      cookies: SLACK_COOKIES,
      timeoutMs: 3000,
    } as FakeOptions);

    const result = await captureSlackTokens(session, {
      ...captureDeps,
      now: advancingClock(),
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capture_timeout');
  });
});
