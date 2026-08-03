/**
 * Capture Slack browser-session tokens by observing a real signed-in browser.
 *
 * Slack's web client authenticates with a pair: an `xoxc-*` API token sent in
 * request bodies, and an `xoxd-*` value in the `d` cookie. The cookie is
 * HttpOnly, so page JavaScript cannot read it — it has to come from the
 * browser's own cookie store, which is why this drives CDP rather than, say,
 * injecting a script.
 *
 * Two sources are combined:
 *   - intercepted API requests, which prove a token is live and in use; and
 *   - `localConfig_v2` in localStorage, which lists every workspace the user
 *     is signed into, including ones they have not opened this session.
 * The union means one sign-in enrols every workspace. localStorage is Slack
 * client internals and may change shape without notice, so a failure to read
 * it degrades to whatever interception found rather than failing the run.
 *
 * The pure extractors below carry the parsing rules and are exported so the
 * tests can pin every request encoding Slack is known to use.
 */

import { connectCdpSocket, createCdpSession, type CdpSession } from './cdp-client.ts';
import {
  findPageTarget,
  launchBrowser,
  type BrowserLaunchFailure,
  type LaunchOptions,
} from './browser-launcher.ts';

export type CaptureFailure =
  | 'devtools_unreachable'
  | 'capture_timeout'
  | 'browser_closed'
  | 'no_cookie';

export interface CapturedWorkspace {
  workspaceUrl: string;
  xoxc: string;
  teamId?: string;
  teamName?: string;
}

export type CaptureResult =
  | { ok: true; xoxd: string; workspaces: CapturedWorkspace[] }
  | { ok: false; reason: CaptureFailure; message: string };

/** Slack API endpoints carrying the token we want. */
const SLACK_API_URL = /^https:\/\/([\w-]+(?:\.enterprise)?)\.slack\.com\/api\//i;

/**
 * The Slack web client's own host. It serves the app shell for every
 * workspace, so it is never itself a workspace origin — accepting it would
 * let a client-host API call masquerade as a distinct workspace and, since
 * workspaces are keyed by team id on save, overwrite the real entry's API
 * base with one that resolves to no particular team.
 */
const SLACK_CLIENT_HOST = 'app.slack.com';

/**
 * Gate every URL that will be paired with a session token.
 *
 * Load-bearing security boundary, not a tidiness check. Workspace URLs are
 * read out of the page's own localStorage, which is only as trustworthy as
 * whatever the browser happens to have open — and the URL becomes the host
 * that `slack-client.ts` sends the `d` cookie to. Without this gate a
 * non-Slack page can name any origin and receive the user's live session
 * credential in cleartext.
 */
export function isSlackWorkspaceUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (host === SLACK_CLIENT_HOST) return false;
  // Suffix match on a dot boundary — a plain `includes` would accept
  // `notslack.com.evil.net`.
  return host === 'slack.com' || host.endsWith('.slack.com');
}

/**
 * Where to send the browser by default.
 *
 * Must be `/client`, not `https://app.slack.com/`. Measured 2026-08-01: a
 * returning user with a live session cookie who opens `app.slack.com/` is
 * redirected to the marketing site (`slack.com/intl/...`), which issues no API
 * calls and defines no `localConfig_v2` — so capture sees nothing and times
 * out, even though the session is perfectly valid. `/client` loads the real
 * workspace client (~47 token-bearing calls within seconds) and, for a
 * signed-out user, still redirects to sign-in first. A workspace host such as
 * `https://myteam.slack.com/` behaves identically; both end up at
 * `app.slack.com/client/<team>/<channel>`.
 */
export const SLACK_CLIENT_URL = 'https://app.slack.com/client';

/**
 * Pull an `xoxc-*` token out of a request body.
 *
 * Slack uses three encodings depending on the endpoint, and all three occur in
 * normal client traffic — `curl-parser.ts` already carries the multipart and
 * JSON cases for the copy-as-cURL flow, and urlencoded shows up on the boot
 * calls. Missing one means missing workspaces, so all three are handled here.
 */
export function extractXoxcFromPostData(postData: string): string | null {
  if (!postData || !postData.includes('xoxc-')) return null;

  const patterns = [
    // multipart/form-data — the boundary puts the value on its own line.
    /name="token"[\s\S]*?(xoxc-[a-zA-Z0-9-]+)/,
    // application/json
    /"token"\s*:\s*"(xoxc-[a-zA-Z0-9-]+)"/,
    // application/x-www-form-urlencoded
    /(?:^|&)token=(xoxc-[a-zA-Z0-9-]+)/,
  ];

  for (const pattern of patterns) {
    const match = postData.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Find the `d` cookie and decode it.
 *
 * Cookies are queried unfiltered and matched on domain here rather than via a
 * `urls` filter, so an enterprise-grid host (`foo.enterprise.slack.com`) is
 * covered without enumerating hostnames. The stored value is percent-encoded,
 * matching what `curl-parser.ts` decodes out of a copied Cookie header.
 */
export function extractXoxdFromCookies(
  cookies: Array<{ name?: string; domain?: string; value?: string }>
): string | null {
  const match = cookies.find(
    (c) =>
      c.name === 'd' &&
      typeof c.value === 'string' &&
      c.value.length > 0 &&
      isSlackCookieDomain(c.domain ?? '')
  );
  if (!match?.value) return null;

  // A malformed percent-sequence makes decodeURIComponent throw; this
  // function's contract is `string | null`, and the caller reports a missing
  // cookie rather than the real cause if it escapes.
  let decoded: string;
  try {
    decoded = decodeURIComponent(match.value);
  } catch {
    return null;
  }
  return decoded.startsWith('xoxd-') ? decoded : null;
}

/**
 * Cookie-domain match, anchored on a dot boundary.
 *
 * Cookie domains may carry a leading dot (`.slack.com`). A substring test
 * would accept `notslack.com.evil.net` and hand that page's `d` value back as
 * if it were the real session.
 */
function isSlackCookieDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, '');
  return normalized === 'slack.com' || normalized.endsWith('.slack.com');
}

/**
 * Read every signed-in workspace out of a `localConfig_v2` payload.
 *
 * Defensive throughout: this is undocumented client state, and a shape change
 * must cost us the extra workspaces, never the run.
 */
export function extractWorkspacesFromLocalConfig(raw: string): CapturedWorkspace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const teams = (parsed as { teams?: unknown } | null)?.teams;
  if (!teams || typeof teams !== 'object') return [];

  const captured: CapturedWorkspace[] = [];
  for (const team of Object.values(teams as Record<string, any>)) {
    const token = team?.token;
    if (typeof token !== 'string' || !token.startsWith('xoxc-')) continue;

    const domain = typeof team?.domain === 'string' ? team.domain : null;
    const url = typeof team?.url === 'string' ? team.url : null;
    // Reduce to an origin: Slack stores `https://team.slack.com/` but has also
    // been seen carrying a path, and this value becomes the API base that
    // every later request is built on.
    const workspaceUrl = url
      ? safeOrigin(url)
      : domain
        ? `https://${encodeURIComponent(domain)}.slack.com`
        : null;
    // The gate: this URL is about to be paired with the live session cookie.
    if (!workspaceUrl || !isSlackWorkspaceUrl(workspaceUrl)) continue;

    captured.push({
      workspaceUrl,
      xoxc: token,
      ...(typeof team?.id === 'string' ? { teamId: team.id } : {}),
      ...(typeof team?.name === 'string' ? { teamName: team.name } : {}),
    });
  }
  return captured;
}

/**
 * Merge intercepted and localStorage-derived workspaces.
 *
 * Keyed on workspace URL. Intercepted tokens are preferred on conflict: they
 * were observed authenticating a live request, whereas a localStorage entry
 * can be a stale leftover from a workspace the user has since left.
 */
export function mergeWorkspaces(
  intercepted: CapturedWorkspace[],
  fromLocalConfig: CapturedWorkspace[]
): CapturedWorkspace[] {
  const byUrl = new Map<string, CapturedWorkspace>();
  for (const workspace of fromLocalConfig) {
    byUrl.set(workspace.workspaceUrl, workspace);
  }
  for (const workspace of intercepted) {
    const existing = byUrl.get(workspace.workspaceUrl);
    byUrl.set(
      workspace.workspaceUrl,
      existing ? { ...existing, ...workspace } : workspace
    );
  }
  return [...byUrl.values()];
}

/** Origin of a URL, or null if it does not parse. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Workspace origin for a Slack API URL, or null when it is not one. */
export function slackOriginFromApiUrl(url: string): string | null {
  const match = url.match(SLACK_API_URL);
  if (!match) return null;
  const origin = `https://${match[1]}.slack.com`;
  // Rejects the client host, which serves every workspace and belongs to none.
  return isSlackWorkspaceUrl(origin) ? origin : null;
}

export interface CaptureOptions {
  /** Overall budget for the user to finish signing in. */
  timeoutMs?: number;
  /** Only affects guidance text: with no window, "sign in" is unactionable. */
  headless?: boolean;
  /** Where to send the browser; defaults to the Slack web client. */
  startUrl?: string;
  onProgress?: (line: string) => void;
  /** Seams for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const POLL_INTERVAL_MS = 500;

/** Ceiling on waiting for additional workspaces to finish booting. */
const SETTLE_BUDGET_MS = 3_000;

/**
 * Drive an attached CDP session until Slack tokens are captured.
 *
 * Takes an established session rather than opening one so the whole capture
 * policy — what counts as a hit, when to give up, how sources combine — is
 * testable against a fake session with no browser involved.
 */
export async function captureSlackTokens(
  session: CdpSession,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const onProgress = options.onProgress ?? (() => {});
  const startUrl = options.startUrl ?? SLACK_CLIENT_URL;

  const intercepted = new Map<string, CapturedWorkspace>();

  session.on('Network.requestWillBeSent', (params: any) => {
    const url = params?.request?.url;
    const postData = params?.request?.postData;
    if (typeof url !== 'string' || typeof postData !== 'string') return;

    const origin = slackOriginFromApiUrl(url);
    if (!origin || intercepted.has(origin)) return;

    const xoxc = extractXoxcFromPostData(postData);
    if (xoxc) {
      intercepted.set(origin, { workspaceUrl: origin, xoxc });
    }
  });

  try {
    await session.send('Network.enable');
    await session.send('Runtime.enable');
    await session.send('Page.navigate', { url: startUrl });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'devtools_unreachable',
      message: `Lost the browser connection: ${err?.message ?? 'unknown error'}`,
    };
  }

  onProgress('Waiting for Slack sign-in in the browser window…');

  // Poll BOTH sources. Interception proves a token is live, but it only sees
  // the attached tab and only while Slack happens to be calling — so waiting
  // on it alone means a valid, fully signed-in session can time out. Reading
  // localStorage each tick makes the two sources genuine alternatives rather
  // than a primary and a decoration: either one alone is enough to finish.
  const deadline = now() + timeoutMs;
  let fromLocalConfig: CapturedWorkspace[] = [];
  let sessionLost = false;

  let consecutiveProbeFailures = 0;
  while (now() < deadline) {
    fromLocalConfig = await readWorkspacesFromLocalStorage(session);
    if (fromLocalConfig.length > 0 || intercepted.size > 0) break;

    if (await sessionAlive(session)) {
      consecutiveProbeFailures = 0;
    } else if (++consecutiveProbeFailures >= LIVENESS_FAILURES_BEFORE_DEAD) {
      sessionLost = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (sessionLost) {
    return {
      ok: false,
      reason: 'browser_closed',
      message:
        'The browser was closed before sign-in completed.\n' +
        '   Run the command again and leave the window open until it finishes.',
    };
  }

  if (fromLocalConfig.length === 0 && intercepted.size === 0) {
    return {
      ok: false,
      reason: 'capture_timeout',
      // Headless has no window, so "complete sign-in in the browser window" is
      // advice the user cannot act on. The real cause there is almost always a
      // saved session that has since expired.
      message: options.headless
        ? 'No Slack session was detected before the timeout.\n' +
          '   The saved browser session has probably expired — re-run without --headless\n' +
          '   and sign in again.'
        : 'No Slack session was detected before the timeout.\n' +
          '   Make sure you completed sign-in in the browser window.',
    };
  }

  // A workspace beyond the first surfaces a beat later, as the client boots
  // each one — so re-read until the count stops growing rather than waiting a
  // fixed interval. Two stable reads end it, which costs the common
  // single-workspace case one poll instead of the full settle budget.
  const settleDeadline = Math.min(now() + SETTLE_BUDGET_MS, deadline);
  let stableReads = 0;
  while (now() < settleDeadline && stableReads < 2) {
    await sleep(POLL_INTERVAL_MS);
    const settled = await readWorkspacesFromLocalStorage(session);
    if (settled.length > fromLocalConfig.length) {
      fromLocalConfig = settled;
      stableReads = 0;
    } else {
      stableReads += 1;
    }
  }

  onProgress('Session detected — reading tokens…');

  const xoxd = await readSessionCookie(session);
  if (!xoxd) {
    return {
      ok: false,
      reason: 'no_cookie',
      message:
        'Signed-in session found, but the `d` session cookie was not readable.\n' +
        '   Try again, or fall back to: slackcli auth parse-curl --login',
    };
  }

  return {
    ok: true,
    xoxd,
    workspaces: mergeWorkspaces([...intercepted.values()], fromLocalConfig),
  };
}

/**
 * Read the `d` cookie from the browser's whole cookie store.
 *
 * `Storage.getCookies` is the browser-wide call. `Network.getCookies` returns
 * cookies *for the current URL* — which happens to work while the tab sits on
 * Slack, and silently returns nothing when sign-in has parked it on an SSO or
 * IdP origin. It stays as a fallback for older protocol builds.
 */
async function readSessionCookie(session: CdpSession): Promise<string | null> {
  for (const method of ['Storage.getCookies', 'Network.getCookies'] as const) {
    try {
      const result = await session.send<{ cookies?: any[] }>(method);
      const found = extractXoxdFromCookies(result?.cookies ?? []);
      if (found) return found;
    } catch {
      // Try the next method; a session that is truly gone fails both and the
      // caller reports no_cookie.
    }
  }
  return null;
}

/** Read signed-in workspaces from Slack's localStorage. Never throws. */
async function readWorkspacesFromLocalStorage(
  session: CdpSession
): Promise<CapturedWorkspace[]> {
  try {
    const evaluated = await session.send<{ result?: { value?: string } }>(
      'Runtime.evaluate',
      {
        expression: "localStorage.getItem('localConfig_v2')",
        returnByValue: true,
      }
    );
    const raw = evaluated?.result?.value;
    return typeof raw === 'string' ? extractWorkspacesFromLocalConfig(raw) : [];
  } catch {
    // Undocumented client state, and the tab may be mid-navigation.
    return [];
  }
}

/**
 * Cheap liveness probe.
 *
 * Without a probe the wait loop is a bare sleep: a user who closes the browser
 * waits out the entire timeout — five minutes by default — and is then told to
 * complete sign-in in a window that no longer exists.
 *
 * A single failure is NOT death. This exact call fails transiently whenever the
 * tab renavigates and tears down its execution context, which is precisely what
 * an SSO redirect does — so treating one error as fatal aborts the sign-in the
 * command exists to perform, at the moment the user is typing their password.
 * Only a sustained run of failures counts.
 */
const LIVENESS_FAILURES_BEFORE_DEAD = 4;

async function sessionAlive(session: CdpSession): Promise<boolean> {
  try {
    await session.send('Runtime.evaluate', { expression: '1', returnByValue: true });
    return true;
  } catch {
    return false;
  }
}

export type BrowserSessionFailure = BrowserLaunchFailure | 'devtools_unreachable';

export type BrowserSessionResult =
  | { ok: true; session: CdpSession; stop: () => Promise<void> }
  | { ok: false; reason: BrowserSessionFailure; message: string };

/**
 * Launch a browser and attach a CDP session to its page target.
 *
 * The IO edge of the capture: everything it composes is covered elsewhere,
 * and every early return releases the browser it already started — a failure
 * here must never strand a window on the user's desktop.
 */
export async function openBrowserSession(
  options: LaunchOptions = {}
): Promise<BrowserSessionResult> {
  const launched = await launchBrowser(options);
  if (!launched.ok) return launched;

  const wsUrl = await findPageTarget(launched.port);
  if (!wsUrl) {
    await launched.stop();
    return {
      ok: false,
      reason: 'devtools_unreachable',
      message: 'The browser started but exposed no page to attach to.',
    };
  }

  // Captured before the closures below so the narrowed type survives.
  const stopBrowser = launched.stop;

  try {
    const socket = await connectCdpSocket(wsUrl);
    const session = createCdpSession(socket);

    // Signal reaping lives in `launchBrowser`, registered the moment the child
    // exists — the window between spawn and attach is seconds long and is
    // exactly when a user interrupts, so covering only this point would leave
    // the common case orphaning a signed-in browser.
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;

      // Ask Chrome to quit itself before resorting to signals. Only the browser
      // can reap its own renderer/GPU/utility helpers and release the profile
      // locks — signalling the parent leaves the helpers orphaned, and killing
      // them outright leaves the profile in a state Chrome refuses to reopen.
      // Best effort: if it does not oblige, `stopBrowser` still escalates.
      try {
        await Promise.race([
          session.send('Browser.close'),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch {
        // Browser already gone, or the command is unavailable.
      }

      session.close();
      await stopBrowser();
    };

    return { ok: true, session, stop };
  } catch (err: any) {
    await launched.stop();
    return {
      ok: false,
      reason: 'devtools_unreachable',
      message: err?.message ?? 'Could not attach to the browser.',
    };
  }
}
