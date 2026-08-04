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

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function parseInline(text: string): RichTextElement[] {
  const elements: RichTextElement[] = [];

  let i = 0;
  while (i < text.length) {
    let matched = false;

    for (const [marker, styleKey] of MARKERS) {
      if (text[i] !== marker) continue;

      // A marker immediately preceded by a word character (the "_" in "merge_requests")
      // never opens a span. Without this, the underscore in one URL or identifier pairs
      // with the underscore in a completely unrelated one later in the message, and
      // everything between the two gets consumed as styled text.
      if (isWordChar(text[i - 1])) continue;

      // Look for a closing marker that also isn't mid-word, skipping past any candidate
      // that fails that check (e.g. the "_" inside "file_name") instead of stopping at
      // the first occurrence.
      let searchFrom = i + 1;
      let end = -1;
      while (searchFrom < text.length) {
        const candidate = text.indexOf(marker, searchFrom);
        if (candidate === -1) break;
        if (!isWordChar(text[candidate + 1])) {
          end = candidate;
          break;
        }
        searchFrom = candidate + 1;
      }
      if (end === -1) continue;

      const inner = text.substring(i + 1, end);
      // Don't match empty content or content that starts/ends with space
      if (inner.length === 0 || inner.startsWith(' ') || inner.endsWith(' ')) continue;

      // Flush any plain text before this marker
      // (already handled by the outer loop collecting plain chars)

      const style: RichTextStyle = { [styleKey]: true };

      if (styleKey === 'code') {
        // Code spans don't nest
        elements.push({ type: 'text', text: inner, style });
      } else {
        // Recursively parse inner content for nested formatting
        const innerElements = parseInline(inner);
        for (const el of innerElements) {
          const mergedStyle = { ...el.style, [styleKey]: true };
          elements.push({ type: 'text', text: el.text, style: mergedStyle });
        }
      }

      i = end + 1;
      matched = true;
      break;
    }

    if (!matched) {
      // Plain character: append to last plain element or create new one
      const last = elements[elements.length - 1];
      if (last && !last.style) {
        last.text += text[i];
      } else {
        elements.push({ type: 'text', text: text[i] });
      }
      i++;
    }
  }

  // Clean up: remove empty style objects
  return elements.map(el => {
    if (el.style && Object.keys(el.style).length === 0) {
      const { style, ...rest } = el;
      return rest as RichTextElement;
    }
    return el;
  });
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
