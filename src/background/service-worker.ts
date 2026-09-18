import type { ExtensionMessage } from '@shared/messages';
import { ASK_AI_PORT, type AskAiPortMessage } from '@shared/messages';
import type { SubtitleSelection } from '@shared/types';
import { log } from '@shared/logger';
import { getSettings, setSettings } from '@shared/storage';
import type { Settings } from '@shared/settings';
import { COMMANDS, SESSION_KEYS } from '@shared/constants';
import type { DictionaryProvider, TranslationProvider, WordDetails } from '../providers/types';
import { fetchGrammar, grammarMeta, supportsGrammar } from '../providers/grammar/providers';
import { runChain, type Refusal } from '../providers/chain';
import { createTranslationChain } from '../providers/translation/providers';
import { createDictionaryChain } from '../providers/dictionary/providers';
import { findPronunciation, wiktionaryHostFor } from '../providers/pronunciation/providers';
import { getVocabularyCount, saveWord } from '../vocabulary/VocabularyManager';
import { fillPrompt } from '@shared/askAi';
import {
  ASSISTANTS,
  assistantById,
  customAssistant,
  isAssistantGranted,
  originsFor,
  type Assistant,
} from '@shared/assistants';
import { askAssistant, streamAnswer } from './askAssistant';

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
    /*
     * NOTE: this list is wider than "sites the user opted into".
     *
     * The comment here used to claim that content-script `matches` from the manifest never
     * appear in `getAll()`. They do — on a clean profile with nothing granted, `origins`
     * already contains all fourteen patterns from `content_scripts`. So the registration
     * below re-registers the manifest's own sites dynamically, duplicating the static
     * declaration, and `origins.length === 0` is never true.
     *
     * That is harmless (the content script guards against running twice) and predates Ask
     * AI, so it is left alone rather than fixed in passing — but it is not what the code
     * reads as if it does.
     */
    const granted = await chrome.permissions.getAll();
    /*
     * Assistant origins are excluded deliberately.
     *
     * Those are granted for Ask AI, which reaches the page with a one-shot `executeScript`
     * at the moment of a press. Treating the grant as an opt-in to interactive subtitles
     * would leave the whole engine standing on sites that have no video in them — access the
     * user gave in order to be *asked a question*, quietly spent on something else. (A side
     * effect is that "Enable on this site" does nothing on chatgpt.com or claude.ai, which
     * costs nothing: there are no captions there to make clickable.)
     *
     * A custom assistant's origin cannot be excluded this way, because it is whatever the
     * user typed and may legitimately also be a site they want subtitles on. Its grant is
     * requested separately and the overlap is theirs to want.
     */
    const askAiOrigins = new Set<string>(originsFor(ASSISTANTS));
    const origins = (granted.origins ?? []).filter((origin) => !askAiOrigins.has(origin));

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

/**
 * Everything about one selection, gathered in parallel.
 *
 * Translation, definitions and grammar come from different services, so they are asked at
 * the same time rather than in sequence — the panel is then as fast as the slowest single
 * source instead of the sum of all three. Each is allowed to fail independently: a word
 * with no Wiktionary page still gets its translation, and a phrase too long to have an
 * article still gets its meaning.
 */
async function wordDetails(message: Extract<ExtensionMessage, { type: 'GET_WORD_DETAILS' }>) {
  const settings = await getSettings();
  const language = message.language || settings.subtitleLanguage;
  const gated = gateFor(settings);

  const [translated, defined, grammared] = await Promise.all([
    runChain(
      createTranslationChain(settings),
      (provider: TranslationProvider) =>
        // The headword, not the raw slice: translating "entscheiden." returned "decide."
        // with the full stop carried through. For a phrase the two are the same string.
        provider.translate(
          message.lookupText || message.text,
          language,
          settings.translationLanguage,
          message.context,
        ),
      { gate: gated, emptyMessage: 'Translation is turned off in settings.' },
    ),
    runChain(
      createDictionaryChain(settings),
      (provider: DictionaryProvider) => provider.lookup(message.lookupText || message.text, language),
      { gate: gated, emptyMessage: 'Dictionary lookup is turned off in settings.' },
    ),
    supportsGrammar(language) && !/\s/.test(message.lookupText || message.text)
      ? runChain([{ meta: grammarMeta }], () => fetchGrammar(message.lookupText || message.text, language), {
          gate: gated,
          emptyMessage: 'No grammar source.',
        })
      : Promise.resolve({ ok: false as const, kind: 'unsupported' as const, message: '' }),
  ]);

  const details: WordDetails = {
    headword: message.lookupText || message.text,
    language,
    sources: [],
    problems: [],
  };

  if (translated.ok) {
    details.translation = { text: translated.data.text, providerId: translated.data.providerId };
    details.sources.push(translated.data.providerId);
  } else if (translated.message) {
    details.problems.push(translated.message);
  }

  if (defined.ok) {
    const result = defined.data;
    details.senses = result.senses;
    if (result.ipa) details.ipa = result.ipa;
    if (result.synonyms) details.synonyms = result.synonyms;
    if (result.antonyms) details.antonyms = result.antonyms;
    if (result.senses[0]?.partOfSpeech) details.partOfSpeech = result.senses[0].partOfSpeech;
    details.sources.push(result.providerId);
  } else if (defined.message) {
    details.problems.push(defined.message);
  }

  if (grammared.ok) {
    const grammar = grammared.data;
    // Grammar wins over the dictionary for these: it comes from a structured template
    // rather than being inferred from prose.
    if (grammar.article) details.article = grammar.article;
    if (grammar.gender) details.gender = grammar.gender;
    if (grammar.plural) details.plural = grammar.plural;
    if (grammar.inflections) details.inflections = grammar.inflections;
    if (grammar.ipa) details.ipa = grammar.ipa;
    if (grammar.hypernyms) details.hypernyms = grammar.hypernyms;
    if (grammar.synonyms) {
      details.synonyms = [...new Set([...(details.synonyms ?? []), ...grammar.synonyms])].slice(0, 8);
    }
    details.sources.push(grammarMeta.id);
  }

  // Only a total blank is a failure; anything found is worth showing.
  if (details.sources.length === 0) {
    const blocked = !translated.ok && translated.kind === 'no-permission';
    return {
      ok: false as const,
      kind: blocked ? ('no-permission' as const) : ('provider' as const),
      message: [...new Set(details.problems)].join('\n') || 'Nothing found for this selection.',
    };
  }

  return { ok: true as const, data: details };
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

/**
 * Ask AI (§65).
 *
 * Note what is *not* here: no `gate()`, no chain, no fetch. This does not send text to a
 * service on the user's behalf — it puts a question into the user's own signed-in ChatGPT,
 * in a tab they can see, only ever in response to a press. `termsAcceptedAt` governs the
 * lookups SubSelect performs in the background, and stretching it to cover this would
 * imply the free-provider chain is involved when none of it is.
 */
async function askAi(message: Extract<ExtensionMessage, { type: 'ASK_AI' }>) {
  const settings = await getSettings();

  if (!settings.askAiEnabled) {
    return { ok: false as const, kind: 'not-configured' as const, message: 'Ask AI is turned off in settings.' };
  }

  const { allowed, known, fallback } = await resolveAssistants(settings);
  if (!fallback) {
    return {
      ok: false as const,
      kind: 'not-configured' as const,
      message: 'No assistant is set up for Ask AI.',
    };
  }
  // Gemini and a custom entry without `{prompt}` can only be reached by typing, so without
  // the grant a press would open an empty chat and silently drop the question.
  if (!fallback.promptUrl && !allowed.some((item) => item.id === fallback.id)) {
    return {
      ok: false as const,
      kind: 'no-permission' as const,
      message: `${fallback.label} needs access before SubSelect can ask it anything.`,
    };
  }

  const prompt = fillPrompt(settings.askAiPrompt, {
    // The headword, for the same reason translation uses it: "entscheiden." asked as-is
    // invites an answer about the punctuation.
    word: message.lookupText || message.text,
    sentence: message.context ?? message.text,
    language: message.language || settings.subtitleLanguage,
    target: settings.translationLanguage,
  });

  /*
   * Panel answers need the assistant's permission twice over — to type the question in, and
   * to read the reply back out — so without the tick there is nothing to read and the
   * question simply goes to the assistant. The press still works; only the convenience is
   * missing, and the panel says which tick would restore it rather than failing.
   */
  const wantsPanel = settings.askAiAnswerIn === 'panel';
  const canReadAnswer = allowed.some((item) => item.id === fallback.id) || allowed.length > 0;
  const panelBlocked =
    wantsPanel && !canReadAnswer
      ? `Tick an assistant under Ask AI in settings to read answers here.`
      : null;

  try {
    const outcome = await askAssistant({
      prompt,
      allowed,
      known,
      fallback,
      preferOpenTab: settings.askAiPreferOpenTab,
      conversation: settings.askAiConversation,
      // A panel answer never takes the viewer anywhere: that is the whole point of it.
      focus: wantsPanel ? false : !settings.askAiBackground,
    });

    if (wantsPanel && outcome.answer) {
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingAnswers.set(runId, outcome.answer);
      return { ok: true as const, data: { ...outcome.result, answerRunId: runId } };
    }

    return {
      ok: true as const,
      data: {
        ...outcome.result,
        ...(panelBlocked ? { answerUnavailable: panelBlocked } : {}),
        ...(wantsPanel && !panelBlocked
          ? { answerUnavailable: `The answer is in ${outcome.result.assistantLabel}.` }
          : {}),
      },
    };
  } catch (error) {
    log.error('ask AI failed', error);
    return {
      ok: false as const,
      kind: 'provider' as const,
      message: `Could not open ${fallback.label}.`,
    };
  }
}

/**
 * Ask AI runs over a port, not a one-shot message.
 *
 * Two reasons, and the first is not a preference. `sender.tab` is populated only for a tab
 * the extension has access to, and content-script `matches` are not host permissions — so
 * on the sites SubSelect runs on by default the worker is handed `{ id, url, origin }` and
 * has no tab id to send anything back to. A port replies to the sender that opened it.
 *
 * The second is that a port keeps this worker alive while the reply is being written, and
 * a disconnect tells us the viewer moved on so the watch can stop.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ASK_AI_PORT) return;

  let live = true;
  port.onDisconnect.addListener(() => {
    live = false;
  });

  port.onMessage.addListener((raw) => {
    const message = raw as ExtensionMessage;
    if (message.type !== 'ASK_AI') return;

    void askAi(message)
      .then(async (outcome) => {
        if (!live) return;
        post(port, { kind: 'result', outcome });

        const runId = outcome.ok ? outcome.data.answerRunId : undefined;
        const watch = runId ? pendingAnswers.get(runId) : undefined;
        if (!runId || !watch) {
          // Nothing to stream; the panel has everything it is going to get.
          try {
            port.disconnect();
          } catch {
            // Already closed.
          }
          return;
        }
        pendingAnswers.delete(runId);

        await streamAnswer(watch.tabId, watch.assistant, watch.baseline, (update) => {
          if (!live) return;
          post(port, {
            kind: 'answer',
            text: update.text,
            done: update.done,
            ...(update.error ? { error: update.error } : {}),
          });
        });

        try {
          port.disconnect();
        } catch {
          // The panel may have closed first, which is the normal ending.
        }
      })
      .catch((error: unknown) => {
        log.error('ask AI failed', error);
        if (live) {
          post(port, {
            kind: 'result',
            outcome: { ok: false, kind: 'provider', message: 'Could not reach an assistant.' },
          });
        }
      });
  });
});

function post(port: chrome.runtime.Port, message: AskAiPortMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The other end went away mid-answer; nothing to do but stop.
  }
}

/**
 * Answers waiting to be streamed, keyed by the run id handed back to the panel.
 *
 * `askAi` decides *whether* a reply can be read; the port handler does the reading. Passing
 * it through here keeps `askAi` returning a plain serialisable result rather than a tab
 * handle the content script has no business seeing.
 */
const pendingAnswers = new Map<string, { tabId: number; assistant: Assistant; baseline: number }>();

/**
 * Turns the settings into the three lists the hand-off needs.
 *
 * `allowed` is the intersection of what the user ticked and what Chrome still grants —
 * checked here rather than trusted from storage, because access can be revoked in Chrome's
 * own settings at any time and the stored list would not hear about it.
 */
async function resolveAssistants(settings: Settings): Promise<{
  allowed: Assistant[];
  known: Assistant[];
  fallback: Assistant | null;
}> {
  const custom = customAssistant({ name: settings.askAiCustomName, url: settings.askAiCustomUrl });
  const known = custom ? [...ASSISTANTS, custom] : [...ASSISTANTS];

  const ticked = known.filter((assistant) => settings.askAiAllowed.includes(assistant.id));
  const allowed: Assistant[] = [];
  for (const assistant of ticked) {
    const granted = await isAssistantGranted(assistant, (origins) =>
      chrome.permissions.contains({ origins }),
    );
    if (granted) allowed.push(assistant);
  }

  const chosen = assistantById(settings.askAiAssistant, custom);
  // A custom assistant that has been emptied out, or a stale id, must not leave the button
  // pointing at nothing — the first built-in is a working answer.
  return { allowed, known, fallback: chosen ?? ASSISTANTS[0] ?? null };
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case 'GET_WORD_DETAILS':
      void wordDetails(message).then(respond);
      return true;

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
