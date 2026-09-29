/**
 * Checks every internal link in the built site, including its fragment.
 *
 * This is a script rather than a link-checking action because the organisation
 * restricts Actions to an allowlist and requires SHA pinning; adding a
 * third-party checker would mean widening that policy for a docs job. It also
 * does the one thing that matters most here and that a generic checker does
 * only with coaxing: `docs/` cross-links by heading anchor
 * (`build-and-release.md#why-bun-is-pinned`), and renaming a heading breaks
 * those silently. The markdown still renders, the link just lands nowhere.
 *
 * External links are deliberately not fetched. A docs job that fails because
 * somebody else's site is down, or because GitHub rate-limited the runner, is a
 * job people learn to ignore.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from '../site.config.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip the generated search index.
        return entry.name === 'pagefind' ? [] : htmlFiles(path);
      }
      return entry.name.endsWith('.html') ? [path] : [];
    })
  );
  return nested.flat();
}

/** `/slackcli/docs/user-guide/` -> the file that serves it. */
function fileFor(href) {
  const path = href.slice(BASE.length) || '/';
  const rel = path.endsWith('/') ? `${path}index.html` : path;
  return join(DIST, rel.replace(/^\//, ''));
}

// Cached as promises, so pages checked concurrently read each target once.
const ids = new Map();
function idsOf(file) {
  if (!ids.has(file)) {
    ids.set(
      file,
      readFile(file, 'utf8').then(
        (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
        () => null
      )
    );
  }
  return ids.get(file);
}

/** The problem with one internal link on `page`, or null when it resolves. */
async function checkHref(page, href) {
  const [path, hash] = href.split('#');
  const target = fileFor(path);
  const targetIds = await idsOf(target);

  if (targetIds === null) return `${page} -> ${href} (no page at ${target.slice(DIST.length)})`;
  if (hash && !targetIds.has(hash)) return `${page} -> ${href} (page exists, no element with id="${hash}")`;
  return null;
}

/** Every broken internal link on one built page. */
async function checkPage(file) {
  const html = await readFile(file, 'utf8');
  const page = file.slice(DIST.length) || '/';
  const hrefs = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))]
    .filter((href) => href.startsWith(BASE + '/') || href === BASE)
    .filter((href) => !/\.(css|js|xml|json|svg|png|webp|woff2?)$/.test(href));
  const results = await Promise.all(hrefs.map((href) => checkHref(page, href)));
  return results.filter((problem) => problem !== null);
}

const files = await htmlFiles(DIST);
// Promise.all keeps input order, so the report lists pages as before.
const problems = (await Promise.all(files.map(checkPage))).flat();

if (problems.length) {
  console.error(`check-links: ${problems.length} broken:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-links: ${files.length} pages, every internal link and fragment resolves`);
