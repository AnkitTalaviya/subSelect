import { describe, expect, it } from 'vitest';
import {
  cleanWikitext,
  extractTemplate,
  parseGermanWikitext,
  parseTemplateParams,
} from '../src/providers/grammar/wikitext';

const NOUN = `
== Feuerwerk ({{Sprache|Deutsch}}) ==
=== {{Wortart|Substantiv|Deutsch}}, {{n}} ===

{{Deutsch Substantiv Übersicht
|Genus=n
|Nominativ Singular=Feuerwerk
|Nominativ Plural=Feuerwerke
|Genitiv Singular=Feuerwerks
|Dativ Plural=Feuerwerken
}}

{{Aussprache}}
:{{IPA}} {{Lautschrift|ˈfɔɪ̯ɐˌvɛʁk}}

{{Bedeutungen}}
:[1] Schauspiel mit pyrotechnischen Effekten

{{Synonyme}}
:[1] [[Feuerwerkskörper]], [[Pyrotechnik]]

{{Oberbegriffe}}
:[1] [[Veranstaltung]]
`;

const VERB = `
=== {{Wortart|Verb|Deutsch}} ===

{{Deutsch Verb Übersicht
|Präsens_ich=entscheide
|Präsens_du=entscheidest
|Präsens_er, sie, es=entscheidet
|Präteritum_ich=entschied
|Partizip II=entschieden
|Konjunktiv II_ich=entschiede
|Hilfsverb=haben
}}

{{Aussprache}}
:{{IPA}} {{Lautschrift|ɛntˈʃaɪ̯dn̩}}
`;

describe('extractTemplate', () => {
  it('returns the template body', () => {
    const body = extractTemplate(NOUN, 'Deutsch Substantiv Übersicht');
    expect(body).toContain('Genus=n');
    expect(body).toContain('Nominativ Plural=Feuerwerke');
  });

  it('returns null when the template is absent', () => {
    expect(extractTemplate(NOUN, 'Deutsch Verb Übersicht')).toBeNull();
  });

  it('counts brace depth rather than matching the first close', () => {
    // A nested template inside the body would end a naive regex match early.
    const nested = '{{Outer\n|A=1\n|B={{Inner|x=2}}\n|C=3\n}} trailing';
    const body = extractTemplate(nested, 'Outer');
    expect(body).toContain('C=3');
    expect(body).not.toContain('trailing');
  });

  it('survives an unterminated template', () => {
    expect(extractTemplate('{{Deutsch Substantiv Übersicht |Genus=n', 'Deutsch')).toBeNull();
  });
});

describe('parseTemplateParams', () => {
  it('reads key/value pairs', () => {
    const params = parseTemplateParams(extractTemplate(NOUN, 'Deutsch Substantiv Übersicht')!);
    expect(params['Genus']).toBe('n');
    expect(params['Nominativ Plural']).toBe('Feuerwerke');
  });

  it('does not split on a pipe inside a nested template or link', () => {
    const params = parseTemplateParams('Name|A={{x|y}}|B=[[page|label]]|C=3');
    expect(params['C']).toBe('3');
    expect(params['B']).toBe('label');
  });
});

describe('cleanWikitext', () => {
  it('unwraps links, keeping the label', () => {
    expect(cleanWikitext('[[Feuerwerk]]')).toBe('Feuerwerk');
    expect(cleanWikitext('[[page|label]]')).toBe('label');
  });

  it('strips templates, italics and html', () => {
    expect(cleanWikitext("''{{x}}text<br/>''")).toBe('text');
  });

  it('drops a reference and its citation text entirely', () => {
    // Keeping the content would splice a citation into the middle of a definition.
    expect(cleanWikitext('Feuerwerk<ref>Duden, Band 1, Seite 5</ref>')).toBe('Feuerwerk');
  });

  it('keeps German characters', () => {
    expect(cleanWikitext('[[Größe]] und [[Straße]]')).toBe('Größe und Straße');
  });
});

describe('parseGermanWikitext — nouns', () => {
  const grammar = parseGermanWikitext(NOUN);

  it('derives the article from the gender', () => {
    expect(grammar.article).toBe('das');
    expect(grammar.gender).toBe('neuter');
  });

  it('reads the plural', () => {
    expect(grammar.plural).toBe('Feuerwerke');
  });

  it('reads the pronunciation', () => {
    expect(grammar.ipa).toBe('ˈfɔɪ̯ɐˌvɛʁk');
  });

  it('reads synonyms and broader terms', () => {
    expect(grammar.synonyms).toEqual(['Feuerwerkskörper', 'Pyrotechnik']);
    expect(grammar.hypernyms).toEqual(['Veranstaltung']);
  });

  it('maps all three genders', () => {
    const article = (genus: string) =>
      parseGermanWikitext(`{{Deutsch Substantiv Übersicht\n|Genus=${genus}\n}}`).article;
    expect(article('m')).toBe('der');
    expect(article('f')).toBe('die');
    expect(article('n')).toBe('das');
  });

  it('omits a plural Wiktionary marks as nonexistent', () => {
    const grammar = parseGermanWikitext(
      '{{Deutsch Substantiv Übersicht\n|Genus=f\n|Nominativ Plural=—\n}}',
    );
    expect(grammar.plural).toBeUndefined();
    expect(grammar.article).toBe('die');
  });
});

describe('parseGermanWikitext — verbs', () => {
  const grammar = parseGermanWikitext(VERB);

  it('reads the forms a learner is taught', () => {
    expect(grammar.inflections).toMatchObject({
      Präteritum: 'entschied',
      'Partizip II': 'entschieden',
      Hilfsverb: 'haben',
    });
  });

  it('has no article or plural for a verb', () => {
    expect(grammar.article).toBeUndefined();
    expect(grammar.plural).toBeUndefined();
  });
});

describe('parseGermanWikitext — robustness', () => {
  it('returns nothing rather than nonsense for an unrelated page', () => {
    expect(parseGermanWikitext('== Something ==\nJust prose.')).toEqual({});
  });

  it('returns nothing for empty input', () => {
    expect(parseGermanWikitext('')).toEqual({});
  });

  it('still reads what it can when a template is malformed', () => {
    const grammar = parseGermanWikitext(`
      {{Deutsch Substantiv Übersicht
      |Genus=
      |Nominativ Plural=Häuser
      }}
      :{{IPA}} {{Lautschrift|haʊ̯s}}
    `);
    expect(grammar.article).toBeUndefined();
    expect(grammar.plural).toBe('Häuser');
    expect(grammar.ipa).toBe('haʊ̯s');
  });
});
