import { describe, expect, it } from 'bun:test';
import { canvasHtmlToMarkdown, isAuthPage } from './canvas-parser.ts';

// ---------------------------------------------------------------------------
// Fixtures — based on real Slack Canvas HTML exports
// ---------------------------------------------------------------------------

const FULL_DOCUMENT = `<!DOCTYPE html><html><head><title>Test</title></head><body><main>
<h1>Title</h1>
<p class='line'>Hello world</p>
</main></body></html>`;

const HEADINGS = `<h1>Heading 1</h1><h2>Heading 2</h2><h3>Heading 3</h3>`;

const FORMATTING = `<p class='line'><b>bold</b> and <i>italic</i> and <del>strike</del> and <code>code</code></p>`;

const LINK = `<p class='line'>Visit <a href="https://example.com">Example</a></p>`;

const UNDERLINE = `<p class='line'><u>underlined text</u></p>`;

const BULLET_LIST = `<div data-section-style='5'><ul>
<li class='parent'><b>Item 1</b><br/></li>
<li class=''>Item 2<br/></li>
</ul></div>`;

const ORDERED_LIST = `<div data-section-style='6'><ul>
<li class=''>First<br/></li>
<li class=''>Second<br/></li>
<li class=''>Third<br/></li>
</ul></div>`;

const CHECKLIST = `<div data-section-style='7'><ul>
<li class='checked'>Done task<br/></li>
<li class=''>Todo task<br/></li>
</ul></div>`;

const NESTED_LIST = `<div data-section-style='5'><ul>
<li class='parent'>Parent<br/></li>
<ul>
<li class=''>Child 1<br/></li>
<li class=''>Child 2<br/></li>
</ul>
</ul></div>`;

const LIST_WITH_MENTION = `<div data-section-style='5'><ul>
<li class=''>Assigned to <@U099ABC123><br/></li>
</ul></div>`;

const CODE_BLOCK = `<pre class='prettyprint'>const x = 1;\nconst y = 2;</pre>`;

const CODE_BLOCK_WITH_FORMATTING = `<pre class='prettyprint'>{<br>    <i>"key"</i>: "value"<br>}</pre>`;

const CODE_BLOCK_WITH_BR = `<pre class='prettyprint'>line1<br>line2<br>line3</pre>`;

const TABLE = `<table>
<tr><td><p class='line'>Name</p></td><td><p class='line'>Age</p></td></tr>
<tr><td><p class='line'>Alice</p></td><td><p class='line'>30</p></td></tr>
<tr><td><p class='line'>Bob</p></td><td><p class='line'>25</p></td></tr>
</table>`;

const TABLE_WITH_HEADING_CELLS = `<table>
<tr><td><h1><b>Name</b></h1></td><td><h1>Role</h1></td></tr>
<tr><td><p class='line'>Alice</p></td><td><p class='line'>Engineer</p></td></tr>
</table>`;

const TABLE_WITH_MENTIONS = `<table>
<tr><td><p class='line'>Responsable</p></td><td><p class='line'>Date</p></td></tr>
<tr><td><p class='line'><@U023L3A4UKX></p></td><td><p class='line'>March 25th</p></td></tr>
</table>`;

const EMOJI_CUSTOM = `<control data-remapped="true"><img src="https://emoji.slack-edge.com/T0266/sparkling-blahaj/abc.png" alt="sparkling-blahaj" data-is-slack style="width: 18px">:sparkling-blahaj:</img></control>`;

const EMOJI_STANDARD = `<control data-remapped="true"><img src="https://a.slack-edge.com/production-standard-emoji-assets/14.0/google-small/1f1fa.png" alt="flag-us" data-is-slack style="width: 18px">:flag-us:</img></control>`;

const USER_MENTION = `<control data-remapped="true"><a>@U023L3A4UKX</a></control>`;

const CHANNEL_MENTION = `<control data-remapped="true"><a>#CNMU9L92Q</a></control>`;

const MESSAGE_LINK = `<control data-remapped="true"><a href="https://team.slack.com/archives/C0C78SG9L/p1758150775836749">message</a></control>`;

const DATE_ELEMENT = `<control data-remapped="true">September 15th</control>`;

const EMBEDDED_FILE = `<p class='embedded-file'>File ID: F08TY7LMG0J File URL: https://team.slack.com/files/U09FF/F08TY7LMG0J/_confessions.gif</p>`;

const EMBEDDED_LINK = `<p class='embedded-link'>Link URL: https://github.com/example/repo</p>`;

const BLOCKQUOTE = `<blockquote>Quote line 1<br>Quote line 2</blockquote>`;

const DIVIDER = `<hr style='width:100%'>`;

const EMPTY_PARAGRAPH = `<p class='line'>\u200B</p>`;

const AUTH_PAGE = `<html><head><title>Sign in - Slack</title></head><body><form data-qa="signin"></form></body></html>`;

const ENTITIES = `<p class='line'>Fish &amp; Chips &lt;3 &quot;tasty&quot;</p>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canvasHtmlToMarkdown', () => {
  describe('content extraction', () => {
    it('should extract content from <main> tag', () => {
      const result = canvasHtmlToMarkdown(FULL_DOCUMENT);
      expect(result).toContain('# Title');
      expect(result).toContain('Hello world');
      expect(result).not.toContain('<html>');
      expect(result).not.toContain('<title>');
    });

    it('should handle raw content without document wrapper', () => {
      const result = canvasHtmlToMarkdown('<p class="line">Just text</p>');
      expect(result).toContain('Just text');
    });
  });

  describe('headings', () => {
    it('should convert h1, h2, h3 to markdown headings', () => {
      const result = canvasHtmlToMarkdown(HEADINGS);
      expect(result).toContain('# Heading 1');
      expect(result).toContain('## Heading 2');
      expect(result).toContain('### Heading 3');
    });

    it('should preserve user mentions inside headings', () => {
      const result = canvasHtmlToMarkdown('<h2>Notes de <@U099ABC123></h2>');
      expect(result).toContain('## Notes de <@U099ABC123>');
    });
  });

  describe('text formatting', () => {
    it('should convert bold, italic, strikethrough, and inline code', () => {
      const result = canvasHtmlToMarkdown(FORMATTING);
      expect(result).toContain('**bold**');
      expect(result).toContain('_italic_');
      expect(result).toContain('~~strike~~');
      expect(result).toContain('`code`');
    });

    it('should convert links', () => {
      const result = canvasHtmlToMarkdown(LINK);
      expect(result).toContain('[Example](https://example.com)');
    });

    it('should preserve underlined text without formatting', () => {
      const result = canvasHtmlToMarkdown(UNDERLINE);
      expect(result).toContain('underlined text');
      expect(result).not.toContain('<u>');
    });

    it('should decode HTML entities', () => {
      const result = canvasHtmlToMarkdown(ENTITIES);
      expect(result).toContain('Fish & Chips <3 "tasty"');
    });
  });

  describe('lists', () => {
    it('should convert bullet lists (data-section-style 5)', () => {
      const result = canvasHtmlToMarkdown(BULLET_LIST);
      expect(result).toContain('- Item 1');
      expect(result).toContain('- Item 2');
    });

    it('should convert ordered lists (data-section-style 6)', () => {
      const result = canvasHtmlToMarkdown(ORDERED_LIST);
      expect(result).toContain('1. First');
      expect(result).toContain('2. Second');
      expect(result).toContain('3. Third');
    });

    it('should convert checked checklist items', () => {
      const result = canvasHtmlToMarkdown(CHECKLIST);
      expect(result).toContain('- [x] Done task');
    });

    it('should convert unchecked checklist items', () => {
      const result = canvasHtmlToMarkdown(CHECKLIST);
      expect(result).toContain('- [ ] Todo task');
    });

    it('should handle nested lists', () => {
      const result = canvasHtmlToMarkdown(NESTED_LIST);
      expect(result).toContain('- Parent');
      expect(result).toContain('  - Child 1');
      expect(result).toContain('  - Child 2');
    });

    it('should preserve user mentions inside list items', () => {
      const result = canvasHtmlToMarkdown(LIST_WITH_MENTION);
      expect(result).toContain('<@U099ABC123>');
    });
  });

  describe('code blocks', () => {
    it('should convert pre.prettyprint to fenced code blocks', () => {
      const result = canvasHtmlToMarkdown(CODE_BLOCK);
      expect(result).toContain('```');
      expect(result).toContain('const x = 1;');
    });

    it('should strip internal formatting tags in code blocks', () => {
      const result = canvasHtmlToMarkdown(CODE_BLOCK_WITH_FORMATTING);
      expect(result).toContain('"key"');
      expect(result).not.toContain('<i>');
      expect(result).not.toContain('_"key"_');
    });

    it('should convert br to newlines in code blocks', () => {
      const result = canvasHtmlToMarkdown(CODE_BLOCK_WITH_BR);
      expect(result).toContain('line1\nline2\nline3');
    });
  });

  describe('slack-specific elements', () => {
    it('should convert custom emoji control elements to :name:', () => {
      const result = canvasHtmlToMarkdown(EMOJI_CUSTOM);
      expect(result).toContain(':sparkling-blahaj:');
      expect(result).not.toContain('<control');
      expect(result).not.toContain('<img');
    });

    it('should convert standard emoji control elements to :name:', () => {
      const result = canvasHtmlToMarkdown(EMOJI_STANDARD);
      expect(result).toContain(':flag-us:');
    });

    it('should convert user mentions to <@U...> format', () => {
      const result = canvasHtmlToMarkdown(USER_MENTION);
      expect(result).toContain('<@U023L3A4UKX>');
    });

    it('should convert channel mentions to <#C...> format', () => {
      const result = canvasHtmlToMarkdown(CHANNEL_MENTION);
      expect(result).toContain('<#CNMU9L92Q>');
    });

    it('should convert message links to markdown links', () => {
      const result = canvasHtmlToMarkdown(MESSAGE_LINK);
      expect(result).toContain('[message](https://team.slack.com/archives/C0C78SG9L/p1758150775836749)');
    });

    it('should convert date control elements to plain text', () => {
      const result = canvasHtmlToMarkdown(DATE_ELEMENT);
      expect(result).toContain('September 15th');
      expect(result).not.toContain('<control');
    });

    it('should convert embedded-file to markdown link with filename', () => {
      const result = canvasHtmlToMarkdown(EMBEDDED_FILE);
      expect(result).toContain('[_confessions.gif]');
      expect(result).toContain('https://team.slack.com/files/');
    });

    it('should convert embedded-link to markdown link', () => {
      const result = canvasHtmlToMarkdown(EMBEDDED_LINK);
      expect(result).toContain('[https://github.com/example/repo](https://github.com/example/repo)');
    });
  });

  describe('block elements', () => {
    it('should convert blockquotes with line breaks', () => {
      const result = canvasHtmlToMarkdown(BLOCKQUOTE);
      expect(result).toContain('> Quote line 1');
      expect(result).toContain('> Quote line 2');
    });

    it('should convert hr to divider', () => {
      const result = canvasHtmlToMarkdown(DIVIDER);
      expect(result).toContain('---');
    });
  });

  describe('tables', () => {
    it('should convert table to GFM format', () => {
      const result = canvasHtmlToMarkdown(TABLE);
      expect(result).toContain('| Name | Age |');
      expect(result).toContain('| --- | --- |');
      expect(result).toContain('| Alice | 30 |');
      expect(result).toContain('| Bob | 25 |');
    });

    it('should preserve inline formatting in table cells', () => {
      const result = canvasHtmlToMarkdown(TABLE_WITH_HEADING_CELLS);
      expect(result).toContain('**Name**');
      expect(result).toContain('Role');
      expect(result).toContain('Alice');
      expect(result).not.toContain('<h1>');
      expect(result).not.toContain('<b>');
    });

    it('should preserve user mentions inside table cells', () => {
      const result = canvasHtmlToMarkdown(TABLE_WITH_MENTIONS);
      expect(result).toContain('<@U023L3A4UKX>');
      expect(result).toContain('March 25th');
    });
  });

  describe('edge cases', () => {
    it('should handle empty HTML', () => {
      const result = canvasHtmlToMarkdown('');
      expect(result).toBe('\n');
    });

    it('should handle HTML with only whitespace', () => {
      const result = canvasHtmlToMarkdown('   \n  ');
      expect(result).toBe('\n');
    });

    it('should strip zero-width space paragraphs', () => {
      const result = canvasHtmlToMarkdown(EMPTY_PARAGRAPH);
      expect(result.trim()).toBe('');
    });

    it('should preserve Slack mentions while stripping HTML tags', () => {
      const html = `<p class="line">Hello <div>world</div> <@U123ABC> and <#C456DEF></p>`;
      const result = canvasHtmlToMarkdown(html);
      expect(result).toContain('<@U123ABC>');
      expect(result).toContain('<#C456DEF>');
      expect(result).not.toContain('<div>');
      expect(result).not.toContain('<p');
    });

    it('should not contain leftover HTML tags', () => {
      const complex = `${HEADINGS}${FORMATTING}${BULLET_LIST}${TABLE}${EMOJI_CUSTOM}${USER_MENTION}`;
      const result = canvasHtmlToMarkdown(complex);
      // Strip Slack mentions before checking for leftover HTML tags
      const withoutMentions = result.replace(/<[@#][^>]+>/g, '');
      expect(withoutMentions).not.toMatch(/<[a-z][^>]*>/i);
    });
  });
});

describe('isAuthPage', () => {
  it('should detect Slack sign-in pages', () => {
    expect(isAuthPage(AUTH_PAGE)).toBe(true);
  });

  it('should not flag normal canvas content', () => {
    expect(isAuthPage(FULL_DOCUMENT)).toBe(false);
    expect(isAuthPage('<h1>Canvas Title</h1>')).toBe(false);
  });
});
