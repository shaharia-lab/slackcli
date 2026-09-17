/**
 * The latest release, resolved at build time.
 *
 * Nothing about a download may be hand-written. This asks the GitHub API once
 * per build and writes src/data/release.json, which the pages import, so the
 * version in the hero, the version on the download buttons and the filenames
 * in the install section are one fact rather than three.
 *
 * Two properties are deliberate:
 *
 *   - **It never fails the build.** No network, no token, a rate limit, a
 *     repository with no releases yet: each falls back to the version in
 *     package.json and the `releases/latest` redirect, which is always correct
 *     even when it cannot name a file. A docs site that cannot build because
 *     GitHub is slow is worse than one showing a generic link.
 *   - **It runs at build time, not in the visitor's browser.** A client-side
 *     fetch would put a third-party request on every page view and would show
 *     an empty download section to anyone the API rate-limits. The Pages
 *     workflow rebuilds this site when a release is published, so the baked
 *     answer is refreshed by the event that changes it.
 *
 * Unlike a desktop app's installers, SlackCLI's assets have STABLE names
 * (`slackcli-linux`, `slackcli-macos-arm64`, ...) with no version in them, so
 * `releases/latest/download/<name>` is a valid permanent URL. The API is still
 * asked, because the size, the digest and the version itself are worth showing
 * and none of them can be spelled out by hand.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/data/release.json');
const REPO_OUT = resolve(here, '../src/data/repo.json');
const PKG = resolve(here, '../../package.json');
const REPO_API = 'https://api.github.com/repos/shaharia-lab/slackcli';
const API = `${REPO_API}/releases/latest`;
const RELEASES = 'https://github.com/shaharia-lab/slackcli/releases';

/**
 * Which download a file is. Ordered: the first pattern that matches wins.
 * `install` is the one-liner the install section prints for that file, and it
 * is per-asset rather than per-OS because the curl URL names the asset.
 */
const PLATFORMS = [
  { id: 'macos-arm', os: 'macos', label: 'macOS', arch: 'Apple Silicon', kind: 'bin', test: /^slackcli-macos-arm64$/ },
  { id: 'macos-x64', os: 'macos', label: 'macOS', arch: 'Intel', kind: 'bin', test: /^slackcli-macos$/ },
  { id: 'linux-x64', os: 'linux', label: 'Linux', arch: 'x86_64', kind: 'bin', test: /^slackcli-linux$/ },
  { id: 'linux-arm', os: 'linux', label: 'Linux', arch: 'ARM64', kind: 'bin', test: /^slackcli-linux-arm64$/ },
  { id: 'win-x64', os: 'windows', label: 'Windows', arch: 'x64', kind: 'exe', test: /^slackcli-windows\.exe$/ },
];

async function fallback(reason) {
  const version = JSON.parse(await readFile(PKG, 'utf8')).version;
  console.warn(`fetch-release: ${reason}, falling back to v${version} with no per-platform files`);
  return {
    version,
    tag: `v${version}`,
    url: `${RELEASES}/latest`,
    publishedAt: null,
    resolved: false,
    checksums: `${RELEASES}/latest`,
    downloads: [],
  };
}

function headers() {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'slackcli-site-build' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** Star count for the call to action. A missing count renders no number. */
async function repoStats() {
  try {
    const res = await fetch(REPO_API, { headers: headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    console.log(`fetch-release: repo has ${r.stargazers_count} stars`);
    return { stars: r.stargazers_count, forks: r.forks_count, resolved: true };
  } catch (err) {
    console.warn(`fetch-release: could not read repo stats (${err.message})`);
    return { stars: null, forks: null, resolved: false };
  }
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(REPO_OUT, JSON.stringify(await repoStats(), null, 2) + '\n', 'utf8');

  let data;
  try {
    const res = await fetch(API, { headers: headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const assets = release.assets ?? [];

    const downloads = PLATFORMS.map((p) => {
      const asset = assets.find((a) => p.test.test(a.name));
      return asset
        ? { ...p, test: undefined, file: asset.name, href: asset.browser_download_url, size: asset.size }
        : null;
    }).filter(Boolean);

    if (!downloads.length) throw new Error(`release ${release.tag_name} carries no recognised binary`);

    const sums = assets.find((a) => a.name === 'checksums.txt');

    data = {
      version: String(release.tag_name).replace(/^v/, ''),
      tag: release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at,
      resolved: true,
      checksums: sums ? sums.browser_download_url : `${RELEASES}/latest`,
      downloads,
    };
    console.log(`fetch-release: ${data.tag}, ${downloads.length} binaries`);
  } catch (err) {
    data = await fallback(err.message);
  }

  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

await main();
