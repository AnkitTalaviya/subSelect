import { SUPPORTED_LANGUAGES, type LanguageCode } from '@shared/constants';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { getSettings, setSettings } from '@shared/storage';
import { hostOf, originOf } from '../providers/url';
import {
  DEFAULT_ENDPOINTS,
  PUBLIC_INSTANCES,
  isOnDeviceTranslationPresent,
  onDeviceAvailability,
} from '../providers/translation/providers';
import { wiktionaryHostFor } from '../providers/pronunciation/providers';
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
 * Where a provider's requests would go, or null for a local or unset provider.
 *
 * The origin is derived from the endpoint rather than assumed to be `https://<host>`: a
 * self-hosted LibreTranslate is commonly plain `http` on a local port, and assuming https
 * would leave it permanently unapprovable.
 */
interface ProviderTarget {
  host: string;
  origin: string;
}

function targetFor(endpoint: string): ProviderTarget | null {
  const host = hostOf(endpoint);
  const origin = originOf(endpoint);
  return host && origin ? { host, origin } : null;
}

function translationTarget(settings: Settings): ProviderTarget | null {
  switch (settings.translationProvider) {
    case 'libretranslate':
    case 'custom':
      return targetFor(settings.translationEndpoint);
    case 'deepl':
      return targetFor(settings.translationEndpoint || DEFAULT_ENDPOINTS.deepl!);
    default:
      return null;
  }
}

function dictionaryTarget(settings: Settings): ProviderTarget | null {
  switch (settings.dictionaryProvider) {
    case 'wiktionary':
      return { host: 'en.wiktionary.org', origin: 'https://en.wiktionary.org/*' };
    case 'free-dictionary':
      return { host: 'api.dictionaryapi.dev', origin: 'https://api.dictionaryapi.dev/*' };
    case 'custom':
      return targetFor(settings.dictionaryEndpoint);
    default:
      return null;
  }
}

function pronunciationTarget(settings: Settings): ProviderTarget | null {
  if (settings.pronunciationProvider !== 'wikimedia') return null;
  // Recordings live on the Wiktionary edition for the subtitle language.
  const host = wiktionaryHostFor(settings.subtitleLanguage);
  return { host, origin: `https://${host}/*` };
}

/**
 * Shows whether a remote provider is approved, and offers the approval.
 *
 * Approval is two things at once, and both have to be true before a request is made: the
 * Chrome host permission, and the user's recorded agreement that this host may receive
 * selected text (§33). They are granted together here because this is the only context
 * that can call `chrome.permissions.request` — a content script cannot.
 */
async function renderApproval(
  kind: 'translation' | 'dictionary' | 'pronunciation',
  target: ProviderTarget | null,
  settings: Settings,
): Promise<void> {
  const field = el<HTMLElement>(`${kind}-approve-field`);
  const hint = el<HTMLElement>(`${kind}-approve-hint`);
  const button = el<HTMLButtonElement>(`${kind}-approve`);

  if (!target) {
    field.hidden = true;
    return;
  }

  field.hidden = false;
  const { host, origin } = target;
  const granted =
    settings.consentedHosts.includes(host) &&
    (await chrome.permissions.contains({ origins: [origin] }));

  if (granted) {
    hint.textContent = `Approved. Selected text is sent to ${host} when you use this action.`;
    button.textContent = 'Approved';
    button.dataset.state = 'approved';
    button.disabled = true;
    return;
  }

  hint.textContent = `Not approved yet. Nothing is sent to ${host} until you approve it.`;
  button.textContent = 'Approve';
  delete button.dataset.state;
  button.disabled = false;
  button.onclick = () => {
    void chrome.permissions.request({ origins: [origin] }).then(async (ok) => {
      if (!ok) return;
      const current = await getSettings();
      await save({ consentedHosts: [...new Set([...current.consentedHosts, host])] });
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
  if (provider === 'none') {
    status.textContent = 'Translate will say it is not set up.';
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
    settings.dictionaryProvider === 'none'
      ? 'Definition will say it is not set up.'
      : 'Online provider. The selected word is sent to it when you press Definition.';

  el<HTMLElement>('pronunciation-status').textContent =
    settings.pronunciationProvider === 'wikimedia'
      ? 'Plays a native-speaker recording from Wiktionary / Lingua Libre, and falls back to speech synthesis when there is none.'
      : 'Your browser reads the word aloud. Works offline.';

  await renderApproval('translation', translationTarget(settings), settings);
  await renderApproval('dictionary', dictionaryTarget(settings), settings);
  await renderApproval('pronunciation', pronunciationTarget(settings), settings);
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
