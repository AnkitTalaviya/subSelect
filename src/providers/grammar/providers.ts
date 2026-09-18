import { ProviderError } from '../types';
import { hasAnyGrammar, parseGermanWikitext, type GermanGrammar } from './wikitext';

/**
 * Grammar for a word, from the Wiktionary edition in its own language.
 *
 * German only for now, and deliberately so: the useful facts — `der/die/das`, the plural,
 * `Partizip II` — live in language-specific page templates, and inventing a generic
 * extractor that half-works everywhere would be worse than one that works properly for
 * the language the product is built around (§13). Other languages simply return nothing,
 * and the panel omits the section.
 */

const SUPPORTED = new Set(['de']);

export function supportsGrammar(language: string | undefined): boolean {
  return SUPPORTED.has((language ?? '').split('-')[0] ?? '');
}

export const GRAMMAR_HOST = 'de.wiktionary.org';
export const GRAMMAR_ORIGIN = 'https://de.wiktionary.org/*';

export const grammarMeta = {
  id: 'wiktionary-grammar',
  label: 'Wiktionary grammar',
  remote: true,
  endpointHost: GRAMMAR_HOST,
  endpointOrigin: GRAMMAR_ORIGIN,
};

export async function fetchGrammar(word: string, language?: string): Promise<GermanGrammar> {
  if (!supportsGrammar(language)) {
    throw new ProviderError('unsupported', 'Grammar details are only available for German so far.');
  }

  const headword = word.trim();
  if (!headword || /\s/.test(headword)) {
    throw new ProviderError('unsupported', 'Grammar details apply to single words.');
  }

  const url =
    `https://${GRAMMAR_HOST}/w/api.php?action=parse&format=json&formatversion=2` +
    `&prop=wikitext&redirects=1&page=${encodeURIComponent(headword)}&origin=*`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ProviderError('network', `Could not reach ${GRAMMAR_HOST}.`, GRAMMAR_ORIGIN);
  }
  if (!response.ok) throw new ProviderError('provider', `${GRAMMAR_HOST} returned ${response.status}.`);

  const payload = (await response.json().catch(() => null)) as
    | { parse?: { wikitext?: string }; error?: { info?: string } }
    | null;

  const wikitext = payload?.parse?.wikitext;
  if (typeof wikitext !== 'string') {
    throw new ProviderError('provider', payload?.error?.info || `No Wiktionary page for "${headword}".`);
  }

  const grammar = parseGermanWikitext(wikitext);
  if (!hasAnyGrammar(grammar)) {
    throw new ProviderError('provider', `No grammar details for "${headword}".`);
  }
  return grammar;
}
