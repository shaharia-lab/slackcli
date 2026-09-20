import { describe, expect, it } from 'bun:test';
import {
  captureSlackTokens,
  extractWorkspacesFromLocalConfig,
  extractXoxcFromPostData,
  extractXoxdFromCookies,
  mergeWorkspaces,
  slackOriginFromApiUrl,
  isSlackWorkspaceUrl,
  SLACK_CLIENT_URL,
} from './browser-auth';
import { isSafeStartUrl } from './browser-launcher';
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

  // A substring test passes all of these; only a dot-anchored suffix rejects
  // them. Each one would otherwise hand a hostile page's value back as the
  // user's real session.
  it.each([
    'notslack.com',
    'slack.com.evil.net',
    '.slack.com.attacker.io',
    'myslack.community',
  ])('rejects a d cookie on look-alike domain %s', (domain) => {
    expect(extractXoxdFromCookies([{ name: 'd', domain, value: 'xoxd-stolen' }])).toBeNull();
  });

  it('accepts the real parent domain and an enterprise subdomain', () => {
    expect(extractXoxdFromCookies([{ name: 'd', domain: '.slack.com', value: 'xoxd-ok' }])).toBe('xoxd-ok');
    expect(
      extractXoxdFromCookies([{ name: 'd', domain: 'foo.enterprise.slack.com', value: 'xoxd-ent' }])
    ).toBe('xoxd-ent');
  });

  it('returns null rather than throwing on a malformed percent-sequence', () => {
    // decodeURIComponent throws URIError here; the signature promises null.
    expect(() =>
      extractXoxdFromCookies([{ name: 'd', domain: '.slack.com', value: 'xoxd-100%bad' }])
    ).not.toThrow();
    expect(
      extractXoxdFromCookies([{ name: 'd', domain: '.slack.com', value: 'xoxd-100%bad' }])
    ).toBeNull();
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

  // localStorage is only as trustworthy as whatever page the browser has
  // open, and this URL becomes the host the live session cookie is sent to.
  it.each([
    ['plain http', 'http://attacker.example:8731'],
    ['non-Slack https host', 'https://attacker.example'],
    ['look-alike host', 'https://slack.com.evil.net'],
    ['the client host itself', 'https://app.slack.com'],
    ['a file URL', 'file:///etc/passwd'],
    ['unparseable', 'not a url at all'],
  ])('refuses a team whose url is %s', (_label, url) => {
    const raw = JSON.stringify({ teams: { T1: { id: 'T1', url, token: 'xoxc-x' } } });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([]);
  });

  it('reduces a team url carrying a path to its origin', () => {
    const raw = JSON.stringify({
      teams: { T1: { id: 'T1', url: 'https://alpha.slack.com/messages/C1', token: 'xoxc-a' } },
    });
    expect(extractWorkspacesFromLocalConfig(raw)[0].workspaceUrl).toBe('https://alpha.slack.com');
  });

  // Undocumented client state: every one of these shapes must cost us the
  // workspaces, never throw out of the capture.
  it.each([
    ['JSON null', 'null'],
    ['a JSON string', '"teams"'],
    ['a JSON number', '42'],
    ['teams set to null', '{"teams":null}'],
    ['teams set to a string', '{"teams":"T1"}'],
    ['teams set to a number', '{"teams":7}'],
    ['teams set to false', '{"teams":false}'],
    ['an empty teams object', '{"teams":{}}'],
    ['an empty string', ''],
  ])('returns [] without throwing for %s', (_label, raw) => {
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([]);
  });

  it.each([
    ['a null team', null],
    ['a string team', 'T1'],
    ['a team with no token', { id: 'T1', domain: 'a' }],
    ['a numeric token', { id: 'T1', domain: 'a', token: 123 }],
    ['an xoxb token', { id: 'T1', domain: 'a', token: 'xoxb-bot-1' }],
    ['an xoxp token', { id: 'T1', domain: 'a', token: 'xoxp-user-1' }],
    ['a token that only contains xoxc-', { id: 'T1', domain: 'a', token: 'Bearer xoxc-1' }],
    ['neither domain nor url', { id: 'T1', token: 'xoxc-1' }],
    ['an empty domain and no url', { id: 'T1', domain: '', token: 'xoxc-1' }],
    ['a non-string domain and url', { id: 'T1', domain: 5, url: ['x'], token: 'xoxc-1' }],
  ])('skips %s', (_label, team) => {
    expect(extractWorkspacesFromLocalConfig(JSON.stringify({ teams: { T1: team } }))).toEqual([]);
  });

  it('keeps the well-formed teams alongside malformed ones', () => {
    const raw = JSON.stringify({
      teams: {
        T0: null,
        T1: { id: 'T1', name: 'Alpha', domain: 'alpha', token: 'xoxc-alpha-1' },
        T2: { id: 'T2', token: 'xoxb-bot-2', domain: 'beta' },
        T3: { id: 'T3', token: 'xoxc-nohost-3' },
        T4: { id: 'T4', url: 'https://attacker.example', token: 'xoxc-evil-4' },
        T5: { id: 'T5', url: 'https://gamma.slack.com/', token: 'xoxc-gamma-5' },
      },
    });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([
      { workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-alpha-1', teamId: 'T1', teamName: 'Alpha' },
      { workspaceUrl: 'https://gamma.slack.com', xoxc: 'xoxc-gamma-5', teamId: 'T5' },
    ]);
  });

  it('prefers url over domain when both are present', () => {
    const raw = JSON.stringify({
      teams: { T1: { domain: 'ignored', url: 'https://real.slack.com/', token: 'xoxc-1' } },
    });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([
      { workspaceUrl: 'https://real.slack.com', xoxc: 'xoxc-1' },
    ]);
  });

  it('falls back to domain when url is an empty string', () => {
    const raw = JSON.stringify({ teams: { T1: { domain: 'alpha', url: '', token: 'xoxc-1' } } });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([
      { workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-1' },
    ]);
  });

  // An unparseable url must not fall through to domain: the team is dropped.
  it('does not fall back to domain when url is present but unparseable', () => {
    const raw = JSON.stringify({ teams: { T1: { domain: 'alpha', url: 'not a url', token: 'xoxc-1' } } });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([]);
  });

  it('percent-encodes a domain so it cannot smuggle in another host', () => {
    const raw = JSON.stringify({ teams: { T1: { domain: 'evil.net/x', token: 'xoxc-1' } } });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([]);
  });

  it('omits teamId and teamName when they are not strings', () => {
    const raw = JSON.stringify({ teams: { T1: { id: 1, name: null, domain: 'alpha', token: 'xoxc-1' } } });
    const [workspace] = extractWorkspacesFromLocalConfig(raw);
    expect(workspace).toEqual({ workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-1' });
    expect(Object.keys(workspace)).toEqual(['workspaceUrl', 'xoxc']);
  });

  it('reads teams stored as an array', () => {
    const raw = JSON.stringify({ teams: [{ domain: 'alpha', token: 'xoxc-1' }] });
    expect(extractWorkspacesFromLocalConfig(raw)).toEqual([
      { workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-1' },
    ]);
  });
});

describe('isSlackWorkspaceUrl', () => {
  it.each([
    'https://alpha.slack.com',
    'https://myorg.enterprise.slack.com',
    'https://slack.com',
  ])('accepts %s', (url) => {
    expect(isSlackWorkspaceUrl(url)).toBe(true);
  });

  it.each([
    'http://alpha.slack.com',
    'https://app.slack.com',
    'https://slack.com.evil.net',
    'https://notslack.com',
    'javascript:alert(1)',
    '',
  ])('rejects %s', (url) => {
    expect(isSlackWorkspaceUrl(url)).toBe(false);
  });
});

describe('isSafeStartUrl', () => {
  // A start URL is positional browser argv: a leading dash makes it a switch.
  it.each([
    '--proxy-server=127.0.0.1:9931',
    '--remote-debugging-address=0.0.0.0',
    '-incognito',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isSafeStartUrl(url)).toBe(false);
  });

  it('accepts an ordinary https URL', () => {
    expect(isSafeStartUrl('https://alpha.slack.com/')).toBe(true);
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
  /** Every command starts failing after this many calls — a browser the user
   *  closed mid-capture. */
  dieAfterCalls?: number;
  /** Fail exactly this many calls, then recover — a tab renavigating, which
   *  tears down the execution context without the browser going anywhere. */
  transientFailures?: number;
}

function makeFakeSession(options: FakeOptions = {}): CdpSession {
  const handlers = new Map<string, Array<(params: any) => void>>();
  let calls = 0;
  let transientRemaining = options.transientFailures ?? 0;
  return {
    on(method, handler) {
      const list = handlers.get(method);
      if (list) list.push(handler);
      else handlers.set(method, [handler]);
    },
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls += 1;
      if (options.dieAfterCalls !== undefined && calls > options.dieAfterCalls) {
        throw new Error('CDP Runtime.evaluate failed: socket closed');
      }
      // Models a renavigation: only evaluations fail, and only for a while.
      // The socket is fine, so setup and cookie reads are unaffected.
      if (method === 'Runtime.evaluate' && transientRemaining > 0) {
        transientRemaining -= 1;
        throw new Error('CDP Runtime.evaluate failed: Execution context was destroyed');
      }
      if (options.throwOn === method) throw new Error('boom');
      if (method === 'Page.navigate') {
        for (const request of options.requests ?? []) {
          for (const handler of handlers.get('Network.requestWillBeSent') ?? []) {
            handler({ request });
          }
        }
      }
      if (method === 'Storage.getCookies' || method === 'Network.getCookies') {
        return { cookies: options.cookies ?? [] } as T;
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        // The capture uses Runtime.evaluate for two different jobs; only the
        // localStorage read should yield a config payload.
        if (expression.includes('localConfig_v2')) {
          return { result: { value: options.localConfig ?? undefined } } as T;
        }
        return { result: { value: 1 } } as T;
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

  // The two sources must be genuine alternatives. Interception only sees the
  // attached tab and only while Slack is calling, so a valid session would
  // otherwise time out whenever it happened not to be talking.
  it('succeeds from localStorage alone when no request is intercepted', async () => {
    const session = makeFakeSession({
      requests: [],
      cookies: SLACK_COOKIES,
      localConfig: LOCAL_CONFIG,
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces.map((w) => w.workspaceUrl).sort()).toEqual([
      'https://alpha.slack.com',
      'https://beta.slack.com',
    ]);
  });

  it('succeeds from interception alone when localStorage is empty', async () => {
    const session = makeFakeSession({
      requests: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }],
      cookies: SLACK_COOKIES,
      localConfig: null,
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces).toHaveLength(1);
  });

  // Without a liveness probe this waited out the full timeout — five minutes
  // by default — then told the user to finish signing in inside a window that
  // no longer existed.
  it('reports browser_closed instead of waiting out the timeout', async () => {
    const session = makeFakeSession({ dieAfterCalls: 3, cookies: SLACK_COOKIES });

    const result = await captureSlackTokens(session, {
      ...captureDeps,
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('browser_closed');
  });

  // An SSO redirect tears down the execution context, so this probe fails
  // transiently while the browser is perfectly alive. Treating one failure as
  // death aborts the sign-in at the moment the user is typing their password.
  it('survives transient probe failures without declaring the browser closed', async () => {
    const session = makeFakeSession({
      transientFailures: 3,
      cookies: SLACK_COOKIES,
      localConfig: LOCAL_CONFIG,
    });

    const result = await captureSlackTokens(session, {
      ...captureDeps,
      now: advancingClock(),
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces.length).toBeGreaterThan(0);
  });

  it('refuses a hostile workspace URL planted in localStorage', async () => {
    const hostile = JSON.stringify({
      teams: { T1: { id: 'T1', url: 'http://attacker.example:8731', token: 'xoxc-x' } },
    });
    const session = makeFakeSession({
      requests: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }],
      cookies: SLACK_COOKIES,
      localConfig: hostile,
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the legitimately intercepted workspace survives.
    expect(result.workspaces.map((w) => w.workspaceUrl)).toEqual(['https://alpha.slack.com']);
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

  // Scripts a session whose state changes as the capture polls it: each
  // localStorage read takes the next entry of `localConfigs` (the last one
  // repeats), and `emitOnRead` fires intercepted requests just before the
  // given read — Slack calling its API while the capture is mid-wait.
  function makeScriptedSession(script: {
    localConfigs?: Array<string | null>;
    emitOnRead?: Record<number, Array<{ url?: unknown; postData?: unknown }>>;
    cookies?: Array<{ name?: string; domain?: string; value?: string }>;
    /** 1-based liveness probes that fail, as a renavigating tab's do. */
    failingProbes?: number[];
  }) {
    const stats = { localConfigReads: 0, probes: 0 };
    const handlers: Array<(params: any) => void> = [];
    const session: CdpSession = {
      on(method, handler) {
        if (method === 'Network.requestWillBeSent') handlers.push(handler);
      },
      async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === 'Storage.getCookies' || method === 'Network.getCookies') {
          return { cookies: script.cookies ?? SLACK_COOKIES } as T;
        }
        if (method !== 'Runtime.evaluate') return {} as T;
        if (!String(params?.expression ?? '').includes('localConfig_v2')) {
          stats.probes += 1;
          if (script.failingProbes?.includes(stats.probes)) {
            throw new Error('CDP Runtime.evaluate failed: Execution context was destroyed');
          }
          return { result: { value: 1 } } as T;
        }
        stats.localConfigReads += 1;
        for (const request of script.emitOnRead?.[stats.localConfigReads] ?? []) {
          for (const handler of handlers) handler({ request });
        }
        const configs = script.localConfigs ?? [null];
        const value = configs[Math.min(stats.localConfigReads, configs.length) - 1];
        return { result: { value: value ?? undefined } } as T;
      },
      close() {},
    };
    return { session, stats };
  }

  const countingSleep = () => {
    const calls: number[] = [];
    return { calls, sleep: async (ms: number) => void calls.push(ms) };
  };

  it('finishes on the first poll without sleeping when a token is already there', async () => {
    const { session, stats } = makeScriptedSession({
      emitOnRead: { 1: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }] },
    });
    const { calls, sleep } = countingSleep();

    const result = await captureSlackTokens(session, {
      sleep,
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result).toEqual({
      ok: true,
      xoxd: 'xoxd-session-abc',
      workspaces: [{ workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-json-test-111-222' }],
    });
    // No liveness probe once a token is found; one read to find it plus two
    // stable settle reads, each settle read preceded by one poll interval.
    expect(stats.probes).toBe(0);
    expect(stats.localConfigReads).toBe(3);
    expect(calls).toEqual([500, 500]);
  });

  it('keeps polling until an intercepted token arrives, then stops early', async () => {
    const { session, stats } = makeScriptedSession({
      emitOnRead: { 4: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }] },
    });
    const { calls, sleep } = countingSleep();

    const result = await captureSlackTokens(session, {
      sleep,
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(true);
    // Reads 1–3 find nothing and are each followed by a probe and a sleep;
    // read 4 sees the token. Nowhere near the 300s timeout.
    expect(stats.probes).toBe(3);
    expect(stats.localConfigReads).toBe(6);
    expect(calls).toHaveLength(5);
  });

  it('keeps polling until localStorage is populated, then stops early', async () => {
    const { session, stats } = makeScriptedSession({
      localConfigs: [null, null, LOCAL_CONFIG],
    });

    const result = await captureSlackTokens(session, {
      sleep: async () => {},
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces.map((w) => w.workspaceUrl)).toEqual([
      'https://alpha.slack.com',
      'https://beta.slack.com',
    ]);
    expect(stats.probes).toBe(2);
  });

  it('polls once per interval until the deadline, then times out', async () => {
    const { session, stats } = makeScriptedSession({});
    const { calls, sleep } = countingSleep();

    const result = await captureSlackTokens(session, {
      sleep,
      now: advancingClock(1000),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capture_timeout');
    expect(result.message).toContain('completed sign-in in the browser window');
    // Deadline is t=1000+5000; the loop head reads t=2000..5000 (four polls)
    // and exits at t=6000.
    expect(stats.localConfigReads).toBe(4);
    expect(stats.probes).toBe(4);
    expect(calls).toEqual([500, 500, 500, 500]);
  });

  it('tells a headless run its saved session probably expired on timeout', async () => {
    const { session } = makeScriptedSession({});

    const result = await captureSlackTokens(session, {
      sleep: async () => {},
      now: advancingClock(),
      timeoutMs: 3000,
      headless: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capture_timeout');
    expect(result.message).toContain('re-run without --headless');
  });

  // Only a *consecutive* run of failures means the browser is gone. Two SSO
  // hops back to back fail three probes each, with one success between them.
  it('resets the probe-failure count after a successful probe', async () => {
    const { session } = makeScriptedSession({
      failingProbes: [1, 2, 3, 5, 6, 7],
      localConfigs: [null, null, null, null, null, null, null, LOCAL_CONFIG],
    });

    const result = await captureSlackTokens(session, {
      sleep: async () => {},
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(true);
  });

  it('declares the browser closed on the fourth consecutive failed probe', async () => {
    const { session, stats } = makeScriptedSession({ failingProbes: [1, 2, 3, 4, 5, 6] });

    const result = await captureSlackTokens(session, {
      sleep: async () => {},
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('browser_closed');
    expect(stats.probes).toBe(4);
  });

  it('picks up a workspace that finishes booting during the settle window', async () => {
    const oneTeam = JSON.stringify({
      teams: { T111: { id: 'T111', domain: 'alpha', token: 'xoxc-alpha-token-111' } },
    });
    const { session } = makeScriptedSession({ localConfigs: [oneTeam, oneTeam, LOCAL_CONFIG] });

    const result = await captureSlackTokens(session, {
      sleep: async () => {},
      now: advancingClock(),
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces.map((w) => w.workspaceUrl)).toEqual([
      'https://alpha.slack.com',
      'https://beta.slack.com',
    ]);
  });

  it('prefers the intercepted token over localStorage for the same workspace', async () => {
    const { session } = makeScriptedSession({
      localConfigs: [LOCAL_CONFIG],
      emitOnRead: { 1: [{ url: 'https://alpha.slack.com/api/x', postData: 'token=xoxc-live-1' }] },
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alpha = result.workspaces.find((w) => w.workspaceUrl === 'https://alpha.slack.com');
    expect(alpha).toEqual({
      workspaceUrl: 'https://alpha.slack.com',
      xoxc: 'xoxc-live-1',
      teamId: 'T111',
      teamName: 'Alpha Team',
    });
  });

  it('keeps the first intercepted token per workspace and ignores malformed events', async () => {
    const { session } = makeScriptedSession({
      emitOnRead: {
        1: [
          { url: 'https://alpha.slack.com/api/a' },
          { url: 42, postData: 'token=xoxc-bad-url-1' },
          { url: 'https://alpha.slack.com/api/b', postData: { token: 'xoxc-object-1' } },
          { url: 'https://alpha.slack.com/api/c', postData: 'channel=C1' },
          { url: 'https://alpha.slack.com/api/d', postData: 'token=xoxc-first-1' },
          { url: 'https://alpha.slack.com/api/e', postData: 'token=xoxc-second-2' },
          { url: 'https://beta.slack.com/api/f', postData: 'token=xoxc-beta-3' },
        ],
      },
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces).toEqual([
      { workspaceUrl: 'https://alpha.slack.com', xoxc: 'xoxc-first-1' },
      { workspaceUrl: 'https://beta.slack.com', xoxc: 'xoxc-beta-3' },
    ]);
  });

  it('never puts a token value in a failure message', async () => {
    const { session } = makeScriptedSession({
      emitOnRead: { 1: [{ url: 'https://alpha.slack.com/api/x', postData: JSON_BODY }] },
      cookies: [],
    });

    const result = await captureSlackTokens(session, { ...captureDeps, now: advancingClock() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_cookie');
    expect(result.message).not.toContain('xoxc-');
  });

  it('ignores non-Slack traffic', async () => {
    const session = makeFakeSession({
      requests: [
        { url: 'https://analytics.example.com/api/track', postData: 'token=xoxc-decoy-1' },
      ],
      cookies: SLACK_COOKIES,
    });

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
