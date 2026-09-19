# Release Policy

This document describes **when** SlackCLI releases happen and **what you can expect** from them. For the mechanics of cutting a release (tags, workflows, the Homebrew tap), see [Build and release](docs/development/build-and-release.md).

SlackCLI is maintained by volunteers. The schedule below is what we work to, and we take it seriously — but it is a commitment made in good faith, not a service-level agreement.

## Schedule

**Releases are cut weekly, on Saturday** (European evening).

A release includes **everything merged to `main` at the moment it is cut**. There is no earlier merge cutoff: if your pull request is merged before the Saturday release starts, it ships that week; otherwise it ships the next.

### A release only happens when there is something releasable

A Saturday with nothing releasable on `main` is skipped — there are no empty version bumps.

A change is **releasable** when it brings real value to someone running the CLI:

- New features — commands, options, newly accepted input formats
- Bug fixes
- Improvements to existing behaviour
- Performance improvements
- Runtime dependency updates (they change the shipped binary)
- Fixes to user-visible error messages and help text

These do **not** trigger a release on their own, and simply ride along with the next one:

- Documentation changes
- Website changes (`web/`)
- CI, tooling and test-only changes
- Changes to the Claude Code plugin under `plugins/` — it is distributed from the repository, not inside the binary

### If a Saturday is missed

If a release cannot be cut on a given Saturday for any other reason — the maintainer is unavailable, CI is red — the changes roll over to the **following Saturday**. Missed releases are not made up mid-week.

## Out-of-band releases

Some fixes do not wait for Saturday. These are released **as early as possible after the verified fix lands on `main`**, on a best-effort basis:

| Situation | Examples |
| --- | --- |
| **Security vulnerabilities** | A zero-day or any high-priority security fix, especially around token and credential handling |
| **Critical bugs and regressions** | Crashes, data loss, broken authentication, or a regression introduced by the latest release |
| **Slack-side breakage** | Slack changes something upstream that breaks a command |
| **Broken install or update** | Faulty binaries, a broken Homebrew formula, or a failing `slackcli update` |

To report a vulnerability, follow [SECURITY.md](SECURITY.md) — never a public issue for anything that could be actively exploited.

## Versioning

SlackCLI follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), using the usual pre-1.0 convention while the version is `0.x`:

| Change | Bump | Example |
| --- | --- | --- |
| New commands, new options, newly accepted input formats | **minor** | `0.11.0` → `0.12.0` |
| Bug fixes only | **patch** | `0.11.0` → `0.11.1` |
| Breaking changes | **minor**, called out as **BREAKING** in the release notes | `0.11.0` → `0.12.0` |

A patch release never contains a breaking change. A change that only alters already-broken output is a fix, not a breaking change.

Every release is a **stable release cut from `main`**. There are no release candidates, betas or nightly builds.

## Deprecation policy

We deprecate before we remove. When a command, option or output field is going away:

1. It keeps working and prints a deprecation warning on **stderr** — never stdout, so `--json` output stays parseable — and the deprecation is noted in the release notes.
2. It stays available for **at least one minor release** after the release that deprecated it. Something deprecated in `0.N` may be removed in `0.N+1` at the earliest.

Three exceptions, where a behaviour may change or disappear without a deprecation period:

- **Security fixes** — when keeping the old behaviour would be unsafe.
- **Slack-side changes** — when Slack removes or changes the API a feature depends on, the CLI cannot keep the old behaviour alive. This applies particularly to browser-session authentication paths, which rely on undocumented endpoints.
- **Experimental features** — anything explicitly marked experimental in the documentation.

## Supported versions

Only the **latest release** is supported. Fixes, including security fixes, always ship in a new release; they are not backported to older versions. If you hit a problem, please reproduce it on the latest version before reporting it.

## How you will hear about a release

| Channel | What happens |
| --- | --- |
| [GitHub Releases](https://github.com/shaharia-lab/slackcli/releases) | The canonical announcement: release notes, binaries for every platform and `checksums.txt`. Use **Watch → Custom → Releases** on the repository to be notified. |
| The CLI itself | SlackCLI checks for a newer version in the background, at most once every 24 hours, and prints a notice on stderr when one exists. |
| [slackcli.dev](https://slackcli.dev) | The website reads the latest version and download links from GitHub Releases whenever it is built. |

The full history of changes is kept in [CHANGELOG.md](CHANGELOG.md).

## How a release reaches you

| Install method | How to upgrade | When the new version is available |
| --- | --- | --- |
| Pre-built binary | `slackcli update`, or download from [GitHub Releases](https://github.com/shaharia-lab/slackcli/releases/latest) | As soon as the GitHub Release is published |
| Homebrew | `brew update && brew upgrade slackcli` | Shortly after — the release workflow updates the [`shaharia-lab/tap`](https://github.com/shaharia-lab/homebrew-tap) formula automatically once the binaries are published |

`slackcli update` deliberately does nothing for a Homebrew install; use `brew upgrade` there. See [Installation](docs/user-guide/installation.md) for details.

## What ships next

Everything merged to `main` since the last release ships in the next one, provided at least one of those changes is releasable. To see exactly what is waiting, compare the latest tag with `main`:

```text
https://github.com/shaharia-lab/slackcli/compare/<latest-tag>...main
```

If the issue you care about is closed by a merged pull request, it is in the next release.

## Who cuts releases

Releases are cut by the maintainer. If you need a release outside the schedule, [open an issue](https://github.com/shaharia-lab/slackcli/issues/new/choose) explaining why. Requests that fall under [Out-of-band releases](#out-of-band-releases) are prioritised; anything else normally waits for the next Saturday.
