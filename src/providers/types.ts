/**
 * Provider contracts (§17, §18, §26, §27, §28, §29).
 *
 * Types only — implementations live beside this file and are selected by
 * `providers/registry.ts`. The selection engine never imports a provider directly, so it
 * cannot grow a dependency on one vendor.
 *
 * Two rules these interfaces encode:
 *
 *  - `context` is part of every request. A word from a subtitle means little on its own;
 *    the cue it came from is what makes a translation or definition useful (§15).
 *  - Every provider is optional and explicitly configured. Nothing is contacted by
 *    default, and no provider is ever called without the user asking for that action —
 *    doing so would send subtitle text off the device (§33).
 */

export interface ProviderMeta {
  id: string;
  label: string;
  /** True when the provider sends text to a third party — disclosed in the UI before use. */
  remote: boolean;
  /** Host the text would be sent to, for the disclosure string. Absent for local providers. */
  endpointHost?: string;
  /**
   * Match pattern for the permission this provider needs, e.g. `http://localhost:5000/*`.
   *
   * Carried explicitly rather than rebuilt from the host, because a self-hosted endpoint
   * is commonly plain `http` on a local port and assuming `https` would leave it
   * permanently unapprovable.
   */
  endpointOrigin?: string;
}

/** Why a provider call could not be completed. Each maps to a specific UI message. */
export type ProviderErrorKind =
  | 'not-configured'
  | 'unsupported'
  | 'no-permission'
  | 'network'
  | 'provider'
  | 'unavailable';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Origin the user would need to grant, for `no-permission`. */
    readonly origin?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Result envelope for provider calls crossing a runtime boundary. */
export type ProviderOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ProviderErrorKind; message: string; origin?: string };

export interface TranslationResult {
  text: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  /** Which provider produced this, so the UI can attribute it. */
  providerId: string;
}

export interface TranslationProvider {
  readonly meta: ProviderMeta;
  translate(
    text: string,
    sourceLanguage?: string,
    targetLanguage?: string,
    context?: string,
  ): Promise<TranslationResult>;
}

export interface DictionarySense {
  partOfSpeech?: string;
  definition: string;
  examples?: string[];
}

export interface DictionaryResult {
  headword: string;
  senses: DictionarySense[];
  /** German nouns: `der` / `die` / `das`. Other languages as applicable (§29). */
  gender?: string;
  plural?: string;
  /** Verb forms, e.g. `{ Präteritum: 'entschied', 'Partizip II': 'entschieden' }`. */
  inflections?: Record<string, string>;
  synonyms?: string[];
  antonyms?: string[];
  /** IPA, without slashes. */
  ipa?: string;
  providerId: string;
}

/**
 * Everything known about one selection, gathered from every source at once (§29, §65).
 *
 * One request, one panel. Translation and definition used to be separate menu actions,
 * which meant two clicks and two waits to learn what a word means — and for a German noun
 * neither of them told you the one thing you cannot use the word without: its article.
 * Every field is optional; the panel renders what was found and says nothing about the
 * rest.
 */
export interface WordDetails {
  headword: string;
  language?: string;
  translation?: { text: string; providerId: string };
  partOfSpeech?: string;
  /** `der` / `die` / `das`. */
  article?: string;
  gender?: string;
  plural?: string;
  inflections?: Record<string, string>;
  ipa?: string;
  senses?: DictionarySense[];
  synonyms?: string[];
  antonyms?: string[];
  /** Broader terms, e.g. Feuerwerk → Pyrotechnik. */
  hypernyms?: string[];
  /** Provider ids that contributed, so every panel says where it came from. */
  sources: string[];
  /** Reasons the missing parts are missing, for when nothing at all was found. */
  problems: string[];
}

export interface DictionaryProvider {
  readonly meta: ProviderMeta;
  lookup(text: string, language?: string): Promise<DictionaryResult>;
}

export interface AIExplanation {
  meaning?: string;
  grammar?: string;
  wordOrder?: string;
  examples?: string[];
  /** A1–C2 (§65). */
  cefrLevel?: string;
  synonyms?: string[];
  antonyms?: string[];
  providerId: string;
}

export interface AIProvider {
  readonly meta: ProviderMeta;
  explain(
    text: string,
    context: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<AIExplanation>;
}
