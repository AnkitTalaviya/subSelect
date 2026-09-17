import type { Settings } from '@shared/settings';
import {
  ProviderError,
  type TranslationProvider,
  type TranslationResult,
} from '../types';
import { hostOf, originOf } from '../url';

/**
 * Translation providers (§17).
 *
 * Deliberately **no undocumented endpoints.** It is easy to point an extension at a
 * search engine's internal translate URL and get free translation; it is also fragile,
 * outside the terms those endpoints are offered under, and the kind of thing that gets an
 * extension pulled from the Web Store. Everything here is either on-device or an API the
 * user has configured with their own credentials.
 *
 * Every remote call runs in the service worker, for two reasons: `fetch` there is governed
 * by host permissions rather than the page's CORS policy, and an API key never has to
 * exist in a tab's process.
 */

/** Maximum characters sent in one request, so a runaway selection cannot be shipped off. */
const MAX_TEXT_LENGTH = 2000;

function assertLength(text: string): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ProviderError('provider', `Selection is too long to translate (${text.length} characters).`);
  }
}

// ── Chrome's built-in on-device translator ────────────────────────────────────

/**
 * Chrome's built-in Translator API: on-device, no key, no network request from us.
 *
 * Feature-detected in full. It is only present in recent Chrome, may need to download a
 * language pack on first use, and does not cover every language pair — so every path here
 * reports a specific reason rather than failing vaguely, and the options page shows
 * whether it is actually usable on this machine.
 */
interface TranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<{
    translate(text: string): Promise<string>;
    destroy?(): void;
  }>;
}

function translatorApi(): TranslatorApi | null {
  const api = (globalThis as { Translator?: TranslatorApi }).Translator;
  return api && typeof api.availability === 'function' && typeof api.create === 'function'
    ? api
    : null;
}

export function isOnDeviceTranslationPresent(): boolean {
  return translatorApi() !== null;
}

/** Reports what the built-in translator can do for a pair, for the options page. */
export async function onDeviceAvailability(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const api = translatorApi();
  if (!api) return 'unavailable';
  try {
    return await api.availability({ sourceLanguage, targetLanguage });
  } catch {
    return 'unavailable';
  }
}

class OnDeviceTranslationProvider implements TranslationProvider {
  readonly meta = {
    id: 'chrome-ondevice',
    label: 'On-device (Chrome built-in)',
    remote: false,
  };

  async translate(
    text: string,
    sourceLanguage?: string,
    targetLanguage?: string,
  ): Promise<TranslationResult> {
    const api = translatorApi();
    if (!api) {
      throw new ProviderError(
        'unsupported',
        "This browser has no built-in translator. Choose a different provider in SubSelect's settings.",
      );
    }
    if (!sourceLanguage || !targetLanguage) {
      throw new ProviderError('not-configured', 'Set a subtitle and translation language first.');
    }

    let availability: string;
    try {
      availability = await api.availability({ sourceLanguage, targetLanguage });
    } catch {
      availability = 'unavailable';
    }

    if (availability === 'unavailable') {
      throw new ProviderError(
        'unsupported',
        `The built-in translator does not support ${sourceLanguage} → ${targetLanguage}.`,
      );
    }

    const translator = await api.create({ sourceLanguage, targetLanguage });
    try {
      return {
        text: await translator.translate(text),
        sourceLanguage,
        targetLanguage,
        providerId: this.meta.id,
      };
    } finally {
      translator.destroy?.();
    }
  }
}

// ── HTTP providers ────────────────────────────────────────────────────────────

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ProviderError(
      'network',
      `Could not reach ${hostOf(url) ?? 'the translation service'}.`,
      originOf(url),
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      'provider',
      `${hostOf(url) ?? 'The translation service'} returned ${response.status}.`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderError('provider', 'The translation service returned an unreadable response.');
  }
}

class LibreTranslateProvider implements TranslationProvider {
  readonly meta: TranslationProvider['meta'];

  constructor(private readonly endpoint: string, private readonly apiKey: string) {
    this.meta = {
      id: 'libretranslate',
      label: 'LibreTranslate',
      remote: true,
      ...(hostOf(endpoint) ? { endpointHost: hostOf(endpoint) } : {}),
      ...(originOf(endpoint) ? { endpointOrigin: originOf(endpoint) } : {}),
    };
  }

  async translate(text: string, sourceLanguage?: string, targetLanguage?: string): Promise<TranslationResult> {
    assertLength(text);
    const payload = await postJson(
      this.endpoint,
      {
        q: text,
        source: sourceLanguage || 'auto',
        target: targetLanguage || 'en',
        format: 'text',
        ...(this.apiKey ? { api_key: this.apiKey } : {}),
      },
      {},
    );

    const translated = (payload as { translatedText?: unknown }).translatedText;
    if (typeof translated !== 'string') {
      throw new ProviderError('provider', 'LibreTranslate returned no translation.');
    }

    return {
      text: translated,
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      providerId: this.meta.id,
    };
  }
}

const DEEPL_FREE = 'https://api-free.deepl.com/v2/translate';

class DeepLProvider implements TranslationProvider {
  readonly meta: TranslationProvider['meta'];

  constructor(private readonly endpoint: string, private readonly apiKey: string) {
    this.meta = {
      id: 'deepl',
      label: 'DeepL',
      remote: true,
      ...(hostOf(endpoint) ? { endpointHost: hostOf(endpoint) } : {}),
      ...(originOf(endpoint) ? { endpointOrigin: originOf(endpoint) } : {}),
    };
  }

  async translate(text: string, sourceLanguage?: string, targetLanguage?: string): Promise<TranslationResult> {
    assertLength(text);
    if (!this.apiKey) {
      throw new ProviderError('not-configured', 'DeepL needs an API key. Add one in settings.');
    }

    const payload = await postJson(
      this.endpoint,
      {
        text: [text],
        // DeepL expects upper-case tags, and no source_lang means auto-detect.
        ...(sourceLanguage ? { source_lang: sourceLanguage.toUpperCase() } : {}),
        target_lang: (targetLanguage || 'EN').toUpperCase(),
      },
      { Authorization: `DeepL-Auth-Key ${this.apiKey}` },
    );

    const translated = (payload as { translations?: Array<{ text?: unknown }> }).translations?.[0]?.text;
    if (typeof translated !== 'string') {
      throw new ProviderError('provider', 'DeepL returned no translation.');
    }

    return {
      text: translated,
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      providerId: this.meta.id,
    };
  }
}

/**
 * A user-supplied endpoint, with a contract small enough to shim in a few lines:
 *
 *   POST  { "text": "...", "source": "de", "target": "en", "context": "..." }
 *   →     { "translation": "..." }
 */
class CustomTranslationProvider implements TranslationProvider {
  readonly meta: TranslationProvider['meta'];

  constructor(private readonly endpoint: string, private readonly apiKey: string) {
    this.meta = {
      id: 'custom',
      label: 'Custom endpoint',
      remote: true,
      ...(hostOf(endpoint) ? { endpointHost: hostOf(endpoint) } : {}),
      ...(originOf(endpoint) ? { endpointOrigin: originOf(endpoint) } : {}),
    };
  }

  async translate(
    text: string,
    sourceLanguage?: string,
    targetLanguage?: string,
    context?: string,
  ): Promise<TranslationResult> {
    assertLength(text);
    const payload = await postJson(
      this.endpoint,
      { text, source: sourceLanguage, target: targetLanguage, context },
      this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    );

    const translated = (payload as { translation?: unknown }).translation;
    if (typeof translated !== 'string') {
      throw new ProviderError(
        'provider',
        'The custom endpoint did not return a "translation" string.',
      );
    }

    return {
      text: translated,
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      providerId: this.meta.id,
    };
  }
}

export function createTranslationProvider(settings: Settings): TranslationProvider | null {
  switch (settings.translationProvider) {
    case 'chrome-ondevice':
      return new OnDeviceTranslationProvider();
    case 'libretranslate':
      return settings.translationEndpoint
        ? new LibreTranslateProvider(settings.translationEndpoint, settings.translationApiKey)
        : null;
    case 'deepl':
      return new DeepLProvider(settings.translationEndpoint || DEEPL_FREE, settings.translationApiKey);
    case 'custom':
      return settings.translationEndpoint
        ? new CustomTranslationProvider(settings.translationEndpoint, settings.translationApiKey)
        : null;
    case 'none':
    default:
      return null;
  }
}

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  libretranslate: 'https://libretranslate.com/translate',
  deepl: DEEPL_FREE,
  custom: '',
};
