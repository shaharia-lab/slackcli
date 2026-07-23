const INVALID_WORKSPACE_URL_MESSAGE =
  'Invalid Slack workspace URL: expected an HTTPS slack.com URL without credentials, a port, path, query, or fragment';

function invalidWorkspaceUrl(): Error {
  return new Error(INVALID_WORKSPACE_URL_MESSAGE);
}

/**
 * Validate a browser-auth workspace URL and return its normalized origin.
 */
export function normalizeSlackWorkspaceUrl(workspaceUrl: unknown): string {
  if (
    typeof workspaceUrl !== 'string' ||
    workspaceUrl !== workspaceUrl.trim()
  ) {
    throw invalidWorkspaceUrl();
  }

  const inputMatch = workspaceUrl.match(/^https:\/\/([^/?#]+)\/?$/i);
  if (!inputMatch) {
    throw invalidWorkspaceUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(workspaceUrl);
  } catch {
    throw invalidWorkspaceUrl();
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw invalidWorkspaceUrl();
  }

  // Comparing the original authority with URL.hostname catches explicit ports,
  // including the default HTTPS port that URL.port normalizes away.
  const authority = inputMatch[1].toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (authority !== hostname || hostname.length > 253) {
    throw invalidWorkspaceUrl();
  }

  if (hostname !== 'slack.com') {
    const suffix = '.slack.com';
    if (!hostname.endsWith(suffix)) {
      throw invalidWorkspaceUrl();
    }

    const subdomain = hostname.slice(0, -suffix.length);
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (subdomain.split('.').some((label) => !validLabel.test(label))) {
      throw invalidWorkspaceUrl();
    }
  }

  return parsed.origin;
}
