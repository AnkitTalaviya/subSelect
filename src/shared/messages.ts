import type { FrameStatus, SubtitleSelection } from './types';
import type { DictionaryResult, ProviderOutcome, TranslationResult } from '../providers/types';
import type { PronunciationResult } from '../providers/pronunciation/providers';

/**
 * Every message crossing a runtime boundary is a member of this union (§55). There is no
 * string-keyed or untyped message passing anywhere in the extension.
 *
 * The union is small on purpose. Settings are *not* passed around as messages: every
 * context — popup, content script, service worker — reads `chrome.storage.local`
 * directly, and `chrome.storage.onChanged` broadcasts a write to all of them at once.
 * That leaves exactly one path into applying a settings change, instead of two that can
 * disagree. Messages are reserved for what storage cannot express:
 *
 *  - `GET_FRAME_STATUS`   popup → content: what does the engine in this frame see?
 *  - `SELECTION_CHANGED`  content → worker: remember the current selection for the popup.
 *
 * It grows as surfaces are added — Phase 3's keyboard commands and context popup, Phase
 * 4's provider calls, which must run in the worker rather than in a page's frame.
 */
export type ExtensionMessage =
  | { type: 'GET_FRAME_STATUS' }
  | { type: 'SELECTION_CHANGED'; selection: SubtitleSelection | null }
  | {
      type: 'TRANSLATE_SELECTION';
      text: string;
      context?: string;
      sourceLanguage?: string;
    }
  | { type: 'LOOKUP_WORD'; text: string; language?: string }
  | { type: 'FIND_PRONUNCIATION'; text: string; language?: string }
  | { type: 'SAVE_WORD'; word: SaveWordRequest }
  | { type: 'GET_VOCABULARY_COUNT' }
  // Content scripts cannot open the options page themselves, and cannot call
  // chrome.permissions at all — so approving a provider is always routed here.
  | { type: 'OPEN_OPTIONS' };

/** What the content script knows when saving; the worker fills in the rest (§20). */
export interface SaveWordRequest {
  word: string;
  context: string;
  translation?: string;
  sourceLanguage?: string;
  website?: string;
}

/** Pairs each request with its reply type, so a wrong response shape is a compile error. */
export interface MessageResponseMap {
  GET_FRAME_STATUS: FrameStatus | null;
  SELECTION_CHANGED: void;
  TRANSLATE_SELECTION: ProviderOutcome<TranslationResult>;
  LOOKUP_WORD: ProviderOutcome<DictionaryResult>;
  FIND_PRONUNCIATION: ProviderOutcome<PronunciationResult>;
  SAVE_WORD: ProviderOutcome<{ saved: true; total: number }>;
  GET_VOCABULARY_COUNT: number;
  OPEN_OPTIONS: void;
}

export type MessageOf<T extends ExtensionMessage['type']> = Extract<ExtensionMessage, { type: T }>;
export type ResponseOf<T extends ExtensionMessage['type']> = MessageResponseMap[T];

/**
 * Typed wrapper over chrome.runtime.sendMessage.
 *
 * Resolves to null instead of throwing when there is no receiver. That is a normal
 * situation — the service worker is asleep, or a frame has no engine — and not one that
 * should take down the caller.
 */
export async function sendMessage<T extends ExtensionMessage>(
  message: T,
): Promise<ResponseOf<T['type']> | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) ?? null;
  } catch {
    return null;
  }
}

/** Typed wrapper over chrome.tabs.sendMessage, for popup → content traffic. */
export async function sendToTab<T extends ExtensionMessage>(
  tabId: number,
  message: T,
  frameId?: number,
): Promise<ResponseOf<T['type']> | null> {
  try {
    const options = frameId === undefined ? {} : { frameId };
    return (await chrome.tabs.sendMessage(tabId, message, options)) ?? null;
  } catch {
    return null;
  }
}
