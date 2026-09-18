import { describe, expect, it } from 'vitest';
import type { Settings } from '@shared/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import {
  createTranslationChain,
  createTranslationProvider,
} from '../src/providers/translation/providers';
import { createDictionaryChain } from '../src/providers/dictionary/providers';
import { findPronunciation } from '../src/providers/pronunciation/providers';
import { fetchGrammar } from '../src/providers/grammar/providers';

/**
 * Hits the real services.
 *
 * Skipped by default — a failing public API must not break `npm test`. Run it when a
 * provider is suspected:
 *
 *   SUBSELECT_LIVE=1 npm test
 *
 * This is what a fixed single provider hid: the only way to know whether the free
 * services still answer for a given word and language pair is to ask them.
 */
const live = Boolean(process.env.SUBSELECT_LIVE);

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  subtitleLanguage: 'de',
  translationLanguage: 'en',
  ...overrides,
});

describe.skipIf(!live)('live translation', () => {
  it('the auto chain translates a German noun', async () => {
    const chain = createTranslationChain(settings({ translationProvider: 'auto' }));
    expect(chain.length).toBeGreaterThan(0);

    const attempts: string[] = [];
    for (const provider of chain) {
      try {
        const result = await provider.translate('Feuerwerk', 'de', 'en');
        console.log(`  Feuerwerk → "${result.text}" via ${result.providerId}`);
        expect(result.text.toLowerCase()).toContain('firework');
        return;
      } catch (error) {
        attempts.push(`${provider.meta.label}: ${(error as Error).message}`);
      }
    }
    throw new Error(`no provider answered —\n${attempts.join('\n')}`);
  }, 30_000);

  it('reports rather than throws when a public instance rejects the request', async () => {
    // The reported symptom: libretranslate.com answers 400 without a key.
    const provider = createTranslationProvider(
      settings({
        translationProvider: 'libretranslate',
        translationEndpoint: 'https://libretranslate.com/translate',
      }),
    );
    await expect(provider!.translate('Feuerwerk', 'de', 'en')).rejects.toThrow();
  }, 30_000);
});

describe.skipIf(!live)('live dictionary', () => {
  it('finds a German word the single-provider path missed', async () => {
    const chain = createDictionaryChain(settings({ dictionaryProvider: 'auto' }));
    const attempts: string[] = [];

    for (const provider of chain) {
      try {
        const result = await provider.lookup('Feuerwerk', 'de');
        console.log(`  Feuerwerk: "${result.senses[0]!.definition}" via ${result.providerId}`);
        expect(result.senses.length).toBeGreaterThan(0);
        expect(result.senses[0]!.definition.length).toBeGreaterThan(2);
        return;
      } catch (error) {
        attempts.push(`${provider.meta.label}: ${(error as Error).message}`);
      }
    }
    throw new Error(`no provider answered —\n${attempts.join('\n')}`);
  }, 30_000);
});

describe.skipIf(!live)('translation spot-check', () => {
  /*
   * Logs what each remote translator returns for single words, which is what the product
   * asks for most. Deliberately assertion-free: translation quality is a judgement, not a
   * pass/fail, and this exists so the chain order is chosen on evidence rather than
   * assumption. MyMemory is a translation *memory*, and its single-word matches can be
   * poor — it returned "do" for "entscheiden".
   */
  it('reports single-word quality per provider', async () => {
    const words = ['entscheiden', 'Feuerwerk', 'allerdings', 'obwohl', 'Größe'];
    const chain = createTranslationChain(settings({ translationProvider: 'auto' }))
      .filter((p) => p.meta.remote);

    for (const provider of chain) {
      const line: string[] = [];
      for (const word of words) {
        try {
          const result = await provider.translate(word, 'de', 'en');
          line.push(`${word} → ${result.text}`);
        } catch (error) {
          line.push(`${word} → (${(error as Error).message.slice(0, 40)})`);
        }
      }
      console.log(`  ${provider.meta.label.padEnd(14)} ${line.join(' · ')}`);
    }
    expect(chain.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!live)('live grammar', () => {
  it('gets the article and plural for a German noun', async () => {
    const grammar = await fetchGrammar('Feuerwerk', 'de');
    console.log(`  Feuerwerk: ${JSON.stringify(grammar)}`);
    expect(grammar.article).toBe('das');
    expect(grammar.plural).toBe('Feuerwerke');
  }, 30_000);

  it('gets the past forms for a German verb', async () => {
    const grammar = await fetchGrammar('entscheiden', 'de');
    console.log(`  entscheiden: ${JSON.stringify(grammar.inflections)}`);
    expect(grammar.inflections?.['Partizip II']).toBe('entschieden');
    expect(grammar.inflections?.['Präteritum']).toBe('entschied');
  }, 30_000);

  it('gets a feminine noun right', async () => {
    const grammar = await fetchGrammar('Entscheidung', 'de');
    console.log(`  Entscheidung: ${grammar.article} / ${grammar.plural}`);
    expect(grammar.article).toBe('die');
    expect(grammar.plural).toBe('Entscheidungen');
  }, 30_000);
});

describe.skipIf(!live)('live pronunciation', () => {
  it('finds a human recording for a common German word', async () => {
    const result = await findPronunciation('Feuerwerk', 'de');
    expect(result.url).toMatch(/^https:\/\//);
    // Wikimedia appends analytics query parameters to media URLs, so the extension is
    // checked against the path rather than the whole URL.
    expect(new URL(result.url).pathname).toMatch(/\.(ogg|oga|opus|mp3|wav|flac)$/i);
    expect(result.title).toContain('Feuerwerk');
  }, 30_000);
});
