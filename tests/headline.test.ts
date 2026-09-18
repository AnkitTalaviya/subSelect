import { describe, expect, it } from 'vitest';
import { headlineFor } from '@content/ContextMenu';
import type { WordDetails } from '../src/providers/types';

const details = (overrides: Partial<WordDetails> = {}): WordDetails => ({
  headword: 'entscheiden',
  sources: [],
  problems: [],
  ...overrides,
});

describe('headlineFor', () => {
  it('prefers the dictionary for a single word', () => {
    /*
     * The case this rule exists for: MyMemory returns "do" for "entscheiden", while
     * Wiktionary has the real meaning. The machine answer must not take the largest type.
     */
    const result = headlineFor(
      details({
        translation: { text: 'do', providerId: 'mymemory' },
        senses: [{ definition: 'to decide, to make a decision' }],
      }),
    );
    expect(result).toEqual({ text: 'to decide, to make a decision', fromDictionary: true });
  });

  it('trims the usage note off the headline', () => {
    const result = headlineFor(
      details({
        senses: [{ definition: "to decide, to make a decision [with ob (+ clause) 'whether ...']" }],
      }),
    );
    expect(result.text).toBe('to decide, to make a decision');
  });

  it('falls back to the translation when the dictionary has nothing', () => {
    const result = headlineFor(details({ translation: { text: 'to decide', providerId: 'mymemory' } }));
    expect(result).toEqual({ text: 'to decide', fromDictionary: false });
  });

  it('uses the translation for a phrase even when senses exist', () => {
    // Dictionaries do not carry phrases, so a sense here would be about the wrong thing.
    const result = headlineFor(
      details({
        headword: 'für einen neuen Job',
        translation: { text: 'for a new job', providerId: 'mymemory' },
        senses: [{ definition: 'for' }],
      }),
    );
    expect(result).toEqual({ text: 'for a new job', fromDictionary: false });
  });

  it('reports nothing when neither source answered', () => {
    expect(headlineFor(details())).toEqual({ fromDictionary: false });
  });

  it('handles a German word with surrounding whitespace', () => {
    const result = headlineFor(
      details({ headword: '  Größe  ', senses: [{ definition: 'size, dimension' }] }),
    );
    expect(result).toEqual({ text: 'size, dimension', fromDictionary: true });
  });
});
