---
name: release
description: Cut a new SlackCLI release end to end — survey commits since the last tag, recommend a SemVer bump, open the release issue, prepare the version bump and CHANGELOG promotion on a branch, open the linked PR, and after merge push the annotated tag that publishes binaries and updates the Homebrew tap. Use when asked to create/cut/prepare a release, bump the version, or ship what is on main.
---

# Cutting a SlackCLI release

A release is two separate things, in this order:

1. A **PR onto `main`** that bumps `package.json` and promotes the `CHANGELOG`. Reversible.
2. An **annotated tag** pushed to that merged commit. This is the irreversible, outward-facing step — `release.yml` builds and publishes public binaries, and force-updates the Homebrew tap at `shaharia-lab/homebrew-tap`.

Never do step 2 without explicit human confirmation. See [Gate before tagging](#7-gate-before-tagging).

## Hard constraints

These are the ways a release goes wrong. Check them, don't rediscover them.

- **`release.yml` fails when the tag disagrees with `package.json`** (#82). The bump must be merged into `main` *before* the tag is pushed. Fixing it after the fact means bumping `main` and then deleting and re-pushing the tag.
- **`main` requires signed commits, with no bypass actors** — an unsigned commit makes the PR unmergeable for anyone, including admins. Verify the release commit carries a signature.
- **The repository constitution in `CLAUDE.md` applies to the release PR too**: it needs a linked GitHub issue carrying `ready-for-pr` before the PR is opened. `pr-linked-issue.yml` enforces the link as a required check.
- **`main` requires one approving review, and an agent cannot approve its own PR.** So `gh pr merge` reports `BLOCKED` / `REVIEW_REQUIRED` even when every check is green. Unblocking it is the maintainer's decision, taken one of two ways — a review, or an explicit instruction to merge with `--admin`. Never pick `--admin` on your own initiative; surface the block and let the maintainer choose. `dismiss_stale_reviews_on_push` is on, so any push after an approval discards it — get the branch final *before* asking for review.
- **Pre-commit hooks block direct commits to `main`.** Always work on a branch.
- **A merged PR does not guarantee a `CHANGELOG` entry.** Reconcile commits against `[Unreleased]` yourself — the mrkdwn fix in #96 landed with no entry and had to be backfilled at v0.9.0.
- **`bun` may not be on `PATH`** in a non-interactive shell. If `bun` is not found, use `export PATH="$HOME/.bun/bin:$PATH"`.

## Procedure

### 1. Survey what is being released

```bash
git describe --tags --abbrev=0                     # last released tag
git log <last-tag>..HEAD --pretty=format:'%h %ad %s' --date=short
git diff <last-tag>..HEAD --stat
```

Separate **user-facing** commits (`feat`, `fix`, `perf`, anything changing CLI behaviour) from **non-shipping** ones (`ci`, `chore`, `docs`, dependency bumps). Only the first group justifies a release or drives the version.

Read the bodies of the user-facing commits — they carry the WHAT/WHY the changelog needs:

```bash
git show <sha> --pretty=format:'%B' --stat
```

### 2. Recommend a version

Follow SemVer against the pre-1.0 convention this repo already uses:

- New commands, new flags, newly accepted input formats → **minor** (`0.8.0` → `0.9.0`)
- Bug fixes only → **patch** (`0.8.0` → `0.8.1`)

State the recommendation and the reasoning before acting on it. A behaviour change that only alters already-broken output is still a fix, not a breaking change.

### 3. Reconcile the CHANGELOG

Compare the user-facing commits from step 1 against the `[Unreleased]` section. Anything shipped but undocumented gets an entry written now, in the voice of the surrounding file: what changed, and why the user cares. Note deliberate behaviour changes explicitly.

### 4. Open the release issue

Required before the PR. Mirror the WHAT / WHY / HOW structure the repo uses (see #101, #111):

- **WHAT** — cut release vX.Y.Z, bump `package.json` from A to B.
- **WHY** — the user-facing changes on `main` that are not yet in a published build, each with its issue/PR number; the SemVer reasoning; the `release.yml` tag/version constraint (#82).
- **HOW** — bump, promote the changelog, merge, push the annotated tag.
- Optionally a **Not included** section naming open `ready-for-pr` issues deliberately deferred, so the omission reads as a decision.

```bash
gh issue create --title "Release vX.Y.Z" --body-file <file> --label ready-for-pr
```

### 5. Prepare the branch

```bash
git checkout -b chore/release-vX.Y.Z
```

- `package.json`: bump `version`.
- `CHANGELOG.md`: insert a `## [X.Y.Z] - YYYY-MM-DD` heading below `## [Unreleased]`, leaving `[Unreleased]` in place and empty, so the existing entries fall under the new version.

Verify before committing:

```bash
bun run type-check
bun test
```

Both must be clean. Commit with `Closes #<issue>` in the body, then confirm the signature is present:

```bash
git cat-file -p HEAD | grep -q gpgsig && echo signed
```

`git log --show-signature` may report the signature as unverified purely because `gpg.ssh.allowedSignersFile` is unset locally; that is a local verification gap, not an unsigned commit. GitHub is the authority — `check-signatures` on the PR reports the truth.

### 6. Open the PR

```bash
gh pr create --base main --head chore/release-vX.Y.Z --title "chore: release vX.Y.Z" --body-file <file>
```

The body should carry: summary and the `release.yml` constraint, **Included since <last-tag>** listing the user-facing changes, **Changes in this PR**, the check results, the post-merge release steps, and `Closes #<issue>`.

Then wait for checks — `gh pr checks <pr>`. `Check linked open issue`, `check-signatures`, `test`, `unit-tests` and `integration-tests` must pass.

### 7. Gate before tagging

**Stop here and ask the human to confirm the merge and tag.** Everything up to this point is reversible; the tag is not — it publishes public binaries and rewrites the Homebrew formula.

The maintainer has to unblock the PR regardless — the branch ruleset requires a review the PR's own author cannot supply — so this gate costs nothing extra.

Once the maintainer has approved, or has explicitly asked for `--admin`:

```bash
gh pr merge <pr> --squash        # add --admin only when explicitly instructed
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

The tag must point at the merged bump commit. Tagging a commit where `package.json` still holds the old version fails `verify-version` immediately.

### 8. Verify the release landed

```bash
gh run list --workflow=release.yml --limit 3
gh release view vX.Y.Z
```

Confirm all five binaries plus `checksums.txt` are attached (`slackcli-linux`, `slackcli-linux-arm64`, `slackcli-macos`, `slackcli-macos-arm64`, `slackcli-windows.exe`), and that `update-homebrew` succeeded. Report the release URL.
