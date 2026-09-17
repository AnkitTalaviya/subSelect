import type { CueSource, SubtitleCue, SubtitleWord } from '@shared/types';
import { cleanCueText, hashText, normalizeWord, toLookupKey } from '@shared/text';
import { tokenizeLine } from './WordTokenizer';

export interface BuildCueInput {
  /** Raw caption text as found; `\n` separates lines. */
  raw: string;
  source: CueSource;
  language?: string;
  startTime?: number;
  endTime?: number;
}

/**
 * Turns raw caption text into the normalized cue model (§11).
 *
 * The cue id is derived from the content, not from a counter, so an unchanged caption
 * produces an unchanged id and the renderer can skip the work entirely. Players that
 * rewrite their caption DOM on every animation frame are common enough that this
 * matters.
 */
export function buildCue(input: BuildCueInput): SubtitleCue | null {
  const text = cleanCueText(input.raw);
  if (!text) return null;

  const lines = text.split('\n');
  const words: SubtitleWord[] = [];

  let lineStart = 0;
  lines.forEach((line, lineIndex) => {
    for (const token of tokenizeLine(line, input.language)) {
      const startIndex = lineStart + token.start;
      const endIndex = lineStart + token.end;
      const normalizedText = token.isWordLike ? normalizeWord(token.text) : token.text;

      words.push({
        id: `w${startIndex}-${endIndex}`,
        text: token.text,
        normalizedText,
        lookupKey: token.isWordLike ? toLookupKey(token.text, input.language) : '',
        startIndex,
        endIndex,
        // A "word-like" token with no letters or digits left after normalisation is
        // punctuation the segmenter mislabelled; it renders but is not clickable.
        isWordLike: token.isWordLike && normalizedText.length > 0,
        lineIndex,
      });
    }
    lineStart += line.length + 1; // +1 for the '\n' that split() removed
  });

  const cue: SubtitleCue = {
    id: `cue-${hashText(text)}`,
    text,
    lines,
    words,
    source: input.source,
  };

  if (input.language) cue.language = input.language;
  if (typeof input.startTime === 'number') cue.startTime = input.startTime;
  if (typeof input.endTime === 'number') cue.endTime = input.endTime;

  return cue;
}

/**
 * Text of a set of selected words, reconstructed from cue offsets.
 *
 * This is the whole reason words carry offsets. Slicing the cue text between the first
 * and last selected word means reverse drags, multi-line spans and any punctuation or
 * spacing that happened to sit between the words all come out exactly as displayed,
 * with no string re-joining and no ordering bugs (§5, §23, §39, §40).
 *
 * Line breaks inside the span become spaces: a caption's wrap point is a display artifact
 * of the player's box width, not part of the phrase, so a selection spanning two lines
 * reads as one phrase (§39).
 */
export function selectionTextFor(cue: SubtitleCue, words: SubtitleWord[]): string {
  if (words.length === 0) return '';

  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const word of words) {
    if (word.startIndex < start) start = word.startIndex;
    if (word.endIndex > end) end = word.endIndex;
  }

  return cue.text.slice(start, end).replace(/\n/g, ' ');
}

/** Every word between two words inclusive, in document order, regardless of drag direction. */
export function wordsBetween(cue: SubtitleCue, anchorId: string, focusId: string): SubtitleWord[] {
  const anchor = cue.words.findIndex((word) => word.id === anchorId);
  const focus = cue.words.findIndex((word) => word.id === focusId);
  if (anchor === -1 || focus === -1) return [];

  const [from, to] = anchor <= focus ? [anchor, focus] : [focus, anchor];
  return cue.words.slice(from, to + 1).filter((word) => word.isWordLike);
}
