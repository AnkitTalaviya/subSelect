import { ProviderError } from '../types';

/**
 * Pronunciation from Wikimedia (§28).
 *
 * Speech synthesis is a robot reading a word. Wiktionary and **Lingua Libre** — the
 * Wikimedia project that records native speakers — hold hundreds of thousands of real
 * human recordings, freely licensed. For a language learner that is a categorically
 * better answer, especially for German vowel length and final devoicing, which TTS
 * frequently gets wrong.
 *
 * One request does the whole job. The Wiktionary action API can generate the media files
 * used on a page and return their URLs together:
 *
 *   /w/api.php?action=query&titles=<word>&generator=images&prop=imageinfo&iiprop=url
 *
 * Recordings follow community naming conventions — `De-Berlin.ogg` on German Wiktionary,
 * `LL-Q188 (deu)-Speaker-Berlin.wav` from Lingua Libre — so candidates are ranked by how
 * well the filename matches the word and language rather than taking whatever comes first.
 */

/** Wiktionary editions that hold pronunciation recordings for a language. */
const WIKTIONARY_HOSTS: Record<string, string> = {
  de: 'de.wiktionary.org',
  en: 'en.wiktionary.org',
  es: 'es.wiktionary.org',
  fr: 'fr.wiktionary.org',
  it: 'it.wiktionary.org',
  pt: 'pt.wiktionary.org',
  nl: 'nl.wiktionary.org',
  pl: 'pl.wiktionary.org',
  tr: 'tr.wiktionary.org',
  ru: 'ru.wiktionary.org',
  ja: 'ja.wiktionary.org',
  ko: 'ko.wiktionary.org',
  zh: 'zh.wiktionary.org',
};

/** ISO 639-3 codes Lingua Libre uses in its filenames, for the languages we list. */
const LINGUA_LIBRE_CODES: Record<string, string> = {
  de: 'deu',
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  it: 'ita',
  pt: 'por',
  nl: 'nld',
  pl: 'pol',
  tr: 'tur',
  ru: 'rus',
  ja: 'jpn',
  ko: 'kor',
  zh: 'cmn',
};

const AUDIO_EXTENSIONS = /\.(ogg|oga|opus|mp3|wav|flac)$/i;

export const WIKIMEDIA_ORIGINS = ['https://*.wiktionary.org/*'];

export interface PronunciationResult {
  url: string;
  /** Filename, so the UI can credit the recording. */
  title: string;
  providerId: string;
}

export function wiktionaryHostFor(language: string | undefined): string {
  const code = (language ?? 'en').split('-')[0] ?? 'en';
  return WIKTIONARY_HOSTS[code] ?? 'en.wiktionary.org';
}

interface MediaPage {
  title?: string;
  imageinfo?: Array<{ url?: string }>;
}

/**
 * Ranks a candidate recording for a word.
 *
 * Returns -1 for files that are not this word's pronunciation at all — a page can also
 * carry maps, portraits and icons, and playing one of those would be worse than silence.
 */
export function scoreRecording(title: string, word: string, language: string | undefined): number {
  if (!AUDIO_EXTENSIONS.test(title)) return -1;

  const stem = title.replace(/^File:/i, '').replace(AUDIO_EXTENSIONS, '').toLowerCase();
  const target = word.toLowerCase();
  if (!stem.includes(target)) return -1;

  const code = (language ?? '').split('-')[0] ?? '';
  let score = 10;

  // `LL-Q188 (deu)-Speaker-word.wav` — a Lingua Libre recording by a native speaker.
  const lingua = LINGUA_LIBRE_CODES[code];
  if (lingua && stem.includes(`(${lingua})`)) score += 30;

  // `De-Berlin.ogg` — the long-standing Wiktionary convention.
  if (code && stem.startsWith(`${code}-`)) score += 25;

  /*
   * Only the last hyphen-separated segment is the word; everything before it is metadata
   * — language code, project id, speaker name. Judging closeness on the whole filename
   * would penalise Lingua Libre for embedding a speaker name, which is exactly backwards:
   * those are the best recordings we can find.
   */
  const spoken = stem.split('-').pop() ?? stem;
  if (spoken === target) score += 20;
  else score -= Math.min(10, Math.max(0, spoken.length - target.length) / 2);

  return score;
}

export async function findPronunciation(
  word: string,
  language?: string,
): Promise<PronunciationResult> {
  const headword = word.trim();
  if (!headword) throw new ProviderError('provider', 'Nothing to pronounce.');
  // Recordings exist for single words, not for whole phrases.
  if (/\s/.test(headword)) {
    throw new ProviderError('unsupported', 'Recordings are only available for single words.');
  }

  const host = wiktionaryHostFor(language);
  const url =
    `https://${host}/w/api.php?action=query&format=json&formatversion=2` +
    `&titles=${encodeURIComponent(headword)}` +
    `&generator=images&gimlimit=50&prop=imageinfo&iiprop=url&origin=*`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ProviderError('network', `Could not reach ${host}.`, `https://${host}/*`);
  }

  if (!response.ok) {
    throw new ProviderError('provider', `${host} returned ${response.status}.`);
  }

  const payload = (await response.json().catch(() => null)) as
    | { query?: { pages?: MediaPage[] } }
    | null;

  const pages = payload?.query?.pages ?? [];
  let best: PronunciationResult | null = null;
  let bestScore = 0;

  for (const page of pages) {
    const title = page.title ?? '';
    const mediaUrl = page.imageinfo?.[0]?.url;
    if (!mediaUrl) continue;

    const score = scoreRecording(title, headword, language);
    if (score > bestScore) {
      bestScore = score;
      best = { url: mediaUrl, title: title.replace(/^File:/i, ''), providerId: 'wikimedia' };
    }
  }

  if (!best) {
    throw new ProviderError('provider', `No recording of "${headword}" on ${host}.`);
  }

  return best;
}
