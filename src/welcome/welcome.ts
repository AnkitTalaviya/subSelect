import { getSettings, setSettings } from '@shared/storage';
import { defaultOrigins } from '../providers/registry';

/**
 * First-run screen.
 *
 * One decision, taken once, covering every default service — instead of an approval prompt
 * the first time each one is reached for. The permission request has to happen here
 * because `chrome.permissions.request` needs a user gesture on an extension page; a
 * content script cannot call it at all.
 *
 * Declining is a real option, not a dead end: selection, copy and save need no network.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`welcome markup is missing #${id}`);
  return node as T;
}

const status = el<HTMLParagraphElement>('status');
const done = el<HTMLElement>('done');
const accept = el<HTMLButtonElement>('accept');
const decline = el<HTMLButtonElement>('decline');

function showDone(message: string): void {
  status.textContent = message;
  done.hidden = false;
  accept.disabled = true;
  accept.textContent = 'Lookups are on';
}

accept.addEventListener('click', () => {
  status.textContent = 'Asking Chrome for access…';
  void chrome.permissions
    .request({ origins: defaultOrigins() })
    .then(async (granted) => {
      if (!granted) {
        status.textContent =
          'Chrome declined the request, so lookups stay off. Everything else still works, and you can try again from Settings.';
        return;
      }
      await setSettings({
        termsAcceptedAt: Date.now(),
        translationProvider: 'auto',
        dictionaryProvider: 'auto',
        pronunciationProvider: 'wikimedia',
      });
      showDone('Lookups are on. Translation, definitions and recordings are ready.');
    })
    .catch(() => {
      status.textContent = 'Something went wrong asking for access. You can try again from Settings.';
    });
});

decline.addEventListener('click', () => {
  status.textContent =
    'No problem — nothing will be sent anywhere. Clicking, selecting, copying and saving all work offline. Turn lookups on any time in Settings.';
  void setSettings({ termsAcceptedAt: 0 });
});

el<HTMLButtonElement>('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  const settings = await getSettings();
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);

  if (settings.termsAcceptedAt > 0) {
    showDone('Lookups are already on.');
  }
}

void init();
