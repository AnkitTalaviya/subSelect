import type { LanguageCode } from './constants';

/**
 * User settings.
 *
 * Every field here does something in this build. The brief's full settings page (§49)
 * covers translation language, auto-enable, providers and vocabulary options; those
 * arrive with the features they control, because a switch that silently does nothing is
 * worse than no switch.
 *
 * Every field must have a default: the content script can read settings before the
 * service worker has ever run.
 */
export interface Settings {
  /** Schema version, for forward migration. */
  version: number;

  /** Master switch (§42). When false, the engine attaches nothing at all. */
  enabled: boolean;

  /**
   * Language used for word segmentation and as the cue language when the site does not
   * declare one. Segmentation is locale-sensitive, so this is not cosmetic.
   */
  subtitleLanguage: LanguageCode;
  /** Language to translate into (§24). */
  translationLanguage: LanguageCode;

  /**
   * Providers (§17, §18).
   *
   * `auto` is the default and means "try the free keyless services in order". The named
   * values pin a single provider for anyone who wants one.
   */
  translationProvider: 'auto' | 'none' | 'chrome-ondevice' | 'libretranslate' | 'lingva' | 'deepl' | 'custom';
  translationEndpoint: string;
  translationApiKey: string;
  dictionaryProvider: 'auto' | 'none' | 'wiktionary' | 'free-dictionary' | 'custom';
  dictionaryEndpoint: string;
  /**
   * Where Pronounce gets its audio.
   *
   * `wikimedia` plays a real human recording from Wiktionary / Lingua Libre and falls back
   * to speech synthesis when there is none; `browser` always synthesises.
   */
  pronunciationProvider: 'browser' | 'wikimedia';

  /**
   * When the user accepted the terms, or 0 if they have not (§33).
   *
   * One agreement up front, covering the default free services named on the welcome
   * screen, instead of an approval prompt per host the first time each is reached. No
   * remote provider runs while this is 0; Chrome's own host permissions remain the second
   * gate, so revoking access in the browser still stops everything.
   */
  termsAcceptedAt: number;

  /** Vocabulary (§19, §49). */
  saveContext: boolean;

  /** Interaction (§43). */
  clickToSelect: boolean;
  /** Drag across words to select a phrase. */
  dragToSelect: boolean;
  /** Double-click a word to select the whole caption. */
  doubleClickToSelect: boolean;

  /** Show the context menu when something is selected (§16). */
  showContextMenu: boolean;
  /**
   * Look a word up as soon as it is selected, without pressing Translate.
   *
   * This changes when text leaves the device: with it on, selecting a word is itself the
   * request. It only ever runs while online lookups are on, and it is listed on the
   * welcome screen and in Settings for that reason.
   */
  autoTranslate: boolean;
  /** Which side of the selection the menu prefers (§49 "Popup position"). */
  contextMenuPlacement: 'auto' | 'above' | 'below';
  /** Offer the Pronounce action, using the browser's own speech synthesis (§28). */
  speechEnabled: boolean;

  /** Selection highlight (§41). */
  highlightColor: string;
  highlightEdgeColor: string;
  /** Colour scheme for SubSelect's own surfaces (§49 "Appearance"). */
  theme: 'system' | 'light' | 'dark';

  /** Diagnostics; also enabled per-page with `localStorage.SUBSELECT_DEBUG = '1'`. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  enabled: true,
  subtitleLanguage: 'de',
  translationLanguage: 'en',
  translationProvider: 'auto',
  translationEndpoint: '',
  translationApiKey: '',
  dictionaryProvider: 'auto',
  dictionaryEndpoint: '',
  pronunciationProvider: 'wikimedia',
  termsAcceptedAt: 0,
  saveContext: true,
  clickToSelect: true,
  dragToSelect: true,
  doubleClickToSelect: true,
  showContextMenu: true,
  autoTranslate: true,
  contextMenuPlacement: 'auto',
  speechEnabled: true,
  highlightColor: 'rgba(108, 140, 255, 0.55)',
  highlightEdgeColor: 'rgba(255, 255, 255, 0.9)',
  theme: 'system',
  debug: false,
};

/** Values a string setting is allowed to take. Anything else falls back to the default. */
const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  contextMenuPlacement: ['auto', 'above', 'below'],
  theme: ['system', 'light', 'dark'],
  translationProvider: ['auto', 'none', 'chrome-ondevice', 'libretranslate', 'lingva', 'deepl', 'custom'],
  dictionaryProvider: ['auto', 'none', 'wiktionary', 'free-dictionary', 'custom'],
  pronunciationProvider: ['browser', 'wikimedia'],
};

/**
 * Merges stored settings over the defaults, dropping unknown keys and ignoring any value
 * whose type no longer matches the schema — so a partial write, a hand-edited storage
 * entry or a future downgrade cannot poison the running config.
 */
export function normalizeSettings(stored: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object') return result;

  const input = stored as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = input[key];
    if (value === undefined) continue;

    // Arrays need their own check: `typeof [] === 'object'`, so the type comparison below
    // would accept any object for a string-list setting.
    if (Array.isArray(DEFAULT_SETTINGS[key])) {
      if (!Array.isArray(value)) continue;
      Object.assign(result, { [key]: value.filter((item) => typeof item === 'string') });
      continue;
    }

    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;

    const allowed = ENUMS[key];
    if (allowed && !allowed.includes(value as string)) continue;

    Object.assign(result, { [key]: value });
  }

  result.version = DEFAULT_SETTINGS.version;
  return result;
}
