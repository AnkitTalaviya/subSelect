/**
 * The assistants Ask AI can hand a question to.
 *
 * A catalogue rather than a provider chain: nothing here is ever called by SubSelect. Each
 * entry describes how to reach a chat the user is already signed into — which origins count
 * as it, and where to land to start a new conversation.
 *
 * Pure data and pure functions. Imported by the content script, the worker and the options
 * page alike, so it must touch no `chrome.*` API.
 */

export type BuiltInAssistantId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'perplexity'
  | 'copilot'
  | 'grok';

export type AssistantId = BuiltInAssistantId | 'custom';

export interface Assistant {
  id: AssistantId;
  label: string;
  /**
   * Match patterns, for `permissions.request`, for finding open tabs, and for deciding
   * whether a given tab is this assistant.
   *
   * One list for all three on purpose. These were briefly an `origins` list plus a `hosts`
   * list, and they immediately drifted: hosts appeared that no origin covered, which would
   * have meant recognising a tab we hold no permission over — visible only at runtime, as
   * the feature silently never finding anything.
   */
  origins: readonly string[];
  /**
   * A new chat with the question already in it, where the site takes one in the URL.
   *
   * Absent means the only way in is to type the question, which needs the site's
   * permission — the settings page says so rather than letting a press quietly go nowhere.
   */
  promptUrl?: (prompt: string) => string;
  /** Where to land when we are going to type the question in ourselves. */
  homeUrl: string;
  /**
   * Where this assistant's replies live, most specific first.
   *
   * Used to read an answer back into the subtitle panel. Tried before the generic patterns
   * in `ANSWER_SELECTORS`, and like every other selector here it is expected to rot: a miss
   * means the panel says it could not read the answer and offers the tab, never that it
   * invents one.
   */
  answerSelectors?: readonly string[];
}

/**
 * Fallbacks for reading a reply, tried after an assistant's own selectors.
 *
 * `data-message-author-role` is ChatGPT's but has been copied widely enough to be worth
 * trying everywhere; the rest are the shapes a chat transcript tends to take. Deliberately
 * no "last big block of text on the page" heuristic — reading the wrong element would put
 * something plausible and wrong in front of someone learning the language.
 */
export const ANSWER_SELECTORS: readonly string[] = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn"]',
  '[data-message-author-role]:not([data-message-author-role="user"])',
];

const q = (base: string) => (prompt: string) => `${base}${encodeURIComponent(prompt)}`;

/**
 * Confidence in these URL entry points is not uniform, and that is deliberate rather than
 * sloppy: ChatGPT's and Perplexity's are documented for search-engine integration, the
 * rest are the conventional `?q=` and are believed to work but are not promised by their
 * vendors. It matters less than it looks, because the URL is only used when the site has
 * *not* been granted — with the grant, the question is typed into the composer and
 * confirmed, which needs no vendor cooperation at all. Gemini publishes nothing usable, so
 * it carries no URL and says plainly that it needs access.
 */
export const ASSISTANTS: readonly Assistant[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // chat.openai.com still redirects here, and a tab left open on it is still reusable.
    origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    promptUrl: q('https://chatgpt.com/?q='),
    homeUrl: 'https://chatgpt.com/',
    answerSelectors: ['[data-message-author-role="assistant"]'],
  },
  {
    id: 'claude',
    label: 'Claude',
    origins: ['https://claude.ai/*'],
    promptUrl: q('https://claude.ai/new?q='),
    homeUrl: 'https://claude.ai/new',
    answerSelectors: ['.font-claude-message', '[data-is-streaming]'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    origins: ['https://gemini.google.com/*'],
    homeUrl: 'https://gemini.google.com/app',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    origins: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    promptUrl: q('https://www.perplexity.ai/search?q='),
    homeUrl: 'https://www.perplexity.ai/',
  },
  {
    id: 'copilot',
    label: 'Microsoft Copilot',
    origins: ['https://copilot.microsoft.com/*'],
    promptUrl: q('https://copilot.microsoft.com/?q='),
    homeUrl: 'https://copilot.microsoft.com/',
  },
  {
    id: 'grok',
    label: 'Grok',
    origins: ['https://grok.com/*'],
    promptUrl: q('https://grok.com/?q='),
    homeUrl: 'https://grok.com/',
  },
];

export const BUILT_IN_IDS: readonly BuiltInAssistantId[] = ASSISTANTS.map(
  (assistant) => assistant.id as BuiltInAssistantId,
);

/** Placeholder a custom URL uses for the question. */
export const CUSTOM_PROMPT_TOKEN = '{prompt}';

export interface CustomAssistantConfig {
  name: string;
  url: string;
}

/**
 * Builds the user's own assistant from what they typed, or null when it is unusable.
 *
 * Self-hosted front-ends — Open WebUI, LibreChat, a company deployment — differ in whether
 * they accept a question in the URL, so the shape of what was entered decides how it is
 * used. A URL containing `{prompt}` is an entry point; one without is just a page to open,
 * and the question gets typed into whatever composer is there.
 *
 * The origin is derived rather than asked for separately: a second field that must agree
 * with the first is a second field to get wrong.
 */
export function customAssistant(config: CustomAssistantConfig): Assistant | null {
  const raw = config.url.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.replace(CUSTOM_PROMPT_TOKEN, 'x'));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const label = config.name.trim() || parsed.hostname;
  const origin = `${parsed.protocol}//${parsed.host}/*`;
  const takesPromptInUrl = raw.includes(CUSTOM_PROMPT_TOKEN);

  return {
    id: 'custom',
    label,
    origins: [origin],
    homeUrl: takesPromptInUrl ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : raw,
    ...(takesPromptInUrl
      ? { promptUrl: (prompt: string) => raw.split(CUSTOM_PROMPT_TOKEN).join(encodeURIComponent(prompt)) }
      : {}),
  };
}

export function assistantById(id: string, custom: Assistant | null): Assistant | null {
  if (id === 'custom') return custom;
  return ASSISTANTS.find((assistant) => assistant.id === id) ?? null;
}

/** The hostname of a page URL, or null when it is not one we would ever act on. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // http is allowed only because a self-hosted assistant is commonly on a LAN address.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Whether a URL falls under a `scheme://host/*` match pattern.
 *
 * Scheme and hostname are both compared exactly. Exactly, because a suffix test would let
 * `chatgpt.com.evil.test` pass, and the scheme because `http://chatgpt.com` is not the site
 * we hold permission for — matching it would mean offering to type someone's question into
 * a page reached over plaintext.
 */
export function originMatches(origin: string, url: string | undefined): boolean {
  if (!url) return false;
  const separator = origin.indexOf('://');
  if (separator < 0) return false;

  const scheme = origin.slice(0, separator);
  const host = origin.slice(separator + 3).replace(/\/.*$/, '');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${scheme}:`) return false;

  // `*.example.com` covers sub-domains and the bare domain, as Chrome's patterns do.
  if (host.startsWith('*.')) {
    const bare = host.slice(2);
    return parsed.hostname === bare || parsed.hostname.endsWith(`.${bare}`);
  }
  return parsed.hostname === host;
}

/** Which assistant a tab belongs to, if any of the given ones claim it. */
export function assistantForUrl(
  url: string | undefined,
  candidates: readonly Assistant[],
): Assistant | null {
  return (
    candidates.find((assistant) =>
      assistant.origins.some((origin) => originMatches(origin, url)),
    ) ?? null
  );
}

/** The parts of a `chrome.tabs.Tab` the ranking below actually reads. */
export interface RankableTab {
  id?: number | undefined;
  url?: string | undefined;
  lastAccessed?: number | undefined;
  active?: boolean | undefined;
}

/**
 * Assistant tabs, most recently used first.
 *
 * "Most recently used" is `lastAccessed` — the browser's own record of when you were last
 * in that tab, not anything SubSelect tracks. It arrived in Chrome 121; on 109–120 it is
 * undefined for every tab, so the tie-break puts the tab you are actually looking at first,
 * which is the same answer in the case that matters.
 *
 * Tabs with no id are dropped because there is nothing to act on, and tabs that match no
 * candidate because `tabs.query` matches by pattern and a pattern is coarser than a host —
 * this is the second gate, after Chrome's own.
 */
export function assistantTabsByRecency<T extends RankableTab>(
  tabs: readonly T[],
  candidates: readonly Assistant[],
): Array<{ tab: T; assistant: Assistant }> {
  return tabs
    .map((tab) => ({ tab, assistant: assistantForUrl(tab.url, candidates) }))
    .filter(
      (entry): entry is { tab: T; assistant: Assistant } =>
        entry.assistant !== null && entry.tab.id !== undefined,
    )
    .sort((a, b) => {
      const byRecency = (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0);
      if (byRecency !== 0) return byRecency;
      return Number(b.tab.active ?? false) - Number(a.tab.active ?? false);
    });
}

/**
 * Whether Chrome will let us act on this assistant at all.
 *
 * **Any** origin, not all of them. Several assistants list a legacy alias next to their
 * current host — ChatGPT still carries `chat.openai.com` — and requiring the whole set meant
 * one revoked alias silently disabled the assistant: no tab discovery, no typing, no answer,
 * and a settings page cheerfully reporting it as off. Everything downstream already copes
 * with an origin it cannot touch, because `tabs.query` simply does not return those tabs and
 * `executeScript` refuses.
 */
export async function isAssistantGranted(
  assistant: Assistant,
  contains: (origins: string[]) => Promise<boolean>,
): Promise<boolean> {
  for (const origin of assistant.origins) {
    if (await contains([origin])) return true;
  }
  return false;
}

export function originsFor(assistants: readonly Assistant[]): string[] {
  return [...new Set(assistants.flatMap((assistant) => assistant.origins))];
}
