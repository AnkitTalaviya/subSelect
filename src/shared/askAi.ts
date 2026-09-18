import { languageLabel } from './constants';

/**
 * Ask AI — handing a selection to whichever assistant the user already has open (§65).
 *
 * This is deliberately *not* a provider. Every other lookup in SubSelect is a `fetch` the
 * service worker makes on the user's behalf against a keyless service; this one opens a
 * tab in the user's browser, already signed in as them, and puts a question in it. No key
 * is stored, no API is called, and what was sent is visible on screen because it is the
 * message in their own chat history.
 *
 * That difference is why it does not go through `providers/` or the provider chain, and
 * why it is not gated on `termsAcceptedAt`: the terms cover text SubSelect sends in the
 * background, and nothing here happens without a press.
 *
 * Which assistants exist lives in `assistants.ts`; this file is only about what to ask.
 *
 * Pure functions only — this module is imported by the content script, the service worker
 * and the options page alike, so it must touch no `chrome.*` API.
 */

/**
 * Upper bound on a prompt, in characters.
 *
 * A subtitle line and a word come nowhere near this; the cap exists so a pathological
 * template — or a caption that turned out to be a whole paragraph — cannot produce a URL
 * long enough to be refused on navigation.
 */
export const ASK_AI_MAX_PROMPT_CHARS = 4000;

/**
 * The default question.
 *
 * Written to get back what the panel above it cannot: why the word takes the form it does
 * *in this sentence*. The dictionary already gives the citation form, the article and the
 * plural, so asking a model to repeat them wastes the one thing it is better at.
 */
export const DEFAULT_ASK_AI_PROMPT = [
  'I am learning {language} and watching something with subtitles.',
  '',
  'Sentence: "{sentence}"',
  'Word or phrase: "{word}"',
  '',
  'Explain in {target}:',
  '1. what "{word}" means here, in this sentence specifically',
  '2. its dictionary form, and why it takes this form here',
  '3. one other example sentence using it',
  '',
  'Keep it short. Skip anything that is obvious from the translation alone.',
].join('\n');

/** Every token `fillPrompt` understands, for the settings hint and for tests. */
export const ASK_AI_PLACEHOLDERS = ['word', 'sentence', 'language', 'target'] as const;

export type AskAiPlaceholder = (typeof ASK_AI_PLACEHOLDERS)[number];

export interface AskAiVars {
  /** The selection, normalized the same way the dictionary lookup normalizes it. */
  word: string;
  /** The caption the word came from — the whole point of asking from a subtitle (§15). */
  sentence: string;
  /** Language code of the subtitle; rendered as a name, since the prompt is prose. */
  language: string;
  /** Language code the user reads in. */
  target: string;
}

/**
 * Substitutes `{word}`, `{sentence}`, `{language}` and `{target}` into a template.
 *
 * Unknown tokens are left exactly as written rather than stripped. The template is the
 * user's own text, and silently deleting a `{note}` they meant literally would be the
 * worse of the two failures — the prompt goes to a chat window where they can see it.
 *
 * An empty template falls back to the default, so clearing the box in settings cannot
 * produce a press that sends nothing but a word.
 */
export function fillPrompt(template: string, vars: AskAiVars): string {
  const source = template.trim() ? template : DEFAULT_ASK_AI_PROMPT;

  const values: Record<string, string> = {
    word: vars.word.trim(),
    // A single-word caption has no sentence to add; repeating the word reads better than
    // a dangling empty quotation.
    sentence: vars.sentence.trim() || vars.word.trim(),
    language: languageLabel(vars.language),
    target: languageLabel(vars.target),
  };

  const filled = source.replace(/\{(\w+)\}/g, (token, name: string) =>
    name in values ? (values[name] as string) : token,
  );

  return filled.trim().slice(0, ASK_AI_MAX_PROMPT_CHARS);
}

/** What the hand-off did, so the menu can say which of the two things happened. */
export type AskAiMode = 'follow-up' | 'new-chat';

export interface AskAiResult {
  mode: AskAiMode;
  /** True when the question went to a tab that was already open. */
  reusedTab: boolean;
  /** Which assistant answered the press, so the menu can name it rather than guess. */
  assistantLabel: string;
  /**
   * Set when the reply will be streamed back to the panel under this id.
   *
   * Absent means the answer is only in the assistant — either the viewer asked for it that
   * way, or it could not be read back and the panel should say where to find it.
   */
  answerRunId?: string;
  /**
   * Why the answer is not coming to the panel, when it was supposed to.
   *
   * Shown as a note rather than an error: the question *was* asked, and the answer is
   * waiting in the assistant. Only the convenience was lost.
   */
  answerUnavailable?: string;
}
