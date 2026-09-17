import { describe, expect, it } from 'vitest';
import type { SavedWord } from '@shared/types';
import { queryVocabulary } from '../src/vocabulary/VocabularyManager';
import {
  exportFilename,
  toCsv,
  toCsvField,
  toJson,
} from '../src/vocabulary/VocabularyExporter';

function word(overrides: Partial<SavedWord> = {}): SavedWord {
  return {
    id: 'id-1',
    word: 'entscheiden',
    normalizedWord: 'entscheiden',
    translation: 'to decide',
    context: 'Ich muss mich heute entscheiden.',
    sourceLanguage: 'de',
    targetLanguage: 'en',
    website: 'example.com',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('toCsvField', () => {
  it('leaves ordinary text alone', () => {
    expect(toCsvField('entscheiden')).toBe('entscheiden');
  });

  it('quotes fields containing a comma', () => {
    expect(toCsvField('Hallo, wie geht es dir?')).toBe('"Hallo, wie geht es dir?"');
  });

  it('doubles interior quotes', () => {
    expect(toCsvField('Er sagte "ja"')).toBe('"Er sagte ""ja"""');
  });

  it('quotes fields containing a newline', () => {
    expect(toCsvField('Ich habe\ngestern')).toBe('"Ich habe\ngestern"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // Subtitle text is not ours to trust; a leading =, +, - or @ executes as a formula in
    // Excel and Sheets. The apostrophe forces the cell to be read as literal text.
    expect(toCsvField('=SUM(A1:A9)')).toBe(`'=SUM(A1:A9)`);
    expect(toCsvField('-1+1')).toBe(`'-1+1`);
    expect(toCsvField('@cmd')).toBe(`'@cmd`);
  });

  it('quotes a guarded field that also contains a delimiter', () => {
    expect(toCsvField('=A1,B2')).toBe(`"'=A1,B2"`);
  });

  it('keeps German characters intact', () => {
    expect(toCsvField('Straße')).toBe('Straße');
  });
});

describe('toCsv', () => {
  it('writes the documented header', () => {
    expect(toCsv([]).trim()).toBe('word,translation,context,language');
  });

  it('writes one row per word in the documented column order', () => {
    const csv = toCsv([word()]);
    expect(csv.split('\r\n')[1]).toBe(
      'entscheiden,to decide,Ich muss mich heute entscheiden.,de',
    );
  });

  it('leaves a missing translation as an empty field rather than "undefined"', () => {
    const csv = toCsv([word({ translation: undefined })]);
    expect(csv.split('\r\n')[1]).toBe('entscheiden,,Ich muss mich heute entscheiden.,de');
  });
});

describe('toJson', () => {
  it('emits an ISO timestamp rather than a raw epoch', () => {
    const parsed = JSON.parse(toJson([word()])) as Array<{ createdAt: string; word: string }>;
    expect(parsed[0]!.word).toBe('entscheiden');
    expect(parsed[0]!.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('round-trips as valid JSON for an empty list', () => {
    expect(JSON.parse(toJson([]))).toEqual([]);
  });
});

describe('exportFilename', () => {
  it('is dated and carries the right extension', () => {
    const date = new Date('2026-03-04T12:00:00Z');
    expect(exportFilename('csv', date)).toBe('subselect-vocabulary-2026-03-04.csv');
    expect(exportFilename('json', date)).toBe('subselect-vocabulary-2026-03-04.json');
  });
});

describe('queryVocabulary', () => {
  const words = [
    word({ id: 'a', word: 'entscheiden', normalizedWord: 'entscheiden', createdAt: 300 }),
    word({
      id: 'b',
      word: 'allerdings',
      normalizedWord: 'allerdings',
      translation: 'however',
      context: 'Das ist allerdings schwierig.',
      createdAt: 100,
    }),
    word({
      id: 'c',
      word: 'Größe',
      normalizedWord: 'Größe',
      translation: 'size',
      context: 'Welche Größe brauchst du?',
      createdAt: 200,
    }),
  ];

  it('sorts newest first by default', () => {
    expect(queryVocabulary(words, '', 'newest').map((w) => w.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts oldest first', () => {
    expect(queryVocabulary(words, '', 'oldest').map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts alphabetically with locale-aware ordering', () => {
    expect(queryVocabulary(words, '', 'alphabetical').map((w) => w.id)).toEqual(['b', 'a', 'c']);
  });

  it('searches the word, the translation and the context', () => {
    expect(queryVocabulary(words, 'however', 'newest').map((w) => w.id)).toEqual(['b']);
    expect(queryVocabulary(words, 'schwierig', 'newest').map((w) => w.id)).toEqual(['b']);
    expect(queryVocabulary(words, 'entscheid', 'newest').map((w) => w.id)).toEqual(['a']);
  });

  it('searches case-insensitively, including German characters', () => {
    expect(queryVocabulary(words, 'größe', 'newest').map((w) => w.id)).toEqual(['c']);
  });

  it('returns everything for an empty search', () => {
    expect(queryVocabulary(words, '   ', 'newest')).toHaveLength(3);
  });

  it('does not mutate the input list', () => {
    const before = words.map((w) => w.id);
    queryVocabulary(words, '', 'alphabetical');
    expect(words.map((w) => w.id)).toEqual(before);
  });
});
