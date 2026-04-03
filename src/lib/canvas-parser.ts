/**
 * Slack Canvas HTML to Markdown converter.
 *
 * Slack Canvas exports are Quip-based HTML with custom elements
 * (data-section-style, <control>, embedded-file/link classes).
 * This parser converts them to clean Markdown with zero dependencies.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert Slack Canvas HTML to Markdown. */
export function canvasHtmlToMarkdown(html: string): string {
  let content = extractContent(html);
  content = processCodeBlocks(content);
  content = stripNoise(content);
  content = convertControlElements(content);
  content = convertEmbeds(content);
  content = convertLists(content);
  content = convertTables(content);
  content = convertBlocks(content);
  content = convertInline(content);
  return cleanup(content);
}

/** Detect if the downloaded HTML is a Slack sign-in page (expired token). */
export function isAuthPage(html: string): boolean {
  return /<form[^>]*signin|data-qa="signin|<title>[^<]*Sign\s*in/i.test(html);
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

/** Extract meaningful content from full HTML document. */
function extractContent(html: string): string {
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  if (mainMatch) return mainMatch[1];
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*)<\/article>/i);
  if (articleMatch) return articleMatch[1];
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html;
}

/**
 * Isolate code blocks BEFORE any other conversion so that internal tags
 * like <i>, <b> inside <pre> are not converted to markdown formatting.
 */
function processCodeBlocks(html: string): string {
  return html.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, inner: string) => {
      // Strip formatting tags that Slack sometimes injects inside code
      let code = inner.replace(/<\/?(?:b|i|em|strong|u|del|span)\b[^>]*>/gi, '');
      // Convert <br> variants to newlines
      code = code.replace(/<br\s*\/?>/gi, '\n');
      // Decode basic HTML entities
      code = decodeEntities(code);
      return `\n\`\`\`\n${code}\n\`\`\`\n`;
    },
  );
}

/** Remove editor noise: temp IDs, decorative classes, style attrs, spans, trailing br. */
function stripNoise(html: string): string {
  let result = html;
  // Remove id attributes
  result = result.replace(/\s+id=(?:'[^']*'|"[^"]*")/gi, '');
  // Remove style attributes
  result = result.replace(/\s+style=(?:'[^']*'|"[^"]*")/gi, '');
  // Remove value attributes on li
  result = result.replace(/\s+value=(?:'[^']*'|"[^"]*")/gi, '');
  // Remove decorative classes (keep semantic ones: checked, embedded-file, embedded-link, prettyprint)
  result = result.replace(
    /\s+class=(?:'([^']*)'|"([^"]*)")/gi,
    (_match, single: string | undefined, double: string | undefined) => {
      const val = single ?? double ?? '';
      if (/^(checked|embedded-file|embedded-link|prettyprint)$/.test(val.trim())) {
        return ` class="${val.trim()}"`;
      }
      return '';
    },
  );
  // Unwrap <span> tags (keep children)
  result = result.replace(/<\/?span\b[^>]*>/gi, '');
  // Remove <br/> at end of <li> content
  result = result.replace(/<br\s*\/?>\s*(<\/li>)/gi, '$1');
  return result;
}

/**
 * Convert Slack-specific <control> elements:
 * - Emoji: <control data-remapped...><img alt="name" data-is-slack...>:name:</img></control>
 * - User mentions: <control data-remapped...><a>@U...</a></control>
 * - Channel mentions: <control data-remapped...><a>#C...</a></control>
 * - Links inside control: <control data-remapped...><a href="url">text</a></control>
 * - Dates/text: <control data-remapped...>September 15th</control>
 */
function convertControlElements(html: string): string {
  return html.replace(
    /<control\b[^>]*>([\s\S]*?)<\/control>/gi,
    (_match, inner: string) => {
      // Emoji: look for :name: text pattern (from <img>:name:</img> or siblings)
      const emojiMatch = inner.match(/:([a-zA-Z0-9_+\-]+):/);
      if (emojiMatch && inner.includes('data-is-slack')) {
        return `:${emojiMatch[1]}:`;
      }

      // User mention: <a>@U...</a>
      const userMatch = inner.match(/<a[^>]*>@(U[A-Z0-9]+)<\/a>/i);
      if (userMatch) return `<@${userMatch[1]}>`;

      // Channel mention: <a>#C...</a>
      const channelMatch = inner.match(/<a[^>]*>#(C[A-Z0-9]+)<\/a>/i);
      if (channelMatch) return `<#${channelMatch[1]}>`;

      // Link with href: <a href="url">text</a>
      const linkMatch = inner.match(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) return `[${linkMatch[2]}](${linkMatch[1]})`;

      // Plain text (dates, etc.)
      const text = inner.replace(/<[^>]*>/g, '').trim();
      return text;
    },
  );
}

/** Convert embedded files and links. */
function convertEmbeds(html: string): string {
  let result = html;

  // Embedded files: <p class="embedded-file">File ID: F... File URL: https://...</p>
  result = result.replace(
    /<p\s+class="embedded-file"[^>]*>([\s\S]*?)<\/p>/gi,
    (_match, inner: string) => {
      const urlMatch = inner.match(/File URL:\s*(https?:\/\/\S+)/i);
      if (!urlMatch) return '';
      const url = urlMatch[1];
      // Extract filename from URL path
      const pathSegments = url.split('/');
      const filename = pathSegments[pathSegments.length - 1] || 'file';
      return `[${decodeURIComponent(filename)}](${url})\n\n`;
    },
  );

  // Embedded links: <p class="embedded-link">Link URL: https://...</p>
  result = result.replace(
    /<p\s+class="embedded-link"[^>]*>([\s\S]*?)<\/p>/gi,
    (_match, inner: string) => {
      const urlMatch = inner.match(/Link URL:\s*(https?:\/\/\S+)/i);
      if (!urlMatch) return '';
      return `[${urlMatch[1]}](${urlMatch[1]})\n\n`;
    },
  );

  return result;
}

/** Convert lists with data-section-style context. */
function convertLists(html: string): string {
  // Process each <div data-section-style="N"> block
  return html.replace(
    /<div\s+data-section-style=(?:'(\d)'|"(\d)")[^>]*>([\s\S]*?)<\/div>/gi,
    (_match, single: string | undefined, double: string | undefined, inner: string) => {
      const style = single ?? double ?? '5';
      return convertListBlock(inner, style, 0);
    },
  );
}

function convertListBlock(html: string, style: string, depth: number): string {
  let result = '';
  const indent = '  '.repeat(depth);
  let itemIndex = 1;

  // Check for nested <ul> before processing items
  const parts = splitListNesting(html);

  for (const part of parts) {
    if (part.type === 'item') {
      const isChecked = /class="checked"/.test(part.attrs);
      const text = part.content.replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
      if (!text) continue;

      if (style === '7') {
        // Checklist
        result += `${indent}- [${isChecked ? 'x' : ' '}] ${text}\n`;
      } else if (style === '6') {
        // Ordered list
        result += `${indent}${itemIndex}. ${text}\n`;
        itemIndex++;
      } else {
        // Bullet list (default)
        result += `${indent}- ${text}\n`;
      }
    } else if (part.type === 'nested') {
      result += convertListBlock(part.content, style, depth + 1);
    }
  }

  return result;
}

/** Split list HTML into top-level items and nested <ul> blocks. */
function splitListNesting(html: string): Array<{ type: 'item' | 'nested'; attrs: string; content: string }> {
  const parts: Array<{ type: 'item' | 'nested'; attrs: string; content: string }> = [];

  // Remove the outer <ul> wrapper if present
  let inner = html.replace(/^\s*<ul\b[^>]*>/i, '').replace(/<\/ul>\s*$/i, '');

  // Match <li>...</li> and <ul>...</ul> at the same level
  const tokenRegex = /<li\b([^>]*)>([\s\S]*?)<\/li>|<ul\b[^>]*>([\s\S]*?)<\/ul>/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(inner)) !== null) {
    if (match[2] !== undefined) {
      // <li> match
      parts.push({ type: 'item', attrs: match[1], content: match[2] });
    } else if (match[3] !== undefined) {
      // nested <ul> match
      parts.push({ type: 'nested', attrs: '', content: `<ul>${match[3]}</ul>` });
    }
  }

  return parts;
}

/** Convert <table> to GFM markdown tables. */
function convertTables(html: string): string {
  return html.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_match, inner: string) => {
      const rows: string[][] = [];
      const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch: RegExpExecArray | null;

      while ((rowMatch = rowRegex.exec(inner)) !== null) {
        const cells: string[] = [];
        const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch: RegExpExecArray | null;

        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
          cells.push(convertCellContent(cellMatch[1]));
        }

        if (cells.length > 0) {
          rows.push(cells);
        }
      }

      if (rows.length === 0) return '';

      // Normalize column count
      const colCount = Math.max(...rows.map(r => r.length));
      const normalized = rows.map(r => {
        while (r.length < colCount) r.push('');
        return r;
      });

      // Build GFM table
      let table = '| ' + normalized[0].join(' | ') + ' |\n';
      table += '| ' + normalized[0].map(() => '---').join(' | ') + ' |\n';
      for (let i = 1; i < normalized.length; i++) {
        table += '| ' + normalized[i].join(' | ') + ' |\n';
      }

      return '\n' + table + '\n';
    },
  );
}

/** Convert block-level HTML elements. */
function convertBlocks(html: string): string {
  let result = html;

  // Headings
  result = result.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, c: string) => `\n# ${stripTags(c).trim()}\n\n`);
  result = result.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, c: string) => `\n## ${stripTags(c).trim()}\n\n`);
  result = result.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, c: string) => `\n### ${stripTags(c).trim()}\n\n`);

  // Blockquotes
  result = result.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, c: string) => {
      const text = stripTags(c.replace(/<br\s*\/?>/gi, '\n')).trim();
      return '\n' + text.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    },
  );

  // Paragraphs
  result = result.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (_m, c: string) => {
      const text = c.replace(/\u200B/g, '').trim();
      if (!text) return '\n';
      return `${text}\n\n`;
    },
  );

  // Horizontal rules
  result = result.replace(/<hr\b[^>]*>/gi, '\n---\n\n');

  // Remove remaining divs (list wrappers already processed)
  result = result.replace(/<\/?div\b[^>]*>/gi, '');

  // Remove remaining ul/ol tags (list content already processed)
  result = result.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '');

  return result;
}

/** Convert inline formatting. */
function convertInline(html: string): string {
  let result = html;

  // Bold
  result = result.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  // Italic
  result = result.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');
  // Strikethrough
  result = result.replace(/<(?:del|s)\b[^>]*>([\s\S]*?)<\/(?:del|s)>/gi, '~~$1~~');
  // Inline code
  result = result.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Links
  result = result.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Underline (no markdown equiv — just unwrap)
  result = result.replace(/<\/?u\b[^>]*>/gi, '');
  // Line breaks
  result = result.replace(/<br\s*\/?>/gi, '\n');

  return result;
}

/** Final cleanup: normalize whitespace, decode entities, strip leftover tags. */
function cleanup(md: string): string {
  let result = md;
  // Strip remaining HTML tags (but preserve Slack mentions like <@U123> and <#C123>)
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // Decode HTML entities
  result = decodeEntities(result);
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing whitespace
  result = result.trim();
  return result + '\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert table cell content: preserve inline formatting, strip block wrappers. */
function convertCellContent(html: string): string {
  // Unwrap block-level elements (keep children)
  let result = html.replace(/<\/?(?:h[1-6]|p|div)\b[^>]*>/gi, '');
  // Reuse the shared inline conversion
  result = convertInline(result);
  // Strip remaining HTML tags but preserve Slack mentions (<@U...>, <#C...>)
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\u200B/g, '').trim();
  return result;
}

function stripTags(html: string): string {
  return html.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
