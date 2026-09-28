// The redaction patterns applied to every log line before it is written.
//
// Redaction runs on the *formatted* record (the JSON Lines string), so it covers
// every field — message, properties, error text — without each call site having
// to remember it. Call sites must still never log request params or message
// text; this is the safety net, not the policy.
//
// One source of truth: the `logs` command (#281) reuses these patterns.

import { JWT_PATTERN, redactByPattern } from '@logtape/redaction';
import type { RedactionPattern, RedactionPatterns } from '@logtape/redaction';
import type { TextFormatter } from '@logtape/logtape';

/**
 * Slack tokens: `xoxb-`, `xoxp-`, `xoxc-`, `xoxd-`, `xoxe-`, rotated
 * `xoxe.xoxp-`, URL-encoded values (`%2F`, `%3D`, …) and decoded ones: the
 * stored `xoxd` is URL-decoded, so it carries base64's `/`, `+` and `=`. The
 * character class deliberately excludes `\` and `"`, so a match can never
 * swallow a JSON escape and leave the line unparseable.
 */
export const SLACK_TOKEN_PATTERN: RedactionPattern = {
  pattern: /xox[a-z](?:\.xox[a-z])?-[A-Za-z0-9%._~+/=-]+/g,
  replacement: 'xox?-[REDACTED]',
};

/**
 * The `d` session cookie (`Cookie: d=<xoxd…>`). `\b` keeps names such as `id=`
 * or `channel_id=` out of it. Stops at `;`, whitespace, `"` and `\`.
 */
export const SLACK_COOKIE_PATTERN: RedactionPattern = {
  pattern: /\bd=[^;\s"\\]+/g,
  replacement: 'd=[REDACTED]',
};

export const SLACK_REDACTION_PATTERNS: RedactionPatterns = [
  SLACK_TOKEN_PATTERN,
  SLACK_COOKIE_PATTERN,
  JWT_PATTERN,
];

/** Wraps a text formatter so its output never carries a credential. */
export function redactFormatter(formatter: TextFormatter): TextFormatter {
  return redactByPattern(formatter, SLACK_REDACTION_PATTERNS);
}
