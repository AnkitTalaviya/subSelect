import type { SavedWord } from '@shared/types';
import { STORAGE_KEYS } from '@shared/constants';
import { log } from '@shared/logger';
import { normalizeWord, toLookupKey } from '@shared/text';

/**
 * The saved vocabulary list (§19, §20).
 *
 * Local only. `chrome.storage.local` is the whole storage story — there is no account, no
 * sync, no backend, and nothing here is ever transmitted. Export (§22) is the way words
 * leave the device, and the user has to ask for it.
 *
 * Kept as a single array under one key rather than a key per word: the list is small
 * (hundreds of entries), and one key means reads, writes and export are each one
 * operation with no chance of a partially-written list.
 */

export interface SaveWordInput {
  word: string;
  context: string;
  translation?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  website?: string;
}

function makeId(): string {
  // crypto.randomUUID is available in every context this runs in; the fallback exists
  // because a saved word must never be lost to a missing API.
  try {
    return crypto.randomUUID();
  } catch {
    return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export async function getVocabulary(): Promise<SavedWord[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.vocabulary);
    const list = stored[STORAGE_KEYS.vocabulary];
    return Array.isArray(list) ? (list as SavedWord[]) : [];
  } catch (error) {
    log.warn('vocabulary read failed', error);
    return [];
  }
}

async function write(words: SavedWord[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.vocabulary]: words });
}

export async function getVocabularyCount(): Promise<number> {
  return (await getVocabulary()).length;
}

/**
 * Saves a word, or updates the existing entry for it.
 *
 * Deduplicated on the normalized form plus the source language, so clicking `Berlin.` and
 * `Berlin` twice does not produce two entries. A later save fills in a translation the
 * first one lacked, but never erases one that is already there.
 */
export async function saveWord(input: SaveWordInput): Promise<SavedWord> {
  const words = await getVocabulary();

  const normalizedWord = normalizeWord(input.word);
  const key = toLookupKey(input.word, input.sourceLanguage);
  const existing = words.find(
    (word) =>
      toLookupKey(word.normalizedWord, word.sourceLanguage) === key &&
      (word.sourceLanguage ?? '') === (input.sourceLanguage ?? ''),
  );

  if (existing) {
    if (input.translation) existing.translation = input.translation;
    if (!existing.context && input.context) existing.context = input.context;
    await write(words);
    return existing;
  }

  const saved: SavedWord = {
    id: makeId(),
    word: input.word,
    normalizedWord,
    context: input.context,
    createdAt: Date.now(),
  };
  if (input.translation) saved.translation = input.translation;
  if (input.sourceLanguage) saved.sourceLanguage = input.sourceLanguage;
  if (input.targetLanguage) saved.targetLanguage = input.targetLanguage;
  if (input.website) saved.website = input.website;

  words.push(saved);
  await write(words);
  return saved;
}

export async function deleteWord(id: string): Promise<void> {
  const words = await getVocabulary();
  await write(words.filter((word) => word.id !== id));
}

export async function clearVocabulary(): Promise<void> {
  await write([]);
}

export type SortOrder = 'newest' | 'oldest' | 'alphabetical';

/** Search and sort, applied locally over the whole list. */
export function queryVocabulary(
  words: readonly SavedWord[],
  search: string,
  order: SortOrder,
): SavedWord[] {
  const needle = search.trim().toLowerCase();

  const filtered = needle
    ? words.filter((word) =>
        [word.word, word.normalizedWord, word.translation ?? '', word.context]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : [...words];

  switch (order) {
    case 'oldest':
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    case 'alphabetical':
      return filtered.sort((a, b) =>
        a.normalizedWord.localeCompare(b.normalizedWord, a.sourceLanguage || undefined),
      );
    case 'newest':
    default:
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }
}
