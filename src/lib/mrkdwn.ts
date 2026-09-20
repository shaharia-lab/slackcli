// Parse Slack mrkdwn text into rich_text block elements.
// Supports: *bold*, _italic_, ~strike~, `code`, and combinations.

interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

interface RichTextElement {
  type: 'text';
  text: string;
  style?: RichTextStyle;
}

interface RichTextSection {
  type: 'rich_text_section';
  elements: RichTextElement[];
}

interface RichTextBlock {
  type: 'rich_text';
  elements: RichTextSection[];
}

// Markers and their corresponding style keys
const MARKERS: [string, keyof RichTextStyle][] = [
  ['`', 'code'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strike'],
];

// Combining marks count as word characters so a decomposed "é" (e + U+0301)
// behaves the same as its precomposed form.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordCodePoint(cp: number | undefined): boolean {
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
}

// Both helpers work on whole code points; indexing by UTF-16 unit would hand a
// lone surrogate to the regex and misclassify every astral letter.
function wordCharBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const prev = text.charCodeAt(i - 1);
  const isTrailSurrogate = prev >= 0xdc00 && prev <= 0xdfff;
  return isWordCodePoint(text.codePointAt(isTrailSurrogate && i >= 2 ? i - 2 : i - 1));
}

function wordCharAfter(text: string, i: number): boolean {
  return isWordCodePoint(text.codePointAt(i + 1));
}

interface MarkerMatch {
  elements: RichTextElement[];
  nextIndex: number;
}

// Locate the closing marker for a span opening at `i`, or -1 when no span starts
// there. The guard order is load-bearing: each guard assumes the previous ones
// already rejected, so reordering them changes what parses.
function findSpanEnd(text: string, marker: string, i: number): number {
  if (text[i] !== marker) return -1;

  // Only "_" requires word boundaries; Slack applies *bold*, ~strike~ and `code`
  // mid-word. Without this, the underscore in one URL or identifier pairs with the
  // underscore in a completely unrelated one later in the message, and everything
  // between the two gets consumed as italic.
  const needsBoundary = marker === '_';
  if (needsBoundary && wordCharBefore(text, i)) return -1;

  const end = text.indexOf(marker, i + 1);
  if (end === -1) return -1;
  // A mid-word "_" (the one in "file_name") does not close a span. Leave the text
  // literal rather than searching on for a later candidate, which would swallow
  // everything in between.
  if (needsBoundary && wordCharAfter(text, end)) return -1;

  const inner = text.substring(i + 1, end);
  // Don't match empty content or content that starts/ends with space
  if (inner.length === 0 || inner.startsWith(' ') || inner.endsWith(' ')) return -1;

  return end;
}

// Build the elements for one span's inner text, applying `styleKey` on top of any
// styles the inner text carries itself.
function styleSpan(inner: string, styleKey: keyof RichTextStyle): RichTextElement[] {
  const style: RichTextStyle = { [styleKey]: true };

  // Code spans don't nest
  if (styleKey === 'code') return [{ type: 'text', text: inner, style }];

  // Recursively parse inner content for nested formatting
  return parseInline(inner).map(el => ({
    type: 'text',
    text: el.text,
    style: { ...el.style, [styleKey]: true },
  }));
}

// Try every marker at position `i`, returning the span's elements and the index to
// continue the walk from, or null when no marker applies there.
function tryMatchMarker(text: string, i: number): MarkerMatch | null {
  for (const [marker, styleKey] of MARKERS) {
    const end = findSpanEnd(text, marker, i);
    if (end === -1) continue;

    return { elements: styleSpan(text.substring(i + 1, end), styleKey), nextIndex: end + 1 };
  }

  return null;
}

// Plain character: append to last plain element or create new one
function appendPlainChar(elements: RichTextElement[], char: string): void {
  const last = elements[elements.length - 1];
  if (last && !last.style) {
    last.text += char;
  } else {
    elements.push({ type: 'text', text: char });
  }
}

// Clean up: remove empty style objects
function stripEmptyStyles(elements: RichTextElement[]): RichTextElement[] {
  return elements.map(el => {
    if (el.style && Object.keys(el.style).length === 0) {
      const { style, ...rest } = el;
      return rest as RichTextElement;
    }
    return el;
  });
}

function parseInline(text: string): RichTextElement[] {
  const elements: RichTextElement[] = [];

  let i = 0;
  while (i < text.length) {
    const match = tryMatchMarker(text, i);
    if (match) {
      elements.push(...match.elements);
      i = match.nextIndex;
    } else {
      appendPlainChar(elements, text[i]);
      i++;
    }
  }

  return stripEmptyStyles(elements);
}

export function parseMrkdwn(text: string): RichTextBlock[] {
  // Keep newlines embedded in text elements rather than splitting into multiple sections.
  // Slack's draft composer renders multiple rich_text_section elements inline (no line breaks),
  // but correctly preserves \n characters within a single text element.
  const elements = parseInline(text);

  return [{
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: elements.length > 0 ? elements : [{ type: 'text', text: '' }],
    }],
  }];
}
