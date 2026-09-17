import { describe, expect, it } from 'vitest';
import { cleanCueText, hashText, normalizeWord, toLookupKey } from '@shared/text';

describe('normalizeWord', () => {
  it('strips edge punctuation', () => {
    expect(normalizeWord('Hallo,')).toBe('Hallo');
    expect(normalizeWord('entscheiden.')).toBe('entscheiden');
    expect(normalizeWord('„Größe“')).toBe('Größe');
    expect(normalizeWord('(Hallo)')).toBe('Hallo');
    expect(normalizeWord('Wirklich?!')).toBe('Wirklich');
  });

  it('keeps word-internal apostrophes and hyphens', () => {
    expect(normalizeWord("geht's?")).toBe("geht's");
    expect(normalizeWord('geht’s')).toBe('geht’s');
    expect(normalizeWord('Kfz-Versicherung,')).toBe('Kfz-Versicherung');
  });

  it('leaves German letters untouched', () => {
    for (const word of ['Größe', 'Mädchen', 'über', 'Straße', 'Fußball', 'ÄÖÜ']) {
      expect(normalizeWord(word)).toBe(word);
    }
  });

  it('returns punctuation-only input unchanged', () => {
    expect(normalizeWord('…')).toBe('…');
    expect(normalizeWord('—')).toBe('—');
  });

  it('normalizes decomposed input to NFC', () => {
    // "über" written with a combining diaeresis must compare equal to the composed form.
    expect(normalizeWord('über')).toBe('über');
  });
});

describe('toLookupKey', () => {
  it('lowercases without destroying ß', () => {
    expect(toLookupKey('Straße', 'de')).toBe('straße');
    expect(toLookupKey('GRÖSSE', 'de')).toBe('grösse');
  });

  it('strips punctuation as well as case', () => {
    expect(toLookupKey('Hallo,', 'de')).toBe('hallo');
    expect(toLookupKey("Geht's?", 'de')).toBe("geht's");
  });

  it('survives an unusable locale tag', () => {
    expect(toLookupKey('Hallo', 'not-a-locale!!')).toBe('hallo');
  });
});

describe('cleanCueText', () => {
  it('collapses caption whitespace without losing lines', () => {
    expect(cleanCueText('  Ich habe gestern \n  einen Film gesehen.  ')).toBe(
      'Ich habe gestern\neinen Film gesehen.',
    );
  });

  it('drops empty lines and zero-width characters', () => {
    expect(cleanCueText('Eins\n\n​Zwei\n')).toBe('Eins\nZwei');
  });

  it('normalizes CRLF', () => {
    expect(cleanCueText('Eins\r\nZwei')).toBe('Eins\nZwei');
  });
});

describe('hashText', () => {
  it('is stable and distinguishes different text', () => {
    expect(hashText('Hallo')).toBe(hashText('Hallo'));
    expect(hashText('Hallo')).not.toBe(hashText('Hallo '));
  });
});
