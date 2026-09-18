import { SESSION_KEYS } from '@shared/constants';
import { log } from '@shared/logger';
import type { AskAiResult } from '@shared/askAi';
import {
  ANSWER_SELECTORS,
  assistantForUrl,
  assistantTabsByRecency,
  originMatches,
  originsFor,
  type Assistant,
} from '@shared/assistants';

/**
 * Handing a question to an assistant the user is already signed into.
 *
 * Three routes, in this order:
 *
 *  1. **An assistant they already have open.** Whichever matching tab was used most
 *     recently gets the question typed into its composer. This is what makes the button
 *     follow attention: if Claude is the tab you were last in, the question goes to Claude,
 *     without a setting having to say so.
 *  2. **The chat this session started.** Remembered from the last press, so a conversation
 *     builds up context across an episode instead of restarting per word.
 *  3. **A new chat.** Either the assistant's published URL entry point, or — where it has
 *     none — its home page with the question typed in.
 *
 * ## What SubSelect can and cannot see
 *
 * Route 1 needs to know which tabs are assistants, and it gets that from
 * `tabs.query({ url })`, which returns **only** tabs whose origin the user has granted.
 * Everything else is invisible: not the URL, not the title, not that the tab exists. That
 * is enforced by Chrome rather than by our own discipline, which is why this works without
 * the `tabs` permission and its "read your browsing history" warning.
 *
 * ## Why it is written to expect failure
 *
 * Typing into a composer means automating someone else's interface, and it will break the
 * day any of them reshuffles their DOM. So it *detects* failure — it confirms the composer
 * emptied — and every failure path falls back to the next route. A redesign at one vendor
 * costs a new chat per word there; it does not break the button.
 */

interface RememberedTab {
  tabId: number;
  assistantId: string;
  /**
   * The assistant's match patterns, carried rather than looked up.
   *
   * The `onUpdated` watcher runs on any tab at any time and has no business reading settings
   * to find out what a custom assistant's origin is. Copying the handful of strings here
   * keeps that check synchronous and independent of configuration that may since have
   * changed — a tab opened under the old custom URL is still judged against the old one.
   */
  origins: string[];
}

async function recallTab(): Promise<RememberedTab | null> {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEYS.askAiTab);
    const value = stored[SESSION_KEYS.askAiTab] as Partial<RememberedTab> | undefined;
    if (typeof value?.tabId !== 'number' || typeof value.assistantId !== 'string') return null;
    return {
      tabId: value.tabId,
      assistantId: value.assistantId,
      origins: Array.isArray(value.origins)
        ? value.origins.filter((origin) => typeof origin === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

async function rememberTab(tabId: number | undefined, assistant: Assistant): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.storage.session.set({
      [SESSION_KEYS.askAiTab]: {
        tabId,
        assistantId: assistant.id,
        origins: [...assistant.origins],
      },
    });
  } catch (error) {
    // Losing the id costs a new chat next time, which is not worth failing the ask over.
    log.warn('could not remember the assistant tab', error);
  }
}

async function forgetTab(): Promise<void> {
  try {
    await chrome.storage.session.remove(SESSION_KEYS.askAiTab);
  } catch {
    // Nothing useful to do; the next press will find the tab gone and open a new one.
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void recallTab().then((remembered) => {
    if (remembered?.tabId === tabId) void forgetTab();
  });
});

/**
 * Forgets the remembered tab once it has demonstrably gone somewhere else.
 *
 * **Only a URL we can actually read counts as evidence.** This used to also treat a bare
 * `status: 'loading'` as the tab leaving, for assistants whose URL Chrome hides from us, and
 * that was wrong in the worst way: every assistant navigates *itself* once an answer starts
 * — `chatgpt.com/?q=…` becomes a conversation URL — and that arrives with no readable URL
 * attached. So the tab was forgotten after every single question, and the next one opened a
 * fresh tab. A new tab per word is a far worse outcome than the rare case this was guarding.
 *
 * What is given up: with no permission for that assistant, a tab the viewer repurposed can
 * still be navigated by a later question. That case needs the viewer to take over the exact
 * tab SubSelect opened, and it costs a navigation they can undo with Back. Ticking the
 * assistant in Settings removes even that, because then the URL is readable and this is
 * exact.
 *
 * No "was it us?" bookkeeping is needed. When SubSelect navigates the tab itself, the URL it
 * navigates to is the assistant's, so it matches and the tab is kept.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;

  void recallTab().then((remembered) => {
    if (remembered?.tabId !== tabId) return;
    if (remembered.origins.some((origin) => originMatches(origin, changeInfo.url))) return;
    log.info('the Ask AI tab went elsewhere; the next question will open a new chat');
    void forgetTab();
  });
});

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  try {
    if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
    // Without this the tab is selected but its window can still be behind the one the
    // video is playing in, which looks exactly like nothing having happened.
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    log.warn('could not focus the assistant tab', error);
  }
}

/**
 * Types a prompt into an assistant's composer and sends it.
 *
 * **This function is injected into the page**, so it is serialized by
 * `chrome.scripting.executeScript` and re-parsed there. It may therefore reference nothing
 * outside itself — no imports, no module constants, no helpers — because none of that
 * exists on the other side. Everything it needs is either inlined or a browser global.
 *
 * It is written against no particular assistant. Every one of them is the same shape
 * underneath — a contenteditable or textarea, and a submit control — so the selectors go
 * from most specific to most generic and the *confirmation* does the real work: whatever
 * was clicked, the question only counts as asked once the composer has emptied.
 *
 * It runs in the isolated world, so it can drive the DOM but cannot see the page's own
 * framework internals; each write below is therefore made the way a keyboard would make
 * it, so the editor's listeners fire and its model stays in step with what is on screen.
 */
function deliverPrompt(prompt: string): Promise<'sent' | 'not-sent' | 'no-composer'> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const visible = (element: Element | null): HTMLElement | null => {
    if (!(element instanceof HTMLElement)) return null;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? element : null;
  };

  const findComposer = (): HTMLElement | null => {
    // Specific first, then the shapes every chat UI shares. `visible` matters because
    // several of these ship a hidden duplicate composer for their mobile layout.
    const selectors = [
      '#prompt-textarea',
      'div[contenteditable="true"][translate="no"]',
      'form div[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'textarea[placeholder]',
      'form textarea',
      'textarea',
    ];
    for (const selector of selectors) {
      for (const candidate of Array.from(document.querySelectorAll(selector))) {
        const element = visible(candidate);
        if (element) return element;
      }
    }
    return null;
  };

  const currentText = (element: HTMLElement): string =>
    (element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '').trim();

  return (async () => {
    // The tab may have been woken from Chrome's tab discard, or simply be mid-navigation,
    // so the composer is waited for rather than required to exist already.
    let composer: HTMLElement | null = null;
    for (let attempt = 0; attempt < 40 && !composer; attempt += 1) {
      composer = findComposer();
      if (!composer) await sleep(200);
    }
    if (!composer) return 'no-composer';

    /*
     * A previous answer may still be streaming; sending on top of it is refused anyway, and
     * waiting a moment is cheaper than a failed hand-off.
     *
     * The control has to be *visible*, not merely present. Several of these keep the stop
     * button in the DOM and toggle it, so testing for existence alone meant waiting the full
     * six seconds on every single question and then deciding it was streaming anyway.
     */
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const streaming =
        visible(document.querySelector('button[data-testid="stop-button"]')) ??
        visible(document.querySelector('button[aria-label*="Stop" i]'));
      if (!streaming) break;
      await sleep(200);
    }

    composer.focus();

    if (composer instanceof HTMLTextAreaElement) {
      // React tracks the last value it wrote and ignores an input event whose value it
      // believes it already has, so the write goes through the prototype setter it hooks.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(composer, prompt);
      else composer.value = prompt;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ProseMirror, Lexical and Slate all keep their own document model and ignore DOM they
      // did not author, so setting textContent leaves the editor believing it is still empty
      // and the send button disabled. execCommand is deprecated but is the one path that
      // still produces the real beforeinput/input pair they listen for.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);

      if (!document.execCommand('insertText', false, prompt)) {
        composer.textContent = prompt;
        composer.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertText' }),
        );
      }
    }

    // The button stays disabled until the editor has processed the text, so a click fired
    // immediately lands on a dead control.
    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
      'form button:last-of-type',
    ];
    let send: HTMLButtonElement | null = null;
    for (let attempt = 0; attempt < 25 && !send; attempt += 1) {
      for (const selector of sendSelectors) {
        const candidate = document.querySelector(selector) as HTMLButtonElement | null;
        if (
          candidate &&
          !candidate.disabled &&
          candidate.getAttribute('aria-disabled') !== 'true' &&
          visible(candidate)
        ) {
          send = candidate;
          break;
        }
      }
      if (!send) await sleep(100);
    }

    if (send) {
      send.click();
    } else {
      // No button we recognise. Enter submits in every one of these so far, and an Enter
      // that goes nowhere leaves the text in the composer for the user to send themselves.
      for (const type of ['keydown', 'keypress', 'keyup'] as const) {
        composer.dispatchEvent(
          new KeyboardEvent(type, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
            composed: true,
          } as KeyboardEventInit),
        );
      }
    }

    // Confirm rather than assume: the composer clears only once the message is actually
    // submitted, so this is the one signal that distinguishes "asked" from "typed into a
    // box and left there". It is also what makes the generic selectors above safe.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (currentText(composer) === '') return 'sent';
      await sleep(100);
    }
    return 'not-sent';
  })();
}

/**
 * Reads the assistant's latest reply out of its page.
 *
 * **Injected**, so the same rule as `deliverPrompt` applies: it may reference nothing
 * outside itself. Selectors arrive as an argument rather than a closure for that reason.
 *
 * Returns the *count* of replies as well as the text, because the count is what tells the
 * caller a new answer has begun. Without it there is no way to distinguish "the answer has
 * not started yet" from "the answer is the same as last time", and the panel would show the
 * previous word's answer for the new word — confidently and wrongly.
 */
function readAnswer(selectors: string[]): { count: number; text: string; streaming: boolean } {
  let nodes: Element[] = [];
  for (const selector of selectors) {
    try {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length > nodes.length) nodes = found;
    } catch {
      // A selector this browser will not parse is simply not one of the candidates.
    }
  }

  const last = nodes[nodes.length - 1];
  const text = last instanceof HTMLElement ? (last.innerText ?? '').trim() : '';

  /*
   * Every one of these shows a stop control while generating, and it is the only signal that
   * does not depend on guessing when text has finished growing.
   *
   * Visibility, not presence: a UI that keeps the button mounted and hides it would look
   * like it was generating forever, and the panel would sit on a blinking caret until the
   * timeout — an answer that is complete on screen but never settles here.
   */
  const shown = (element: Element | null): boolean => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const streaming =
    shown(document.querySelector('button[data-testid="stop-button"]')) ||
    shown(document.querySelector('button[aria-label*="stop" i]'));

  return { count: nodes.length, text: text.slice(0, 8000), streaming };
}

/** Types the question into a tab. False for every reason it did not land. */
async function typeInto(tabId: number, prompt: string): Promise<boolean> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: deliverPrompt,
      args: [prompt],
    });
    if (injection?.result === 'sent') return true;
    log.warn(`hand-off did not land (${String(injection?.result)}); falling back`);
  } catch (error) {
    // Refused means the tab is no longer on an origin we hold — it moved, or it never was.
    log.warn('could not reach the assistant composer', error);
  }
  return false;
}

function answerSelectorsFor(assistant: Assistant): string[] {
  return [...(assistant.answerSelectors ?? []), ...ANSWER_SELECTORS];
}

/** How many replies the conversation already has, so a new one can be told apart. */
export async function countAnswers(tabId: number, assistant: Assistant): Promise<number> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readAnswer,
      args: [answerSelectorsFor(assistant)],
    });
    return injection?.result?.count ?? 0;
  } catch {
    return 0;
  }
}

export interface AnswerUpdate {
  text: string;
  done: boolean;
  error?: string;
}

/** Long enough for a slow model on a long answer; short enough to give up rather than hang. */
const ANSWER_TIMEOUT_MS = 150_000;
const ANSWER_POLL_MS = 700;

/**
 * Watches an assistant's reply appear and reports it as it grows.
 *
 * Polling rather than a MutationObserver in the page: an observer would need a long-lived
 * injected script holding a channel open, and this has to survive the worker being killed
 * and the tab being backgrounded. Polling is a few DOM reads every 700ms in one tab, only
 * while an answer is actually in flight.
 *
 * "Finished" is the stop control disappearing *and* the text going quiet for two polls.
 * Either alone is unreliable: the control flickers between tokens on some builds, and text
 * pauses mid-answer while the model thinks.
 */
export async function streamAnswer(
  tabId: number,
  assistant: Assistant,
  baseline: number,
  onUpdate: (update: AnswerUpdate) => void,
): Promise<void> {
  const selectors = answerSelectorsFor(assistant);
  const startedAt = Date.now();
  let lastText = '';
  let quietPolls = 0;
  let started = false;

  while (Date.now() - startedAt < ANSWER_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));

    let reading: { count: number; text: string; streaming: boolean } | undefined;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readAnswer,
        args: [selectors],
      });
      reading = injection?.result;
    } catch (error) {
      // The tab closed, or went somewhere we hold no permission over.
      onUpdate({ text: lastText, done: true, error: 'Lost sight of the answer.' });
      log.warn('could not read the answer', error);
      return;
    }

    if (!reading) continue;
    // Nothing new yet: the reply element appears only once the model starts.
    if (reading.count <= baseline) continue;
    started = true;

    if (reading.text !== lastText) {
      lastText = reading.text;
      quietPolls = 0;
      onUpdate({ text: lastText, done: false });
      continue;
    }

    if (!reading.streaming && lastText) {
      quietPolls += 1;
      if (quietPolls >= 2) {
        onUpdate({ text: lastText, done: true });
        return;
      }
    }
  }

  onUpdate({
    text: lastText,
    done: true,
    ...(lastText
      ? {}
      : { error: started ? 'The answer took too long.' : 'No answer appeared.' }),
  });
}

/**
 * Assistant tabs the user has open, most recently used first.
 *
 * `tabs.query` is given only the origins of assistants the user ticked, so what comes back
 * is already the whole visible world: a tab for anything else is not filtered out here, it
 * is never returned in the first place.
 *
 * `lastAccessed` is what "most recently used" means, and it is the browser's own record of
 * it rather than anything SubSelect tracks. It arrived in Chrome 121; on 109–120 it is
 * undefined, so the currently-active tab leads and the rest keep query order — which is a
 * reasonable stand-in, since a tab you are looking at is the one you most recently used.
 */
async function openAssistantTabs(
  assistants: readonly Assistant[],
): Promise<Array<{ tab: chrome.tabs.Tab; assistant: Assistant }>> {
  const origins = originsFor(assistants);
  if (origins.length === 0) return [];

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: origins });
  } catch (error) {
    log.warn('could not look for open assistant tabs', error);
    return [];
  }

  return assistantTabsByRecency(tabs, assistants);
}

async function openNewChat(
  prompt: string,
  assistant: Assistant,
  focus: boolean,
  reuse: { tabId: number; canType: boolean } | null,
): Promise<AskOutcome> {
  /*
   * With the assistant granted, the question is typed into its composer rather than put in
   * the URL. That is deliberately the *better* path: it is confirmed to have been sent, and
   * it works the same for every assistant including one that publishes no URL entry point
   * at all. The URL is what is left when there is no permission to type.
   */
  const url = assistant.promptUrl && !reuse?.canType ? assistant.promptUrl(prompt) : assistant.homeUrl;

  let tab: chrome.tabs.Tab | null = null;
  let reusedTab = false;

  if (reuse !== null) {
    tab = await chrome.tabs.update(reuse.tabId, { url, active: focus }).catch(() => null);
    reusedTab = tab !== null;
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: focus });
  }

  await rememberTab(tab.id, assistant);

  /*
   * The reply to watch for is the first one on a page that has just loaded, so the baseline
   * is zero — taking a count here would count the *old* page's replies and then wait forever
   * for one more.
   */
  let answer: AskOutcome['answer'] = reuse?.canType
    ? { tabId: tab.id as number, assistant, baseline: 0 }
    : null;

  // A home-page landing carries no question, so it has to be typed once the page is there.
  // `deliverPrompt` waits for the composer itself, which covers the load.
  if (url === assistant.homeUrl && tab.id !== undefined) {
    const typed = await typeInto(tab.id, prompt);
    if (!typed) {
      answer = null;
      if (assistant.promptUrl) {
        // Last resort: the URL entry point, which at least puts the question on screen.
        await chrome.tabs.update(tab.id, { url: assistant.promptUrl(prompt) }).catch(() => null);
      }
    }
  }

  if (focus) await focusTab(tab);
  return {
    result: { mode: 'new-chat', reusedTab, assistantLabel: assistant.label },
    answer,
  };
}

export interface AskAssistantRequest {
  prompt: string;
  /** Assistants the user ticked and Chrome granted — the only tabs we can see. */
  allowed: readonly Assistant[];
  /** Every assistant that exists, for resolving a tab opened under older settings. */
  known: readonly Assistant[];
  /** Where to go when nothing is already open. */
  fallback: Assistant;
  /** Prefer an assistant already open over `fallback`. */
  preferOpenTab: boolean;
  /** `follow-up` continues an existing chat; `new-chat` always starts a clean one. */
  conversation: 'follow-up' | 'new-chat';
  /** False leaves the user on the video, with the question sent in a background tab. */
  focus: boolean;
}

/**
 * What the hand-off did, plus where its answer can be read from.
 *
 * `answer` is null whenever the reply is out of reach — the assistant was not granted, or
 * the question went in through a URL rather than the composer. The panel then says where
 * the answer is instead of pretending to fetch one.
 */
export interface AskOutcome {
  result: AskAiResult;
  answer: { tabId: number; assistant: Assistant; baseline: number } | null;
}

export async function askAssistant(request: AskAssistantRequest): Promise<AskOutcome> {
  const remembered = await recallTab();
  const open = request.preferOpenTab ? await openAssistantTabs(request.allowed) : [];

  if (request.conversation === 'follow-up') {
    /*
     * Order matters here. The most recently used tab comes first because that is the
     * assistant the user was actually just looking at; the chat SubSelect started only wins
     * when it *is* that tab, or when nothing else is open. Preferring our own chat would
     * mean someone who deliberately switched to Claude kept being answered in ChatGPT.
     */
    const candidates = [...open];
    if (remembered && !candidates.some((entry) => entry.tab.id === remembered.tabId)) {
      /*
       * Confirmed, not merely remembered.
       *
       * The tabs in `open` were matched against assistant origins by Chrome, but this one is
       * only an id we stored earlier — and `typeInto` will inject into whatever is there now.
       * If that tab has since moved to another origin we happen to hold (youtube.com, granted
       * for subtitles), the generic composer selectors would find that page's own search box
       * and put the viewer's question in it. So it is only a candidate while it can still be
       * shown to be the assistant.
       */
      const ours = await confirmOurTab(remembered, request.allowed, request.known);
      if (ours?.canType) {
        const tab = await chrome.tabs.get(ours.tabId).catch(() => null);
        if (tab) candidates.push({ tab, assistant: ours.assistant });
      }
    }

    for (const { tab, assistant } of candidates) {
      if (tab.id === undefined) continue;
      // Counted *before* the question goes in: it is what tells a new reply apart from the
      // one still on screen from the last word.
      const baseline = await countAnswers(tab.id, assistant);
      if (await typeInto(tab.id, request.prompt)) {
        await rememberTab(tab.id, assistant);
        if (request.focus) await focusTab(tab);
        return {
          result: { mode: 'follow-up', reusedTab: true, assistantLabel: assistant.label },
          answer: { tabId: tab.id, assistant, baseline },
        };
      }
    }
  }

  /*
   * Nothing could be continued, so a new chat it is — and the only tab that may be
   * navigated for it is one SubSelect opened itself.
   *
   * Reusing *any* open assistant tab here would be worse than leaving a trail of tabs:
   * "start a new chat every time" would replace a conversation the viewer was having with
   * a fresh one about a subtitle word. Adding a message to their chat (the follow-up route
   * above) is a different thing from throwing it away.
   */
  const ours = await confirmOurTab(remembered, request.allowed, request.known);

  /*
   * An assistant that can be neither typed into nor reached by URL cannot be asked anything,
   * so reusing its tab would open a page with the question nowhere on it. That happens when
   * the viewer un-ticks an assistant with no URL entry point after a tab was already opened
   * for it. The configured fallback has been checked for exactly this and is a working
   * answer; the stale tab is not.
   */
  const usable = ours && (ours.canType || ours.assistant.promptUrl) ? ours : null;
  const assistant = usable?.assistant ?? request.fallback;
  return openNewChat(request.prompt, assistant, request.focus, usable);
}

/**
 * The tab SubSelect opened, if it is still that assistant's.
 *
 * The check is only as strong as what Chrome will show us. With the assistant granted,
 * `tab.url` is readable and this is exact. Without it the URL is hidden — so the tab is
 * taken on trust, and `onUpdated` below is what keeps that trust from going stale.
 */
async function confirmOurTab(
  remembered: RememberedTab | null,
  allowed: readonly Assistant[],
  known: readonly Assistant[],
): Promise<{ tabId: number; canType: boolean; assistant: Assistant } | null> {
  if (!remembered) return null;

  const granted = allowed.find((item) => item.id === remembered.assistantId) ?? null;
  // `known`, not `allowed`: a tab we opened before the user un-ticked that assistant is
  // still ours to reuse, we just cannot type into it any more.
  const assistant = granted ?? known.find((item) => item.id === remembered.assistantId) ?? null;
  if (!assistant) return null;

  const tab = await chrome.tabs.get(remembered.tabId).catch(() => null);
  if (!tab) return null;
  if (granted && !assistantForUrl(tab.url, [granted])) return null;

  return { tabId: remembered.tabId, canType: granted !== null, assistant };
}
