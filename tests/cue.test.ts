import { describe, expect, it } from 'vitest';
import { buildCue, selectionTextFor, wordsBetween } from '@content/SubtitleParser';
import type { SubtitleCue } from '@shared/types';

function cueOf(raw: string, language = 'de'): SubtitleCue {
  const cue = buildCue({ raw, source: 'dom', language });
  if (!cue) throw new Error('expected a cue');
  return cue;
}

function wordNamed(cue: SubtitleCue, normalized: string): string {
  const word = cue.words.find((candidate) => candidate.normalizedText === normalized);
  if (!word) throw new Error(`no word "${normalized}" in "${cue.text}"`);
  return word.id;
}

describe('buildCue', () => {
  it('returns null for empty captions', () => {
    expect(buildCue({ raw: '', source: 'dom' })).toBeNull();
    expect(buildCue({ raw: '   \n  ', source: 'dom' })).toBeNull();
  });

  it('carries timing and language through', () => {
    const cue = buildCue({
      raw: 'Ich muss mich heute entscheiden.',
      source: 'texttrack',
      language: 'de',
      startTime: 12.5,
      endTime: 15,
    });
    expect(cue?.startTime).toBe(12.5);
    expect(cue?.endTime).toBe(15);
    expect(cue?.language).toBe('de');
    expect(cue?.source).toBe('texttrack');
  });

  it('gives identical text the same id, so an unchanged caption is not re-rendered', () => {
    expect(cueOf('Hallo Welt').id).toBe(cueOf('Hallo  Welt ').id);
    expect(cueOf('Hallo Welt').id).not.toBe(cueOf('Hallo Welt!').id);
  });

  it('keeps every word offset valid against the cue text', () => {
    const cue = cueOf('Ich habe gestern\neinen interessanten Film gesehen.');
    for (const word of cue.words) {
      expect(cue.text.slice(word.startIndex, word.endIndex)).toBe(word.text);
    }
  });

  it('assigns line indices across a multi-line cue', () => {
    const cue = cueOf('Ich habe gestern\neinen interessanten Film gesehen.');
    expect(cue.lines).toEqual(['Ich habe gestern', 'einen interessanten Film gesehen.']);
    expect(cue.words.find((word) => word.normalizedText === 'Ich')?.lineIndex).toBe(0);
    expect(cue.words.find((word) => word.normalizedText === 'einen')?.lineIndex).toBe(1);
  });

  it('exposes normalized and lookup forms alongside the original', () => {
    const cue = cueOf("Hallo, wie geht's?");
    const last = cue.words[cue.words.length - 1]!;
    expect(last.text).toBe("geht's?");
    expect(last.normalizedText).toBe("geht's");
    expect(last.lookupKey).toBe("geht's");
  });

  it('marks punctuation-only tokens as not clickable', () => {
    const cue = cueOf('Hallo … Welt');
    const ellipsis = cue.words.find((word) => word.text === '…');
    expect(ellipsis?.isWordLike).toBe(false);
  });
});

describe('selectionTextFor', () => {
  const sentence = cueOf('Ich möchte morgen nach Berlin fahren.');

  it('returns a single word exactly as displayed', () => {
    const berlin = sentence.words.find((word) => word.normalizedText === 'Berlin')!;
    expect(selectionTextFor(sentence, [berlin])).toBe('Berlin');
  });

  it('keeps trailing punctuation on the last word', () => {
    const fahren = sentence.words.find((word) => word.normalizedText === 'fahren')!;
    expect(selectionTextFor(sentence, [fahren])).toBe('fahren.');
  });

  it('joins a multi-word span with the original spacing', () => {
    const words = wordsBetween(sentence, wordNamed(sentence, 'morgen'), wordNamed(sentence, 'Berlin'));
    expect(selectionTextFor(sentence, words)).toBe('morgen nach Berlin');
  });

  it('is identical for a reversed selection', () => {
    const forward = wordsBetween(sentence, wordNamed(sentence, 'morgen'), wordNamed(sentence, 'Berlin'));
    const backward = wordsBetween(sentence, wordNamed(sentence, 'Berlin'), wordNamed(sentence, 'morgen'));
    expect(selectionTextFor(sentence, backward)).toBe(selectionTextFor(sentence, forward));
  });

  it('reads a span across two lines as one phrase', () => {
    const cue = cueOf('Ich habe gestern\neinen interessanten Film gesehen.');
    const words = wordsBetween(cue, wordNamed(cue, 'gestern'), wordNamed(cue, 'interessanten'));
    expect(selectionTextFor(cue, words)).toBe('gestern einen interessanten');
  });

  it('preserves interior punctuation inside a span', () => {
    const cue = cueOf('Ja, nein, vielleicht');
    const words = wordsBetween(cue, wordNamed(cue, 'Ja'), wordNamed(cue, 'nein'));
    expect(selectionTextFor(cue, words)).toBe('Ja, nein,');
  });

  it('returns nothing for an empty selection', () => {
    expect(selectionTextFor(sentence, [])).toBe('');
  });
});

describe('wordsBetween', () => {
  const sentence = cueOf('Ich möchte morgen nach Berlin fahren.');

  it('includes both endpoints', () => {
    const words = wordsBetween(sentence, wordNamed(sentence, 'Ich'), wordNamed(sentence, 'möchte'));
    expect(words.map((word) => word.normalizedText)).toEqual(['Ich', 'möchte']);
  });

  it('handles first and last word', () => {
    const words = wordsBetween(sentence, wordNamed(sentence, 'Ich'), wordNamed(sentence, 'fahren'));
    expect(words).toHaveLength(6);
  });

  it('returns an empty list for unknown ids', () => {
    expect(wordsBetween(sentence, 'nope', wordNamed(sentence, 'Ich'))).toEqual([]);
  });

  it('skips punctuation-only tokens', () => {
    const cue = cueOf('Hallo … Welt');
    const words = wordsBetween(cue, wordNamed(cue, 'Hallo'), wordNamed(cue, 'Welt'));
    expect(words.map((word) => word.text)).toEqual(['Hallo', 'Welt']);
  });
});
