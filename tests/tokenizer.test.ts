import { describe, expect, it } from 'vitest';
import { tokenizeLine } from '@content/WordTokenizer';

/** Word-like tokens as displayed, i.e. with attached edge punctuation. */
function words(input: string, language = 'de'): string[] {
  return tokenizeLine(input, language)
    .filter((token) => token.isWordLike)
    .map((token) => token.text);
}

describe('tokenizeLine — offsets', () => {
  const samples = [
    'Ich möchte morgen nach Berlin fahren.',
    "Hallo, wie geht's?",
    '„Größe“ und — Straße …',
    'Ja/Nein? Vielleicht!',
    'Kfz-Versicherung für 1.999 €',
    '',
    '   ',
  ];

  it('produces offsets that slice back to the token text', () => {
    for (const sample of samples) {
      for (const token of tokenizeLine(sample, 'de')) {
        expect(sample.slice(token.start, token.end)).toBe(token.text);
      }
    }
  });

  it('never overlaps or reorders tokens', () => {
    for (const sample of samples) {
      const tokens = tokenizeLine(sample, 'de');
      for (let i = 1; i < tokens.length; i++) {
        expect(tokens[i]!.start).toBeGreaterThanOrEqual(tokens[i - 1]!.end);
      }
    }
  });
});

describe('tokenizeLine — German', () => {
  it('splits a sentence into its words', () => {
    expect(words('Ich möchte morgen nach Berlin fahren.')).toEqual([
      'Ich',
      'möchte',
      'morgen',
      'nach',
      'Berlin',
      'fahren.',
    ]);
  });

  it('keeps umlauts and ß intact', () => {
    expect(words('Größe Mädchen über Straße Fußball')).toEqual([
      'Größe',
      'Mädchen',
      'über',
      'Straße',
      'Fußball',
    ]);
  });

  it('never splits compound nouns', () => {
    expect(words('Arbeitslosenversicherung')).toEqual(['Arbeitslosenversicherung']);
    expect(words('Kraftfahrzeughaftpflichtversicherung')).toEqual([
      'Kraftfahrzeughaftpflichtversicherung',
    ]);
  });

  it('keeps hyphenated words together', () => {
    expect(words('Kfz-Versicherung')).toEqual(['Kfz-Versicherung']);
    expect(words('Nord-Süd-Verbindung')).toEqual(['Nord-Süd-Verbindung']);
  });

  it('keeps contractions together', () => {
    expect(words("Hallo, wie geht's?")).toEqual(['Hallo,', 'wie', "geht's?"]);
    expect(words('Wie geht’s dir?')).toEqual(['Wie', 'geht’s', 'dir?']);
  });

  it('treats a spaced dash as a separator, not part of a word', () => {
    expect(words('Ich – du')).toEqual(['Ich', 'du']);
  });
});

describe('tokenizeLine — punctuation', () => {
  it('attaches trailing punctuation to the word', () => {
    expect(words('Wirklich?!')).toEqual(['Wirklich?!']);
  });

  it('attaches enclosing quotes and brackets', () => {
    expect(words('„Hallo“')).toEqual(['„Hallo“']);
    expect(words('(Hallo)')).toEqual(['(Hallo)']);
  });

  it('leaves punctuation that separates two words clickable-free', () => {
    // A slash between two words belongs to neither, so both stay individually selectable.
    expect(words('Ja/Nein')).toEqual(['Ja', 'Nein']);
  });

  it('emits punctuation-only runs as non-word tokens', () => {
    const tokens = tokenizeLine('Hallo … Welt', 'de');
    const nonWords = tokens.filter((token) => !token.isWordLike).map((token) => token.text);
    expect(nonWords).toEqual(['…']);
  });
});

describe('tokenizeLine — other scripts', () => {
  it('segments Japanese without whitespace cues', () => {
    const tokens = words('私は学生です', 'ja');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe('私は学生です');
  });

  it('handles Latin text with diacritics', () => {
    expect(words('Ça va très bien', 'fr')).toEqual(['Ça', 'va', 'très', 'bien']);
  });
});
