import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings';

describe('normalizeSettings', () => {
  it('falls back to defaults for missing or invalid input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('applies a partial patch over the defaults', () => {
    const settings = normalizeSettings({ enabled: false, subtitleLanguage: 'en' });
    expect(settings.enabled).toBe(false);
    expect(settings.subtitleLanguage).toBe('en');
    expect(settings.clickToSelect).toBe(DEFAULT_SETTINGS.clickToSelect);
  });

  it('ignores values of the wrong type rather than adopting them', () => {
    const settings = normalizeSettings({ enabled: 'yes', highlightColor: 12 });
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.highlightColor).toBe(DEFAULT_SETTINGS.highlightColor);
  });

  it('drops unknown keys', () => {
    const settings = normalizeSettings({ enabled: true, somethingElse: 'x' });
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('always stamps the current schema version', () => {
    expect(normalizeSettings({ version: 99 }).version).toBe(DEFAULT_SETTINGS.version);
  });

  it('accepts valid values for the enumerated settings', () => {
    expect(normalizeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(normalizeSettings({ contextMenuPlacement: 'below' }).contextMenuPlacement).toBe('below');
    expect(normalizeSettings({ askAiConversation: 'new-chat' }).askAiConversation).toBe('new-chat');
  });

  it('keeps a hand-written Ask AI prompt, but not a non-string one', () => {
    // The template is free text, so it has no enum to check — only its type.
    expect(normalizeSettings({ askAiPrompt: 'What does {word} mean?' }).askAiPrompt).toBe(
      'What does {word} mean?',
    );
    expect(normalizeSettings({ askAiPrompt: 42 }).askAiPrompt).toBe(DEFAULT_SETTINGS.askAiPrompt);
  });

  it('rejects an out-of-range value for an enumerated setting', () => {
    // The right type but not a value we handle — the overlay would otherwise be asked to
    // render a theme that has no styles.
    expect(normalizeSettings({ theme: 'solarized' }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(normalizeSettings({ contextMenuPlacement: 'left' }).contextMenuPlacement).toBe(
      DEFAULT_SETTINGS.contextMenuPlacement,
    );
    expect(normalizeSettings({ askAiConversation: 'same-tab' }).askAiConversation).toBe(
      DEFAULT_SETTINGS.askAiConversation,
    );
  });
});
