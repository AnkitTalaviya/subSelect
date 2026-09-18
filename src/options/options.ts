import { SUPPORTED_LANGUAGES, type LanguageCode } from '@shared/constants';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { getSettings, setSettings } from '@shared/storage';
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
  dragToSelect: el<HTMLInputElement>('dragToSelect'),
  doubleClickToSelect: el<HTMLInputElement>('doubleClickToSelect'),
  showContextMenu: el<HTMLInputElement>('showContextMenu'),
  contextMenuPlacement: el<HTMLSelectElement>('contextMenuPlacement'),
  speechEnabled: el<HTMLInputElement>('speechEnabled'),
  theme: el<HTMLSelectElement>('theme'),
  highlightColor: el<HTMLInputElement>('highlightColor'),
  highlightAlpha: el<HTMLInputElement>('highlightAlpha'),
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
  controls.dragToSelect.checked = settings.dragToSelect;
  controls.doubleClickToSelect.checked = settings.doubleClickToSelect;
  controls.showContextMenu.checked = settings.showContextMenu;
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

  applyTheme(settings.theme);
  void renderProviders(settings);
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
      'On. The word you select is sent to a free service only when you press Translate, Definition or Pronounce.';
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
  'dragToSelect',
  'doubleClickToSelect',
  'showContextMenu',
  'speechEnabled',
];

for (const key of toggles) {
  const input = controls[key] as HTMLInputElement;
  input.addEventListener('change', () => void save({ [key]: input.checked } as Partial<Settings>));
}

providerControls.saveContext.addEventListener('change', () => {
  void save({ saveContext: providerControls.saveContext.checked });
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
