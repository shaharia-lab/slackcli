import { getLogger } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';

const logger = getLogger(['slackcli', 'canvas']);

// `canvas sections` (#431): the lookup criteria for Slack's
// `canvases.sections.lookup`, validated before any Slack call, and the section
// list read back from its answer.

/**
 * The section types `canvases.sections.lookup` accepts in `section_types`, as
 * its reference lists them. Several types match a section of any of them.
 */
export const CANVAS_SECTION_TYPES = [
  'any_header',
  'h1',
  'h2',
  'h3',
  'blockquote',
  'callout',
  'canvas_unfurl',
  'chart',
  'citation',
  'file_unfurl',
  'flexbox',
  'horizontal_line',
  'list',
  'message_unfurl',
  'sfdc_record_mention',
  'sfdc_record_unfurl',
  'table',
  'user_mention',
  'user_unfurl',
] as const;

export type CanvasSectionType = (typeof CANVAS_SECTION_TYPES)[number];

/** The `criteria` object Slack expects; at least one key is set. */
export interface CanvasSectionCriteria {
  section_types?: CanvasSectionType[];
  contains_text?: string;
}

/** One matching section as the CLI reports it. */
export interface CanvasSection {
  id: string;
}

function isSectionType(value: string): value is CanvasSectionType {
  return (CANVAS_SECTION_TYPES as readonly string[]).includes(value);
}

/**
 * Parse `--type`: comma-separated, each entry trimmed and lower-cased,
 * duplicates dropped (first occurrence keeps its position). Throws
 * InvalidInputError on an empty list or entry, or a type Slack does not accept.
 */
export function parseSectionTypes(input: string): CanvasSectionType[] {
  const entries = input.split(',').map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => entry === '')) {
    throw new InvalidInputError('--type needs comma-separated section types without empty entries, e.g. --type h1,h2');
  }
  const types: CanvasSectionType[] = [];
  for (const entry of entries) {
    if (!isSectionType(entry)) {
      throw new InvalidInputError(`Unknown section type "${entry}" in --type; use one of ${CANVAS_SECTION_TYPES.join(', ')}`);
    }
    if (!types.includes(entry)) types.push(entry);
  }
  return types;
}

/**
 * Build the lookup criteria from `--type` and `--contains`. Slack's lookup
 * needs a criterion, so at least one is required; with both, Slack narrows by
 * both. `--contains` must hold text other than whitespace, and is sent as given.
 */
export function buildSectionCriteria(options: { type?: string; contains?: string }): CanvasSectionCriteria {
  if (options.type === undefined && options.contains === undefined) {
    throw new InvalidInputError('Give --type, --contains or both to say which sections to look up');
  }
  const criteria: CanvasSectionCriteria = {};
  if (options.type !== undefined) criteria.section_types = parseSectionTypes(options.type);
  if (options.contains !== undefined) {
    if (options.contains.trim() === '') {
      throw new InvalidInputError('--contains needs some text to match');
    }
    criteria.contains_text = options.contains;
  }
  return criteria;
}

/**
 * The sections in a `canvases.sections.lookup` answer, in Slack's order. An
 * entry without a string `id` cannot be targeted by an edit, so it is left out
 * (and counted in the log); a missing `sections` list reads as no match.
 */
export function sectionsOf(response: { sections?: unknown } | null | undefined): CanvasSection[] {
  const sections = Array.isArray(response?.sections) ? response.sections : [];
  const usable = sections
    .filter((section): section is { id: string } => typeof section?.id === 'string' && section.id !== '')
    .map((section) => ({ id: section.id }));
  const skipped = sections.length - usable.length;
  if (skipped > 0) {
    logger.warn('canvases.sections.lookup returned {skipped} sections without an id', { skipped });
  }
  return usable;
}
