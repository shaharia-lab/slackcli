/**
 * docs/ is the single source. This copies it into the site.
 *
 * The markdown in `docs/` is written to be read on GitHub - relative `*.md`
 * links, no frontmatter, an inline table of contents in some files. None of
 * that is wrong; it is just not what Starlight consumes. So rather than
 * reshaping the source (which would degrade it for everyone reading the
 * repository, and break README.md and CLAUDE.md's own pointers), this rewrites
 * a copy at build time:
 *
 *   - the H1 becomes the frontmatter `title`, and is removed from the body,
 *     because Starlight renders the title itself;
 *   - the lead paragraph becomes `description` (used for <meta> and search),
 *     unless the manifest overrides it;
 *   - an inline bullet TOC is dropped, because Starlight renders one;
 *   - a link between two docs is resolved RELATIVE TO THE LINKING FILE and
 *     repointed at the published route - `authentication.md` inside
 *     `user-guide/` becomes `/slackcli/docs/user-guide/authentication/`, and
 *     `../development/architecture.md#dual-authentication` keeps its fragment;
 *   - a link that leaves docs/ (`../../CONTRIBUTING.md`) becomes a GitHub blob
 *     URL, since those files have no page on this site.
 *
 * The relative resolution is the part that differs from a flat docs tree, and
 * it is why nothing here pattern-matches on filenames: `installation.md` means
 * two different pages depending on which file wrote it.
 *
 * The output is generated and gitignored. Never edit it.
 */
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, REPO_BLOB } from '../site.config.mjs';
import { PAGES } from '../docs.manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../docs');
const OUT = resolve(here, '../src/content/docs/docs');

const bySourceFile = new Map(PAGES.map((p) => [p.file, p]));

/** Every `.md` under docs/, as paths relative to docs/. */
async function markdownFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await markdownFiles(join(dir, entry.name), rel)));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** The published route for a docs-relative path, or null if it is not a page. */
function routeFor(file) {
  const page = bySourceFile.get(file);
  if (!page) return null;
  return page.slug === 'index' ? `${BASE}/docs/` : `${BASE}/docs/${page.slug}/`;
}

/**
 * Rewrites one link target, given the docs-relative path of the file it was
 * written in. Returns an absolute-on-this-site route, a GitHub blob URL, or
 * null for targets that should be left exactly as written.
 */
function resolveTarget(target, fromFile) {
  if (/^(https?:|mailto:|#)/.test(target)) return null;

  const [path, hash] = target.split('#');

  // A bare fragment was handled above; a link like `#usage` in the middle of a
  // path is not a thing, so an empty path here means the link is malformed.
  if (!path) return null;

  // Resolve against the linking file's directory, then normalise away the
  // `../` segments. `posix` rather than the platform's `path`, because these
  // are URL paths that happen to look like file paths, and on Windows the
  // platform separator would produce backslashes in an href.
  const fromDir = posix.dirname(fromFile);
  const resolved = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, path));

  const route = routeFor(resolved);
  if (route) return hash ? `${route}#${hash}` : route;

  // Anything else points outside docs/ - CONTRIBUTING.md, LICENSE, a source
  // file. Real destinations, just not pages on this site. `resolved` is
  // relative to docs/, so a target that climbed out of it arrives here with
  // leading `../` segments that have to be stripped to name a repo path.
  const climbed = resolved.startsWith('../');
  const repoPath = climbed ? resolved.replace(/^(\.\.\/)+/, '') : `docs/${resolved}`;
  return `${REPO_BLOB}/${repoPath}${hash ? `#${hash}` : ''}`;
}

function rewriteLinks(body, fromFile) {
  return body.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, target, title = '') => {
    const href = resolveTarget(target, fromFile);
    return href === null ? whole : `](${href}${title})`;
  });
}

/** Strip a leading bullet TOC of in-page anchors; Starlight renders its own. */
function dropInlineToc(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^[-*] \[.+\]\(#.+\)$/.test(l.trim()));
  if (start === -1) return body;
  let end = start;
  while (
    end < lines.length &&
    (/^[-*] \[.+\]\(#.+\)$/.test(lines[end].trim()) || lines[end].trim() === '')
  ) {
    end++;
  }
  const entries = lines.slice(start, end).filter((l) => l.trim()).length;
  if (entries < 3) return body;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

function plain(md) {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First whole sentence if it fits, otherwise a clean word boundary. */
function summarise(text, max = 165) {
  if (text.length <= max) return text;
  const sentence = text.slice(0, max).match(/^.*?[.!?](?=\s|$)/);
  if (sentence && sentence[0].length > 60) return sentence[0];
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function yaml(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The lead paragraph, for pages the manifest does not describe by hand.
 *
 * A block is only a candidate if it reads as prose: headings, tables, block
 * quotes, thematic breaks, list items and fenced code are all skipped, because
 * a <meta> description built from a code fence or a table row is worse than
 * none. Anything left that still does not stand alone gets a `description` in
 * docs.manifest.mjs.
 */
function leadParagraph(body) {
  let fenced = false;
  const blocks = [];
  let current = [];
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === '') {
      if (current.length) blocks.push(current.join(' '));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join(' '));

  return blocks
    .map((b) => b.trim())
    .find((b) => b && !/^(#|\||>|---|```|[-*+] |\d+\. )/.test(b));
}

function transform(raw, page) {
  const lines = raw.split('\n');
  const h1 = lines.findIndex((l) => l.startsWith('# '));
  const title = h1 === -1 ? page.label : lines[h1].slice(2).trim();
  let body = h1 === -1 ? raw : lines.slice(h1 + 1).join('\n');

  body = dropInlineToc(body);

  const lead = leadParagraph(body);
  const description = page.description ?? (lead ? summarise(plain(lead)) : '');

  const front = [
    '---',
    `title: ${yaml(title)}`,
    description ? `description: ${yaml(description)}` : null,
    `editUrl: ${yaml(`${REPO_BLOB}/docs/${page.file}`)}`,
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  return front + rewriteLinks(body, page.file).replace(/^\n+/, '\n');
}

async function main() {
  await rm(OUT, { recursive: true, force: true });

  const present = new Set(await markdownFiles(SRC));
  let written = 0;

  for (const page of PAGES) {
    if (!present.has(page.file)) {
      throw new Error(
        `docs/${page.file} is listed in docs.manifest.mjs but does not exist. ` +
          `Update PAGES if the file was renamed or removed.`
      );
    }
    const raw = await readFile(join(SRC, page.file), 'utf8');
    const out = join(OUT, `${page.slug}.md`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, transform(raw, page), 'utf8');
    written++;
  }

  // A doc added to docs/ and not listed in the manifest would silently never
  // publish, and - worse - every existing link to it would quietly turn into a
  // GitHub blob URL rather than an internal one.
  const unlisted = [...present].filter((f) => !bySourceFile.has(f));
  if (unlisted.length) {
    throw new Error(
      `docs/ contains ${unlisted.join(', ')}, which the site does not publish. ` +
        `Add ${unlisted.length > 1 ? 'them' : 'it'} to PAGES in web/docs.manifest.mjs.`
    );
  }

  console.log(`sync-docs: ${written} pages`);
}

await main();
