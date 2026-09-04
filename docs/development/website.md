# Website

The project site lives in [`web/`](../../web) and publishes to GitHub Pages at
**https://shaharia-lab.github.io/slackcli/**. It is an Astro site with three
parts: a hand-laid landing page, the documentation you are reading now, and a
blog.

There is no custom domain, so every route carries the `/slackcli/` prefix.

## Run it locally

```bash
cd web
npm ci
npm run dev            # http://localhost:4321/slackcli/
```

```bash
npm run build          # clean, sync docs, resolve the release, build to web/dist
npm run preview        # serve web/dist
npm run check:links    # every internal link and fragment in web/dist
npm run build:og       # redraw public/og.png (needs a local Chrome)
```

The site uses **npm**, not Bun, even though the rest of the repository is a Bun
project. It has its own `package.json`, its own lockfile and its own
`node_modules` under `web/`, none of which the CLI build ever sees. Astro and
Starlight are best exercised on npm, and the sibling site at
[myagento.app](https://myagento.app) is built the same way, so the two stay
diffable.

`web/.npmrc` pins the `@shaharia-lab` scope to the public npm registry. Do not
remove it: a developer whose own `~/.npmrc` maps that scope to GitHub Packages
otherwise gets a 404 on the design system that reads as "this package does not
exist".

## The docs half is generated

**Never edit anything under `web/src/content/docs/`.** It is generated from this
`docs/` directory by `web/scripts/sync-docs.mjs` on every build, and your edit is
overwritten by the next one. Edit the file in `docs/` instead.

The sync script exists because the markdown here is written to be read on
GitHub: relative `*.md` links, no frontmatter, headings that serve as anchors.
At build time it lifts the H1 into the frontmatter `title`, derives a `<meta>`
description from the lead paragraph, and rewrites every relative link into a
site route, resolved against the directory of the file that wrote it.

### Adding a documentation page

Two steps, and the build fails loudly if you do only the first:

1. Add the file under `docs/user-guide/` or `docs/development/`.
2. Add it to `PAGES` in [`web/docs.manifest.mjs`](../../web/docs.manifest.mjs),
   with its `slug`, its sidebar `label` and its `group`.

The manifest is the single source for both the generated pages and the sidebar,
so the two cannot disagree. A file in `docs/` that is not listed fails the build
rather than silently never publishing, which matters more than it sounds: an
unlisted page also turns every existing link to it into a GitHub blob URL
instead of an internal one.

Give the page a `description` in the manifest if it opens with anything that is
not a sentence, such as a code fence, a table or a bullet list.

The `slug` mirrors the path with the extension dropped, and a directory's
`README.md` collapses to the directory itself:

| File | Route |
|---|---|
| `docs/README.md` | `/slackcli/docs/` |
| `docs/user-guide/README.md` | `/slackcli/docs/user-guide/` |
| `docs/user-guide/search.md` | `/slackcli/docs/user-guide/search/` |

### Renaming a heading is a breaking change

Pages cross-link by anchor, and a renamed heading breaks those silently: the
markdown still renders and the link just lands nowhere. `npm run check:links`
catches it, and the `Site check` workflow runs it on every pull request that
touches `docs/` or `web/`.

## Writing a blog post

Add a markdown file to `web/src/content/blog/`. The frontmatter schema is in
`web/src/content.config.ts`:

```yaml
---
title: A sentence that is not a label
description: One sentence. It is the meta description and the RSS summary.
date: 2026-08-14
author: Shaharia Azam
tags: ['Design']
featured: false      # at most one post may set this
draft: false
---
```

Links from a post to a documentation page are written as absolute site paths,
including the prefix: `/slackcli/docs/user-guide/scripting/`. Markdown cannot
call the site's `url()` helper, so this is the one place the prefix is spelled
out by hand, and `npm run check:links` is what stops it from rotting.

## Where things are

| Path | What it is |
|---|---|
| `web/site.config.mjs` | The address, the repo, the share card, the analytics and consent snippets |
| `web/docs.manifest.mjs` | Which docs publish, in what order, under what heading |
| `web/faq.config.mjs` | The landing FAQ, rendered both as markup and as `FAQPage` structured data |
| `web/astro.config.mjs` | Astro, Starlight, the sidebar, the code-block theme |
| `web/src/pages/index.astro` | The landing page |
| `web/src/components/Term.astro` | The replayed terminal session in the hero |
| `web/src/components/Install.astro` | The install section, driven by the release API |
| `web/src/styles/` | `tokens.css` (design system shim), `site.css` (landing and blog), `starlight.css` (docs) |
| `web/scripts/` | `sync-docs`, `fetch-release`, `clean`, `check-links`, `render-og` |
| `web/design/og-image.html` | Source for `public/og.png`, rendered by hand |

## Design system

All colour, type, spacing, border and motion tokens come from
[`@shaharia-lab/agento-code`](https://www.npmjs.com/package/@shaharia-lab/agento-code),
the design system shared by every Shaharia Lab open-source project site.
`web/src/styles/tokens.css` is a shim that imports it; nothing in this
repository redefines a token.

Read a colour through a token, never as a literal. The two deliberate
exceptions are documented where they sit: the code-block ground in
`astro.config.mjs`, which Expressive Code has to parse as a real colour at build
time, and `web/design/og-image.html`, which is rendered standalone with no
stylesheet behind it.

## Analytics

There is none unless the build is given one. `PUBLIC_GTM_ID` is a repository
variable read by `gtmId()` in `web/site.config.mjs`; when it is unset the build
emits no third-party script and no cookie banner at all. Only the `Site`
workflow passes it, which is what keeps the tag off `npm run dev`, off fork
builds and off pull-request builds.

When it is set, Google Consent Mode v2 denies everything except
`security_storage` before the container loads, globally rather than for the EEA
alone, and the banner's Accept and Reject are deliberately the same control.

## What CI does

| Workflow | When | What |
|---|---|---|
| `Site check` | pull requests touching `docs/`, `web/` or `package.json` | Builds the site and checks every internal link and fragment |
| `Site` | pushes to `main` on the same paths, and every published release | Builds and deploys to GitHub Pages |

`Site` also runs on a release because the landing page bakes in the current
version, the per-platform binary sizes and the checksums URL. Without that
trigger the site would advertise the previous release until somebody happened to
push a docs change.

## Known gaps

- **`robots.txt` is not where a crawler looks.** A crawler reads it from the
  origin root, and a project site publishes it under the path prefix. The route
  is kept because it costs nothing and becomes correct the day the site takes a
  domain of its own; until then the sitemap has to be submitted by hand as a
  URL-prefix property in Search Console.
- **GitHub Pages has to be enabled once**, with the source set to GitHub
  Actions, before the `Site` workflow can deploy. Repository settings for this
  organisation are managed in `shaharia-lab/infrastructure`.
