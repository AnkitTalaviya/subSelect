/** URL helpers shared by the providers. */

export function hostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

/** Match pattern for the origin a provider needs, for `chrome.permissions` requests. */
export function originOf(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Plain text from a small HTML fragment.
 *
 * Providers return definitions as HTML. This runs in the **service worker**, which has no
 * DOM and therefore no `DOMParser`, so it is a deliberate string operation rather than a
 * parser. The output is only ever set with `textContent`, never inserted as markup, so
 * stripping tags is about readability rather than being the safety boundary.
 */
export function stripHtml(html: string): string {
  return html
    // Elements whose *content* is not prose. Stripping only the tags leaves the stylesheet
    // body behind, and Wiktionary inlines one into its definitions — so a perfectly good
    // gloss arrived with ".mw-parser-output .deprecated{color:…}" spliced into the middle.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (match, entity: string) => {
      const named = ENTITIES[entity.toLowerCase()];
      if (named) return named;
      const numeric = /^#(\d+)$/.exec(entity);
      return numeric ? String.fromCodePoint(Number(numeric[1])) : match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
