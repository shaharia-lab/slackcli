import chalk from 'chalk';

// Slack block-kit + legacy attachments renderer for terminal output.
// Recursive — rich_text blocks nest sections/lists/quotes/preformatted spans.

export function renderBlocks(blocks: Array<Record<string, any>>, indent: number): string {
  const indentStr = ' '.repeat(indent);
  let out = '';

  for (const block of blocks) {
    switch (block.type) {
      case 'header':
        if (block.text?.text) {
          out += `${indentStr}${chalk.bold(block.text.text)}\n`;
        }
        break;
      case 'section': {
        if (block.text?.text) {
          for (const line of String(block.text.text).split('\n')) {
            out += `${indentStr}${line}\n`;
          }
        }
        if (Array.isArray(block.fields)) {
          for (const f of block.fields) {
            if (f?.text) out += `${indentStr}  • ${String(f.text).replace(/\n/g, ' ')}\n`;
          }
        }
        break;
      }
      case 'context': {
        const parts = (block.elements || [])
          .map((el: any) => el.text || el.alt_text || '')
          .filter(Boolean);
        if (parts.length) out += `${indentStr}${chalk.dim(parts.join(' '))}\n`;
        break;
      }
      case 'divider':
        out += `${indentStr}${chalk.dim('─────────')}\n`;
        break;
      case 'rich_text': {
        const flat = flattenRichText(block.elements || []);
        if (flat) {
          for (const line of flat.split('\n')) {
            out += `${indentStr}${line}\n`;
          }
        }
        break;
      }
      case 'actions':
      case 'image':
        // Skip — interactive buttons / images don't render usefully in terminal
        break;
      default:
        if (block.text?.text) out += `${indentStr}${block.text.text}\n`;
    }
  }
  return out;
}

function flattenRichText(elements: any[]): string {
  let s = '';
  for (const el of elements) {
    if (Array.isArray(el.elements)) {
      const inner = flattenRichText(el.elements);
      if (el.type === 'rich_text_list') {
        for (const line of inner.split('\n')) {
          if (line) s += `• ${line}\n`;
        }
      } else if (el.type === 'rich_text_quote') {
        for (const line of inner.split('\n')) {
          if (line) s += `> ${line}\n`;
        }
      } else if (el.type === 'rich_text_preformatted') {
        s += '```\n' + inner + '\n```\n';
      } else {
        s += inner;
        if (el.type === 'rich_text_section') s += '\n';
      }
    } else if (el.type === 'text') {
      s += el.text || '';
    } else if (el.type === 'link') {
      s += el.text || el.url || '';
    } else if (el.type === 'user') {
      s += `<@${el.user_id}>`;
    } else if (el.type === 'channel') {
      s += `<#${el.channel_id}>`;
    } else if (el.type === 'emoji') {
      s += `:${el.name}:`;
    }
  }
  return s;
}

export function renderAttachments(attachments: Array<Record<string, any>>, indent: number): string {
  const indentStr = ' '.repeat(indent);
  let out = '';

  for (const att of attachments) {
    if (att.pretext) out += `${indentStr}${chalk.dim(String(att.pretext))}\n`;
    if (att.title) {
      const titleLine = att.title_link
        ? `${chalk.bold(att.title)} ${chalk.dim(`(${att.title_link})`)}`
        : chalk.bold(String(att.title));
      out += `${indentStr}${titleLine}\n`;
    }
    if (att.text) {
      for (const line of String(att.text).split('\n')) {
        out += `${indentStr}${line}\n`;
      }
    }
    if (Array.isArray(att.fields)) {
      for (const f of att.fields) {
        const title = f?.title ? `${chalk.bold(f.title)}: ` : '';
        const value = f?.value != null ? String(f.value) : '';
        if (!title && !value) continue;
        const lines = `${title}${value}`.split('\n');
        for (const line of lines) {
          out += `${indentStr}  ${line}\n`;
        }
      }
    }
    if (att.footer) {
      out += `${indentStr}${chalk.dim(String(att.footer))}\n`;
    }
    if (Array.isArray(att.blocks) && att.blocks.length > 0) {
      out += renderBlocks(att.blocks, indent + 2);
    }
  }
  return out;
}
