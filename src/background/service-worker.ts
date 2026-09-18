import type { ExtensionMessage } from '@shared/messages';
import type { SubtitleSelection } from '@shared/types';
import { log } from '@shared/logger';
import { getSettings, setSettings } from '@shared/storage';
import type { Settings } from '@shared/settings';
import { COMMANDS, SESSION_KEYS } from '@shared/constants';
import type { DictionaryProvider, TranslationProvider } from '../providers/types';
import { runChain, type Refusal } from '../providers/chain';
import { createTranslationChain } from '../providers/translation/providers';
import { createDictionaryChain } from '../providers/dictionary/providers';
import { findPronunciation, wiktionaryHostFor } from '../providers/pronunciation/providers';
import { getVocabularyCount, saveWord } from '../vocabulary/VocabularyManager';

/**
 * MV3 service worker.
 *
 * Holds no engine state. The worker is killed whenever Chrome feels like it, so anything
 * that must survive lives in storage, and everything that touches a video lives in the
 * content script. What is left is: seeding defaults, routing a few messages, keeping the
 * most recent selection for the popup to show, and keeping dynamic content-script
 * registrations in step with the host permissions the user has granted.
 */

const DYNAMIC_SCRIPT_ID = 'subselect-user-granted';

chrome.runtime.onInstalled.addListener((details) => {
  void getSettings()
    .then((settings) => setSettings(settings))
    .catch((error: unknown) => log.error('could not seed settings', error));
  void reconcileDynamicScripts();

  // The welcome screen is where the user accepts the terms and grants access to the
  // default services in one go — it has to be an extension page, because
  // chrome.permissions.request needs a user gesture and is unavailable to content scripts.
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileDynamicScripts();
});

/**
 * Keeps SubSelect running on sites the user opted into.
 *
 * The extension asks for no host permissions at install time. When the user grants one
 * from the popup, that origin is added to a single dynamic content-script registration,
 * which Chrome persists across restarts — so an opted-in site keeps working on reload
 * without the extension ever having had blanket access.
 */
async function reconcileDynamicScripts(): Promise<void> {
  try {
    // getAll() reports host permissions the user has granted. Content-script `matches`
    // from the manifest are not host permissions and never appear here, so this list is
    // exactly the set of sites the user opted into.
    const granted = await chrome.permissions.getAll();
    const origins = granted.origins ?? [];

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    }
    if (origins.length === 0) return;

    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches: origins,
        js: ['content.js'],
        css: ['content.css'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
    log.info(`registered dynamic content script for ${origins.length} origin(s)`);
  } catch (error) {
    log.warn('could not reconcile dynamic content scripts', error);
  }
}

chrome.permissions.onAdded.addListener(() => void reconcileDynamicScripts());
chrome.permissions.onRemoved.addListener(() => void reconcileDynamicScripts());

/**
 * Keyboard commands (§45).
 *
 * The toggle writes to storage and stops there: `chrome.storage.onChanged` is what
 * actually applies it, in every frame of every tab at once, so there is still exactly one
 * path into the engine's settings handling.
 *
 * The default is Alt+Shift+S rather than the brief's Alt+S. Extension commands intercept
 * the key before the page sees it, so binding plain Alt+S would silently break any site
 * that uses it — which §45 says not to do. Users can rebind it at
 * chrome://extensions/shortcuts.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command !== COMMANDS.toggle) return;
  void getSettings()
    .then((settings) => setSettings({ enabled: !settings.enabled }))
    .catch((error: unknown) => log.error('toggle command failed', error));
});

/**
 * Most recent selection per tab, in session storage.
 *
 * Session storage is memory-backed and cleared when the browser closes, so a word someone
 * clicked is never written to disk. It exists only so the popup can show what is
 * currently selected; nothing accumulates and nothing is sent anywhere (§33).
 */
async function rememberSelection(tabId: number, selection: SubtitleSelection | null): Promise<void> {
  const key = `${SESSION_KEYS.selectionPrefix}${tabId}`;
  if (!selection) {
    await chrome.storage.session.remove(key);
    return;
  }
  await chrome.storage.session.set({
    [key]: {
      text: selection.text,
      context: selection.context,
      language: selection.language,
    },
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`${SESSION_KEYS.selectionPrefix}${tabId}`);
});

/**
 * Runs a provider call and flattens it into a result envelope.
 *
 * Provider work happens here, not in the content script, for three reasons: `fetch` in the
 * worker is governed by host permissions instead of the page's CORS policy; an API key
 * never has to exist in a tab's process; and a page can never observe that a lookup
 * happened.
 *
 * Two gates stand in front of every remote call — the host permission Chrome enforces, and
 * the user's own recorded agreement that this host may receive selected text (§33).
 */
interface ProviderLike {
  meta: { remote: boolean; endpointHost?: string; endpointOrigin?: string; label: string };
}

/** Why this provider cannot be called right now, or null if it can. */
async function gate(meta: ProviderLike['meta'], settings: Settings): Promise<Refusal | null> {
  if (!meta.remote) return null;

  if (settings.termsAcceptedAt === 0) {
    return {
      kind: 'no-permission',
      message: 'Online lookups are off. Turn them on to use translation and definitions.',
      global: true,
    };
  }
  if (!meta.endpointOrigin) {
    return { kind: 'not-configured', message: `${meta.label} has no usable endpoint set.` };
  }
  if (!(await chrome.permissions.contains({ origins: [meta.endpointOrigin] }))) {
    return {
      kind: 'no-permission',
      message: `SubSelect does not have permission to contact ${meta.endpointHost ?? meta.label}.`,
    };
  }
  return null;
}

/** Binds the permission/consent checks to a chain run. */
const gateFor =
  (settings: Settings) =>
  (provider: ProviderLike) =>
    gate(provider.meta, settings);

async function translate(message: Extract<ExtensionMessage, { type: 'TRANSLATE_SELECTION' }>) {
  const settings = await getSettings();
  return runChain(
    createTranslationChain(settings),
    (provider: TranslationProvider) =>
      provider.translate(
        message.text,
        message.sourceLanguage || settings.subtitleLanguage,
        settings.translationLanguage,
        message.context,
      ),
    { gate: gateFor(settings), emptyMessage: 'Translation is turned off in settings.' },
  );
}

async function lookup(message: Extract<ExtensionMessage, { type: 'LOOKUP_WORD' }>) {
  const settings = await getSettings();
  // §18: no invented definitions — if no provider has the word, say so.
  return runChain(
    createDictionaryChain(settings),
    (provider: DictionaryProvider) =>
      provider.lookup(message.text, message.language || settings.subtitleLanguage),
    { gate: gateFor(settings), emptyMessage: 'Dictionary lookup is turned off in settings.' },
  );
}

async function pronounce(message: Extract<ExtensionMessage, { type: 'FIND_PRONUNCIATION' }>) {
  const settings = await getSettings();
  if (settings.pronunciationProvider !== 'wikimedia') {
    // The caller falls back to speech synthesis, which needs no network at all.
    return { ok: false as const, kind: 'not-configured' as const, message: 'Recordings are turned off.' };
  }

  const language = message.language || settings.subtitleLanguage;
  const host = wiktionaryHostFor(language);

  return runChain(
    [{ meta: { remote: true, label: 'Wikimedia', endpointHost: host, endpointOrigin: `https://${host}/*` } }],
    () => findPronunciation(message.text, language),
    { gate: gateFor(settings), emptyMessage: 'Recordings are turned off.' },
  );
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case 'FIND_PRONUNCIATION':
      void pronounce(message).then(respond);
      return true;

    case 'TRANSLATE_SELECTION':
      void translate(message).then(respond);
      return true;

    case 'LOOKUP_WORD':
      void lookup(message).then(respond);
      return true;

    case 'SAVE_WORD':
      void getSettings()
        .then(async (settings) => {
          const input = {
            word: message.word.word,
            context: settings.saveContext ? message.word.context : '',
            ...(message.word.translation ? { translation: message.word.translation } : {}),
            ...(message.word.sourceLanguage ? { sourceLanguage: message.word.sourceLanguage } : {}),
            targetLanguage: settings.translationLanguage,
            ...(message.word.website ? { website: message.word.website } : {}),
          };
          await saveWord(input);
          return { ok: true as const, data: { saved: true as const, total: await getVocabularyCount() } };
        })
        .catch((error: unknown) => {
          log.error('save failed', error);
          return { ok: false as const, kind: 'provider' as const, message: 'Could not save this word.' };
        })
        .then(respond);
      return true;

    case 'GET_VOCABULARY_COUNT':
      void getVocabularyCount().then(respond);
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      respond(undefined);
      return false;

    case 'SELECTION_CHANGED': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void rememberSelection(tabId, message.selection);
      respond(undefined);
      return false;
    }

    default:
      return false;
  }
});
