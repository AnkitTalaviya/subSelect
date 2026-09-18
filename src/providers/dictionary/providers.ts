import type { Settings } from '@shared/settings';
import {
  ProviderError,
  type DictionaryProvider,
  type DictionaryResult,
  type DictionarySense,
} from '../types';
import { hostOf, originOf, stripHtml } from '../url';

/**
 * Dictionary providers (§18).
 *
 * §18 is explicit that dictionary information must never be invented. So there is no
 * built-in word list and no heuristic fallback: either a provider returns definitions, or
 * the UI says lookup is not configured. A plausible-looking guess would be worse than
 * nothing for someone learning the language.
 */

/** Wiktionary's REST definition endpoint, keyed by the language the *word* is in. */
const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
export const WIKTIONARY_ORIGIN = 'https://en.wiktionary.org/*';

/** Wiktionary groups definitions by language name, not by code. */
const WIKTIONARY_LANGUAGE_NAMES: Record<string, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

interface WiktionaryDefinition {
  definition?: string;
  examples?: string[];
}

interface WiktionaryEntry {
  partOfSpeech?: string;
  language?: string;
  definitions?: WiktionaryDefinition[];
}

class WiktionaryProvider implements DictionaryProvider {
  readonly meta = {
    id: 'wiktionary',
    label: 'Wiktionary',
    remote: true,
    endpointHost: 'en.wiktionary.org',
    endpointOrigin: WIKTIONARY_ORIGIN,
  };

  async lookup(text: string, language?: string): Promise<DictionaryResult> {
    const headword = text.trim();
    if (!headword) throw new ProviderError('provider', 'Nothing to look up.');

    const url = `${WIKTIONARY_ENDPOINT}${encodeURIComponent(headword)}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError('network', 'Could not reach en.wiktionary.org.', originOf(url));
    }

    if (response.status === 404) {
      throw new ProviderError('provider', `Wiktionary has no entry for "${headword}".`);
    }
    if (!response.ok) {
      throw new ProviderError('provider', `Wiktionary returned ${response.status}.`);
    }

    let payload: Record<string, WiktionaryEntry[]>;
    try {
      payload = (await response.json()) as Record<string, WiktionaryEntry[]>;
    } catch {
      throw new ProviderError('provider', 'Wiktionary returned an unreadable response.');
    }

    /*
     * The response is keyed by language code. Prefer the requested language, but never
     * return nothing just because that key is absent: an entry under another key is far
     * more useful than "no entry", and the language hint is a guess often enough that
     * insisting on it produced misses for perfectly ordinary words.
     */
    const code = language ? (language.split('-')[0] ?? '') : '';
    const preferred = code ? (payload[code] ?? []) : [];
    const entries = preferred.length > 0 ? preferred : Object.values(payload).flat();
    const wantedName = code ? WIKTIONARY_LANGUAGE_NAMES[code] : undefined;
    // Only filter by language name when that is what we actually matched on.
    const filterByName = preferred.length > 0 ? wantedName : undefined;

    const senses: DictionarySense[] = [];
    for (const entry of entries) {
      if (filterByName && entry.language && entry.language !== filterByName) continue;

      for (const definition of entry.definitions ?? []) {
        const text = stripHtml(definition.definition ?? '');
        if (!text) continue;

        const sense: DictionarySense = { definition: text };
        if (entry.partOfSpeech) sense.partOfSpeech = entry.partOfSpeech;

        const examples = (definition.examples ?? []).map(stripHtml).filter(Boolean);
        if (examples.length > 0) sense.examples = examples.slice(0, 2);

        senses.push(sense);
        if (senses.length >= 6) break;
      }
      if (senses.length >= 6) break;
    }

    if (senses.length === 0) {
      throw new ProviderError(
        'provider',
        language
          ? `Wiktionary has no ${WIKTIONARY_LANGUAGE_NAMES[language.split('-')[0] ?? ''] ?? language} entry for "${headword}".`
          : `Wiktionary has no entry for "${headword}".`,
      );
    }

    return { headword, senses, providerId: this.meta.id };
  }
}

/**
 * The Free Dictionary API — the open-source project behind dictionaryapi.dev
 * (MIT, github.com/meetDeveloper/freeDictionaryAPI). No key, no signup.
 *
 * Richer than Wiktionary for the languages it covers: definitions carry a part of speech,
 * examples, synonyms and often a pronunciation recording. It covers fewer languages,
 * which is why Wiktionary remains the default for German.
 */
const FREE_DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/';
export const FREE_DICTIONARY_ORIGIN = 'https://api.dictionaryapi.dev/*';

interface FreeDictionaryEntry {
  word?: string;
  phonetic?: string;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{ definition?: string; example?: string }>;
    synonyms?: string[];
    antonyms?: string[];
  }>;
}

class FreeDictionaryProvider implements DictionaryProvider {
  readonly meta = {
    id: 'free-dictionary',
    label: 'Free Dictionary API',
    remote: true,
    endpointHost: 'api.dictionaryapi.dev',
    endpointOrigin: FREE_DICTIONARY_ORIGIN,
  };

  async lookup(text: string, language?: string): Promise<DictionaryResult> {
    const headword = text.trim();
    if (!headword) throw new ProviderError('provider', 'Nothing to look up.');

    const code = (language ?? 'en').split('-')[0] ?? 'en';
    const url = `${FREE_DICTIONARY_ENDPOINT}${encodeURIComponent(code)}/${encodeURIComponent(headword)}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError('network', 'Could not reach api.dictionaryapi.dev.', FREE_DICTIONARY_ORIGIN);
    }

    if (response.status === 404) {
      throw new ProviderError('provider', `No entry for "${headword}" in this dictionary.`);
    }
    if (!response.ok) {
      throw new ProviderError('provider', `The dictionary returned ${response.status}.`);
    }

    const payload = (await response.json().catch(() => null)) as FreeDictionaryEntry[] | null;
    if (!Array.isArray(payload)) {
      throw new ProviderError('provider', 'The dictionary returned an unreadable response.');
    }

    const senses: DictionarySense[] = [];
    const synonyms = new Set<string>();
    const antonyms = new Set<string>();
    let ipa: string | undefined;

    for (const entry of payload) {
      if (!ipa && entry.phonetic) ipa = entry.phonetic.replace(/^\/|\/$/g, '');
      for (const meaning of entry.meanings ?? []) {
        for (const word of meaning.synonyms ?? []) synonyms.add(word);
        for (const word of meaning.antonyms ?? []) antonyms.add(word);

        for (const definition of meaning.definitions ?? []) {
          if (!definition.definition) continue;
          const sense: DictionarySense = { definition: definition.definition };
          if (meaning.partOfSpeech) sense.partOfSpeech = meaning.partOfSpeech;
          if (definition.example) sense.examples = [definition.example];
          if (senses.length < 6) senses.push(sense);
        }
      }
    }

    if (senses.length === 0) {
      throw new ProviderError('provider', `No definitions for "${headword}".`);
    }

    return {
      headword,
      senses,
      ...(synonyms.size > 0 ? { synonyms: [...synonyms].slice(0, 8) } : {}),
      ...(antonyms.size > 0 ? { antonyms: [...antonyms].slice(0, 8) } : {}),
      ...(ipa ? { ipa } : {}),
      providerId: this.meta.id,
    };
  }
}

/**
 * A user-supplied endpoint:
 *
 *   GET   <endpoint>?word=<word>&language=<code>
 *   →     { "senses": [ { "definition": "...", "partOfSpeech": "...", "examples": [...] } ] }
 */
class CustomDictionaryProvider implements DictionaryProvider {
  readonly meta: DictionaryProvider['meta'];

  constructor(private readonly endpoint: string) {
    this.meta = {
      id: 'custom',
      label: 'Custom endpoint',
      remote: true,
      ...(hostOf(endpoint) ? { endpointHost: hostOf(endpoint) } : {}),
      ...(originOf(endpoint) ? { endpointOrigin: originOf(endpoint) } : {}),
    };
  }

  async lookup(text: string, language?: string): Promise<DictionaryResult> {
    const url = new URL(this.endpoint);
    url.searchParams.set('word', text);
    if (language) url.searchParams.set('language', language);

    let response: Response;
    try {
      response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError(
        'network',
        `Could not reach ${hostOf(this.endpoint) ?? 'the dictionary service'}.`,
        originOf(this.endpoint),
      );
    }

    if (!response.ok) throw new ProviderError('provider', `The dictionary returned ${response.status}.`);

    const payload = (await response.json().catch(() => null)) as { senses?: DictionarySense[] } | null;
    const senses = payload?.senses;
    if (!Array.isArray(senses) || senses.length === 0) {
      throw new ProviderError('provider', 'The custom endpoint returned no senses.');
    }

    return { headword: text, senses: senses.slice(0, 6), providerId: this.meta.id };
  }
}

/**
 * Dictionary providers to try, in order.
 *
 * Wiktionary first — it has by far the best coverage of German, and its entries for a word
 * in one language are written in the language of the edition, so `en.wiktionary.org` gives
 * English glosses for German words, which is what a learner wants. The Free Dictionary API
 * follows for the languages it covers. Still no invented definitions anywhere (§18): if
 * none of them has the word, the UI says so.
 */
export function createDictionaryChain(settings: Settings): DictionaryProvider[] {
  if (settings.dictionaryProvider !== 'auto') {
    const single = createDictionaryProvider(settings);
    return single ? [single] : [];
  }
  return [new WiktionaryProvider(), new FreeDictionaryProvider()];
}

export function createDictionaryProvider(settings: Settings): DictionaryProvider | null {
  switch (settings.dictionaryProvider) {
    case 'wiktionary':
      return new WiktionaryProvider();
    case 'free-dictionary':
      return new FreeDictionaryProvider();
    case 'custom':
      return settings.dictionaryEndpoint ? new CustomDictionaryProvider(settings.dictionaryEndpoint) : null;
    case 'none':
    default:
      return null;
  }
}
