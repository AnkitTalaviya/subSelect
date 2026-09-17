/**
 * Core data model. Deliberately free of any streaming-service concepts (§11) and of any
 * DOM references, so cues and selections stay structured-cloneable for messaging.
 */

/** DOMRect-shaped plain object. A real DOMRect satisfies this structurally. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where a cue's text came from. Affects how it is positioned, not how it is used. */
export type CueSource = 'dom' | 'texttrack';

export interface SubtitleWord {
  id: string;
  /** Original slice of the cue text, punctuation preserved: `geht's?` (§40). */
  text: string;
  /** Edge punctuation stripped, internals kept: `geht's`. */
  normalizedText: string;
  /** Locale-lowercased `normalizedText`, for dictionary/vocabulary keys. */
  lookupKey: string;
  /** Offset into `SubtitleCue.text`. */
  startIndex: number;
  /** Exclusive offset into `SubtitleCue.text`. */
  endIndex: number;
  /** False for punctuation-only runs, which render but are not clickable. */
  isWordLike: boolean;
  /** Zero-based index of the cue line this word sits on. */
  lineIndex: number;
  /** Filled in by the renderer once the word has been laid out. */
  boundingRect?: Rect;
}

export interface SubtitleCue {
  id: string;
  /** Full cue text; lines joined with `\n`. All word offsets index into this. */
  text: string;
  lines: string[];
  /** Seconds. Present for TextTrack cues; usually absent for DOM-scraped captions. */
  startTime?: number;
  endTime?: number;
  /** BCP-47 tag when the site tells us; otherwise the user's configured language. */
  language?: string;
  words: SubtitleWord[];
  source: CueSource;
}

export interface SubtitleSelection {
  id: string;
  /**
   * Reconstructed from cue offsets, never by joining word strings — that is what makes
   * reverse drags, multi-line spans and interior punctuation come out byte-exact (§5, §39, §40).
   */
  text: string;
  words: SubtitleWord[];
  cueId?: string;
  language?: string;
  /** The whole cue the selection was taken from (§15). */
  context?: string;
  startTime?: number;
  endTime?: number;
}

/** Geometry and typography the overlay mirrors from the player. */
export interface SubtitleBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  textShadow: string;
  textAlign: string;
  textStroke: string;
  background: string;
  padding: string;
  borderRadius: string;
  /** True when coordinates are viewport-relative rather than offsetParent-relative. */
  fixed: boolean;
}

/**
 * A saved vocabulary entry (§20).
 *
 * Designed for the flashcard and spaced-repetition work in Phase 6: `normalizedWord` is
 * the stable key to deduplicate and group by, and `context` is the sentence the word was
 * met in, which is what makes a card worth reviewing.
 *
 * Stored only in `chrome.storage.local`. Nothing here is ever sent anywhere (§19).
 */
export interface SavedWord {
  id: string;
  word: string;
  normalizedWord: string;
  translation?: string;
  context: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  website?: string;
  createdAt: number;
}

/** Why the engine is or is not currently doing anything — surfaced in the popup. */
export type FrameState =
  | 'disabled'
  | 'no-video'
  | 'no-subtitle-source'
  | 'waiting-for-cue'
  | 'active'
  | 'error';

export interface FrameStatus {
  state: FrameState;
  /** Adapter id, e.g. `generic-dom`. */
  adapterId?: string;
  source?: CueSource;
  language?: string;
  url: string;
}
