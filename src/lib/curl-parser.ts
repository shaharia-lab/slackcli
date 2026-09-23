/**
 * Curl command parser for extracting Slack authentication tokens
 */

export interface ParsedCurlResult {
  workspaceName: string;
  workspaceUrl: string;
  xoxd: string;
  xoxc: string;
}

export interface ParseError {
  field: 'workspace' | 'xoxd' | 'xoxc';
  message: string;
}

/**
 * Extract the workspace name (first subdomain segment) from a Slack workspace URL.
 * Handles both standard (myorg.slack.com) and enterprise (myorg.enterprise.slack.com) URLs.
 * Returns 'workspace' if the URL does not match.
 */
export function extractSlackWorkspaceName(url: string): string {
  const match = /https?:\/\/([\w.-]+)\.slack\.com/.exec(url);
  return match ? match[1].split('.')[0] : 'workspace';
}

/**
 * Request body of a cURL command: `--data-raw` or `--data`, followed by a
 * single-quoted ('…', $'…') or double-quoted ("…", $"…") value. Group 1 holds a
 * single-quoted body, group 2 a double-quoted one. `--data\s` cannot match
 * inside `--data-raw`, `--data-binary` or `--data-urlencode`, and a single scan
 * means the leftmost flag in the command wins.
 */
const DATA_BODY_PATTERN = /--data(?:-raw)?\s+\$?(?:'([^']+)'|"([^"]+)")/;

/**
 * Parse a cURL command and extract Slack authentication tokens
 */
export function parseCurlCommand(curlInput: string): ParsedCurlResult {
  // Extract workspace URL — domain can be myorg.slack.com or myorg.enterprise.slack.com
  // The URL is either positional (curl 'https://...') or behind the --url flag
  // (curl --url 'https://...'), which Chrome 151+ DevTools emits for "Copy as cURL".
  const urlMatch = /(?:curl\s+|--url(?:\s+|=))['"]?(https?:\/\/([\w.-]+)\.slack\.com[^'"\s]*)/.exec(
    curlInput
  );
  if (!urlMatch) {
    throw new CurlParseError('workspace', 'Could not find Slack workspace URL in cURL command');
  }
  const fullSubdomain = urlMatch[2];
  const workspaceUrl = `https://${fullSubdomain}.slack.com`;
  const workspaceName = extractSlackWorkspaceName(workspaceUrl);

  // Extract xoxd token from cookie header
  // Supports: -b 'cookies', --cookie 'cookies', -H 'Cookie: cookies'
  // The value's first character excludes whitespace so `\s*` and the value
  // never compete for the same characters (quadratic backtracking, #213).
  const cookieMatch = /(?:-b|--cookie)\s+'([^']+)'|-H\s+'[Cc]ookie:\s*([^'\s][^']*)'/.exec(
    curlInput
  );
  const cookieHeader = cookieMatch ? (cookieMatch[1] || cookieMatch[2]) : '';

  const xoxdMatch = /(?:^|;\s*)d=(xoxd-[^;]+)/.exec(cookieHeader);
  if (!xoxdMatch) {
    throw new CurlParseError('xoxd', 'Could not find xoxd token in cookie header (d=xoxd-...)');
  }
  const xoxdEncoded = xoxdMatch[1];
  const xoxd = decodeURIComponent(xoxdEncoded);

  // Extract xoxc token from data
  const dataMatch = DATA_BODY_PATTERN.exec(curlInput);
  const dataContent = dataMatch ? (dataMatch[1] ?? dataMatch[2] ?? '') : '';

  const xoxcMatch =
    /name="token".*?(xoxc-[a-zA-Z0-9-]+)/.exec(dataContent) ||
    /"token"\s*:\s*"(xoxc-[a-zA-Z0-9-]+)"/.exec(dataContent);
  if (!xoxcMatch) {
    throw new CurlParseError('xoxc', 'Could not find xoxc token in request data');
  }
  const xoxc = xoxcMatch[1];

  return {
    workspaceName,
    workspaceUrl,
    xoxd,
    xoxc,
  };
}

/**
 * Custom error class for cURL parsing errors
 */
export class CurlParseError extends Error {
  public field: ParseError['field'];

  constructor(field: ParseError['field'], message: string) {
    super(message);
    this.name = 'CurlParseError';
    this.field = field;
  }
}

/**
 * Validate that a string looks like a cURL command
 */
export function looksLikeCurlCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith('curl ') || trimmed.startsWith('curl\t');
}
