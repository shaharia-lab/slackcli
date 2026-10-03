import { InvalidInputError } from './cli-errors.ts';

// `--fields` on the read commands (#330): with --json, keep only the fields the
// caller names, so an agent pays for the data it uses rather than for full
// Slack objects. Projection runs on the finished payload just before
// writeJson(); no Slack request changes. Without --fields nothing here runs,
// so the default output is unchanged.

/** The option every read command with --json registers. */
export const FIELDS_FLAG = '--fields <list>';
export const FIELDS_DESCRIPTION = 'With --json, include only these comma-separated fields (dot paths allowed)';

/**
 * The key holding each read command's main list (or single record, for
 * `conversations get`). `null` means the command prints one record and the
 * record itself is projected. Every other top-level key of the output is an
 * envelope (counts, cursors, the resolved `users` list) and is kept as is.
 */
export const FIELDS_LIST_KEYS = {
  'canvas list': 'canvases',
  'canvas read': null,
  'conversations get': 'message',
  'conversations list': 'conversations',
  'conversations read': 'messages',
  'conversations unread': 'unread_channels',
  'emoji get': null,
  'emoji list': 'emoji',
  'files info': null,
  'files read': null,
  'messages list-drafts': 'drafts',
  'saved list': 'items',
  'search channels': 'channels',
  'search messages': 'matches',
  'search people': 'people',
  'team info': null,
  'usergroups list': 'usergroups',
  'usergroups read': null,
  'users info': null,
  'users list': 'users',
} as const satisfies Record<string, string | null>;

export type FieldsCommand = keyof typeof FIELDS_LIST_KEYS;

/** A parsed field list: each entry is one path, split on dots. */
export type FieldPaths = string[][];

// A path segment is a JSON key as Slack writes them: letters, digits, `_`, `-`.
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Parse a `--fields` value: comma-separated, each entry trimmed, duplicates
 * dropped (first occurrence wins the position). Throws InvalidInputError on an
 * empty list, an empty entry or segment (`a,,b`, `a.`, `.a`), or a character
 * a key cannot contain.
 */
export function parseFields(input: string): FieldPaths {
  const entries = input.split(',').map((entry) => entry.trim());
  if (entries.every((entry) => entry === '')) {
    throw new InvalidInputError('--fields needs at least one field name, e.g. --fields ts,user,text');
  }
  const seen = new Set<string>();
  const paths: FieldPaths = [];
  for (const entry of entries) {
    const segments = entry.split('.');
    if (entry === '' || segments.some((segment) => !SEGMENT.test(segment))) {
      throw new InvalidInputError(
        `Invalid --fields entry "${entry}": use comma-separated names of letters, digits, _ or -, ` +
          'with dots for nested fields (e.g. ts,user,profile.email)',
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    paths.push(segments);
  }
  return paths;
}

/**
 * Read and validate the `--fields` option of a command. Returns undefined when
 * it was not given. Throws InvalidInputError when it is given without --json,
 * or malformed. Call it before any Slack request.
 */
export function fieldsOption(options: { fields?: string; json?: boolean }): FieldPaths | undefined {
  if (options.fields === undefined) return undefined;
  if (!options.json) {
    throw new InvalidInputError('--fields only applies to --json output; add --json');
  }
  return parseFields(options.fields);
}

// A tree of requested paths: `true` keeps the whole value under that key.
type FieldTree = Map<string, FieldTree | true>;

function buildTree(paths: FieldPaths): FieldTree {
  const root: FieldTree = new Map();
  for (const path of paths) {
    let node = root;
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      const existing = node.get(key);
      if (existing === true) break; // a shorter path already keeps it all
      if (i === path.length - 1) {
        node.set(key, true); // keeps it all, so drop any narrower paths
        break;
      }
      const child: FieldTree = existing ?? new Map();
      node.set(key, child);
      node = child;
    }
  }
  return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Assign without going through a setter: a key named `__proto__` must become
// an own property, never the object's prototype.
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Project one value through a tree. An object keeps the requested keys it
 * has, in the order they were requested; an array is projected element by
 * element. Returns undefined when nothing requested is there, so the caller
 * can omit the key: a missing field is not an error.
 */
function projectValue(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) {
    // Objects keep their place (as `{}` when they lack every field); a scalar
    // has no fields to select, so a dot path drops it.
    return value.filter((element) => isPlainObject(element) || Array.isArray(element))
      .map((element) => projectValue(element, tree) ?? (Array.isArray(element) ? [] : {}));
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  let kept = false;
  for (const [key, child] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    const projected = child === true ? value[key] : projectValue(value[key], child);
    if (projected === undefined) continue;
    setOwn(out, key, projected);
    kept = true;
  }
  return kept ? out : undefined;
}

/**
 * Apply a field list to a command's JSON output. With `listKey`, each item of
 * the array at that key (or the single object there) is projected and every
 * other key is returned unchanged; with `listKey: null`, the output is one
 * record and is projected itself. Without `fields`, the value is returned
 * untouched (the same reference).
 *
 * Items are never dropped: an item with none of the fields becomes `{}`, so
 * the count still matches the unprojected output.
 */
export function projectFields<T>(value: T, fields: FieldPaths | undefined, listKey: string | null): T | Record<string, unknown> {
  if (!fields) return value;
  const tree = buildTree(fields);
  const project = (item: unknown) => (isPlainObject(item) ? (projectValue(item, tree) ?? {}) : item);

  if (listKey === null) return project(value) as Record<string, unknown>;
  if (!isPlainObject(value) || !Object.hasOwn(value, listKey)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== listKey) setOwn(out, key, entry);
    else setOwn(out, key, Array.isArray(entry) ? entry.map(project) : project(entry));
  }
  return out;
}

/**
 * Project a read command's output using its entry in FIELDS_LIST_KEYS. The
 * one call every command makes just before writeJson().
 */
export function applyFields<T>(command: FieldsCommand, value: T, fields: FieldPaths | undefined): T | Record<string, unknown> {
  return projectFields(value, fields, FIELDS_LIST_KEYS[command]);
}
