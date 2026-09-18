import type { SubtitleCue, SubtitleSelection, SubtitleWord } from '@shared/types';
import type { Settings } from '@shared/settings';
import {
  DOUBLE_PRESS_MS,
  DOUBLE_PRESS_SLOP_PX,
  DRAG_MAX_DISTANCE_PX,
  DRAG_THRESHOLD_PX,
} from '@shared/constants';
import { log } from '@shared/logger';
import { nextId } from '@shared/text';
import { selectionTextFor, wordsBetween } from './SubtitleParser';
import type { OverlayRenderer } from './OverlayRenderer';
import { pickWordAtPoint, type WordRect } from './hitTest';
import { Disposer } from './dom';

/**
 * Turns pointer and keyboard input on the overlay into a `SubtitleSelection`
 * (§4, §5, §6, §23, §39, §43, §44).
 *
 * ## Why the drag is ours, and the native selection is a mirror
 *
 * The brief asks for selection that feels native (§6) but warns against depending on it,
 * because players render captions in ways that often defeat normal DOM selection. Both
 * halves are honoured, in that order of authority:
 *
 *  - **We own the gesture.** `pointerdown` is prevented, the pointer is captured on the
 *    word that was pressed, and every move resolves to a word by geometry. That is
 *    word-granular, survives an ancestor with `user-select: none`, and cannot run away
 *    into the surrounding page the way a native drag can.
 *
 *  - **The native selection mirrors the result** once the gesture ends. This is not
 *    decoration: it is what makes Ctrl+C, right-click → Copy and assistive technology work
 *    at all, since a `copy` event only fires when the document has a selection. The native
 *    highlight itself is hidden inside the layer (content.css) because our own highlight
 *    has to stay readable over arbitrary video, which `::selection` cannot do.
 *
 * Copy text never comes from the native selection: a range spanning two caption lines
 * stringifies with a newline in it, and §39 wants one phrase. `selectionTextFor` slices
 * the cue by offset instead.
 */

/** Why a selection ended. */
export type ClearReason = 'user' | 'cue-change';

interface DragState {
  pointerId: number;
  captureTarget: HTMLElement;
  anchorWordId: string;
  focusWordId: string;
  startX: number;
  startY: number;
  moved: boolean;
  /** This press landed on an already-selected lone word; a click here clears it. */
  toggleOff: boolean;
  /** Read once at drag start; see OverlayRenderer.wordRects. */
  rects: WordRect[];
  /** Guards against a cue changing underneath an in-flight drag. */
  cueId: string;
}

export class SelectionManager {
  private readonly disposer = new Disposer();
  private current: SubtitleSelection | null = null;
  private drag: DragState | null = null;
  /**
   * The previous press, for double-press detection.
   *
   * Carries the cue id because word ids are derived from character offsets, so `w0-3` is
   * the first word of *every* caption — without it, a press on a new caption shortly
   * after one on the old could read as a double-press.
   */
  private lastPress: { cueId: string; wordId: string; time: number; x: number; y: number } | null = null;
  private isOwnUi: (node: Node | null) => boolean = () => false;
  private settings: Settings;

  constructor(
    private readonly renderer: OverlayRenderer,
    private readonly getCue: () => SubtitleCue | null,
    private readonly onSelection: (selection: SubtitleSelection | null, reason: ClearReason) => void,
    settings: Settings,
  ) {
    this.settings = settings;
  }

  attach(): void {
    const layer = this.renderer.mount();

    // Only word spans receive pointer events; the layer and the gaps between words are
    // transparent, so seeking, volume and the control bar keep working (§43).
    this.disposer.listen(layer, 'pointerdown', (event) => this.onPointerDown(event as PointerEvent), {
      capture: true,
    });
    this.disposer.listen(layer, 'pointermove', (event) => this.onPointerMove(event as PointerEvent), {
      capture: true,
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.disposer.listen(layer, type, (event) => this.onPointerUp(event as PointerEvent), {
        capture: true,
      });
    }

    // Players bind play/pause to several of these, so each is stopped for word hits.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) {
      this.disposer.listen(
        layer,
        type,
        (event) => {
          if (this.renderer.wordIdAt(event.target)) {
            event.stopPropagation();
            event.preventDefault();
          }
        },
        { capture: true },
      );
    }

    this.disposer.listen(
      document,
      'pointerdown',
      (event) => {
        const target = event.target as Node;
        // The context menu is a sibling of the layer, not a descendant, so it needs the
        // guard too — otherwise pressing "Copy" would clear the selection it copies.
        if (this.renderer.contains(target) || this.isOwnUi(target)) return;
        this.clear();
      },
      { capture: true },
    );

    this.disposer.listen(document, 'keydown', (event) => this.onKeyDown(event as KeyboardEvent), {
      capture: true,
    });

    // Fires for Ctrl/Cmd+C, right-click → Copy and the browser's Edit menu alike, so one
    // handler covers every way a user can ask for the text.
    this.disposer.listen(document, 'copy', (event) => this.onCopy(event as ClipboardEvent), {
      capture: true,
    });

    this.disposer.add(() => this.cancelDrag());
  }

  detach(): void {
    this.cancelDrag();
    this.disposer.dispose();
    this.current = null;
    this.lastPress = null;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /**
   * Registers extra UI that counts as "inside" for outside-click dismissal.
   *
   * Set by the engine once the context menu exists; the two cannot be wired at
   * construction because the menu's Copy action calls back into this object.
   */
  setUiGuard(guard: (node: Node | null) => boolean): void {
    this.isOwnUi = guard;
  }

  getSelection(): SubtitleSelection | null {
    return this.current;
  }

  /**
   * Drops the selection.
   *
   * `reason` matters downstream: a caption changing takes the highlighted words off the
   * screen, but it is not the user asking to be rid of the menu they just opened. See
   * SubtitleEngine.publishSelection.
   */
  clear(reason: ClearReason = 'user'): void {
    this.cancelDrag();
    if (!this.current) return;

    this.current = null;
    this.renderer.setSelected([]);
    this.clearNativeSelection();
    this.onSelection(null, reason);
  }

  /** Copies arbitrary text, for the menu acting on its own captured selection. */
  async copyText(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      this.renderer.flashNotice('Copied ✓');
      return true;
    } catch (error) {
      log.warn('clipboard write failed', error);
      return false;
    }
  }

  /** Builds and publishes a selection from a set of words in the current cue. */
  selectWords(words: SubtitleWord[]): void {
    const cue = this.getCue();
    if (!cue || words.length === 0) {
      this.clear();
      return;
    }

    const selection: SubtitleSelection = {
      id: nextId('sel'),
      text: selectionTextFor(cue, words),
      words,
      cueId: cue.id,
      // The whole cue travels with the selection: it is what makes a translation or
      // definition contextual rather than a bare word lookup (§15).
      context: cue.text,
    };
    if (cue.language) selection.language = cue.language;
    if (typeof cue.startTime === 'number') selection.startTime = cue.startTime;
    if (typeof cue.endTime === 'number') selection.endTime = cue.endTime;

    this.current = selection;
    this.renderer.setSelected(words.map((word) => word.id));

    // Mid-drag the highlight updates on every word, but subscribers do not: a six-word
    // drag would otherwise send six messages to the service worker for five throwaway
    // intermediate states. The final selection is published once, on pointerup.
    if (!this.drag?.moved) this.onSelection(selection, 'user');
  }

  /**
   * Copies the current selection (§23).
   *
   * Exactly the selected text: no translation, no label, no extension name. Phase 3's
   * context menu calls this; Ctrl+C normally goes through `onCopy` instead.
   */
  async copySelection(): Promise<boolean> {
    const text = this.current?.text;
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      this.renderer.flashNotice('Copied ✓');
      return true;
    } catch (error) {
      log.warn('clipboard write failed', error);
      return false;
    }
  }

  // ── Pointer gestures ────────────────────────────────────────────────────────

  private onPointerDown(event: PointerEvent): void {
    if (!this.settings.clickToSelect && !this.settings.dragToSelect) return;
    // Primary button only: right-click belongs to the page's context menu.
    if (event.button !== 0) return;

    const wordId = this.renderer.wordIdAt(event.target);
    if (!wordId) return;

    event.stopPropagation();
    // Prevents the browser starting its own drag-selection, and prevents focus moving
    // into the player. Our own mirror re-establishes a native selection at pointerup.
    event.preventDefault();

    const cue = this.getCue();
    const word = cue?.words.find((candidate) => candidate.id === wordId);
    if (!cue || !word) return;

    if (this.isDoublePress(event, cue.id, wordId)) {
      this.lastPress = null;
      // Single press selects a word, so the natural escalation is the whole caption —
      // which is also the unit a learner wants to translate or keep as context (§15).
      this.selectWords(cue.words.filter((candidate) => candidate.isWordLike));
      this.mirrorToNativeSelection();
      return;
    }

    this.lastPress = {
      cueId: cue.id,
      wordId,
      time: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };

    // A second, unhurried press on a lone selected word clears it, so a click is its own
    // undo — but only if the press turns out to be a click. Deciding that here would
    // break dragging outwards from a word that is already selected, so the toggle is
    // resolved at pointerup instead.
    const toggleOff = this.current?.words.length === 1 && this.current.words[0]?.id === wordId;

    const target = this.renderer.elementFor(wordId);
    if (target) {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Capture can be refused if the pointer is already gone; the drag simply ends at
        // the first move that lands outside, which is acceptable.
      }
    }

    this.drag = {
      pointerId: event.pointerId,
      captureTarget: target ?? (event.target as HTMLElement),
      anchorWordId: wordId,
      focusWordId: wordId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      toggleOff,
      rects: this.renderer.wordRects(),
      cueId: cue.id,
    };

    // Select immediately so a plain click feels instantaneous rather than waiting for
    // the pointer to come back up.
    this.selectWords([word]);
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!this.settings.dragToSelect) return;

    // A cue change mid-drag invalidates the cached rects and the word ids alike.
    if (this.getCue()?.id !== drag.cueId) {
      this.cancelDrag();
      return;
    }

    if (!drag.moved) {
      const travelled = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      this.renderer.setDragging(true);
    }

    event.stopPropagation();
    event.preventDefault();

    const wordId = pickWordAtPoint(event.clientX, event.clientY, drag.rects, DRAG_MAX_DISTANCE_PX);
    if (!wordId || wordId === drag.focusWordId) return;

    drag.focusWordId = wordId;
    this.extendSelection(drag);
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const wasDrag = drag.moved;
    if (wasDrag) {
      event.stopPropagation();
      event.preventDefault();
    }

    this.cancelDrag();

    // The press landed on an already-selected word and never became a drag, so it was a
    // click: clear, making a click its own undo.
    if (!wasDrag && drag.toggleOff) {
      this.clear();
      return;
    }

    // Publish the one selection the gesture actually produced.
    if (wasDrag && this.current) this.onSelection(this.current, 'user');

    // Mirror once, at the end of the gesture: doing it per move would fire a
    // selectionchange storm for no visible benefit, since the native highlight is hidden.
    this.mirrorToNativeSelection();
  }

  /** Two presses on the same word of the same caption, close together in time and space (§43). */
  private isDoublePress(event: PointerEvent, cueId: string, wordId: string): boolean {
    if (!this.settings.doubleClickToSelect) return false;

    const previous = this.lastPress;
    if (!previous || previous.cueId !== cueId || previous.wordId !== wordId) return false;
    if (event.timeStamp - previous.time > DOUBLE_PRESS_MS) return false;

    return Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_PRESS_SLOP_PX;
  }

  private extendSelection(drag: DragState): void {
    const cue = this.getCue();
    if (!cue) return;

    const words = wordsBetween(cue, drag.anchorWordId, drag.focusWordId);
    if (words.length > 0) this.selectWords(words);
  }

  private cancelDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;

    this.renderer.setDragging(false);
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // The element may already be detached by a cue change; nothing to release.
    }
  }

  // ── Keyboard and clipboard ──────────────────────────────────────────────────

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (!this.current) return;
      this.clear();
      // Stopped so the site does not also act on it, but never prevented: Chrome's
      // Escape-to-exit-fullscreen is not cancellable and must not be interfered with (§44).
      event.stopPropagation();
      return;
    }

    if (!this.current) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;

    // With the mirror intact the browser raises a `copy` event by itself and `onCopy`
    // supplies the text. Stepping in here as well would copy twice. This path exists for
    // the case where the mirror could not be established at all.
    if (this.hasOwnNativeSelection()) return;

    event.preventDefault();
    event.stopPropagation();
    void this.copySelection();
  }

  private onCopy(event: ClipboardEvent): void {
    if (!this.current || !this.hasOwnNativeSelection()) return;

    // The native range would stringify a two-line caption with a newline in it; §39 wants
    // one phrase, so the cue-offset slice is what goes on the clipboard.
    event.clipboardData?.setData('text/plain', this.current.text);
    event.preventDefault();
    event.stopPropagation();
    this.renderer.flashNotice('Copied ✓');
  }

  // ── Native selection mirror ─────────────────────────────────────────────────

  /**
   * Points `window.getSelection()` at exactly the selected word spans.
   *
   * The range runs from the first word to the last, so the gap spans in between are
   * included and the browser's own view of the selection matches ours.
   */
  private mirrorToNativeSelection(): void {
    const words = this.current?.words;
    if (!words || words.length === 0) return;

    const first = this.renderer.elementFor(words[0]!.id);
    const last = this.renderer.elementFor(words[words.length - 1]!.id);
    if (!first?.isConnected || !last?.isConnected) return;

    try {
      const selection = window.getSelection();
      if (!selection) return;

      const range = document.createRange();
      range.setStartBefore(first.firstChild ?? first);
      range.setEndAfter(last.lastChild ?? last);

      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      // Selection APIs can throw across unusual node arrangements. Losing the mirror only
      // costs the native Ctrl+C path, which onKeyDown then covers.
      log.debug('native selection mirror failed', error);
    }
  }

  private hasOwnNativeSelection(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    return this.renderer.contains(selection.anchorNode) && this.renderer.contains(selection.focusNode);
  }

  private clearNativeSelection(): void {
    if (!this.hasOwnNativeSelection()) return;
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // Nothing to do; an uncleared mirror is harmless.
    }
  }
}
