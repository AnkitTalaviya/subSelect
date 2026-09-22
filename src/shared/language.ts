import { SUPPORTED_LANGUAGES, type LanguageCode } from './constants';

/**
 * Working out what language a subtitle is in, and keeping the two language settings apart.
 *
 * Detection is deliberately shallow. A subtitle line is a handful of words, so anything
 * claiming to be a real language classifier would be pretending: the honest approach is to
 * use the two signals that are genuinely decisive at this length — the writing system, and
 * a small set of very common function words — and to say nothing when neither is convincing
 * (§25). Saying nothing is safe, because the declared language and the user's own setting
 * are both better answers than a guess.
 */

/** `subtitleLanguage` may also be "detect it from the captions". */
export const AUTO_LANGUAGE = 'auto';
export type SubtitleLanguage = LanguageCode | typeof AUTO_LANGUAGE;

const CODES = new Set<string>(SUPPORTED_LANGUAGES.map((language) => language.code));

export function isLanguageCode(value: string): value is LanguageCode {
  return CODES.has(value);
}

/**
 * Scripts that settle the question by themselves.
 *
 * Kana decides Japanese even in a sentence that is mostly Han characters, which is why it
 * is tested before Han; Han on its own is read as Chinese. Hangul and Cyrillic have no such
 * ambiguity among the languages offered.
 */
const SCRIPTS: ReadonlyArray<{ code: LanguageCode; pattern: RegExp }> = [
  { code: 'ko', pattern: /[가-힯ᄀ-ᇿ]/ },
  { code: 'ja', pattern: /[぀-ゟ゠-ヿ]/ },
  { code: 'zh', pattern: /[一-鿿]/ },
  { code: 'ru', pattern: /[Ѐ-ӿ]/ },
];

/**
 * Letters that only one of the Latin-script languages uses, or uses far more than the rest.
 *
 * These carry more weight than any single word, because a word like "de" belongs to four of
 * these languages while "ß" belongs to exactly one.
 */
const MARKERS: ReadonlyArray<{ code: LanguageCode; pattern: RegExp; weight: number }> = [
  { code: 'de', pattern: /[ß]/, weight: 6 },
  { code: 'es', pattern: /[ñ¿¡]/, weight: 6 },
  { code: 'pt', pattern: /[ãõ]/, weight: 6 },
  { code: 'pl', pattern: /[ąćęłńśźż]/, weight: 6 },
  { code: 'tr', pattern: /[ğışİ]/, weight: 6 },
  { code: 'fr', pattern: /[çœù]/, weight: 4 },
  { code: 'it', pattern: /[àèìòù]/, weight: 2 },
  { code: 'de', pattern: /[äöü]/, weight: 2 },
];

/**
 * Function words, which are the most frequent words in any text and therefore the ones most
 * likely to appear in a single line of dialogue.
 *
 * Words shared with another language on the list are omitted rather than included and
 * discounted — "de" is Spanish, French, Portuguese and Dutch at once, so counting it helps
 * nobody. What is left is small on purpose.
 */
const STOPWORDS: Readonly<Record<LanguageCode, readonly string[]>> = {
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'mit', 'auf', 'ein', 'eine', 'wir', 'aber', 'noch', 'schon', 'auch', 'wenn'],
  en: ['the', 'and', 'is', 'that', 'you', 'for', 'with', 'this', 'have', 'what', 'was', 'are', 'they', 'just', 'know'],
  es: ['que', 'los', 'las', 'una', 'por', 'con', 'para', 'pero', 'como', 'todo', 'esta', 'muy', 'está', 'sí'],
  fr: ['les', 'des', 'est', 'une', 'pas', 'vous', 'pour', 'dans', 'qui', 'mais', 'avec', 'tout', 'je', 'nous'],
  it: ['che', 'non', 'per', 'una', 'sono', 'con', 'come', 'questo', 'anche', 'più', 'ma', 'gli', 'della'],
  pt: ['não', 'uma', 'com', 'para', 'você', 'mas', 'como', 'isso', 'está', 'mais', 'por', 'dos'],
  nl: ['het', 'een', 'niet', 'van', 'ik', 'je', 'dat', 'zijn', 'maar', 'ook', 'naar', 'wat', 'nog'],
  pl: ['nie', 'jest', 'się', 'że', 'to', 'na', 'jak', 'tak', 'czy', 'tylko', 'ale', 'już'],
  tr: ['bir', 've', 'bu', 'için', 'değil', 'ben', 'çok', 'ama', 'daha', 'ne', 'var', 'gibi'],
  ru: ['что', 'это', 'как', 'все', 'она', 'мне', 'так', 'его', 'вы', 'мы'],
  ja: [],
  ko: [],
  zh: [],
};

/** Enough evidence to be worth acting on. Below this the answer is "I do not know". */
const MIN_SCORE = 3;

export interface LanguageGuessResult {
  code: LanguageCode;
  score: number;
}

/**
 * Best guess at the language of some caption text, or null when nothing is convincing.
 *
 * Pure, so the popup, the content script and the service worker can all reach the same
 * conclusion about the same text without passing a verdict between them.
 */
export function detectLanguageFromText(text: string): LanguageGuessResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // A writing system is decisive on its own, and is reliable from a single short line.
  for (const { code, pattern } of SCRIPTS) {
    if (pattern.test(trimmed)) return { code, score: 100 };
  }

  const lower = trimmed.toLowerCase();
  const scores = new Map<LanguageCode, number>();
  const add = (code: LanguageCode, amount: number): void => {
    scores.set(code, (scores.get(code) ?? 0) + amount);
  };

  for (const { code, pattern, weight } of MARKERS) {
    if (pattern.test(lower)) add(code, weight);
  }

  const words = lower.split(/[^\p{L}'’]+/u).filter(Boolean);
  for (const [code, list] of Object.entries(STOPWORDS) as [LanguageCode, readonly string[]][]) {
    for (const word of words) {
      if (list.includes(word)) add(code, 2);
    }
  }

  let best: LanguageGuessResult | null = null;
  let runnerUp = 0;
  for (const [code, score] of scores) {
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { code, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  // A tie is not an answer. Two languages scoring the same means the evidence was the kind
  // they share, and picking the one that happened to come first would be arbitrary.
  if (!best || best.score < MIN_SCORE || best.score === runnerUp) return null;
  return best;
}

/**
 * Accumulates evidence across several captions.
 *
 * One line is often too short to be sure, and a wrong answer that sticks is worse than a
 * late one. Text is collected until the guess is either decisive on script or has been
 * reached twice, and the verdict is then held so the reported language does not flicker
 * from line to line while somebody is reading.
 */
export class LanguageGuess {
  private buffer = '';
  private settled: LanguageCode | null = null;
  private pending: LanguageCode | null = null;
  private lastText = '';

  /** Feeds one caption in. Cheap enough to call on every cue. */
  observe(text: string): void {
    const trimmed = text.trim();

    /*
     * The same caption arrives many times over — the adapter re-reads it on every mutation
     * the player makes while it is on screen. Counting those repeats would let a single
     * line agree with itself and settle the language, which is exactly what "two agreeing
     * lines" is meant to prevent.
     */
    if (!trimmed || trimmed === this.lastText) return;
    this.lastText = trimmed;

    /*
     * The line on its own is consulted first, and the pool only when it has nothing to say.
     *
     * Pooling alone cannot change its mind: a decisive script stays in the buffer and keeps
     * winning, so a film that opened in Korean would still read as Korean after the viewer
     * switched to the English subtitles. Reading the newest line by itself is what notices
     * that the language has moved on.
     */
    const line = detectLanguageFromText(text);

    // Bounded: this is evidence, not a transcript, and nothing here is ever stored (§32).
    this.buffer = `${this.buffer} ${text}`.slice(-400);

    const guess = line ?? detectLanguageFromText(this.buffer);
    if (!guess) return;

    // Agrees with the standing verdict: nothing to do, and any doubt is dropped.
    if (guess.code === this.settled) {
      this.pending = null;
      return;
    }

    // A writing system settles it outright, but only from a standing start. Changing a
    // verdict always takes two, so one stray line cannot flip the language mid-scene.
    if (guess.score >= 100 && !this.settled) {
      this.settled = guess.code;
      this.pending = null;
      return;
    }

    if (this.pending === guess.code) {
      this.settled = guess.code;
      this.pending = null;
      return;
    }

    /*
     * A new candidate starts its own case. The buffer is cleared so the evidence for it is
     * gathered fresh rather than competing with several lines of the language it would be
     * replacing — which is what lets a viewer switch subtitle track mid-film and be
     * followed, instead of being stuck with whatever the first scene happened to be in.
     */
    this.pending = guess.code;
    this.buffer = text.slice(-400);
  }

  /** The language decided on, or null while the evidence is still thin. */
  get(): LanguageCode | null {
    return this.settled;
  }

  reset(): void {
    this.buffer = '';
    this.settled = null;
    this.pending = null;
    this.lastText = '';
  }
}

/**
 * Keeps the two language settings from naming the same language.
 *
 * Translating German into German is not a thing anybody wants, and refusing the change
 * would leave the user stuck with a control that appears not to work. Swapping is what they
 * almost certainly meant: choosing "German" as the target when German is the subtitle
 * language reads as "turn it round the other way".
 *
 * `auto` never collides, because it does not name a language yet.
 */
export function resolveLanguagePair(
  current: { subtitleLanguage: SubtitleLanguage; translationLanguage: LanguageCode },
  patch: { subtitleLanguage?: SubtitleLanguage; translationLanguage?: LanguageCode },
): { subtitleLanguage: SubtitleLanguage; translationLanguage: LanguageCode } {
  const next = {
    subtitleLanguage: patch.subtitleLanguage ?? current.subtitleLanguage,
    translationLanguage: patch.translationLanguage ?? current.translationLanguage,
  };

  if (next.subtitleLanguage !== next.translationLanguage) return next;

  // Both named in one go and identical: there is no previous value to swap in for the field
  // the user did not touch, so the target falls back to the language being displaced.
  if (patch.subtitleLanguage !== undefined && patch.translationLanguage !== undefined) {
    const fallback = current.subtitleLanguage === next.subtitleLanguage
      ? current.translationLanguage
      : current.subtitleLanguage;
    return {
      subtitleLanguage: next.subtitleLanguage,
      translationLanguage: fallback !== next.subtitleLanguage && fallback !== AUTO_LANGUAGE
        ? fallback
        : firstOtherLanguage(next.subtitleLanguage),
    };
  }

  // One was changed, so the other takes the value the changed one just gave up.
  if (patch.translationLanguage !== undefined) {
    const displaced = current.subtitleLanguage;
    return {
      subtitleLanguage: displaced === next.translationLanguage
        ? firstOtherLanguage(next.translationLanguage)
        : displaced,
      translationLanguage: next.translationLanguage,
    };
  }

  const displaced = current.translationLanguage;
  return {
    subtitleLanguage: next.subtitleLanguage,
    translationLanguage: displaced === next.subtitleLanguage
      ? firstOtherLanguage(next.subtitleLanguage)
      : displaced,
  };
}

/** A sane partner for `code`, for the corner where there is nothing to swap in. */
function firstOtherLanguage(code: SubtitleLanguage): LanguageCode {
  return (SUPPORTED_LANGUAGES.find((language) => language.code !== code)?.code ?? 'en') as LanguageCode;
}

/**
 * The language a lookup should actually use: what the cue declared, else what was detected
 * from the text, else the user's setting — and never the literal string "auto", which no
 * dictionary or translator can do anything with.
 */
export function effectiveLanguage(
  declared: string | undefined,
  setting: SubtitleLanguage,
  text?: string,
): LanguageCode | undefined {
  if (declared) {
    const base = declared.split('-')[0]?.toLowerCase() ?? '';
    if (isLanguageCode(base)) return base;
  }
  if (setting !== AUTO_LANGUAGE) return setting;
  if (text) return detectLanguageFromText(text)?.code;
  return undefined;
}
