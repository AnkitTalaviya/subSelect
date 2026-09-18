import { LINGVA_ORIGIN, MYMEMORY_ORIGIN } from './translation/providers';
import { FREE_DICTIONARY_ORIGIN } from './dictionary/providers';

/**
 * Everything the out-of-the-box configuration can contact.
 *
 * Requested once, together, when the user accepts the terms on first run — rather than
 * one interruption per service the first time each is reached for. All are free, keyless,
 * and documented; see README for what each one is.
 *
 * `*.wiktionary.org` covers every language edition, because pronunciation recordings and
 * definitions both live on the edition matching the word's language.
 */
export const DEFAULT_PROVIDER_ORIGINS = [
  MYMEMORY_ORIGIN,
  LINGVA_ORIGIN,
  'https://*.wiktionary.org/*',
  FREE_DICTIONARY_ORIGIN,
] as const;

export function defaultOrigins(): string[] {
  return [...DEFAULT_PROVIDER_ORIGINS];
}
