import { describe, expect, it } from 'vitest';
import {
  ASSISTANTS,
  BUILT_IN_IDS,
  assistantById,
  assistantForUrl,
  assistantTabsByRecency,
  customAssistant,
  hostOf,
  originsFor,
} from '@shared/assistants';

describe('the built-in catalogue', () => {
  it('gives every assistant a distinct id, a label and at least one origin', () => {
    expect(new Set(BUILT_IN_IDS).size).toBe(ASSISTANTS.length);
    for (const assistant of ASSISTANTS) {
      expect(assistant.origins.length).toBeGreaterThan(0);
      expect(assistant.label.trim()).not.toBe('');
    }
  });

  it('only claims https origins, since every built-in is a hosted service', () => {
    for (const assistant of ASSISTANTS) {
      for (const origin of assistant.origins) {
        expect(origin.startsWith('https://'), `${assistant.id}: ${origin}`).toBe(true);
        expect(origin.endsWith('/*'), `${assistant.id}: ${origin}`).toBe(true);
      }
    }
  });

  it('produces a usable URL from every assistant that declares one', () => {
    for (const assistant of ASSISTANTS) {
      if (!assistant.promptUrl) continue;
      const url = new URL(assistant.promptUrl('was heißt "groß"? #1 & more'));
      expect(url.searchParams.get('q')).toBe('was heißt "groß"? #1 & more');
      // The entry point has to be on a site we hold permission for, or the tab it opens is
      // one we can neither find again nor continue.
      expect(assistantForUrl(url.href, [assistant])).toBe(assistant);
    }
  });

  it('gives every assistant a home URL under one of its own origins', () => {
    for (const assistant of ASSISTANTS) {
      expect(assistantForUrl(assistant.homeUrl, [assistant]), assistant.id).toBe(assistant);
    }
  });
});

describe('assistantForUrl', () => {
  it('identifies a tab by exact hostname', () => {
    expect(assistantForUrl('https://claude.ai/chat/abc', ASSISTANTS)?.id).toBe('claude');
    expect(assistantForUrl('https://chatgpt.com/c/abc', ASSISTANTS)?.id).toBe('chatgpt');
    expect(assistantForUrl('https://chat.openai.com/c/abc', ASSISTANTS)?.id).toBe('chatgpt');
    expect(assistantForUrl('https://www.perplexity.ai/search?q=x', ASSISTANTS)?.id).toBe('perplexity');
  });

  it('refuses a lookalike host', () => {
    // The whole tab-picking mechanism rests on this: a suffix match would hand the viewer's
    // subtitle question to whoever registered the lookalike.
    expect(assistantForUrl('https://claude.ai.evil.test/', ASSISTANTS)).toBeNull();
    expect(assistantForUrl('https://notchatgpt.com/', ASSISTANTS)).toBeNull();
    expect(assistantForUrl('https://evil.test/?x=claude.ai', ASSISTANTS)).toBeNull();
  });

  it('returns null for anything that is not a page URL', () => {
    expect(assistantForUrl(undefined, ASSISTANTS)).toBeNull();
    expect(assistantForUrl('', ASSISTANTS)).toBeNull();
    expect(assistantForUrl('not a url', ASSISTANTS)).toBeNull();
    expect(assistantForUrl('chrome://extensions', ASSISTANTS)).toBeNull();
    expect(assistantForUrl('javascript:alert(1)', ASSISTANTS)).toBeNull();
  });

  it('only matches within the candidates it was given', () => {
    // Which is what keeps an un-ticked assistant from being used just because a tab is open.
    const claudeOnly = ASSISTANTS.filter((assistant) => assistant.id === 'claude');
    expect(assistantForUrl('https://chatgpt.com/', claudeOnly)).toBeNull();
    expect(assistantForUrl('https://claude.ai/', claudeOnly)?.id).toBe('claude');
  });
});

describe('customAssistant', () => {
  it('treats a URL containing {prompt} as an entry point', () => {
    const assistant = customAssistant({ name: 'Mine', url: 'https://chat.example.com/?q={prompt}' });
    expect(assistant?.label).toBe('Mine');
    expect(assistant?.promptUrl?.('hallo welt')).toBe('https://chat.example.com/?q=hallo%20welt');
    expect(assistant?.origins).toEqual(['https://chat.example.com/*']);
  });

  it('treats a URL without {prompt} as a page to open and type into', () => {
    const assistant = customAssistant({ name: '', url: 'https://llm.example.com/chat' });
    expect(assistant?.promptUrl).toBeUndefined();
    expect(assistant?.homeUrl).toBe('https://llm.example.com/chat');
    // No name given, so the host stands in rather than a blank chip in the settings list.
    expect(assistant?.label).toBe('llm.example.com');
  });

  it('substitutes every occurrence of the token', () => {
    const assistant = customAssistant({ name: '', url: 'https://x.test/?a={prompt}&b={prompt}' });
    expect(assistant?.promptUrl?.('hi')).toBe('https://x.test/?a=hi&b=hi');
  });

  it('allows http, because a self-hosted assistant is usually on a LAN address', () => {
    const assistant = customAssistant({ name: 'Local', url: 'http://192.168.1.10:3000/?q={prompt}' });
    expect(assistant?.origins).toEqual(['http://192.168.1.10:3000/*']);
  });

  it('derives the origin from the URL rather than asking for it twice', () => {
    // Two fields that must agree is a second field to get wrong.
    const assistant = customAssistant({ name: '', url: 'https://a.example.com:8443/deep/path?q={prompt}' });
    expect(assistant?.origins).toEqual(['https://a.example.com:8443/*']);
  });

  it('rejects what cannot be opened', () => {
    expect(customAssistant({ name: '', url: '' })).toBeNull();
    expect(customAssistant({ name: '', url: '   ' })).toBeNull();
    expect(customAssistant({ name: '', url: 'not a url' })).toBeNull();
    expect(customAssistant({ name: '', url: 'chat.example.com' })).toBeNull();
    // A scheme that would run code rather than open a page.
    expect(customAssistant({ name: '', url: 'javascript:alert(1)' })).toBeNull();
    expect(customAssistant({ name: '', url: 'file:///etc/passwd' })).toBeNull();
  });
});

describe('assistantById', () => {
  it('finds a built-in, and resolves custom only when one is configured', () => {
    expect(assistantById('gemini', null)?.label).toBe('Gemini');
    expect(assistantById('custom', null)).toBeNull();

    const custom = customAssistant({ name: 'Mine', url: 'https://x.test/' });
    expect(assistantById('custom', custom)?.label).toBe('Mine');
  });

  it('returns null for an id we do not have', () => {
    expect(assistantById('llama-at-home', null)).toBeNull();
  });
});

describe('assistantTabsByRecency', () => {
  const tab = (id: number, url: string, extra: Record<string, unknown> = {}) => ({ id, url, ...extra });

  it('puts the most recently used assistant tab first', () => {
    // The rule the whole feature turns on: the question follows attention rather than a
    // setting, so having just switched to Claude is what decides it.
    const ranked = assistantTabsByRecency(
      [
        tab(1, 'https://chatgpt.com/c/a', { lastAccessed: 1000 }),
        tab(2, 'https://claude.ai/chat/b', { lastAccessed: 3000 }),
        tab(3, 'https://www.perplexity.ai/', { lastAccessed: 2000 }),
      ],
      ASSISTANTS,
    );
    expect(ranked.map((entry) => entry.assistant.id)).toEqual(['claude', 'perplexity', 'chatgpt']);
    expect(ranked[0]?.tab.id).toBe(2);
  });

  it('falls back to the active tab where the browser reports no access time', () => {
    // Chrome 109–120 has no `lastAccessed`; the tab being looked at is the same answer in
    // the case that matters, and a stable order otherwise.
    const ranked = assistantTabsByRecency(
      [
        tab(1, 'https://chatgpt.com/'),
        tab(2, 'https://claude.ai/', { active: true }),
        tab(3, 'https://grok.com/'),
      ],
      ASSISTANTS,
    );
    expect(ranked[0]?.assistant.id).toBe('claude');
  });

  it('drops tabs that are not assistants, or that have no id to act on', () => {
    const ranked = assistantTabsByRecency(
      [
        tab(1, 'https://example.com/', { lastAccessed: 9000 }),
        { url: 'https://claude.ai/', lastAccessed: 8000 },
        tab(2, 'https://chatgpt.com/', { lastAccessed: 1 }),
      ],
      ASSISTANTS,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.assistant.id).toBe('chatgpt');
  });

  it('ignores an assistant the user has not ticked, even with a tab open', () => {
    // Chrome would not return that tab in the first place; this is the second gate, so a
    // widened query pattern can never quietly widen which assistants get used.
    const chatgptOnly = ASSISTANTS.filter((assistant) => assistant.id === 'chatgpt');
    const ranked = assistantTabsByRecency(
      [tab(1, 'https://claude.ai/', { lastAccessed: 9000 }), tab(2, 'https://chatgpt.com/', { lastAccessed: 1 })],
      chatgptOnly,
    );
    expect(ranked.map((entry) => entry.tab.id)).toEqual([2]);
  });

  it('returns nothing when no assistant is ticked', () => {
    expect(assistantTabsByRecency([tab(1, 'https://claude.ai/')], [])).toEqual([]);
  });
});

describe('originsFor', () => {
  it('collects origins without repeating one', () => {
    const chatgpt = ASSISTANTS.find((assistant) => assistant.id === 'chatgpt')!;
    expect(originsFor([chatgpt, chatgpt])).toEqual([...chatgpt.origins]);
  });
});

describe('hostOf', () => {
  it('accepts page URLs and refuses everything else', () => {
    expect(hostOf('https://claude.ai/x')).toBe('claude.ai');
    expect(hostOf('http://localhost:3000/')).toBe('localhost');
    expect(hostOf('chrome-extension://abc/x.html')).toBeNull();
    expect(hostOf('about:blank')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});
