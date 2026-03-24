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

function parseInline(text: string): RichTextElement[] {
  const elements: RichTextElement[] = [];

  let i = 0;
  while (i < text.length) {
    let matched = false;

    for (const [marker, styleKey] of MARKERS) {
      if (text[i] !== marker) continue;

      // Look for the closing marker
      const end = text.indexOf(marker, i + 1);
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
  const lines = text.split('\n');
  const sections: RichTextSection[] = lines.map(line => ({
    type: 'rich_text_section',
    elements: line.length > 0 ? parseInline(line) : [{ type: 'text', text: '\n' }],
  }));

  return [{
    type: 'rich_text',
    elements: sections,
  }];
}
