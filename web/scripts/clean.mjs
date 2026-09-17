/**
 * Removes the build output and Astro's cache before each build.
 *
 * Not housekeeping. An incremental build was observed on the sibling Agento
 * site to emit a fresh `_astro/ec.<hash>.css` while leaving the previous hash
 * in the generated HTML, so every page linked a stylesheet that 404ed and every
 * code block rendered unstyled: dark text on a dark ground, with no frame. It
 * looks exactly like a theming bug, and it is not one; a clean build is always
 * correct. This site builds in seconds, so the cache buys nothing worth that
 * failure mode.
 */
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['dist', '.astro', 'node_modules/.astro']) {
  await rm(resolve(root, dir), { recursive: true, force: true });
}
