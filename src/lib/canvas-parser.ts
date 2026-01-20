import { parse, HTMLElement, TextNode, Node } from 'node-html-parser';

/**
 * Convert HTML canvas content to simplified markdown
 */
export function htmlToMarkdown(html: string): string {
  const root = parse(html);

  // Find the body or main content area
  const body = root.querySelector('body') || root;

  return processNode(body).trim();
}

function processNode(node: Node): string {
  if (node instanceof TextNode) {
    return node.text;
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  const tag = node.tagName?.toLowerCase();
  const children = node.childNodes.map(processNode).join('');

  switch (tag) {
    // Headings
    case 'h1':
      return `# ${children.trim()}\n\n`;
    case 'h2':
      return `## ${children.trim()}\n\n`;
    case 'h3':
      return `### ${children.trim()}\n\n`;
    case 'h4':
      return `#### ${children.trim()}\n\n`;
    case 'h5':
      return `##### ${children.trim()}\n\n`;
    case 'h6':
      return `###### ${children.trim()}\n\n`;

    // Paragraphs and blocks
    case 'p':
      return `${children.trim()}\n\n`;
    case 'div':
      return children + '\n';
    case 'br':
      return '\n';
    case 'hr':
      return '\n---\n\n';

    // Text formatting
    case 'strong':
    case 'b':
      return `**${children}**`;
    case 'em':
    case 'i':
      return `*${children}*`;
    case 'u':
      return children; // Markdown doesn't have underline
    case 's':
    case 'strike':
    case 'del':
      return `~~${children}~~`;
    case 'code':
      return `\`${children}\``;
    case 'pre':
      return `\`\`\`\n${children.trim()}\n\`\`\`\n\n`;

    // Links
    case 'a':
      const href = node.getAttribute('href');
      if (href) {
        return `[${children}](${href})`;
      }
      return children;

    // Lists
    case 'ul':
      return processUnorderedList(node);
    case 'ol':
      return processOrderedList(node);
    case 'li':
      return children.trim();

    // Blockquotes
    case 'blockquote':
      return children
        .trim()
        .split('\n')
        .map((line: string) => `> ${line}`)
        .join('\n') + '\n\n';

    // Tables (simplified)
    case 'table':
      return processTable(node);

    // Images
    case 'img':
      const src = node.getAttribute('src');
      const alt = node.getAttribute('alt') || 'image';
      if (src) {
        return `![${alt}](${src})`;
      }
      return '';

    // Skip these tags but process children
    case 'html':
    case 'head':
    case 'body':
    case 'article':
    case 'section':
    case 'main':
    case 'span':
    case 'header':
    case 'footer':
    case 'nav':
    case 'aside':
      return children;

    // Skip script and style completely
    case 'script':
    case 'style':
    case 'link':
    case 'meta':
    case 'title':
      return '';

    default:
      return children;
  }
}

function processUnorderedList(node: HTMLElement): string {
  const items = node.querySelectorAll(':scope > li');
  const lines = items.map((item) => {
    const content = processNode(item).trim();
    return `- ${content}`;
  });
  return lines.join('\n') + '\n\n';
}

function processOrderedList(node: HTMLElement): string {
  const items = node.querySelectorAll(':scope > li');
  const lines = items.map((item, index) => {
    const content = processNode(item).trim();
    return `${index + 1}. ${content}`;
  });
  return lines.join('\n') + '\n\n';
}

function processTable(node: HTMLElement): string {
  const rows = node.querySelectorAll('tr');
  if (rows.length === 0) return '';

  const lines: string[] = [];
  let headerProcessed = false;

  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    const cellContents = cells.map((cell) => processNode(cell).trim());
    lines.push(`| ${cellContents.join(' | ')} |`);

    // Add header separator after first row with th elements
    if (!headerProcessed && row.querySelector('th')) {
      lines.push(`| ${cellContents.map(() => '---').join(' | ')} |`);
      headerProcessed = true;
    }
  }

  // If no header row, add separator after first row
  if (!headerProcessed && lines.length > 0) {
    const firstRow = rows[0].querySelectorAll('th, td');
    lines.splice(1, 0, `| ${firstRow.map(() => '---').join(' | ')} |`);
  }

  return lines.join('\n') + '\n\n';
}
