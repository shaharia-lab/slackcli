import { basename, dirname, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

// Where a `--output` path actually lands, and whether that is outside the
// directory the command was run from.
export interface OutputPathTarget {
  // `path.resolve()` of the value the user passed — always absolute.
  resolved: string;
  // The same path with its parent directory resolved through symlinks, which is
  // what the containment decision is made on. Equals `resolved` when no symlink
  // is involved.
  real: string;
  // True when `real` is neither the working directory nor below it.
  outside: boolean;
}

// realpath() throws for a path that does not exist yet. The caller only wants a
// best-effort canonical form, so fall back to the path as given.
function canonical(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

// Resolve an `--output` path and report whether it escapes `cwd`.
//
// The file itself is expected NOT to exist (the download opens it with 'wx'),
// so the symlink resolution is applied to the parent directory — realpath() on
// the full path would throw for every ordinary download. That is also the
// bypass worth closing: `./link/file` where `link` points at `/etc` resolves
// inside the working directory as a string and outside it on disk.
//
// `cwd` is canonicalised too, so a working directory that is itself reached
// through a symlink (a home under /var on macOS, a bind-mounted checkout) does
// not make every relative path look like an escape.
export function resolveOutputPath(outputPath: string, cwd: string = process.cwd()): OutputPathTarget {
  const container = canonical(resolve(cwd));
  const resolved = resolve(container, outputPath);
  const parent = canonical(dirname(resolved));
  const name = basename(resolved);
  const real = name ? resolve(parent, name) : parent;

  // The `+ sep` matters: without it a sibling directory whose name merely starts
  // with the working directory's name (…/work-evil next to …/work) reads as
  // contained. `real === container` is the output path being the working
  // directory itself, which open() rejects as EISDIR rather than traversing.
  const outside = real !== container && !real.startsWith(container + sep);

  return { resolved, real, outside };
}
