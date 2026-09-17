import type { SavedWord } from '@shared/types';

/**
 * Local export (§22).
 *
 * Both formats are produced in the page from data already in `chrome.storage.local`.
 * Nothing is uploaded, and no service is contacted to generate a file.
 */

export type ExportFormat = 'csv' | 'json';

const CSV_COLUMNS = ['word', 'translation', 'context', 'language'] as const;

/**
 * Escapes one CSV field.
 *
 * Quotes anything containing a delimiter, quote or newline, and doubles interior quotes,
 * per RFC 4180. Subtitle text routinely contains commas and quotation marks, so this is
 * load-bearing rather than defensive.
 *
 * The leading apostrophe guards against CSV injection: a field starting `=`, `+`, `-` or
 * `@` is executed as a formula by spreadsheet software, and subtitle text is not something
 * we control.
 */
export function toCsvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(words: readonly SavedWord[]): string {
  const rows = words.map((word) =>
    [word.word, word.translation ?? '', word.context, word.sourceLanguage ?? '']
      .map(toCsvField)
      .join(','),
  );
  // CRLF and a trailing newline: what spreadsheet software expects of a .csv.
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

export function toJson(words: readonly SavedWord[]): string {
  return `${JSON.stringify(
    words.map((word) => ({
      word: word.word,
      normalizedWord: word.normalizedWord,
      translation: word.translation,
      context: word.context,
      sourceLanguage: word.sourceLanguage,
      targetLanguage: word.targetLanguage,
      website: word.website,
      createdAt: new Date(word.createdAt).toISOString(),
    })),
    null,
    2,
  )}\n`;
}

export function exportFilename(format: ExportFormat, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `subselect-vocabulary-${stamp}.${format}`;
}

export function serialize(words: readonly SavedWord[], format: ExportFormat): string {
  return format === 'csv' ? toCsv(words) : toJson(words);
}
