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

    // The response is keyed by language code; fall back to whatever it does have rather
    // than reporting nothing when the language hint is missing or unexpected.
    const wantedName = language ? WIKTIONARY_LANGUAGE_NAMES[language.split('-')[0] ?? ''] : undefined;
    const entries = (language && payload[language.split('-')[0] ?? '']) ||
      Object.values(payload).flat();

    const senses: DictionarySense[] = [];
    for (const entry of entries) {
      if (wantedName && entry.language && entry.language !== wantedName) continue;

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

export function createDictionaryProvider(settings: Settings): DictionaryProvider | null {
  switch (settings.dictionaryProvider) {
    case 'wiktionary':
      return new WiktionaryProvider();
    case 'custom':
      return settings.dictionaryEndpoint ? new CustomDictionaryProvider(settings.dictionaryEndpoint) : null;
    case 'none':
    default:
      return null;
  }
}
