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

  /** Providers (§17, §18). `none` is the default: nothing is contacted until asked for. */
  translationProvider: 'none' | 'chrome-ondevice' | 'libretranslate' | 'deepl' | 'custom';
  translationEndpoint: string;
  translationApiKey: string;
  dictionaryProvider: 'none' | 'wiktionary' | 'custom';
  dictionaryEndpoint: string;

  /**
   * Origins the user has agreed may receive selected text (§33).
   *
   * A remote provider is not called until its host appears here, and the menu asks for
   * that agreement by name the first time.
   */
  consentedHosts: string[];

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
  translationProvider: 'none',
  translationEndpoint: '',
  translationApiKey: '',
  dictionaryProvider: 'none',
  dictionaryEndpoint: '',
  consentedHosts: [],
  saveContext: true,
  clickToSelect: true,
  dragToSelect: true,
  doubleClickToSelect: true,
  showContextMenu: true,
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
  translationProvider: ['none', 'chrome-ondevice', 'libretranslate', 'deepl', 'custom'],
  dictionaryProvider: ['none', 'wiktionary', 'custom'],
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
