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

    /*
     * Anything other than "available" means a language pack still has to be fetched, which
     * can take minutes. Waiting on that leaves the user watching "Translating…" for a word
     * a remote service would have returned instantly, so the download is started in the
     * background and the chain is allowed to move on. The next request finds it ready.
     */
    if (availability !== 'available') {
      void api.create({ sourceLanguage, targetLanguage }).catch(() => {});
      throw new ProviderError(
        'unavailable',
        `The built-in translator is preparing ${sourceLanguage} → ${targetLanguage}; it will be ready shortly.`,
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

/**
 * Lingva Translate — an open-source (MIT) front end for Google Translate, the same idea
 * as Invidious for YouTube. Community-run instances, a documented REST API and no key.
 *
 *   GET  <instance>/api/v1/<source>/<target>/<text>  →  { "translation": "…" }
 *
 * Worth being straight about what this is: the instance scrapes Google Translate, so the
 * quality is Google's and the terms question belongs to whoever runs the instance rather
 * than being laundered away. It is here because it gives working translation with no
 * signup, but LibreTranslate is the recommendation for a genuinely open pipeline.
 * Public instances also come and go, which is why the endpoint is editable.
 */
class LingvaProvider implements TranslationProvider {
  readonly meta: TranslationProvider['meta'];

  constructor(private readonly endpoint: string) {
    this.meta = {
      id: 'lingva',
      label: 'Lingva Translate',
      remote: true,
      ...(hostOf(endpoint) ? { endpointHost: hostOf(endpoint) } : {}),
      ...(originOf(endpoint) ? { endpointOrigin: originOf(endpoint) } : {}),
    };
  }

  async translate(text: string, sourceLanguage?: string, targetLanguage?: string): Promise<TranslationResult> {
    assertLength(text);

    const base = this.endpoint.replace(/\/+$/, '');
    const source = sourceLanguage || 'auto';
    const target = targetLanguage || 'en';
    const url = `${base}/api/v1/${encodeURIComponent(source)}/${encodeURIComponent(target)}/${encodeURIComponent(text)}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError(
        'network',
        `Could not reach ${hostOf(base) ?? 'the Lingva instance'}. Public instances go down often — try another in settings.`,
        originOf(base),
      );
    }

    if (!response.ok) {
      throw new ProviderError('provider', `${hostOf(base) ?? 'The Lingva instance'} returned ${response.status}.`);
    }

    const payload = (await response.json().catch(() => null)) as { translation?: unknown } | null;
    if (typeof payload?.translation !== 'string') {
      throw new ProviderError('provider', 'Lingva returned no translation.');
    }

    return {
      text: payload.translation,
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      providerId: this.meta.id,
    };
  }
}

/**
 * MyMemory — a free translation memory API with no key and no signup.
 *
 *   GET /get?q=<text>&langpair=de|en  →  { responseData: { translatedText }, responseStatus }
 *
 * Anonymous use is rate limited per day, which is why it sits in a chain rather than
 * standing alone. It is reliable in a way volunteer-run instances are not, so it is the
 * remote translator SubSelect reaches for first.
 */
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
export const MYMEMORY_ORIGIN = 'https://api.mymemory.translated.net/*';

class MyMemoryProvider implements TranslationProvider {
  readonly meta = {
    id: 'mymemory',
    label: 'MyMemory',
    remote: true,
    endpointHost: 'api.mymemory.translated.net',
    endpointOrigin: MYMEMORY_ORIGIN,
  };

  async translate(text: string, sourceLanguage?: string, targetLanguage?: string): Promise<TranslationResult> {
    assertLength(text);
    const source = (sourceLanguage || 'de').split('-')[0];
    const target = (targetLanguage || 'en').split('-')[0];
    if (source === target) {
      throw new ProviderError('unsupported', `Subtitle and translation language are both ${target}.`);
    }

    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError('network', 'Could not reach MyMemory.', MYMEMORY_ORIGIN);
    }
    if (!response.ok) throw new ProviderError('provider', `MyMemory returned ${response.status}.`);

    const payload = (await response.json().catch(() => null)) as
      | { responseData?: { translatedText?: unknown }; responseStatus?: number; responseDetails?: string }
      | null;

    const translated = payload?.responseData?.translatedText;
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new ProviderError('provider', payload?.responseDetails || 'MyMemory returned no translation.');
    }
    // The daily quota is reported in the body with a 200 status.
    if (/MYMEMORY WARNING|QUOTA/i.test(translated)) {
      throw new ProviderError('provider', 'MyMemory daily limit reached.');
    }

    return { text: translated, sourceLanguage: source, targetLanguage: target, providerId: this.meta.id };
  }
}

const DEEPL_FREE = 'https://api-free.deepl.com/v2/translate';
const LINGVA_DEFAULT = 'https://lingva.ml';
export const LINGVA_ORIGIN = 'https://lingva.ml/*';

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

/**
 * The providers to try, in order, for the current settings.
 *
 * `auto` is the default and returns a chain: on-device first because it needs no network
 * at all, then the keyless remote services. Each is tried until one answers, so a service
 * being down, rate limited or simply lacking the language pair is a pause rather than a
 * dead end — which is what a single fixed provider gave.
 */
export function createTranslationChain(settings: Settings): TranslationProvider[] {
  if (settings.translationProvider !== 'auto') {
    const single = createTranslationProvider(settings);
    return single ? [single] : [];
  }

  const chain: TranslationProvider[] = [];
  if (isOnDeviceTranslationPresent()) chain.push(new OnDeviceTranslationProvider());
  chain.push(new MyMemoryProvider());
  chain.push(new LingvaProvider(LINGVA_DEFAULT));
  return chain;
}

export function createTranslationProvider(settings: Settings): TranslationProvider | null {
  switch (settings.translationProvider) {
    case 'chrome-ondevice':
      return new OnDeviceTranslationProvider();
    case 'libretranslate':
      return settings.translationEndpoint
        ? new LibreTranslateProvider(settings.translationEndpoint, settings.translationApiKey)
        : null;
    case 'lingva':
      return new LingvaProvider(settings.translationEndpoint || LINGVA_DEFAULT);
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
  lingva: LINGVA_DEFAULT,
  deepl: DEEPL_FREE,
  custom: '',
};

/**
 * Community-run instances, offered as suggestions in settings.
 *
 * Both projects are self-hostable, and self-hosting is the only way to be certain an
 * instance stays up and sees nothing it should not. These lists will go stale — they are
 * a starting point, not a guarantee.
 */
export const PUBLIC_INSTANCES: Record<string, string[]> = {
  libretranslate: [
    'https://libretranslate.com/translate',
    'https://translate.fedilab.app/translate',
    'https://libretranslate.de/translate',
  ],
  lingva: ['https://lingva.ml', 'https://lingva.lunar.icu', 'https://translate.plausibility.cloud'],
};
