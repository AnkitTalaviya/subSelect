import { isInnerJoiner } from '@shared/text';

/**
 * Word tokenization (§12, §13, §40).
 *
 * Built on `Intl.Segmenter`, which implements Unicode UAX #29 word boundaries. Using the
 * platform segmenter rather than a regex is what makes the hard cases correct for free:
 *
 *  - German compounds (`Arbeitslosenversicherung`) contain no word boundary, so they are
 *    never split.
 *  - `'` and `’` are UAX #29 MidLetter, so `geht's` stays one word.
 *  - Umlauts and `ß` are ordinary letters; no special casing exists or is needed.
 *  - CJK and Thai segment correctly, which a whitespace splitter cannot do.
 *
 * Two things UAX #29 does not do for us, handled below:
 *  - hyphens are not MidLetter, so `Kfz-Versicherung` arrives in three pieces and is
 *    re-joined by `mergeJoinedWords`;
 *  - edge punctuation is its own segment, and is re-attached by `claimAdjacentPunctuation`
 *    so a token can carry `geht's?` for display while normalising to `geht's` for lookup.
 */

export interface RawToken {
  /** Exact slice of the input, including any attached edge punctuation. */
  text: string;
  start: number;
  /** Exclusive. */
  end: number;
  isWordLike: boolean;
}

interface Segment {
  text: string;
  start: number;
  end: number;
  isWordLike: boolean;
}

const segmenterCache = new Map<string, Intl.Segmenter | null>();

function getSegmenter(language?: string): Intl.Segmenter | null {
  const key = language ?? '';
  if (segmenterCache.has(key)) return segmenterCache.get(key) ?? null;

  let segmenter: Intl.Segmenter | null = null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      segmenter = language
        ? new Intl.Segmenter(language, { granularity: 'word' })
        : new Intl.Segmenter(undefined, { granularity: 'word' });
    }
  } catch {
    // An unusable locale tag is not worth failing over; fall back to the default locale.
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      segmenter = null;
    }
  }

  segmenterCache.set(key, segmenter);
  return segmenter;
}

/** Regex fallback for the (currently hypothetical) engine without Intl.Segmenter. */
const FALLBACK_WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’ʼ]*/gu;

function segmentFallback(input: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(FALLBACK_WORD)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push(...splitNonWord(input.slice(cursor, start), cursor));
    }
    segments.push({ text: match[0], start, end: start + match[0].length, isWordLike: true });
    cursor = start + match[0].length;
  }
  if (cursor < input.length) segments.push(...splitNonWord(input.slice(cursor), cursor));

  return segments;
}

/** Splits a non-word run into alternating whitespace and punctuation segments. */
function splitNonWord(text: string, offset: number): Segment[] {
  const segments: Segment[] = [];
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const start = offset + (match.index ?? 0);
    segments.push({ text: match[0], start, end: start + match[0].length, isWordLike: false });
  }
  return segments;
}

function segment(input: string, language?: string): Segment[] {
  const segmenter = getSegmenter(language);
  if (!segmenter) return segmentFallback(input);

  const segments: Segment[] = [];
  for (const item of segmenter.segment(input)) {
    segments.push({
      text: item.segment,
      start: item.index,
      end: item.index + item.segment.length,
      isWordLike: Boolean(item.isWordLike),
    });
  }
  return segments;
}

function isWhitespace(text: string): boolean {
  return /^\s+$/.test(text);
}

/** A non-word segment that is not whitespace: punctuation, symbols, emoji. */
function isPunctuation(seg: Segment): boolean {
  return !seg.isWordLike && !isWhitespace(seg.text);
}

function isJoinerSegment(seg: Segment): boolean {
  return seg.text.length === 1 && isInnerJoiner(seg.text);
}

/**
 * Re-joins `word + joiner + word` runs that UAX #29 split, so `Kfz-Versicherung` and
 * `Sehenswürdigkeiten-Tour` survive as one selectable word. Runs longer than one joiner
 * character (`--`, ` - `) are separators and are left alone.
 */
function mergeJoinedWords(source: string, segments: Segment[]): Segment[] {
  const merged: Segment[] = [];

  for (let i = 0; i < segments.length; i++) {
    let current = segments[i]!;

    while (
      current.isWordLike &&
      i + 2 < segments.length &&
      isJoinerSegment(segments[i + 1]!) &&
      segments[i + 2]!.isWordLike &&
      segments[i + 1]!.start === current.end &&
      segments[i + 2]!.start === segments[i + 1]!.end
    ) {
      const end = segments[i + 2]!.end;
      current = { text: source.slice(current.start, end), start: current.start, end, isWordLike: true };
      i += 2;
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Attaches edge punctuation to the word it belongs to.
 *
 * A punctuation run that touches a word on both sides (`Ja/Nein`) belongs to neither and
 * stays a separate, non-interactive token. That keeps `Ja` and `Nein` individually
 * clickable, and costs nothing for copying, which reads from offsets rather than from
 * re-joined token text.
 */
function claimAdjacentPunctuation(source: string, segments: Segment[]): RawToken[] {
  const claimed = new Array<boolean>(segments.length).fill(false);
  const bounds = segments.map((seg) => ({ start: seg.start, end: seg.end }));

  const touchesWordOnRight = (i: number): boolean =>
    i + 1 < segments.length && segments[i + 1]!.isWordLike && segments[i + 1]!.start === segments[i]!.end;

  const touchesWordOnLeft = (i: number): boolean =>
    i > 0 && segments[i - 1]!.isWordLike && segments[i - 1]!.end === segments[i]!.start;

  for (let i = 0; i < segments.length; i++) {
    if (!segments[i]!.isWordLike) continue;

    // Extend right: `fahren` + `.` → `fahren.`
    let j = i + 1;
    while (
      j < segments.length &&
      !claimed[j] &&
      isPunctuation(segments[j]!) &&
      segments[j]!.start === bounds[i]!.end &&
      !touchesWordOnRight(j)
    ) {
      claimed[j] = true;
      bounds[i]!.end = segments[j]!.end;
      j++;
    }

    // Extend left: `„` + `Hallo` → `„Hallo`
    let k = i - 1;
    while (
      k >= 0 &&
      !claimed[k] &&
      isPunctuation(segments[k]!) &&
      segments[k]!.end === bounds[i]!.start &&
      !touchesWordOnLeft(k)
    ) {
      claimed[k] = true;
      bounds[i]!.start = segments[k]!.start;
      k--;
    }
  }

  const tokens: RawToken[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (claimed[i]) continue;
    const seg = segments[i]!;
    if (isWhitespace(seg.text)) continue;

    const { start, end } = bounds[i]!;
    tokens.push({ text: source.slice(start, end), start, end, isWordLike: seg.isWordLike });
  }

  return tokens.sort((a, b) => a.start - b.start);
}

/**
 * Tokenizes a single line. Offsets are relative to `source` and are exact:
 * `source.slice(token.start, token.end) === token.text` always holds.
 *
 * Whitespace is deliberately not emitted as a token — the renderer reproduces it from the
 * gaps between token offsets, so spacing stays byte-exact without inventing tokens.
 */
export function tokenizeLine(source: string, language?: string): RawToken[] {
  if (!source) return [];
  return claimAdjacentPunctuation(source, mergeJoinedWords(source, segment(source, language)));
}
