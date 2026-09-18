import { describe, expect, it } from 'vitest';
import { scoreRecording, wiktionaryHostFor } from '../src/providers/pronunciation/providers';

/** Highest-scoring candidate, or null when none qualifies. */
function best(titles: string[], word: string, language?: string): string | null {
  let winner: string | null = null;
  let top = 0;
  for (const title of titles) {
    const score = scoreRecording(title, word, language);
    if (score > top) {
      top = score;
      winner = title;
    }
  }
  return winner;
}

describe('wiktionaryHostFor', () => {
  it('uses the edition for the language', () => {
    expect(wiktionaryHostFor('de')).toBe('de.wiktionary.org');
    expect(wiktionaryHostFor('fr')).toBe('fr.wiktionary.org');
  });

  it('ignores a region subtag', () => {
    expect(wiktionaryHostFor('de-AT')).toBe('de.wiktionary.org');
  });

  it('falls back to English for an unknown or missing language', () => {
    expect(wiktionaryHostFor('xx')).toBe('en.wiktionary.org');
    expect(wiktionaryHostFor(undefined)).toBe('en.wiktionary.org');
  });
});

describe('scoreRecording — rejection', () => {
  it('rejects files that are not audio', () => {
    // A Wiktionary page carries maps, portraits and icons as well as recordings.
    expect(scoreRecording('File:Berlin_montage.jpg', 'Berlin', 'de')).toBe(-1);
    expect(scoreRecording('File:Map_of_Berlin.svg', 'Berlin', 'de')).toBe(-1);
  });

  it('rejects audio for a different word', () => {
    expect(scoreRecording('File:De-Hamburg.ogg', 'Berlin', 'de')).toBe(-1);
  });

  it('accepts the audio formats Wikimedia actually uses', () => {
    for (const ext of ['ogg', 'oga', 'opus', 'mp3', 'wav', 'flac']) {
      expect(scoreRecording(`File:De-Berlin.${ext}`, 'Berlin', 'de')).toBeGreaterThan(0);
    }
  });
});

describe('scoreRecording — ranking', () => {
  it('prefers a Lingua Libre recording in the right language', () => {
    const titles = [
      'File:De-Berlin.ogg',
      'File:LL-Q188 (deu)-Sebastian Wallroth-Berlin.wav',
      'File:En-us-Berlin.ogg',
    ];
    expect(best(titles, 'Berlin', 'de')).toBe('File:LL-Q188 (deu)-Sebastian Wallroth-Berlin.wav');
  });

  it('prefers the matching language over another one', () => {
    const titles = ['File:En-us-Berlin.ogg', 'File:De-Berlin.ogg'];
    expect(best(titles, 'Berlin', 'de')).toBe('File:De-Berlin.ogg');
  });

  it('prefers an exact word over one that merely contains it', () => {
    const titles = ['File:De-Berlinerin.ogg', 'File:De-Berlin.ogg'];
    expect(best(titles, 'Berlin', 'de')).toBe('File:De-Berlin.ogg');
  });

  it('still returns something when only a foreign-language recording exists', () => {
    expect(best(['File:En-us-Berlin.ogg'], 'Berlin', 'de')).toBe('File:En-us-Berlin.ogg');
  });

  it('handles German characters in filenames', () => {
    const titles = ['File:De-Größe.ogg', 'File:De-Grosse.ogg'];
    expect(best(titles, 'Größe', 'de')).toBe('File:De-Größe.ogg');
  });

  it('matches regardless of case', () => {
    expect(scoreRecording('File:De-berlin.ogg', 'Berlin', 'de')).toBeGreaterThan(0);
  });

  it('works without a language hint', () => {
    expect(scoreRecording('File:De-Berlin.ogg', 'Berlin', undefined)).toBeGreaterThan(0);
  });
});
