# Security Policy

## Reporting a Vulnerability

We take security seriously and appreciate your help in keeping SlackCLI safe for everyone.

### GitHub Issues

For most security concerns, please open a GitHub issue describing the vulnerability, its potential impact, and steps to reproduce if possible.

### Private Disclosure for Critical Vulnerabilities

If you discover a zero-day vulnerability or a critical issue that could be actively exploited, please report it privately by email:

**hello@shaharialab.com**

Use email when:

- The vulnerability is a zero-day or has no known fix.
- Public disclosure could put users at immediate risk.
- The issue involves sensitive data exposure or remote code execution.
- You believe the vulnerability is being actively exploited.

In your email, please include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- The potential impact and affected components.
- Any suggested fixes, if you have them.

We will acknowledge your report within 48 hours and work with you to understand the scope and coordinate a fix before any public disclosure.

## Supported Versions

Security fixes are applied to the latest release. We recommend always running the most recent version of SlackCLI.

## Token & Credential Safety

SlackCLI stores Slack tokens locally at `~/.config/slackcli/workspaces.json` with file permissions set to `0o600` (owner read/write only). Never share this file or commit it to version control. If you believe your tokens have been compromised, revoke them immediately in your Slack workspace settings or at [api.slack.com/apps](https://api.slack.com/apps).
