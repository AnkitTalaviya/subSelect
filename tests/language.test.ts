import { describe, expect, it } from 'vitest';
import {
  AUTO_LANGUAGE,
  LanguageGuess,
  detectLanguageFromText,
  effectiveLanguage,
  resolveLanguagePair,
} from '@shared/language';

describe('detectLanguageFromText', () => {
  it('reads the writing system where there is one', () => {
    expect(detectLanguageFromText('여기서 뭐 하고 있어요?')?.code).toBe('ko');
    expect(detectLanguageFromText('これはちょっと難しいですね。')?.code).toBe('ja');
    expect(detectLanguageFromText('这件事情真的很复杂。')?.code).toBe('zh');
    expect(detectLanguageFromText('Я не знаю, что это такое.')?.code).toBe('ru');
  });

  it('prefers Japanese over Chinese when kana appear beside Han characters', () => {
    // Mostly Han, but the kana settle it — which is why kana is tested first.
    expect(detectLanguageFromText('今日は本当に忙しかった。')?.code).toBe('ja');
  });

  it('identifies the Latin-script languages from ordinary subtitle lines', () => {
    expect(detectLanguageFromText('Ich weiß nicht, ob das eine gute Idee ist.')?.code).toBe('de');
    expect(detectLanguageFromText('I know what you did and that is the problem.')?.code).toBe('en');
    expect(detectLanguageFromText('No sé qué está pasando, pero es muy extraño.')?.code).toBe('es');
    expect(detectLanguageFromText('Je ne sais pas qui vous êtes, mais restez là.')?.code).toBe('fr');
    expect(detectLanguageFromText('Non so che cosa sia questo, ma è più strano.')?.code).toBe('it');
    expect(detectLanguageFromText('Você não sabe o que isso significa para mim.')?.code).toBe('pt');
    expect(detectLanguageFromText('Ik weet niet wat dat is, maar het is niet goed.')?.code).toBe('nl');
    expect(detectLanguageFromText('Nie wiem, co to jest, ale to się nie liczy.')?.code).toBe('pl');
    expect(detectLanguageFromText('Bu çok daha iyi bir şey değil ama ne var?')?.code).toBe('tr');
  });

  it('says nothing rather than guessing at a line with no evidence', () => {
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('   ')).toBeNull();
    expect(detectLanguageFromText('Hmm.')).toBeNull();
    expect(detectLanguageFromText('42')).toBeNull();
    // Proper nouns belong to no language in particular.
    expect(detectLanguageFromText('Berlin, Paris, Madrid')).toBeNull();
  });

  it('is not fooled by a word several languages share', () => {
    // "de" and "la" belong to Spanish, French, Portuguese and Italian alike, so a line made
    // only of shared words must not resolve to whichever happened to be checked first.
    expect(detectLanguageFromText('de la')).toBeNull();
  });
});

describe('LanguageGuess', () => {
  it('settles immediately on a decisive script', () => {
    const guess = new LanguageGuess();
    guess.observe('もう行かないと。');
    expect(guess.get()).toBe('ja');
  });

  it('waits for a second agreeing line before committing to a Latin language', () => {
    const guess = new LanguageGuess();
    guess.observe('Ich weiß nicht, ob das eine gute Idee ist.');
    // One line is evidence, not a verdict.
    expect(guess.get()).toBeNull();
    guess.observe('Wir sollten nicht so lange warten, oder?');
    expect(guess.get()).toBe('de');
  });

  it('does not let one stray line flip a settled verdict', () => {
    const guess = new LanguageGuess();
    guess.observe('여기서 뭐 하고 있어요?');
    expect(guess.get()).toBe('ko');
    // A single line in another language is not enough to change its mind mid-scene.
    guess.observe('I know what you did and that is the problem.');
    expect(guess.get()).toBe('ko');
  });

  it('follows a viewer who switches the subtitle track mid-film', () => {
    const guess = new LanguageGuess();
    guess.observe('여기서 뭐 하고 있어요?');
    expect(guess.get()).toBe('ko');

    // Two agreeing lines in the new language, and it moves.
    guess.observe('I know what you did and that is the problem.');
    guess.observe('We should not wait for them any longer than this.');
    expect(guess.get()).toBe('en');
  });

  it('ignores a caption it has already seen, so one line cannot agree with itself', () => {
    const guess = new LanguageGuess();
    const line = 'Ich weiß nicht, ob das eine gute Idee ist.';
    // The adapter re-reads the caption on every mutation while it is on screen.
    guess.observe(line);
    guess.observe(line);
    guess.observe(line);
    expect(guess.get()).toBeNull();

    guess.observe('Wir sollten nicht so lange warten, oder?');
    expect(guess.get()).toBe('de');
  });

  it('ignores blank cues', () => {
    const guess = new LanguageGuess();
    guess.observe('   ');
    expect(guess.get()).toBeNull();
  });

  it('starts over after a reset', () => {
    const guess = new LanguageGuess();
    guess.observe('もう行かないと。');
    guess.reset();
    expect(guess.get()).toBeNull();
  });
});

describe('resolveLanguagePair', () => {
  const base = { subtitleLanguage: 'de' as const, translationLanguage: 'en' as const };

  it('leaves a pair that does not collide alone', () => {
    expect(resolveLanguagePair(base, { translationLanguage: 'fr' }))
      .toEqual({ subtitleLanguage: 'de', translationLanguage: 'fr' });
  });

  it('interchanges the two when the target is set to the subtitle language', () => {
    expect(resolveLanguagePair(base, { translationLanguage: 'de' }))
      .toEqual({ subtitleLanguage: 'en', translationLanguage: 'de' });
  });

  it('interchanges the two when the subtitle language is set to the target', () => {
    expect(resolveLanguagePair(base, { subtitleLanguage: 'en' }))
      .toEqual({ subtitleLanguage: 'en', translationLanguage: 'de' });
  });

  it('treats auto as colliding with nothing', () => {
    expect(resolveLanguagePair(base, { subtitleLanguage: AUTO_LANGUAGE }))
      .toEqual({ subtitleLanguage: AUTO_LANGUAGE, translationLanguage: 'en' });
  });

  it('still returns a usable pair when both are set to the same language at once', () => {
    const result = resolveLanguagePair(base, { subtitleLanguage: 'fr', translationLanguage: 'fr' });
    expect(result.subtitleLanguage).toBe('fr');
    expect(result.translationLanguage).not.toBe('fr');
  });

  it('never returns a pair that translates a language into itself', () => {
    const codes = ['de', 'en', 'es', 'fr', 'ja'] as const;
    for (const from of codes) {
      for (const to of codes) {
        const result = resolveLanguagePair(base, { subtitleLanguage: from, translationLanguage: to });
        expect(result.subtitleLanguage).not.toBe(result.translationLanguage);
      }
    }
  });
});

describe('effectiveLanguage', () => {
  it('trusts what the cue declared', () => {
    expect(effectiveLanguage('fr', 'de')).toBe('fr');
  });

  it('reduces a regional tag to the language', () => {
    expect(effectiveLanguage('pt-BR', AUTO_LANGUAGE)).toBe('pt');
  });

  it('falls back to the setting when nothing is declared', () => {
    expect(effectiveLanguage(undefined, 'de')).toBe('de');
  });

  it('never hands the literal "auto" to a provider', () => {
    expect(effectiveLanguage(undefined, AUTO_LANGUAGE)).toBeUndefined();
  });

  it('detects from the text when the setting is auto and nothing was declared', () => {
    expect(effectiveLanguage(undefined, AUTO_LANGUAGE, 'Ich weiß nicht, ob das gut ist.')).toBe('de');
  });

  it('ignores a declared language it does not recognise', () => {
    expect(effectiveLanguage('xx', 'de')).toBe('de');
  });
});
