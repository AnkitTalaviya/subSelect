export const EXTENSION_NAME = 'SubSelect';

/** Prefix for every attribute and class SubSelect puts into a page. */
export const NS = 'subselect';

export const CLASS = {
  layer: `${NS}-layer`,
  line: `${NS}-line`,
  lineInner: `${NS}-line-inner`,
  word: `${NS}-word`,
  gap: `${NS}-gap`,
  notice: `${NS}-notice`,
  menu: `${NS}-menu`,
  menuHeader: `${NS}-menu-header`,
  menuTerm: `${NS}-menu-term`,
  menuContext: `${NS}-menu-context`,
  menuItem: `${NS}-menu-item`,
  menuIcon: `${NS}-menu-icon`,
  menuNote: `${NS}-menu-note`,
  menuResult: `${NS}-menu-result`,
  menuResultText: `${NS}-menu-result-text`,
  menuSenses: `${NS}-menu-senses`,
  menuPos: `${NS}-menu-pos`,
  menuLink: `${NS}-menu-link`,
  menuGrammar: `${NS}-menu-grammar`,
  menuTranslation: `${NS}-menu-translation`,
  menuForms: `${NS}-menu-forms`,
  menuRelated: `${NS}-menu-related`,
  menuExample: `${NS}-menu-example`,
  menuSlot: `${NS}-menu-slot`,
  menuArticle: `${NS}-menu-article`,
  menuArticleWord: `${NS}-menu-article-word`,
  menuSectionLabel: `${NS}-menu-section`,
  menuChips: `${NS}-menu-chips`,
  menuChip: `${NS}-menu-chip`,
  menuItemCompact: `${NS}-menu-item-compact`,
  menuAnswer: `${NS}-menu-answer`,
  menuCaret: `${NS}-menu-caret`,
} as const;

export const ATTR = {
  /** Marks the site's own caption element while we mirror it. */
  hiddenOriginal: `data-${NS}-hidden`,
  /** Word id, used to map an event target back to a SubtitleWord. */
  wordId: `data-ss-word`,
  selected: `data-ss-selected`,
  layerHidden: `data-ss-hidden`,
  layerFixed: `data-ss-fixed`,
  layerDragging: `data-ss-dragging`,
  layerSuppressed: `data-ss-suppressed`,
} as const;

export const STORAGE_KEYS = {
  settings: 'settings',
  vocabulary: 'vocabulary',
} as const;

/** Session storage is memory-backed: nothing under these keys is ever written to disk. */
export const SESSION_KEYS = {
  selectionPrefix: 'selection:',
  /**
   * The ChatGPT tab Ask AI is currently talking to.
   *
   * Session storage is what gives "a new chat when you start, follow-ups after that" for
   * free: it is cleared when the browser closes, so the first ask of a browsing session
   * opens a fresh conversation and every ask after it lands in that same one. It also means
   * a tab id — which says something about what the user has open — never reaches the disk.
   */
  askAiTab: 'askAi:tab',
} as const;

/**
 * Timing budget. Every number here exists to keep the extension off the main thread;
 * see docs/FEASIBILITY.md §7. Nothing may be lowered without a measurement.
 */
export const TIMING = {
  /** Trailing throttle for the wide document observer used before a video is bound. */
  discoveryObserverMs: 250,
  /** Retry cadence while no video is bound. Stops permanently once one is. */
  discoveryRetryMs: 2000,
  /** Trailing debounce for resize/fullscreen driven re-measurement. */
  repositionDebounceMs: 60,
  /** Bounded rAF burst after a layout-affecting event, to settle CSS transitions. */
  repositionFrames: 10,
  /** Trailing throttle for SPA URL checks. */
  urlWatchMs: 300,
  /**
   * Liveness check while the feature is on.
   *
   * Observers only fire on subtrees that still exist. A player that rebuilds itself —
   * changing episode, seeking, re-creating its DOM — can take our overlay and the elements
   * we were watching with it, leaving the engine bound to nothing and silently dead until
   * the user toggled the extension. This notices and re-binds.
   *
   * It is a handful of `isConnected` reads, not a scan, and it stops while the tab is
   * hidden or the feature is off.
   */
  healthCheckMs: 2000,
  /** How long to wait before trying again after repeated failures. */
  errorRecoveryMs: 5000,
} as const;

/** Consecutive pipeline failures before the engine stands down (§58). */
export const MAX_CONSECUTIVE_ERRORS = 3;

/** Pointer movement, in CSS pixels, that turns a click into a drag. */
export const DRAG_THRESHOLD_PX = 3;

/**
 * How far outside the caption a drag may stray before it stops extending, in CSS pixels.
 *
 * Generous, because overshooting the end of a line is normal; but finite, so dragging off
 * to the player controls does not keep dragging a selection along with it.
 */
export const DRAG_MAX_DISTANCE_PX = 220;

/**
 * Double-press detection, done by hand rather than with the `dblclick` event.
 *
 * Cancelling `pointerdown` — which we must, to stop the browser starting its own drag
 * selection — suppresses the compatibility mouse events. The Pointer Events spec
 * guarantees `click`, `auxclick` and `contextmenu` still fire, but says nothing about
 * `dblclick`, so relying on it would be relying on unspecified behaviour.
 */
export const DOUBLE_PRESS_MS = 400;
export const DOUBLE_PRESS_SLOP_PX = 10;

/** Context menu geometry, in CSS pixels. */
export const MENU_GAP_PX = 10;
export const MENU_MARGIN_PX = 8;

/**
 * Pause before an automatic lookup fires.
 *
 * Long enough that clicking through several words in a row sends one request instead of
 * one per word, short enough to feel immediate. Each new selection cancels the pending
 * one, so only the word you settle on is ever looked up.
 */
export const AUTO_TRANSLATE_DELAY_MS = 220;

/**
 * Keyboard command ids, mirrored in manifest.json.
 *
 * Only the toggle exists so far: the rest of §45 (translate, dictionary, save vocabulary)
 * are shortcuts for actions that do not exist yet, and a shortcut that does nothing is
 * worse than no shortcut.
 */
export const COMMANDS = {
  toggle: 'toggle-interactive-subtitles',
} as const;

/** Minimum score an element needs to be treated as the page's primary video (§10). */
export const ACTIVE_VIDEO_MIN_SCORE = 1;

export const SUPPORTED_LANGUAGES = [
  { code: 'de', label: 'German' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/**
 * Human name for a language code, for text meant to be read rather than matched.
 *
 * Falls back to the code itself: a cue can declare a language we do not have a label for
 * (`sv`, or a regional tag like `pt-BR`), and "sv" in a sentence is still better than
 * either a blank or a wrong guess.
 */
export function languageLabel(code: string): string {
  const base = code.split('-')[0]?.toLowerCase() ?? code;
  return SUPPORTED_LANGUAGES.find((language) => language.code === base)?.label ?? code;
}

/** Message shown when a player's subtitles cannot be reached legitimately (§34). */
export const UNSUPPORTED_MESSAGE = "Interactive subtitles aren't available for this player.";
