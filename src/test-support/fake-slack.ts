// Test-only: lets a test stand a local server in for Slack now that the browser
// transport refuses every workspace URL that is not an https slack.com origin
// (#513). Profiles keep the real-looking FAKE_SLACK_ORIGIN, and fetch is
// rerouted from that origin to the local server. Nothing in src/ imports this,
// so it never reaches the compiled binary, and the production check has no
// bypass to leave open.

/** The workspace URL test profiles store. */
export const FAKE_SLACK_ORIGIN = 'https://acme.slack.com';

/** The env variable the preload reads the local server's base URL from. */
export const FAKE_SLACK_SERVER_ENV = 'SLACKCLI_TEST_FAKE_SLACK_SERVER';

/** Absolute path of the preload script for `bun --preload`. */
export const FAKE_SLACK_PRELOAD = new URL('./fake-slack-preload.ts', import.meta.url).pathname;

function urlOf(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

/**
 * A fetch that sends FAKE_SLACK_ORIGIN requests to `server` (e.g.
 * `http://127.0.0.1:1234`), with their path, query and init, and passes
 * anything else to `realFetch`.
 */
export function fakeSlackFetch(server: string, realFetch: typeof fetch): typeof fetch {
  const rerouted = (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith(`${FAKE_SLACK_ORIGIN}/`)) {
      return realFetch(`${server}${url.slice(FAKE_SLACK_ORIGIN.length)}`, init);
    }
    return realFetch(input, init);
  };
  return Object.assign(rerouted, { preconnect: realFetch.preconnect }) as typeof fetch;
}
