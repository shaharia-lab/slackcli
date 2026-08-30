<!--
Per the repository constitution (CLAUDE.md), every PR must be linked to an open,
triaged issue carrying the `ready-for-pr` label. PRs that skip this are likely
to be rejected, even if the code is good.
-->

## Linked issue

<!-- Required. Use a closing keyword so GitHub links the issue. -->
Fixes #

## Summary

<!-- What does this PR change, and why? Keep the change focused on the linked issue. -->

## Checklist

- [ ] The linked issue is open and carries the `ready-for-pr` label (constitution §1–2)
- [ ] Change is focused on the linked issue — no unrelated edits
- [ ] Tests added/updated, including edge cases (constitution §4)
- [ ] `bun run type-check` and `bun test` pass locally
- [ ] Pre-commit hooks are installed and passing — no `--no-verify`, no `SKIP=` (constitution §5)
- [ ] All commits are signed (constitution §5 — unsigned commits make the PR unmergeable)
- [ ] Documentation in `docs/` updated, added, or deleted as needed (constitution §7)
- [ ] No tokens, credentials, or user data handled insecurely
