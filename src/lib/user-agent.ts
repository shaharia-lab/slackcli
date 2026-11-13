/**
 * The User-Agent a browser-auth workspace sends to Slack.
 *
 * A browser session's `xoxd`/`xoxc` pair belongs to the browser it came from.
 * Calling Slack with it under a different User-Agent looks like the session
 * being replayed from a second client, and workspaces with stricter session
 * security answer by signing the account out everywhere (#105, #535). So the
 * login paths capture the browser's own User-Agent and the client replays it.
 */

/** Sent by workspaces saved before the User-Agent was captured. */
export const DEFAULT_BROWSER_USER_AGENT = 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)';

/** Real browser User-Agents are a few hundred characters; this is generous. */
const MAX_USER_AGENT_LENGTH = 1024;

/**
 * A captured User-Agent that is safe to send as a header, or undefined.
 *
 * The value comes from pasted input or a browser page, and ends up in the
 * workspace file and in a request header, so anything outside printable ASCII
 * (CR/LF above all) is refused rather than cleaned up.
 */
export function sanitizeUserAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USER_AGENT_LENGTH) return undefined;
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

/** The User-Agent to send for a stored browser workspace. */
export function browserUserAgent(config: { user_agent?: string }): string {
  return sanitizeUserAgent(config.user_agent) ?? DEFAULT_BROWSER_USER_AGENT;
}
