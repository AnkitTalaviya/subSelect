import type { FrameStatus } from '@shared/types';
import { SESSION_KEYS, SUPPORTED_LANGUAGES, UNSUPPORTED_MESSAGE } from '@shared/constants';
import type { LanguageCode } from '@shared/constants';
import { sendToTab } from '@shared/messages';
import { getSettings, setSettings } from '@shared/storage';
import { getVocabularyCount } from '../vocabulary/VocabularyManager';

/**
 * Popup (§46).
 *
 * Kept to the controls that do something in this build: the master switch, the subtitle
 * language, what the engine currently thinks of this page, and — so Phase 1 can be
 * verified end to end — the word that is selected right now.
 */

const enabledInput = must<HTMLInputElement>('#enabled');
const languageSelect = must<HTMLSelectElement>('#language');
const statusLine = must<HTMLParagraphElement>('#status');
const grantButton = must<HTMLButtonElement>('#grant');
const selectionBlock = must<HTMLElement>('#selection-block');
const selectionText = must<HTMLParagraphElement>('#selection-text');
const selectionContext = must<HTMLParagraphElement>('#selection-context');

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`popup markup is missing ${selector}`);
  return element;
}

const STATUS_TEXT: Record<FrameStatus['state'], string> = {
  active: 'Interactive subtitles are active.',
  'waiting-for-cue': 'Ready — waiting for the next subtitle.',
  'no-subtitle-source': UNSUPPORTED_MESSAGE,
  'no-video': 'No video found on this page.',
  disabled: 'Turned off.',
  error: 'Stood down after an error. Playback is unaffected.',
};

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function setStatus(text: string, good = false): void {
  statusLine.textContent = text;
  if (good) statusLine.setAttribute('data-tone', 'good');
  else statusLine.removeAttribute('data-tone');
}

function populateLanguages(selected: LanguageCode): void {
  languageSelect.replaceChildren(
    ...SUPPORTED_LANGUAGES.map(({ code, label }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      option.selected = code === selected;
      return option;
    }),
  );
}

/** Starts SubSelect in the current tab right now, without waiting for a reload. */
async function injectNow(tabId: number): Promise<void> {
  await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
}

async function refreshStatus(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) {
    setStatus('No active tab.');
    return;
  }

  // Broadcast to every frame; the first engine to answer wins. Frame-level detail is a
  // Phase 5 concern, when per-frame diagnostics start to matter for site testing.
  const status = await sendToTab(tab.id, { type: 'GET_FRAME_STATUS' });

  if (status) {
    setStatus(STATUS_TEXT[status.state], status.state === 'active' || status.state === 'waiting-for-cue');
    grantButton.hidden = true;
    return;
  }

  // No engine in any frame: either the site is not in the manifest's match list, or the
  // user has not granted it yet.
  const origin = originOf(tab.url);
  if (!origin) {
    setStatus('SubSelect cannot run on this page.');
    grantButton.hidden = true;
    return;
  }

  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (granted) {
    setStatus('Not running yet — reload the page.');
    grantButton.hidden = true;
    return;
  }

  setStatus(`SubSelect isn't enabled on ${new URL(origin).hostname}.`);
  grantButton.hidden = false;
  grantButton.dataset.origin = origin;
}

async function refreshSelection(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) return;

  const key = `${SESSION_KEYS.selectionPrefix}${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  const selection = stored[key] as { text?: string; context?: string } | undefined;

  if (!selection?.text) {
    selectionBlock.hidden = true;
    return;
  }

  selectionText.textContent = selection.text;
  selectionContext.textContent = selection.context ?? '';
  selectionContext.hidden = !selection.context || selection.context === selection.text;
  selectionBlock.hidden = false;
}

grantButton.addEventListener('click', () => {
  const origin = grantButton.dataset.origin;
  if (!origin) return;

  // permissions.request needs the user gesture, so it has to run here in the popup rather
  // than in the service worker. The worker reacts to permissions.onAdded and registers a
  // persistent content script for the origin.
  void chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    if (!granted) return;
    const tab = await activeTab();
    if (tab?.id) await injectNow(tab.id);
    await refreshStatus();
  });
});

enabledInput.addEventListener('change', () => {
  void setSettings({ enabled: enabledInput.checked }).then(() => refreshStatus());
});

languageSelect.addEventListener('change', () => {
  void setSettings({ subtitleLanguage: languageSelect.value as LanguageCode });
});

must<HTMLButtonElement>('#open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

must<HTMLButtonElement>('#open-vocabulary').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('vocabulary.html') });
  window.close();
});

async function refreshVocabularyCount(): Promise<void> {
  const count = await getVocabularyCount();
  must<HTMLElement>('#vocab-count').textContent = String(count);
}

async function init(): Promise<void> {
  const settings = await getSettings();
  enabledInput.checked = settings.enabled;
  populateLanguages(settings.subtitleLanguage);

  // The popup follows the same theme choice as the rest of SubSelect's surfaces.
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);

  await refreshStatus();
  await refreshSelection();
  await refreshVocabularyCount();
}

void init();
