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
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'pagefind') continue; // generated search index
      out.push(...(await htmlFiles(path)));
    } else if (entry.name.endsWith('.html')) {
      out.push(path);
    }
  }
  return out;
}

/** `/slackcli/docs/user-guide/` -> the file that serves it. */
function fileFor(href) {
  const path = href.slice(BASE.length) || '/';
  const rel = path.endsWith('/') ? `${path}index.html` : path;
  return join(DIST, rel.replace(/^\//, ''));
}

const ids = new Map();
async function idsOf(file) {
  if (!ids.has(file)) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      ids.set(file, null);
      return null;
    }
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
}

const files = await htmlFiles(DIST);
const problems = [];

for (const file of files) {
  const html = await readFile(file, 'utf8');
  const page = file.slice(DIST.length) || '/';
  const hrefs = new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));

  for (const href of hrefs) {
    if (!href.startsWith(BASE + '/') && href !== BASE) continue;
    if (/\.(css|js|xml|json|svg|png|webp|woff2?)$/.test(href)) continue;

    const [path, hash] = href.split('#');
    const target = fileFor(path);
    const targetIds = await idsOf(target);

    if (targetIds === null) {
      problems.push(`${page} -> ${href} (no page at ${target.slice(DIST.length)})`);
      continue;
    }
    if (hash && !targetIds.has(hash)) {
      problems.push(`${page} -> ${href} (page exists, no element with id="${hash}")`);
    }
  }
}

if (problems.length) {
  console.error(`check-links: ${problems.length} broken:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-links: ${files.length} pages, every internal link and fragment resolves`);
