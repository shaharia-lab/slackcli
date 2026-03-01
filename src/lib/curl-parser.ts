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
 * Parse a cURL command and extract Slack authentication tokens
 */
export function parseCurlCommand(curlInput: string): ParsedCurlResult {
  // Extract workspace URL — domain can be myorg.slack.com or myorg.enterprise.slack.com
  const urlMatch = curlInput.match(/curl\s+'?(https?:\/\/([\w.-]+)\.slack\.com[^'"\s]*)/);
  if (!urlMatch) {
    throw new CurlParseError('workspace', 'Could not find Slack workspace URL in cURL command');
  }
  const fullSubdomain = urlMatch[2];
  const workspaceUrl = `https://${fullSubdomain}.slack.com`;
  const workspaceName = fullSubdomain.split('.')[0];

  // Extract xoxd token from cookie header
  // Supports: -b 'cookies', --cookie 'cookies', -H 'Cookie: cookies'
  const cookieMatch = curlInput.match(
    /-b\s+'([^']+)'|--cookie\s+'([^']+)'|-H\s+'[Cc]ookie:\s*([^']+)'/
  );
  const cookieHeader = cookieMatch ? (cookieMatch[1] || cookieMatch[2] || cookieMatch[3]) : '';

  const xoxdMatch = cookieHeader.match(/(?:^|;\s*)d=(xoxd-[^;]+)/);
  if (!xoxdMatch) {
    throw new CurlParseError('xoxd', 'Could not find xoxd token in cookie header (d=xoxd-...)');
  }
  const xoxdEncoded = xoxdMatch[1];
  const xoxd = decodeURIComponent(xoxdEncoded);

  // Extract xoxc token from data
  // Supports: --data-raw 'data', --data-raw $'data', --data 'data', --data $'data'
  const dataMatch = curlInput.match(
    /--data-raw\s+\$?'([^']+)'|--data-raw\s+\$?"([^"]+)"|--data\s+\$?'([^']+)'|--data\s+\$?"([^"]+)"/
  );
  const dataContent = dataMatch
    ? (dataMatch[1] || dataMatch[2] || dataMatch[3] || dataMatch[4])
    : '';

  const xoxcMatch = dataContent.match(/name="token".*?(xoxc-[a-zA-Z0-9-]+)/);
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
