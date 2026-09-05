/**
 * /robots.txt, and the one line that tells a crawler the sitemap exists.
 *
 * @astrojs/sitemap emits /sitemap-index.xml and nothing points at it: the file
 * is otherwise reachable only by a crawler guessing the conventional name, or
 * by somebody submitting it in Search Console by hand.
 *
 * It is generated rather than dropped in public/ so the absolute `Sitemap:`
 * URL, which must be absolute per the sitemaps protocol, comes from SITE and
 * BASE in site.config.mjs. A static file would be the only place in this site
 * that spells the address out, and it would go stale in silence, since a wrong
 * Sitemap line is not an error anywhere. Crawlers just ignore it.
 *
 * This only does its job because the site sits at the root of its own domain.
 * A crawler reads robots.txt from the ORIGIN root, so on the previous GitHub
 * Pages project address it would have published at `/slackcli/robots.txt`,
 * where nothing looks for it. Keep that in mind before ever moving the site
 * back under a path prefix.
 */
import type { APIRoute } from 'astro';
import { SITE, BASE } from '../../site.config.mjs';

/**
 * Everything here is public documentation of an open-source project, so there
 * is nothing to hide from an indexer and the allow is unconditional. The
 * generated Pagefind search index is excluded because it is a build artifact of
 * the docs, not a page: it is megabytes of fragments that render as nothing and
 * would dilute what an indexer sees of the real pages.
 */
const body = `User-agent: *
Allow: /
Disallow: ${BASE}/pagefind/

Sitemap: ${SITE}${BASE}/sitemap-index.xml
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
