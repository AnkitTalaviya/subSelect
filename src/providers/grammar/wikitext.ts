/**
 * Pulls grammar out of German Wiktionary wikitext (§29).
 *
 * The REST definition endpoint gives meanings but not gender, plural or verb forms — and
 * for a German learner those *are* the useful part. `der/die/das` is not decoration; you
 * cannot use a noun without it. That information exists on Wiktionary only inside its
 * page templates, so this reads them.
 *
 * Wikitext is community-edited, which shapes everything here: the parse is entirely
 * best-effort, every field is optional, and a template that has changed shape yields
 * nothing rather than nonsense. Output is plain text and is only ever rendered with
 * `textContent`, never as markup.
 */

export interface GermanGrammar {
  /** `der`, `die` or `das`. */
  article?: string;
  /** Long form, e.g. "neuter". */
  gender?: string;
  plural?: string;
  /** Verb forms keyed by their German label, e.g. `Präteritum` → `entschied`. */
  inflections?: Record<string, string>;
  /** IPA, without slashes. */
  ipa?: string;
  synonyms?: string[];
  /** Broader terms — often the most useful "what kind of thing is this". */
  hypernyms?: string[];
}

const ARTICLES: Record<string, { article: string; gender: string }> = {
  m: { article: 'der', gender: 'masculine' },
  f: { article: 'die', gender: 'feminine' },
  n: { article: 'das', gender: 'neuter' },
};

/**
 * Body of the first template whose name starts with `prefix`.
 *
 * Scans brace depth rather than matching a regex, because these templates contain nested
 * ones and a greedy or lazy `}}` match gets either far too much or half a template.
 */
export function extractTemplate(wikitext: string, prefix: string): string | null {
  const start = wikitext.indexOf(`{{${prefix}`);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
      depth++;
      i++;
    } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      i++;
      if (depth === 0) return wikitext.slice(start + 2, i - 1);
    }
  }
  return null;
}

/** `|Genus=n|Nominativ Plural=Feuerwerke` → a map. Nested templates are skipped. */
export function parseTemplateParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};

  let depth = 0;
  let current = '';
  const parts: string[] = [];

  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      current += two;
      i++;
      continue;
    }
    if (two === '}}' || two === ']]') {
      depth--;
      current += two;
      i++;
      continue;
    }
    if (body[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += body[i];
  }
  parts.push(current);

  for (const part of parts.slice(1)) {
    const split = part.indexOf('=');
    if (split === -1) continue;
    const key = part.slice(0, split).trim();
    const value = cleanWikitext(part.slice(split + 1));
    if (key && value) params[key] = value;
  }

  return params;
}

/** Strips the markup a learner should never see. */
export function cleanWikitext(value: string): string {
  return (
    value
      // References go entirely, content included — stripping only the tags would splice
      // citation text into the middle of a definition.
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
      .replace(/<ref[^>]*\/>/gi, '')
      .replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1')
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/''+/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Wiki links from a list line, e.g. `:[1] [[Beschluss]], [[Wahl]]`. */
function linksFrom(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/g)) {
    const value = match[1]?.trim();
    // Skip Wiktionary's own cross-reference pages.
    if (value && !/^(?:Kategorie|Category|Verzeichnis|wikipedia):/i.test(value)) out.push(value);
  }
  return [...new Set(out)];
}

/** Items listed under a `{{Section}}` heading, until the next heading or blank line. */
function listUnder(wikitext: string, heading: string, limit = 6): string[] {
  const start = wikitext.indexOf(`{{${heading}}}`);
  if (start === -1) return [];

  const out: string[] = [];
  for (const line of wikitext.slice(start).split('\n').slice(1)) {
    if (!line.trim()) break;
    if (line.startsWith('{{') || line.startsWith('==')) break;
    out.push(...linksFrom(line));
    if (out.length >= limit) break;
  }
  return [...new Set(out)].slice(0, limit);
}

/** Verb forms worth showing, mapped from template keys to learner-facing labels. */
const VERB_FORMS: Array<[key: string, label: string]> = [
  ['Präsens_ich', 'Präsens (ich)'],
  ['Präsens_du', 'Präsens (du)'],
  ['Präsens_er, sie, es', 'Präsens (er/sie/es)'],
  ['Präteritum_ich', 'Präteritum'],
  ['Partizip II', 'Partizip II'],
  ['Konjunktiv II_ich', 'Konjunktiv II'],
  ['Imperativ Singular', 'Imperativ'],
  ['Hilfsverb', 'Hilfsverb'],
];

export function parseGermanWikitext(wikitext: string): GermanGrammar {
  const grammar: GermanGrammar = {};

  const noun = extractTemplate(wikitext, 'Deutsch Substantiv Übersicht');
  if (noun) {
    const params = parseTemplateParams(noun);
    const genus = (params['Genus'] ?? params['Genus 1'] ?? '').toLowerCase();
    const mapped = ARTICLES[genus];
    if (mapped) {
      grammar.article = mapped.article;
      grammar.gender = mapped.gender;
    }
    const plural = params['Nominativ Plural'] ?? params['Nominativ Plural 1'];
    // Wiktionary writes an em dash for nouns with no plural.
    if (plural && !/^[—–-]$/.test(plural)) grammar.plural = plural;
  }

  const verb = extractTemplate(wikitext, 'Deutsch Verb Übersicht');
  if (verb) {
    const params = parseTemplateParams(verb);
    const inflections: Record<string, string> = {};
    for (const [key, label] of VERB_FORMS) {
      const value = params[key];
      if (value) inflections[label] = value;
    }
    if (Object.keys(inflections).length > 0) grammar.inflections = inflections;
  }

  const ipa = /\{\{Lautschrift\|([^}|]+)\}\}/.exec(wikitext);
  if (ipa?.[1]) grammar.ipa = ipa[1].trim();

  const synonyms = listUnder(wikitext, 'Synonyme');
  if (synonyms.length > 0) grammar.synonyms = synonyms;

  const hypernyms = listUnder(wikitext, 'Oberbegriffe', 4);
  if (hypernyms.length > 0) grammar.hypernyms = hypernyms;

  return grammar;
}

export function hasAnyGrammar(grammar: GermanGrammar): boolean {
  return Object.values(grammar).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  );
}
