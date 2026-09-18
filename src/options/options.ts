import { SUPPORTED_LANGUAGES, type LanguageCode } from '@shared/constants';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { getSettings, setSettings } from '@shared/storage';
import { DEFAULT_ASK_AI_PROMPT } from '@shared/askAi';
import {
  ASSISTANTS,
  assistantById,
  customAssistant,
  isAssistantGranted,
  originsFor,
  type Assistant,
} from '@shared/assistants';
import { defaultOrigins } from '../providers/registry';
import {
  DEFAULT_ENDPOINTS,
  PUBLIC_INSTANCES,
  isOnDeviceTranslationPresent,
  onDeviceAvailability,
} from '../providers/translation/providers';
import { clearVocabulary, getVocabularyCount } from '../vocabulary/VocabularyManager';

/**
 * Options page (§49).
 *
 * Every control here changes something in this build. The brief's Providers and Vocabulary
 * sections are absent rather than present-and-inert; they arrive with the features they
 * configure. Saving is immediate — there is no Save button to forget to press.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`options markup is missing #${id}`);
  return node as T;
}

const controls = {
  enabled: el<HTMLInputElement>('enabled'),
  debug: el<HTMLInputElement>('debug'),
  subtitleLanguage: el<HTMLSelectElement>('subtitleLanguage'),
  clickToSelect: el<HTMLInputElement>('clickToSelect'),
  pauseOnSelect: el<HTMLInputElement>('pauseOnSelect'),
  dragToSelect: el<HTMLInputElement>('dragToSelect'),
  doubleClickToSelect: el<HTMLInputElement>('doubleClickToSelect'),
  showContextMenu: el<HTMLInputElement>('showContextMenu'),
  autoTranslate: el<HTMLInputElement>('autoTranslate'),
  contextMenuPlacement: el<HTMLSelectElement>('contextMenuPlacement'),
  speechEnabled: el<HTMLInputElement>('speechEnabled'),
  theme: el<HTMLSelectElement>('theme'),
  highlightColor: el<HTMLInputElement>('highlightColor'),
  highlightAlpha: el<HTMLInputElement>('highlightAlpha'),
};

const askControls = {
  askAiEnabled: el<HTMLInputElement>('askAiEnabled'),
  askAiPreferOpenTab: el<HTMLInputElement>('askAiPreferOpenTab'),
  askAiAssistant: el<HTMLSelectElement>('askAiAssistant'),
  askAiCustomName: el<HTMLInputElement>('askAiCustomName'),
  askAiCustomUrl: el<HTMLInputElement>('askAiCustomUrl'),
  askAiAnswerIn: el<HTMLSelectElement>('askAiAnswerIn'),
  askAiConversation: el<HTMLSelectElement>('askAiConversation'),
  askAiBackground: el<HTMLInputElement>('askAiBackground'),
  askAiPrompt: el<HTMLTextAreaElement>('askAiPrompt'),
};

const providerControls = {
  translationLanguage: el<HTMLSelectElement>('translationLanguage'),
  translationProvider: el<HTMLSelectElement>('translationProvider'),
  translationEndpoint: el<HTMLInputElement>('translationEndpoint'),
  translationApiKey: el<HTMLInputElement>('translationApiKey'),
  dictionaryProvider: el<HTMLSelectElement>('dictionaryProvider'),
  dictionaryEndpoint: el<HTMLInputElement>('dictionaryEndpoint'),
  pronunciationProvider: el<HTMLSelectElement>('pronunciationProvider'),
  saveContext: el<HTMLInputElement>('saveContext'),
};

const preview = el<HTMLElement>('preview');
const savedState = el<HTMLElement>('saved-state');
const speechHint = el<HTMLElement>('speech-hint');
const shortcutLabel = el<HTMLElement>('shortcut');

// ── Colour helpers ────────────────────────────────────────────────────────────
//
// Settings store a full `rgba(...)` string, because that is what the overlay needs. The
// page edits it as a hex colour plus an opacity, which is what people can actually reason
// about.

function parseRgba(value: string): { hex: string; alpha: number } {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(value);
  if (!match) return { hex: '#6c8cff', alpha: 0.55 };

  const toHex = (part: string | undefined): string =>
    Math.min(255, Number(part ?? 0)).toString(16).padStart(2, '0');

  return {
    hex: `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`,
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function toRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(2))})`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function applyTheme(theme: Settings['theme']): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function render(settings: Settings): void {
  controls.enabled.checked = settings.enabled;
  controls.debug.checked = settings.debug;
  controls.subtitleLanguage.value = settings.subtitleLanguage;
  controls.clickToSelect.checked = settings.clickToSelect;
  controls.pauseOnSelect.checked = settings.pauseOnSelect;
  controls.dragToSelect.checked = settings.dragToSelect;
  controls.doubleClickToSelect.checked = settings.doubleClickToSelect;
  controls.showContextMenu.checked = settings.showContextMenu;
  controls.autoTranslate.checked = settings.autoTranslate;
  controls.contextMenuPlacement.value = settings.contextMenuPlacement;
  controls.speechEnabled.checked = settings.speechEnabled;
  controls.theme.value = settings.theme;

  const { hex, alpha } = parseRgba(settings.highlightColor);
  controls.highlightColor.value = hex;
  controls.highlightAlpha.value = String(Math.round(alpha * 100));
  preview.style.setProperty('--preview-highlight', settings.highlightColor);

  providerControls.translationLanguage.value = settings.translationLanguage;
  providerControls.translationProvider.value = settings.translationProvider;
  providerControls.translationEndpoint.value = settings.translationEndpoint;
  providerControls.translationApiKey.value = settings.translationApiKey;
  providerControls.dictionaryProvider.value = settings.dictionaryProvider;
  providerControls.dictionaryEndpoint.value = settings.dictionaryEndpoint;
  providerControls.pronunciationProvider.value = settings.pronunciationProvider;
  providerControls.saveContext.checked = settings.saveContext;

  askControls.askAiEnabled.checked = settings.askAiEnabled;
  askControls.askAiPreferOpenTab.checked = settings.askAiPreferOpenTab;
  askControls.askAiAnswerIn.value = settings.askAiAnswerIn;
  askControls.askAiConversation.value = settings.askAiConversation;
  askControls.askAiBackground.checked = settings.askAiBackground;
  if (document.activeElement !== askControls.askAiCustomName) {
    askControls.askAiCustomName.value = settings.askAiCustomName;
  }
  if (document.activeElement !== askControls.askAiCustomUrl) {
    askControls.askAiCustomUrl.value = settings.askAiCustomUrl;
  }
  // Skipped while the box has focus: re-rendering after every keystroke-triggered save
  // would move the caret to the end of the text mid-sentence.
  if (document.activeElement !== askControls.askAiPrompt) {
    askControls.askAiPrompt.value = settings.askAiPrompt;
  }

  applyTheme(settings.theme);
  void renderProviders(settings);
  void renderAskAi(settings);
}

// ── Ask AI ────────────────────────────────────────────────────────────────────

/** Assistants the user ticked *and* Chrome still grants. Revocation happens elsewhere. */
async function grantedAssistants(settings: Settings): Promise<Set<string>> {
  const custom = customAssistant({
    name: settings.askAiCustomName,
    url: settings.askAiCustomUrl,
  });
  const known = custom ? [...ASSISTANTS, custom] : [...ASSISTANTS];

  const granted = new Set<string>();
  for (const assistant of known) {
    if (!settings.askAiAllowed.includes(assistant.id)) continue;
    const ok = await isAssistantGranted(assistant, (origins) =>
      chrome.permissions.contains({ origins }),
    );
    if (ok) granted.add(assistant.id);
  }
  return granted;
}

/**
 * The assistant checklist, and what ticking one actually buys.
 *
 * Worth being precise about, because the permission is narrower than it sounds. SubSelect
 * does not read the conversation and does not run on the page: it asks Chrome which tabs
 * are on that site, and injects one function at the moment of a press to type the question.
 * Everything else about the browser stays invisible to it — which is the whole reason this
 * is a tick per assistant rather than the blanket `tabs` permission that would show it every
 * tab you have open.
 */
function renderAssistantList(settings: Settings, granted: Set<string>): void {
  const list = el<HTMLElement>('ask-allowed-list');
  const custom = customAssistant({
    name: settings.askAiCustomName,
    url: settings.askAiCustomUrl,
  });
  const known = custom ? [...ASSISTANTS, custom] : [...ASSISTANTS];

  list.replaceChildren(
    ...known.map((assistant) => {
      const label = document.createElement('label');
      label.dataset.granted = granted.has(assistant.id) ? 'yes' : 'no';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = granted.has(assistant.id);
      box.disabled = !settings.askAiEnabled;
      box.addEventListener('change', () => {
        void toggleAssistant(assistant, box.checked);
      });

      label.append(box, document.createTextNode(assistant.label));
      // Says where access would go, so ticking is never a blind decision.
      label.title = originsFor([assistant]).join(', ');
      return label;
    }),
  );
}

/**
 * Ticking asks Chrome; the setting only records what Chrome agreed to.
 *
 * Storing the tick first and requesting after would leave the list claiming access that was
 * refused, which is exactly the kind of lie that makes a settings page untrustworthy.
 */
async function toggleAssistant(assistant: Assistant, wanted: boolean): Promise<void> {
  const origins = originsFor([assistant]);
  const settings = await getSettings();

  if (!wanted) {
    await chrome.permissions.remove({ origins }).catch(() => undefined);
    await save({ askAiAllowed: settings.askAiAllowed.filter((id) => id !== assistant.id) });
    return;
  }

  const ok = await chrome.permissions.request({ origins }).catch(() => false);
  if (!ok) {
    // Redraw so the box springs back: it is showing a grant that does not exist.
    await rerender();
    return;
  }
  await save({ askAiAllowed: [...new Set([...settings.askAiAllowed, assistant.id])] });
}

function renderAssistantChoices(settings: Settings): void {
  const custom = customAssistant({
    name: settings.askAiCustomName,
    url: settings.askAiCustomUrl,
  });

  const options = [
    ...ASSISTANTS.map((assistant) => ({ value: assistant.id, label: assistant.label })),
    { value: 'custom', label: custom ? `${custom.label} (yours)` : 'Your own assistant…' },
  ];

  askControls.askAiAssistant.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  askControls.askAiAssistant.value = settings.askAiAssistant;
}

async function renderAskAi(settings: Settings): Promise<void> {
  const enabled = settings.askAiEnabled;
  for (const control of [
    askControls.askAiAnswerIn,
    askControls.askAiPreferOpenTab,
    askControls.askAiAssistant,
    askControls.askAiCustomName,
    askControls.askAiCustomUrl,
    askControls.askAiConversation,
    askControls.askAiBackground,
    askControls.askAiPrompt,
  ]) {
    control.disabled = !enabled;
  }

  const granted = await grantedAssistants(settings);
  renderAssistantChoices(settings);
  renderAssistantList(settings, granted);

  el<HTMLElement>('ask-custom-field').hidden =
    settings.askAiAssistant !== 'custom' && !settings.askAiCustomUrl.trim();

  el<HTMLElement>('ask-prefer-hint').textContent =
    granted.size === 0
      ? 'Tick an assistant above first — SubSelect cannot see a tab for one you have not.'
      : `On, the question goes to whichever of ${[...granted].length === 1 ? 'it' : 'them'} you used most recently, and only falls back to the choice below when none is open.`;

  const custom = customAssistant({ name: settings.askAiCustomName, url: settings.askAiCustomUrl });
  const chosen = assistantById(settings.askAiAssistant, custom);

  el<HTMLElement>('ask-assistant-hint').textContent = !chosen
    ? 'Fill in your own assistant below, or pick one from the list.'
    : chosen.promptUrl
      ? `Opens a new ${chosen.label} chat with the question already in it. Needs no access.`
      : granted.has(chosen.id)
        ? `Opens ${chosen.label} and types the question in.`
        : `${chosen.label} takes no question in a URL, so it must be ticked above before SubSelect can ask it anything.`;

  // Reading a reply out of the assistant's page needs that site's permission, exactly as
  // typing the question in does — so the panel option is only real once something is ticked.
  el<HTMLElement>('ask-answer-hint').textContent =
    settings.askAiAnswerIn === 'assistant'
      ? 'You are taken to the assistant, where the full chat is.'
      : granted.size > 0
        ? 'The reply is read back and shown under the word, so you never leave the player. SubSelect reads only the reply, and only after you press the button.'
        : 'Needs an assistant ticked above — reading the reply needs the same access as asking does. Until then the question opens the assistant instead.';

  askControls.askAiBackground.disabled = !enabled || settings.askAiAnswerIn === 'panel';

  const wantsFollowUps = settings.askAiConversation === 'follow-up';
  el<HTMLElement>('ask-conversation-hint').textContent = !wantsFollowUps
    ? 'Each question opens a clean chat. Only a tab SubSelect opened is ever reused for it.'
    : granted.size > 0
      ? 'Questions go into the chat you already have open, so the assistant keeps the context of everything you asked before it.'
      : 'Needs an assistant ticked above. Without one, every question starts a new chat instead.';
}

// ── Providers ─────────────────────────────────────────────────────────────────

/**
 * One switch for all online lookups.
 *
 * This replaced a per-host approval prompt. Approving each service the first time it was
 * reached for meant a wall of interruptions before the product did anything useful, and
 * with a provider chain there is no single host to name up front anyway. So it is one
 * decision, taken on the welcome screen or here, covering the default free services —
 * and Chrome's host permissions remain the second gate, so revoking access in the browser
 * still stops everything regardless of this setting.
 *
 * `chrome.permissions.request` needs a user gesture on an extension page, which is why
 * this lives here and not in the content script.
 */
async function renderLookups(settings: Settings): Promise<void> {
  const hint = el<HTMLElement>('lookups-hint');
  const button = el<HTMLButtonElement>('lookups-toggle');

  const granted =
    settings.termsAcceptedAt > 0 &&
    (await chrome.permissions.contains({ origins: defaultOrigins() }));

  if (granted) {
    hint.textContent =
      'On. Words you select are sent to a free service to be looked up — nothing else, and nothing in the background.';
    button.textContent = 'Turn off';
    button.onclick = () => {
      void chrome.permissions
        .remove({ origins: defaultOrigins() })
        .then(() => save({ termsAcceptedAt: 0 }));
    };
    return;
  }

  hint.textContent = settings.termsAcceptedAt > 0
    ? 'Access was revoked in Chrome. Turn it on again to use lookups.'
    : 'Off. Selecting, copying and saving still work — nothing is sent anywhere.';
  button.textContent = 'Turn on';
  button.onclick = () => {
    void chrome.permissions.request({ origins: defaultOrigins() }).then(async (ok) => {
      if (!ok) return;
      await save({ termsAcceptedAt: Date.now() });
    });
  };
}

async function renderProviders(settings: Settings): Promise<void> {
  const provider = settings.translationProvider;

  el<HTMLElement>('translation-endpoint-field').hidden = !['libretranslate', 'lingva', 'custom', 'deepl'].includes(provider);
  // Lingva takes no key.
  el<HTMLElement>('translation-key-field').hidden = !['libretranslate', 'custom', 'deepl'].includes(provider);

  const endpointHint = el<HTMLElement>('translation-endpoint-hint');
  endpointHint.textContent =
    provider === 'custom'
      ? 'Receives { text, source, target, context }, must return { "translation": "…" }.'
      : provider === 'deepl'
        ? 'Leave blank for DeepL’s free API endpoint.'
        : provider === 'lingva'
          ? 'A Lingva instance’s base URL. Public instances are volunteer-run and often down.'
          : 'Your LibreTranslate instance’s /translate URL. Self-hosting is the reliable option.';

  // Suggested instances, as one-click buttons — these projects are self-hostable and the
  // public lists go stale, so they are a starting point rather than a promise.
  const instances = el<HTMLElement>('translation-instances');
  const suggestions = PUBLIC_INSTANCES[provider] ?? [];
  instances.replaceChildren();
  if (suggestions.length > 0) {
    instances.appendChild(document.createTextNode('Try: '));
    suggestions.forEach((url, index) => {
      if (index > 0) instances.appendChild(document.createTextNode(' · '));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'linkish';
      button.textContent = url.replace(/^https?:\/\//, '');
      button.addEventListener('click', () => void save({ translationEndpoint: url }));
      instances.appendChild(button);
    });
  }

  const status = el<HTMLElement>('translation-status');
  if (provider === 'auto') {
    const chain = isOnDeviceTranslationPresent()
      ? 'On-device, then MyMemory, then Lingva.'
      : 'MyMemory, then Lingva. This browser has no built-in translator.';
    status.textContent = `Tries each in turn until one answers: ${chain}`;
  } else if (provider === 'none') {
    status.textContent = 'Translate will say it is switched off.';
  } else if (provider === 'chrome-ondevice') {
    if (!isOnDeviceTranslationPresent()) {
      status.textContent = 'This browser has no built-in translator. Choose another provider.';
    } else {
      const availability = await onDeviceAvailability(
        settings.subtitleLanguage,
        settings.translationLanguage,
      );
      status.textContent =
        availability === 'unavailable'
          ? `The built-in translator does not support ${settings.subtitleLanguage} → ${settings.translationLanguage}.`
          : availability === 'available'
            ? 'Ready. Runs on your device; nothing is sent anywhere.'
            : 'Available — the language pack downloads on first use. Nothing is sent anywhere.';
    }
  } else {
    status.textContent = 'Online provider. Selected text is sent to it when you press Translate.';
  }

  el<HTMLElement>('dictionary-endpoint-field').hidden = settings.dictionaryProvider !== 'custom';
  el<HTMLElement>('dictionary-status').textContent =
    settings.dictionaryProvider === 'auto'
      ? 'Tries each in turn until one answers: Wiktionary, then the Free Dictionary API.'
      : settings.dictionaryProvider === 'none'
        ? 'Definition will say it is switched off.'
        : 'Online provider. The selected word is sent to it when you press Definition.';

  el<HTMLElement>('pronunciation-status').textContent =
    settings.pronunciationProvider === 'wikimedia'
      ? 'Plays a native-speaker recording from Wiktionary / Lingua Libre, and falls back to speech synthesis when there is none.'
      : 'Your browser reads the word aloud. Works offline.';

  await renderLookups(settings);
}

/** Redraws from storage — for the things that change without a setting changing. */
async function rerender(): Promise<void> {
  render(await getSettings());
}

let savedTimer: ReturnType<typeof setTimeout> | null = null;
async function save(patch: Partial<Settings>): Promise<void> {
  const settings = await setSettings(patch);
  render(settings);

  savedState.textContent = 'Saved';
  if (savedTimer !== null) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedState.textContent = '';
  }, 1600);
}

function populateLanguages(): void {
  for (const select of [controls.subtitleLanguage, providerControls.translationLanguage]) {
    select.replaceChildren(
      ...SUPPORTED_LANGUAGES.map(({ code, label }) => {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = label;
        return option;
      }),
    );
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

const toggles: Array<keyof Settings & keyof typeof controls> = [
  'enabled',
  'debug',
  'clickToSelect',
  'pauseOnSelect',
  'dragToSelect',
  'doubleClickToSelect',
  'showContextMenu',
  'autoTranslate',
  'speechEnabled',
];

for (const key of toggles) {
  const input = controls[key] as HTMLInputElement;
  input.addEventListener('change', () => void save({ [key]: input.checked } as Partial<Settings>));
}

providerControls.saveContext.addEventListener('change', () => {
  void save({ saveContext: providerControls.saveContext.checked });
});

for (const key of ['askAiEnabled', 'askAiBackground', 'askAiPreferOpenTab'] as const) {
  askControls[key].addEventListener('change', () => {
    void save({ [key]: askControls[key].checked } as Partial<Settings>);
  });
}

askControls.askAiAnswerIn.addEventListener('change', () => {
  void save({ askAiAnswerIn: askControls.askAiAnswerIn.value as Settings['askAiAnswerIn'] });
});

askControls.askAiConversation.addEventListener('change', () => {
  void save({
    askAiConversation: askControls.askAiConversation.value as Settings['askAiConversation'],
  });
});

askControls.askAiAssistant.addEventListener('change', () => {
  void save({ askAiAssistant: askControls.askAiAssistant.value });
});

askControls.askAiCustomName.addEventListener('change', () => {
  void save({ askAiCustomName: askControls.askAiCustomName.value.trim() });
});

/*
 * Changing the URL drops the grant that went with the old one.
 *
 * Access was given to a specific host. Silently carrying the tick over to a different one
 * would leave the list showing access to a site the user never agreed to — so the tick is
 * cleared and they are asked again, for the site they actually typed.
 */
askControls.askAiCustomUrl.addEventListener('change', () => {
  void (async () => {
    const settings = await getSettings();
    const next = askControls.askAiCustomUrl.value.trim();
    if (next === settings.askAiCustomUrl) return;

    const previous = customAssistant({ name: settings.askAiCustomName, url: settings.askAiCustomUrl });
    if (previous) {
      await chrome.permissions.remove({ origins: originsFor([previous]) }).catch(() => undefined);
    }
    await save({
      askAiCustomUrl: next,
      askAiAllowed: settings.askAiAllowed.filter((id) => id !== 'custom'),
    });
  })();
});

// `change`, not `input`: the prompt is saved when the box is left, so a half-typed
// sentence is never what a press would send.
askControls.askAiPrompt.addEventListener('change', () => {
  void save({ askAiPrompt: askControls.askAiPrompt.value });
});

el<HTMLButtonElement>('reset-ask-prompt').addEventListener('click', () => {
  askControls.askAiPrompt.value = DEFAULT_ASK_AI_PROMPT;
  void save({ askAiPrompt: DEFAULT_ASK_AI_PROMPT });
});

providerControls.translationLanguage.addEventListener('change', () => {
  void save({ translationLanguage: providerControls.translationLanguage.value as LanguageCode });
});

providerControls.translationProvider.addEventListener('change', () => {
  const value = providerControls.translationProvider.value as Settings['translationProvider'];
  // Prefill the endpoint so a provider that has a canonical URL is one click to configure.
  const suggested = DEFAULT_ENDPOINTS[value] ?? '';
  void save({
    translationProvider: value,
    ...(providerControls.translationEndpoint.value ? {} : { translationEndpoint: suggested }),
  });
});

providerControls.translationEndpoint.addEventListener('change', () => {
  void save({ translationEndpoint: providerControls.translationEndpoint.value.trim() });
});

providerControls.translationApiKey.addEventListener('change', () => {
  void save({ translationApiKey: providerControls.translationApiKey.value.trim() });
});

providerControls.dictionaryProvider.addEventListener('change', () => {
  void save({ dictionaryProvider: providerControls.dictionaryProvider.value as Settings['dictionaryProvider'] });
});

providerControls.dictionaryEndpoint.addEventListener('change', () => {
  void save({ dictionaryEndpoint: providerControls.dictionaryEndpoint.value.trim() });
});

providerControls.pronunciationProvider.addEventListener('change', () => {
  void save({
    pronunciationProvider: providerControls.pronunciationProvider.value as Settings['pronunciationProvider'],
  });
});

el<HTMLButtonElement>('open-vocabulary').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('vocabulary.html') });
});

el<HTMLButtonElement>('clear-vocabulary').addEventListener('click', () => {
  void getVocabularyCount().then(async (count) => {
    if (count === 0) return;
    // Irreversible and local-only, so a plain confirm is the whole safeguard needed.
    if (!confirm(`Delete all ${count} saved words? This cannot be undone.`)) return;
    await clearVocabulary();
    await refreshVocabularyCount();
  });
});

async function refreshVocabularyCount(): Promise<void> {
  const count = await getVocabularyCount();
  el<HTMLElement>('vocabulary-count').textContent =
    count === 0 ? 'Nothing saved yet' : `${count} ${count === 1 ? 'word' : 'words'} on this device`;
}

controls.subtitleLanguage.addEventListener('change', () => {
  void save({ subtitleLanguage: controls.subtitleLanguage.value as LanguageCode });
});

controls.contextMenuPlacement.addEventListener('change', () => {
  void save({ contextMenuPlacement: controls.contextMenuPlacement.value as Settings['contextMenuPlacement'] });
});

controls.theme.addEventListener('change', () => {
  void save({ theme: controls.theme.value as Settings['theme'] });
});

const saveHighlight = (): void => {
  const alpha = Number(controls.highlightAlpha.value) / 100;
  void save({ highlightColor: toRgba(controls.highlightColor.value, alpha) });
};
controls.highlightColor.addEventListener('change', saveHighlight);
controls.highlightAlpha.addEventListener('change', saveHighlight);

// Live feedback while dragging the opacity slider, without a write per pixel.
controls.highlightAlpha.addEventListener('input', () => {
  const alpha = Number(controls.highlightAlpha.value) / 100;
  preview.style.setProperty('--preview-highlight', toRgba(controls.highlightColor.value, alpha));
});

el<HTMLButtonElement>('reset-appearance').addEventListener('click', () => {
  void save({
    theme: DEFAULT_SETTINGS.theme,
    highlightColor: DEFAULT_SETTINGS.highlightColor,
    highlightEdgeColor: DEFAULT_SETTINGS.highlightEdgeColor,
  });
});

el<HTMLButtonElement>('edit-shortcuts').addEventListener('click', () => {
  // Extensions cannot set their own shortcut; Chrome reserves that for the user.
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

async function showActualShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const toggle = commands.find((command) => command.name === 'toggle-interactive-subtitles');
    shortcutLabel.textContent = toggle?.shortcut || 'Not set';
  } catch {
    // Leave the manifest default showing.
  }
}

function describeSpeechSupport(): void {
  if ('speechSynthesis' in window) return;
  controls.speechEnabled.checked = false;
  controls.speechEnabled.disabled = true;
  speechHint.textContent = 'This browser has no speech synthesis available.';
}

async function init(): Promise<void> {
  populateLanguages();
  describeSpeechSupport();
  render(await getSettings());
  await refreshVocabularyCount();
  await showActualShortcut();
}

void init();
