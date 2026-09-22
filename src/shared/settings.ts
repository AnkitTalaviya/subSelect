import { SUPPORTED_LANGUAGES, type LanguageCode } from './constants';
import { DEFAULT_ASK_AI_PROMPT } from './askAi';
import { BUILT_IN_IDS } from './assistants';
import { AUTO_LANGUAGE, resolveLanguagePair, type SubtitleLanguage } from './language';

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
   *
   * `auto` means "read it off the captions": the track's declared language, a `lang`
   * attribute inside the player, or failing both, the text itself (§25).
   */
  subtitleLanguage: SubtitleLanguage;
  /** Language to translate into (§24). Never the same as the subtitle language. */
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
  /**
   * Pause the video while a word is selected, and resume when the selection is dropped.
   *
   * Only ever resumes a video SubSelect paused itself, so a video the viewer paused stays
   * paused, and pressing play while reading permanently hands control back.
   */
  pauseOnSelect: boolean;
  /** Drag across words to select a phrase. */
  dragToSelect: boolean;
  /** Double-click a word to select the whole caption. */
  doubleClickToSelect: boolean;

  /**
   * Ask AI (§65) — offer the action that hands a word to the user's own ChatGPT.
   *
   * Unlike every other provider setting, nothing here configures a service SubSelect
   * calls. It opens a tab as the user, in their own signed-in session; see
   * `shared/askAi.ts` for why that is a different kind of thing.
   */
  askAiEnabled: boolean;
  /**
   * Assistants SubSelect may look for among open tabs and continue a chat in.
   *
   * Each one needs that site's permission, so this list only ever contains assistants the
   * user ticked and Chrome granted. An empty list is normal and still works: questions then
   * open a new chat in `askAiAssistant` by URL, which needs no permission at all.
   */
  askAiAllowed: string[];
  /**
   * Prefer an assistant the user already has open over the configured one.
   *
   * This is what makes the button follow attention rather than a setting: if Claude is the
   * tab you were last looking at, the question goes to Claude. Only tabs for assistants in
   * `askAiAllowed` are visible to SubSelect at all — Chrome enforces that, not us.
   */
  askAiPreferOpenTab: boolean;
  /** Which assistant to open when none is already open. */
  askAiAssistant: string;
  /** Label for the user's own assistant; falls back to its hostname. */
  askAiCustomName: string;
  /**
   * URL of the user's own assistant — a self-hosted Open WebUI, LibreChat, a company
   * deployment. Containing `{prompt}` makes it an entry point that carries the question;
   * without it, the page is opened and the question typed in.
   */
  askAiCustomUrl: string;
  /**
   * `follow-up` keeps asking in the chat that is already going, so the conversation builds
   * up context across an episode. `new-chat` starts a clean one every time, for anyone who
   * would rather not have one thread full of unrelated words.
   *
   * Follow-ups need the assistant's permission, because continuing an open conversation
   * means putting text in its composer. Without it this degrades to `new-chat` rather than
   * failing.
   */
  askAiConversation: 'follow-up' | 'new-chat';
  /**
   * Where the answer shows up.
   *
   * `panel` reads the reply back out of the assistant's page and renders it under the word,
   * so the viewer never leaves the player — which is the whole point of the extension. It
   * needs that assistant ticked, because reading the page needs its permission; without the
   * tick it falls back to `assistant` and says why.
   *
   * `assistant` is the older behaviour: the question is handed over and you go and read it
   * there, with the full interactive chat.
   */
  askAiAnswerIn: 'panel' | 'assistant';
  /**
   * Send the question without leaving the video. Nothing announces the answer.
   *
   * Only meaningful when the answer appears in the assistant — panel answers never take the
   * viewer anywhere, so there is nothing to suppress.
   */
  askAiBackground: boolean;
  /** Prompt template; see `ASK_AI_PLACEHOLDERS` for the tokens it may use. */
  askAiPrompt: string;

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
  subtitleLanguage: AUTO_LANGUAGE,
  translationLanguage: 'en',
  translationProvider: 'auto',
  translationEndpoint: '',
  translationApiKey: '',
  dictionaryProvider: 'auto',
  dictionaryEndpoint: '',
  pronunciationProvider: 'wikimedia',
  termsAcceptedAt: 0,
  askAiEnabled: true,
  askAiAllowed: [],
  askAiPreferOpenTab: true,
  askAiAssistant: 'chatgpt',
  askAiCustomName: '',
  askAiCustomUrl: '',
  askAiConversation: 'follow-up',
  askAiAnswerIn: 'panel',
  askAiBackground: false,
  askAiPrompt: DEFAULT_ASK_AI_PROMPT,
  saveContext: true,
  clickToSelect: true,
  pauseOnSelect: true,
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

const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);

/** Values a string setting is allowed to take. Anything else falls back to the default. */
const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  // Both were previously unchecked, so any string at all survived normalisation and was
  // handed to a segmenter or a translation provider as if it were a language.
  subtitleLanguage: [AUTO_LANGUAGE, ...LANGUAGE_CODES],
  translationLanguage: LANGUAGE_CODES,
  contextMenuPlacement: ['auto', 'above', 'below'],
  theme: ['system', 'light', 'dark'],
  translationProvider: ['auto', 'none', 'chrome-ondevice', 'libretranslate', 'lingva', 'deepl', 'custom'],
  dictionaryProvider: ['auto', 'none', 'wiktionary', 'free-dictionary', 'custom'],
  pronunciationProvider: ['browser', 'wikimedia'],
  askAiConversation: ['follow-up', 'new-chat'],
  askAiAnswerIn: ['panel', 'assistant'],
  askAiAssistant: [...BUILT_IN_IDS, 'custom'],
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

  /*
   * `askAiAllowed` needs more than the generic array check above: its members name
   * assistants, and an id we do not have would be turned into a permission request for an
   * origin that does not exist. Unknown entries are dropped rather than carried.
   */
  const known = new Set<string>([...BUILT_IN_IDS, 'custom']);
  result.askAiAllowed = [...new Set(result.askAiAllowed.filter((id) => known.has(id)))];

  /*
   * A stored pair naming the same language twice is repaired here rather than only in the
   * controls that set it, so settings written by an older build — or by hand — cannot ask
   * for German to be translated into German.
   */
  Object.assign(result, resolveLanguagePair(result, {
    subtitleLanguage: result.subtitleLanguage,
    translationLanguage: result.translationLanguage,
  }));

  result.version = DEFAULT_SETTINGS.version;
  return result;
}
