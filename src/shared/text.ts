/**
 * Language-neutral text helpers (§13, §40).
 *
 * Two rules govern everything here:
 *  - Never mutate the source text's length or offsets. Word offsets index into the cue
 *    text, so NFC normalisation happens only on derived lookup values, never in place.
 *  - Never uppercase. `ß`.toUpperCase() is `SS`, which silently corrupts German.
 */

/** Unicode punctuation or symbol, the characters we strip from a word's edges. */
const EDGE_PUNCTUATION = /[\p{P}\p{S}]/u;

/** Characters that join two word parts rather than separating them. */
const INNER_JOINERS = new Set([
  "'", // apostrophe
  '’', // right single quote, the typographic apostrophe
  'ʼ', // modifier letter apostrophe
  '-', // hyphen-minus
  '‐', // hyphen
  '‑', // non-breaking hyphen
  '­', // soft hyphen
]);

export function isEdgePunctuation(char: string): boolean {
  return EDGE_PUNCTUATION.test(char);
}

export function isInnerJoiner(char: string): boolean {
  return INNER_JOINERS.has(char);
}

/** True when the string contains at least one letter or digit. */
export function hasWordCharacter(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Strips punctuation from both ends while preserving word-internal apostrophes and
 * hyphens, so `„Hallo,` → `Hallo` and `geht's?` → `geht's` but `Kfz-Versicherung` and
 * `Arbeitslosenversicherung` come back untouched.
 *
 * Returns the input unchanged when it contains no letters or digits, so a standalone
 * `—` or `...` still has something to display.
 */
export function normalizeWord(input: string): string {
  const text = input.trim();
  if (!text || !hasWordCharacter(text)) return text;

  let start = 0;
  let end = text.length;

  while (start < end && isEdgePunctuation(text[start]!)) start++;
  while (end > start && isEdgePunctuation(text[end - 1]!)) end--;

  return text.slice(start, end).normalize('NFC');
}

/**
 * Case-folded key for dictionary and vocabulary lookups.
 *
 * Locale-aware lowercasing matters: Turkish dotted/dotless `I` maps differently, and
 * lowercasing (unlike uppercasing) leaves `ß` intact.
 */
export function toLookupKey(input: string, language?: string): string {
  const normalized = normalizeWord(input);
  try {
    return language ? normalized.toLocaleLowerCase(language) : normalized.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

/**
 * Collapses the whitespace a player's caption markup leaves behind — non-breaking
 * spaces, zero-width characters, runs of spaces — without touching line structure.
 */
export function cleanCueText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Small, stable, non-cryptographic hash. Used to tell cues apart cheaply. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

let idCounter = 0;
/** Monotonic id, unique within one content-script instance. */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}
