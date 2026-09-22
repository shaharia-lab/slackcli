# Architecture

SlackCLI is a thin, layered CLI. The shape is deliberately boring: commands
parse and print, libraries do the work, and exactly one class knows how to talk
to Slack.

```
src/index.ts                 Commander program; registers 7 command groups
        │
        ▼
src/commands/*.ts            Parse flags, call lib, format output, set exit code
        │
        ▼
src/lib/*.ts                 All logic: client, auth, storage, parsers, formatting
        │
        ▼
src/types/index.ts           Shared interfaces
```

**The rule that keeps it navigable:** command files contain no Slack knowledge
and no business logic beyond argument handling. Anything testable lives in
`src/lib/`, which is why the lib modules have thorough unit tests and the
command files have very few.

## Dual authentication

Two credential kinds coexist everywhere, and the split is the single most
important thing to understand about this codebase.

| | Standard | Browser |
|---|---|---|
| Tokens | `xoxb-*` / `xoxp-*` | `xoxd-*` cookie + `xoxc-*` token |
| Transport | `@slack/web-api` `WebClient` | raw `fetch` to `<workspace_url>/api/<method>` |
| Auth carried by | SDK bearer token | `Cookie: d=<urlencoded xoxd>` + `token` form field |
| Discriminated by | `config.auth_type === 'standard'` | `config.auth_type === 'browser'` |

`SlackClient.request()` in `src/lib/slack-client.ts` is the fork:

```ts
async request(method: string, params = {}) {
  return this.rateLimiter.run(() =>
    this.config.auth_type === 'standard'
      ? this.standardRequest(method, params)
      : this.browserRequest(method, params));
}
```

Everything above it — every `listConversations`, `postMessage`, `searchMessages`
— is auth-agnostic and goes through `request()`. **New API calls belong there,
not in a command file.**

### Throttling

Because `request()` is a complete funnel, it is also where outgoing traffic is
paced. `src/lib/rate-limiter.ts` holds a hand-rolled `RateLimiter` — a
concurrency cap plus a minimum delay between call *starts* — and
`slackRateLimiter`, the process-wide instance every `SlackClient` shares by
default (`SLACK_MAX_CONCURRENT_REQUESTS`, `SLACK_MIN_REQUEST_INTERVAL_MS`).

It exists because Slack's Enterprise Grid anomaly detection raises
[`unexpected_api_call_volume`](https://docs.slack.dev/reference/audit-logs-api/anomalous-events-reference/)
when a client outpaces what a browser would do, and it can log the session out.
Several paths fan out one call per entity — `getUsersInfo()`,
`enrichSavedItems()` in `saved.ts`, and the unread resolver in `unread.ts` — so
the gate sits in `request()` and those modules need no throttling of their own.

Two consequences worth knowing:

- The pacing applies to **both** auth types. The anomaly is about volume, not
  about which transport produced it.
- Commands that resolve many names (`saved list`, `conversations unread`) are
  measurably slower on large workspaces. That is the trade; keep the spinner
  running so it does not look hung.

Retry/backoff on HTTP 429 is deliberately *not* here — it is a separate concern
from pacing, and the raw `fetch()` calls used for file upload/download are
single-shot per invocation, so they bypass the limiter.

### Where the two genuinely diverge

A handful of methods branch on `authType` because Slack itself offers different
endpoints. Each divergence is one method, and each is a deliberate trade:

| Method | Browser | Standard |
|---|---|---|
| `createDraft` | `drafts.create` | throws — no public API exists |
| `listDrafts` | `drafts.list` | throws — no public API exists |
| `listSavedItems` | `saved.list` | `stars.list` |
| `searchModules` | `search.modules` | list + client-side filter (capped at 1000) |
| `getUnreadCounts` | `client.counts` | `conversations.list` unread fields |
| `fetchMessage` (`src/lib/message.ts`) | `messages.list` — resolves replies too | `conversations.history` — top-level only |

When you add a feature that only one auth type can support, follow this shape:
implement the capable path, degrade or fail loudly on the other, and say so in
the command's `--help` text and in the [user guide](../user-guide/README.md).

## Workspace storage

`src/lib/workspaces.ts` owns `~/.config/slackcli/workspaces.json` (file `0600`
inside a `0700` directory).

The map key is a **profile key**. Resolution and key derivation are pure
functions with no I/O — `resolveWorkspace()` and `deriveStorageKey()` — which is
why they are heavily unit-tested.

- `resolveWorkspace()` tries, in order: exact profile key → explicit `profile`
  field → workspace ID → workspace name. A selector matching more than one
  record throws `AmbiguousWorkspaceError` instead of guessing.
- `deriveStorageKey()` keeps backward compatibility: the first identity for a
  team is stored under its bare `team_id`, exactly as before profiles existed.
  Re-authenticating the same identity (team + auth type + `user_id`) refreshes in
  place; a *different* identity gets `T123-2` rather than overwriting the first.

If you touch either function, assume there are legacy config files in the wild
that predate the `profile` and `user_id` fields — the tests encode that.

### Credentials go through a `SecretStore`

Secrets (`token`, `xoxc_token`, `xoxd_token`) are never read or written on a
record directly. `src/lib/secret-store.ts` defines a small `SecretStore`
interface (`get`/`set`/`delete` on string keys of the form
`<profile key>:<token|xoxc|xoxd>`), and `workspaces.ts` splits every config into
metadata (`metadataOf()`) plus secrets (`storeCredentials()` /
`loadCredentials()` / `deleteCredentials()`).

- `FileSecretStore` keeps secrets inline on the record under their legacy field
  names — so an all-file `workspaces.json` is byte-for-byte unchanged. It
  mutates the loaded document; `saveWorkspaces()` still does the one write.
- `MacOSKeychainSecretStore` (macOS only) shells out to the `security` CLI
  (service `slackcli`, account `<profile key>:<token|xoxc|xoxd>`) rather than
  an FFI binding — the `cdp-client.ts` trade-off again. Its `SecurityCliRunner`
  is injectable, the same seam `cdp-client.test.ts` uses for an untestable
  transport, so it is fully unit-tested without a real Mac or keychain.
- `get` returns `null` only when a secret does not exist. A backend that is
  unavailable or refuses access throws `SecretStoreError` (`reason`
  `unavailable` / `access_denied`); a record whose secret is missing surfaces as
  `MissingCredentialError`. Keep those three cases distinct.
- Only `getWorkspace()` resolves secrets. `auth list` and `auth set-default`
  work from metadata; `auth remove` and `auth logout` delete credentials before
  the record, so a failing backend leaves the profile listed and retryable.
- The document-level operations (`putWorkspace`, `readWorkspace`,
  `dropWorkspace`, `dropAllWorkspaces`) take the document and a store and do no
  I/O — test new credential behaviour there, with an in-memory store, never
  against the real `~/.config/slackcli`.

### Multiple backends in one document: `RoutingSecretStore` and migration

A profile's `secret_backend` field (absent = `'file'`) says which backend its
credentials are on. `workspaces.ts`'s `secretStoreFor()` wraps every document
in a `RoutingSecretStore`, which re-reads that field on every call and
dispatches to `FileSecretStore` or the Keychain store accordingly — so one
document can hold some profiles on each backend at once, and a profile mid
re-tag is never read from the wrong place.

`putWorkspace()` only applies its `backend` argument to a **brand-new**
profile; refreshing an existing one (a plain token rotation via `auth login`)
always keeps whatever backend it is already tagged with, ignoring the
argument. Otherwise an ordinary refresh — which passes Commander's `'file'`
default, not the user's original choice — would silently migrate a Keychain
profile back to plaintext. The only sanctioned way to change an existing
profile's backend is `migrateWorkspaceCredentials()` /
`auth migrate-secrets`.

Migration takes explicit `{ file, keychain }` backend instances
(`secretBackendsFor()`), never the routing store — the routing store starts
reading the *new* backend the instant the metadata flips mid-migration, so the
function needs a reference to the *old* backend that survives that flip.
Order, all covered by `workspaces.test.ts`'s failure-injection tests:

1. Read + validate credentials on the current backend.
2. Write them to the target backend; a write failure cleans up the target and
   leaves everything else untouched.
3. Read them back from the target and compare byte-for-byte
   (`credentialsMatch()`); a mismatch cleans up the target the same way.
4. Flip `secret_backend` on the in-memory record — replacing it with fresh
   metadata, which also clears an old *file* backend's inline secret as a side
   effect, not a separate step.

The **IO wrapper** (`migrateSecrets()`) then does two things the document-level
function deliberately does not: `saveWorkspaces()` to persist the flip
durably, and only *after* that succeeds, deletes the old backend's copy. That
ordering — durably commit the new copy before removing the last old one — is
the same rule `putWorkspace()` follows for an auth-type switch; breaking it
either way risks a state with neither backend holding a valid credential.
Migrating "every profile" loops one profile at a time through this same
sequence rather than batching, so an interruption mid-batch leaves the
document in a valid, resumable state and a re-run only touches what is left.

## Authentication flows

`src/lib/auth.ts` orchestrates login and is the only place that decides a token
is valid.

- `authenticateStandard()` and `authenticateBrowser()` build a temporary config,
  call `auth.test`, then persist the real `team_id` / `user_id` from the
  response.
- `authenticateAuto()` — the `login-auto` flow — deliberately routes
  verification and persistence back through `authenticateBrowser()`, so a
  workspace enrolled by the browser is indistinguishable from one added by hand.
- `getAuthenticatedClient(identifier?)` is what every command calls to get a
  ready `SlackClient`.

Per-workspace failures in `authenticateAuto()` are collected rather than thrown:
when several workspaces are captured at once, one stale token must not discard
the rest.

## Browser token capture (`login-auto`)

Three modules, in order:

1. **`browser-launcher.ts`** — finds a local Chrome/Edge/Chromium/Brave
   (`SLACKCLI_BROWSER` overrides), launches it against SlackCLI's own profile
   directory with remote debugging on loopback, and cleans it up.
2. **`cdp-client.ts`** — a ~200-line Chrome DevTools Protocol client over Bun's
   WebSocket. Playwright would be the obvious alternative, but SlackCLI ships as
   a `bun build --compile` binary: bundling Playwright blows the 150 MB CI
   budget, and an external one cannot be resolved from a downloaded binary at
   all. The transport edge (`connectCdpSocket`) is kept a few lines long;
   everything decidable lives in `createCdpSession`, behind a `CdpSocket` seam so
   it unit-tests without a browser.
3. **`browser-auth.ts`** — captures the pair. The `xoxc-*` token comes from
   intercepted API requests (which proves it is live); the `xoxd-*` value comes
   from the browser's cookie store, because the `d` cookie is `HttpOnly` and page
   JavaScript cannot read it. It also reads `localConfig_v2` from localStorage to
   enumerate workspaces the user is signed into but has not opened — that union
   is why one sign-in enrols every workspace. localStorage is Slack client
   internals and may change shape without notice, so a failure to read it
   degrades to whatever interception found rather than failing the run.

Security invariants worth preserving if you work here: only `https://` URLs on a
`slack.com` host are ever paired with the session cookie, and that check is
re-done at the point the credential is used rather than being delegated; the
browser is closed whether or not capture succeeded; and `auth logout` deletes the
browser profile, because while it exists it can re-mint working tokens with no
prompt.

## Parsers

Each is dependency-free and pure, so each is directly testable:

| Module | Job |
|---|---|
| `curl-parser.ts` | Pull `xoxd`/`xoxc` out of a DevTools cURL command. Handles URL-encoded tokens, `-b` / `--cookie` / `-H 'Cookie:'`, and enterprise Slack URLs. The most thoroughly tested file in the repo — use it as the model for new tests. |
| `slack-url-parser.ts` | Normalise Slack URLs, permalinks, and timestamps into IDs. Also produces the workspace-mismatch warning. |
| `mrkdwn.ts` | Slack mrkdwn → `rich_text` blocks, for drafts. |
| `canvas-parser.ts` | Slack canvas (Quip-based) HTML → Markdown, zero dependencies. |

## Output

`src/lib/formatter.ts` holds every chalk-coloured renderer plus `success()`,
`error()`, `info()`, `warning()`.

One rule with teeth — read the comment above `writeJson()` before changing
anything about output:

> **Never call `process.exit()` after `writeJson()`.** `ora` materialises Bun's
> Node-compat `WriteStream` at import time, which routes stdout through an async
> path. Exiting immediately drops everything past the 64 KiB pipe buffer, giving
> you silently truncated JSON *with exit code 0*. Set `process.exitCode` and
> return instead.

That is [issue #73](https://github.com/shaharia-lab/slackcli/issues/73), and
[#77](https://github.com/shaharia-lab/slackcli/issues/77) tracks the same hazard
on the non-JSON paths.

## Adding to the client

To wire up a new Slack API method:

1. Add a method to `SlackClient` that calls `this.request(...)`.
2. Branch on `this.config.auth_type` **only** if Slack genuinely offers
   different endpoints — and document the divergence.
3. Add types to `src/types/index.ts` rather than passing `any` around.
4. Add a formatter if the output is human-facing, and a `--json` shape if it is
   script-facing.

Worked example: [adding a command](adding-a-command.md).
