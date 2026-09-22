import { STORAGE_KEYS } from './constants';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { resolveLanguagePair } from './language';
import { log } from './logger';

/**
 * chrome.storage.local access (§50).
 *
 * Only settings and — from Phase 4 — vocabulary are stored. Nothing is ever written to
 * sync storage, and nothing leaves the device.
 */

export async function getSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return normalizeSettings(stored[STORAGE_KEYS.settings]);
  } catch (error) {
    log.warn('settings read failed, using defaults', error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const merged: Partial<Settings> = { ...current, ...patch };

  /*
   * Choosing a language that is already taken by the other setting swaps the two, rather
   * than being refused or quietly producing a German-to-German translation. It happens here
   * so every way of changing a language behaves the same — the popup, the settings page,
   * and anything added later — and so the rule is stated once.
   *
   * The patch is passed rather than the merged object because which field the user actually
   * touched is the whole question: the one they set wins, the other gives way.
   */
  if (patch.subtitleLanguage !== undefined || patch.translationLanguage !== undefined) {
    Object.assign(merged, resolveLanguagePair(current, {
      ...(patch.subtitleLanguage !== undefined ? { subtitleLanguage: patch.subtitleLanguage } : {}),
      ...(patch.translationLanguage !== undefined ? { translationLanguage: patch.translationLanguage } : {}),
    }));
  }

  const next = normalizeSettings(merged);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/**
 * Subscribes to settings changes.
 *
 * chrome.storage.onChanged fires in every context including the one that made the
 * change, which is exactly what we want: the content script never has to be told
 * about a settings update by the popup.
 */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.settings];
    if (!change) return;
    callback(normalizeSettings(change.newValue));
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
