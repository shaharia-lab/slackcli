import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSync } from '@logtape/logtape';
import { buildSectionCriteria, CANVAS_SECTION_TYPES, parseSectionTypes, sectionsOf } from './canvas-sections.ts';
import { InvalidInputError } from './cli-errors.ts';
import { configureLogging } from './logger.ts';

describe('parseSectionTypes', () => {
  it.each(CANVAS_SECTION_TYPES.map((type) => [type]))('accepts %s', (type) => {
    expect(parseSectionTypes(type)).toEqual([type]);
  });

  it('trims, lower-cases and drops duplicates, keeping the first position', () => {
    expect(parseSectionTypes(' H2 , h1,h2,ANY_HEADER ')).toEqual(['h2', 'h1', 'any_header']);
  });

  it.each([[''], ['   '], ['h1,'], [',h1'], ['h1,,h2'], ['h1, ,h2']])('refuses an empty entry in %p', (input) => {
    expect(() => parseSectionTypes(input)).toThrow(InvalidInputError);
    expect(() => parseSectionTypes(input)).toThrow('without empty entries, e.g. --type h1,h2');
  });

  it.each([['h4'], ['header'], ['h1,paragraph'], ['any-header']])('refuses an unknown type in %p', (input) => {
    expect(() => parseSectionTypes(input)).toThrow(InvalidInputError);
    expect(() => parseSectionTypes(input)).toThrow(`use one of ${CANVAS_SECTION_TYPES.join(', ')}`);
  });

  it('accepts the non-heading types too', () => {
    expect(parseSectionTypes('list,table,callout')).toEqual(['list', 'table', 'callout']);
  });

  it('names the unknown entry', () => {
    expect(() => parseSectionTypes('h1,Paragraph')).toThrow('Unknown section type "paragraph" in --type');
  });
});

describe('buildSectionCriteria', () => {
  it('needs --type or --contains', () => {
    expect(() => buildSectionCriteria({})).toThrow(InvalidInputError);
    expect(() => buildSectionCriteria({})).toThrow('Give --type, --contains or both');
  });

  it('sends section_types only for --type', () => {
    expect(buildSectionCriteria({ type: 'h2' })).toStrictEqual({ section_types: ['h2'] });
  });

  it('sends contains_text only for --contains, as given', () => {
    expect(buildSectionCriteria({ contains: ' Status ' })).toStrictEqual({ contains_text: ' Status ' });
  });

  it('sends both when both are given', () => {
    expect(buildSectionCriteria({ type: 'h1,h2', contains: 'Status' }))
      .toStrictEqual({ section_types: ['h1', 'h2'], contains_text: 'Status' });
  });

  it.each([[''], ['  '], ['\t\n']])('refuses a blank --contains %p', (contains) => {
    expect(() => buildSectionCriteria({ contains })).toThrow('--contains needs some text to match');
    expect(() => buildSectionCriteria({ type: 'h1', contains })).toThrow(InvalidInputError);
  });

  it('validates --type when --contains is fine', () => {
    expect(() => buildSectionCriteria({ type: 'h9', contains: 'Status' })).toThrow('Unknown section type "h9"');
  });
});

describe('sectionsOf', () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'slackcli-sections-'));
  });

  afterEach(async () => {
    resetSync();
    await rm(logDir, { recursive: true, force: true });
  });

  it('keeps Slack order and only the id', () => {
    expect(sectionsOf({ sections: [{ id: 'temp:C:b', extra: 1 }, { id: 'temp:C:a' }] }))
      .toStrictEqual([{ id: 'temp:C:b' }, { id: 'temp:C:a' }]);
  });

  it.each([[undefined], [null], [{}], [{ sections: null }], [{ sections: 'x' }], [{ sections: [] }]])(
    'reads %p as no match',
    (response) => {
      expect(sectionsOf(response as any)).toEqual([]);
    },
  );

  it('leaves out entries without a usable id and logs how many', () => {
    const file = configureLogging({ level: 'trace', verbose: false, dir: logDir }).logFile!;
    const found = sectionsOf({ sections: [null, { id: '' }, { id: 7 }, 'temp:C:x', { id: 'temp:C:ok' }] });
    expect(found).toStrictEqual([{ id: 'temp:C:ok' }]);

    const records = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => record.message.includes('without an id'));
    expect(records.map((record) => [record.level, record.properties.skipped])).toEqual([['WARN', 4]]);
  });

  it('logs nothing when every entry is usable', () => {
    const file = configureLogging({ level: 'trace', verbose: false, dir: logDir }).logFile!;
    sectionsOf({ sections: [{ id: 'temp:C:ok' }] });
    let text = '';
    try { text = readFileSync(file, 'utf-8'); } catch { /* no file: nothing logged */ }
    expect(text).not.toContain('without an id');
  });
});
