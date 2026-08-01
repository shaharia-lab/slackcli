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
      (c.domain ?? '').includes('slack.com')
  );
  if (!match?.value) return null;

  const decoded = decodeURIComponent(match.value);
  return decoded.startsWith('xoxd-') ? decoded : null;
}

/**
 * Read every signed-in workspace out of a `localConfig_v2` payload.
 *
 * Defensive throughout: this is undocumented client state, and a shape change
 * must cost us the extra workspaces, never the run.
 */
export function extractWorkspacesFromLocalConfig(raw: string): CapturedWorkspace[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const teams = parsed?.teams;
  if (!teams || typeof teams !== 'object') return [];

  const captured: CapturedWorkspace[] = [];
  for (const team of Object.values<any>(teams)) {
    const token = team?.token;
    if (typeof token !== 'string' || !token.startsWith('xoxc-')) continue;

    const domain = typeof team?.domain === 'string' ? team.domain : null;
    const url = typeof team?.url === 'string' ? team.url : null;
    const workspaceUrl = url
      ? url.replace(/\/+$/, '')
      : domain
        ? `https://${domain}.slack.com`
        : null;
    if (!workspaceUrl) continue;

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

/** Workspace origin for a Slack API URL, or null when it is not one. */
export function slackOriginFromApiUrl(url: string): string | null {
  const match = url.match(SLACK_API_URL);
  return match ? `https://${match[1]}.slack.com` : null;
}

export interface CaptureOptions {
  /** Overall budget for the user to finish signing in. */
  timeoutMs?: number;
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

  const deadline = now() + timeoutMs;
  while (now() < deadline && intercepted.size === 0) {
    await sleep(POLL_INTERVAL_MS);
  }

  if (intercepted.size === 0) {
    return {
      ok: false,
      reason: 'capture_timeout',
      message:
        'No Slack session was detected before the timeout.\n' +
        '   Make sure you completed sign-in in the browser window.',
    };
  }

  // A workspace beyond the first surfaces a beat later, as the client boots
  // each one. A short extra settle is much cheaper than making the user
  // re-run to pick up the rest.
  const settleDeadline = Math.min(now() + 3_000, deadline);
  while (now() < settleDeadline) {
    await sleep(POLL_INTERVAL_MS);
  }

  onProgress('Session detected — reading tokens…');

  let xoxd: string | null = null;
  try {
    const result = await session.send<{ cookies?: any[] }>('Network.getCookies');
    xoxd = extractXoxdFromCookies(result?.cookies ?? []);
  } catch {
    xoxd = null;
  }

  if (!xoxd) {
    return {
      ok: false,
      reason: 'no_cookie',
      message:
        'Signed-in session found, but the `d` session cookie was not readable.\n' +
        '   Try again, or fall back to: slackcli auth parse-curl --login',
    };
  }

  let fromLocalConfig: CapturedWorkspace[] = [];
  try {
    const evaluated = await session.send<{ result?: { value?: string } }>(
      'Runtime.evaluate',
      {
        expression: "localStorage.getItem('localConfig_v2')",
        returnByValue: true,
      }
    );
    const raw = evaluated?.result?.value;
    if (typeof raw === 'string') {
      fromLocalConfig = extractWorkspacesFromLocalConfig(raw);
    }
  } catch {
    // Undocumented client state; interception already gave us a usable result.
    fromLocalConfig = [];
  }

  return {
    ok: true,
    xoxd,
    workspaces: mergeWorkspaces([...intercepted.values()], fromLocalConfig),
  };
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

  try {
    const socket = await connectCdpSocket(wsUrl);
    const session = createCdpSession(socket);
    return {
      ok: true,
      session,
      stop: async () => {
        session.close();
        await launched.stop();
      },
    };
  } catch (err: any) {
    await launched.stop();
    return {
      ok: false,
      reason: 'devtools_unreachable',
      message: err?.message ?? 'Could not attach to the browser.',
    };
  }
}
