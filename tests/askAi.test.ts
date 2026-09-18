import { describe, expect, it } from 'vitest';
import { ASK_AI_MAX_PROMPT_CHARS, DEFAULT_ASK_AI_PROMPT, fillPrompt } from '@shared/askAi';
import { ASSISTANTS, assistantForUrl } from '@shared/assistants';

const chatgpt = ASSISTANTS.find((assistant) => assistant.id === 'chatgpt')!;
const chatGptUrlFor = (prompt: string): string => chatgpt.promptUrl!(prompt);
const isChatGptUrl = (url: string | undefined): boolean => assistantForUrl(url, [chatgpt]) !== null;

const vars = {
  word: 'entscheiden',
  sentence: 'Wir müssen uns jetzt entscheiden.',
  language: 'de',
  target: 'en',
};

describe('fillPrompt', () => {
  it('substitutes every placeholder it knows', () => {
    const prompt = fillPrompt('{word} / {sentence} / {language} / {target}', vars);
    expect(prompt).toBe('entscheiden / Wir müssen uns jetzt entscheiden. / German / English');
  });

  it('renders languages as names, because the prompt is prose', () => {
    expect(fillPrompt('{language}', vars)).toBe('German');
    // A cue can declare a language we have no label for; the tag beats a blank.
    expect(fillPrompt('{language}', { ...vars, language: 'sv' })).toBe('sv');
    // Regional tags fall back to the base language rather than to the raw tag.
    expect(fillPrompt('{language}', { ...vars, language: 'pt-BR' })).toBe('Portuguese');
  });

  it('leaves a token it does not know exactly as the user wrote it', () => {
    // Deleting text someone typed on purpose is the worse of the two failures — the prompt
    // lands in a chat window where they can see it either way.
    expect(fillPrompt('Ask about {word}. {note}', vars)).toBe('Ask about entscheiden. {note}');
  });

  it('falls back to the word when the selection had no sentence around it', () => {
    const prompt = fillPrompt('Sentence: "{sentence}"', { ...vars, sentence: '   ' });
    expect(prompt).toBe('Sentence: "entscheiden"');
  });

  it('falls back to the default when the template has been cleared', () => {
    // Otherwise emptying the box in settings would send a press that asks nothing.
    expect(fillPrompt('', vars)).toBe(fillPrompt(DEFAULT_ASK_AI_PROMPT, vars));
    expect(fillPrompt('   \n  ', vars)).toBe(fillPrompt(DEFAULT_ASK_AI_PROMPT, vars));
  });

  it('caps the result, so no template can produce an unnavigable URL', () => {
    const prompt = fillPrompt('x'.repeat(ASK_AI_MAX_PROMPT_CHARS + 500), vars);
    expect(prompt).toHaveLength(ASK_AI_MAX_PROMPT_CHARS);
  });

  it('fills the shipped default with something usable', () => {
    const prompt = fillPrompt(DEFAULT_ASK_AI_PROMPT, vars);
    expect(prompt).toContain('entscheiden');
    expect(prompt).toContain('Wir müssen uns jetzt entscheiden.');
    expect(prompt).toContain('German');
    expect(prompt).toContain('English');
    expect(prompt).not.toMatch(/\{\w+\}/);
  });
});

describe('chatGptUrlFor', () => {
  it('encodes the prompt into the published search parameter', () => {
    const url = new URL(chatGptUrlFor('was heißt "groß"? #1 & more'));
    expect(url.origin).toBe('https://chatgpt.com');
    expect(url.searchParams.get('q')).toBe('was heißt "groß"? #1 & more');
  });

  it('survives a newline-heavy prompt, which the default is', () => {
    const prompt = fillPrompt(DEFAULT_ASK_AI_PROMPT, vars);
    expect(new URL(chatGptUrlFor(prompt)).searchParams.get('q')).toBe(prompt);
  });
});

describe('isChatGptUrl', () => {
  it('accepts the hosts a hand-off may reuse', () => {
    expect(isChatGptUrl('https://chatgpt.com/')).toBe(true);
    expect(isChatGptUrl('https://chatgpt.com/c/abc-123')).toBe(true);
    expect(isChatGptUrl('https://chat.openai.com/c/abc-123')).toBe(true);
  });

  it('rejects anything else, including a lookalike host', () => {
    expect(isChatGptUrl(undefined)).toBe(false);
    expect(isChatGptUrl('')).toBe(false);
    expect(isChatGptUrl('not a url')).toBe(false);
    // The tab id is remembered across navigations, so a tab that wandered off must not be
    // typed into.
    expect(isChatGptUrl('https://example.com/')).toBe(false);
    expect(isChatGptUrl('https://chatgpt.com.evil.test/')).toBe(false);
    expect(isChatGptUrl('https://notchatgpt.com/')).toBe(false);
    // http would mean the hand-off could be read in transit.
    expect(isChatGptUrl('http://chatgpt.com/')).toBe(false);
  });
});
