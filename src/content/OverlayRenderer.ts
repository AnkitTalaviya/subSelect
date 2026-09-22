import type { SubtitleBox, SubtitleCue, SubtitleWord } from '@shared/types';
import { ATTR, CLASS, EXTENSION_NAME } from '@shared/constants';
import type { Settings } from '@shared/settings';
import type { AdapterPresentation } from './adapters/types';
import type { WordRect } from './hitTest';
import type { Box } from './menuPlacement';

/**
 * Draws the interaction layer (§7, §41).
 *
 * Three decisions shape this file:
 *
 *  - **The player's DOM is not restructured.** The only write to a site element is one
 *    attribute, `data-subselect-hidden`, which our manifest CSS turns into
 *    `visibility: hidden`. Wrapping the player's own caption text nodes in spans would
 *    position perfectly, but it risks throwing inside a framework's render loop, and §58
 *    makes breaking playback unacceptable.
 *
 *  - **Light DOM, not shadow DOM.** `window.getSelection()` and `Range` have to work
 *    across the word spans for Phase 2 drag selection. Page CSS can therefore reach us,
 *    which is why every rule in content.css is defensive.
 *
 *  - **Spacing comes from cue offsets.** The gaps between words are sliced out of the cue
 *    text rather than re-inserted as single spaces, so what is rendered is exactly what
 *    the cue said.
 */

export class OverlayRenderer {
  private layer: HTMLElement | null = null;
  private wordElements = new Map<string, HTMLElement>();
  private selected = new Set<string>();
  private renderedCueId: string | null = null;
  private notice: HTMLElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly presentation: AdapterPresentation) {}

  mount(): HTMLElement {
    if (this.layer) return this.layer;

    const layer = document.createElement('div');
    layer.className = CLASS.layer;
    layer.setAttribute('role', 'region');
    layer.setAttribute('aria-label', `${EXTENSION_NAME} interactive subtitle`);
    layer.setAttribute(ATTR.layerHidden, 'true');
    /*
     * Captions grow upward from their bottom edge, in both modes.
     *
     * Mirror mode is given the original's exact box, so anything that renders one line
     * taller than the player did — a font that falls back, a caption whose padding makes it
     * wrap a word earlier — used to spill downward, off the bottom of the picture, and the
     * last line was cut in half. Anchoring at the bottom keeps the overlay sitting on the
     * caption it covers and sends any overflow up into the frame, where it can still be
     * read. It is also simply how a caption behaves.
     */
    layer.setAttribute('data-ss-anchor', 'bottom');

    this.presentation.mountParent.appendChild(layer);
    this.layer = layer;
    this.hideOriginal();
    return layer;
  }

  getLayer(): HTMLElement | null {
    return this.layer;
  }

  /**
   * Puts the layer back if the page removed it.
   *
   * Players rewrite the subtree their captions live in, and an overlay mounted anywhere
   * inside it goes with it. Re-appending costs nothing and keeps the rendered words, the
   * selection and any open menu exactly as they were, where rebuilding the binding throws
   * all three away. Returns false only when there is nowhere left to put it, which is the
   * one case that really does mean the binding is finished.
   */
  ensureMounted(): boolean {
    const layer = this.layer;
    if (!layer) return false;
    if (layer.isConnected) return true;

    // While something is fullscreen, only that subtree renders (§37), so the layer goes
    // back there rather than to a mount point that is currently invisible.
    const fullscreen = document.fullscreenElement;
    const host = fullscreen instanceof HTMLElement ? fullscreen : this.presentation.mountParent;
    if (!host.isConnected) return false;

    host.appendChild(layer);
    return true;
  }

  /** True when the given node is part of our overlay. */
  contains(node: Node | null): boolean {
    return Boolean(node && this.layer?.contains(node));
  }

  applyAppearance(settings: Settings): void {
    if (!this.layer) return;
    this.layer.style.setProperty('--ss-highlight', settings.highlightColor);
    this.layer.style.setProperty('--ss-highlight-edge', settings.highlightEdgeColor);
  }

  /**
   * Writes the measured geometry and typography.
   *
   * Everything dynamic goes through custom properties on this one element, so the number
   * of scripted style writes stays small and stays in one place — which is also the
   * mitigation for the open CSP question in docs/FEASIBILITY.md §5.2.
   */
  applyBox(box: SubtitleBox): void {
    const layer = this.layer;
    if (!layer) return;

    const style = layer.style;
    style.setProperty('--ss-x', `${Math.round(box.x)}px`);
    style.setProperty('--ss-y', `${Math.round(box.y)}px`);
    style.setProperty('--ss-width', `${Math.round(box.width)}px`);
    style.setProperty('--ss-height', box.height > 0 ? `${Math.round(box.height)}px` : 'auto');
    style.setProperty('--ss-font-family', box.fontFamily);
    style.setProperty('--ss-font-size', box.fontSize);
    style.setProperty('--ss-font-weight', box.fontWeight);
    style.setProperty('--ss-line-height', box.lineHeight);
    style.setProperty('--ss-letter-spacing', box.letterSpacing);
    style.setProperty('--ss-color', box.color);
    style.setProperty('--ss-text-shadow', box.textShadow);
    style.setProperty('--ss-text-align', box.textAlign);
    style.setProperty('--ss-text-stroke', box.textStroke);
    style.setProperty('--ss-background', box.background);
    style.setProperty('--ss-padding', box.padding);
    style.setProperty('--ss-radius', box.borderRadius);

    if (box.fixed) layer.setAttribute(ATTR.layerFixed, 'true');
    else layer.removeAttribute(ATTR.layerFixed);
  }

  /** Renders a cue, or clears the layer when there is none. Identical cues are skipped. */
  render(cue: SubtitleCue | null): void {
    const layer = this.mount();

    if (!cue || cue.words.length === 0) {
      this.clear();
      return;
    }

    this.hideOriginal();

    if (cue.id === this.renderedCueId) return;
    this.renderedCueId = cue.id;
    this.selected.clear();
    this.wordElements.clear();

    const fragment = document.createDocumentFragment();
    let lineStart = 0;

    cue.lines.forEach((line, lineIndex) => {
      const lineEnd = lineStart + line.length;

      const lineEl = document.createElement('div');
      lineEl.className = CLASS.line;
      const inner = document.createElement('span');
      inner.className = CLASS.lineInner;

      let cursor = lineStart;
      for (const word of cue.words) {
        if (word.lineIndex !== lineIndex) continue;

        if (word.startIndex > cursor) {
          inner.appendChild(this.createGap(cue.text.slice(cursor, word.startIndex)));
        }
        inner.appendChild(this.createToken(word));
        cursor = word.endIndex;
      }
      if (cursor < lineEnd) inner.appendChild(this.createGap(cue.text.slice(cursor, lineEnd)));

      lineEl.appendChild(inner);
      fragment.appendChild(lineEl);

      lineStart = lineEnd + 1; // +1 for the '\n' that split() removed
    });

    layer.replaceChildren(fragment);
    // replaceChildren just removed the notice along with the old cue; put it back if it
    // is mid-flash, so a "Copied ✓" is not cut short by the next caption.
    if (this.notice?.hasAttribute('data-ss-show')) layer.appendChild(this.notice);
    layer.removeAttribute(ATTR.layerHidden);
  }

  /**
   * Empties the layer without unmounting it.
   *
   * The original stays hidden deliberately. Un-hiding it in the gap between two cues
   * would make the player's own text flash for a frame every time a caption changes;
   * it is restored only when the overlay is destroyed.
   */
  clear(): void {
    this.renderedCueId = null;
    this.selected.clear();
    this.wordElements.clear();
    if (this.layer) {
      this.layer.replaceChildren();
      this.layer.setAttribute(ATTR.layerHidden, 'true');
    }
  }

  setSelected(wordIds: Iterable<string>): void {
    for (const id of this.selected) {
      this.wordElements.get(id)?.removeAttribute(ATTR.selected);
    }
    this.selected = new Set(wordIds);
    for (const id of this.selected) {
      this.wordElements.get(id)?.setAttribute(ATTR.selected, 'true');
    }
    this.bridgeGaps();
  }

  /**
   * Highlights the spaces *between* selected words, so a phrase reads as one mark.
   *
   * Only the words carry the highlight otherwise, and the gaps between them stay clear —
   * which renders a four-word phrase as four separate boxes rather than one selection.
   * Bridging is done per line, so a selection spanning two caption lines does not paint a
   * band across the empty end of the first one.
   */
  private bridgeGaps(): void {
    const layer = this.layer;
    if (!layer) return;

    for (const gap of layer.querySelectorAll(`.${CLASS.gap}[${ATTR.selected}]`)) {
      gap.removeAttribute(ATTR.selected);
    }
    if (this.selected.size < 2) return;

    for (const line of layer.querySelectorAll(`.${CLASS.lineInner}`)) {
      const children = [...line.children];
      const isSelectedWord = (node: Element): boolean =>
        node.classList.contains(CLASS.word) && node.hasAttribute(ATTR.selected);

      const first = children.findIndex(isSelectedWord);
      if (first === -1) continue;
      let last = first;
      for (let i = children.length - 1; i > first; i--) {
        if (isSelectedWord(children[i]!)) {
          last = i;
          break;
        }
      }

      for (let i = first + 1; i < last; i++) {
        const node = children[i]!;
        if (node.classList.contains(CLASS.gap)) node.setAttribute(ATTR.selected, 'true');
      }
    }
  }

  getSelected(): Set<string> {
    return new Set(this.selected);
  }

  /** Maps an event target back to a word id, if it is one of ours. */
  wordIdAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const element = target.closest(`.${CLASS.word}`);
    return element?.getAttribute(ATTR.wordId) ?? null;
  }

  /**
   * Live rect of one rendered word.
   *
   * Phase 3 anchors the context popup to this. Measurement is on demand rather than per
   * cue, because reading a rect forces layout and a cue change already costs one.
   */
  rectOf(wordId: string): DOMRect | null {
    return this.wordElements.get(wordId)?.getBoundingClientRect() ?? null;
  }

  elementFor(wordId: string): HTMLElement | null {
    return this.wordElements.get(wordId) ?? null;
  }

  /**
   * Union of the currently selected words' rects, in viewport coordinates.
   *
   * The context menu anchors to this rather than to a single word, so a multi-word phrase
   * gets a menu centred on the phrase instead of on whichever word happened to be first.
   */
  selectionRect(): Box | null {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let found = false;

    for (const id of this.selected) {
      const element = this.wordElements.get(id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;

      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      found = true;
    }

    return found ? { left, top, right, bottom } : null;
  }

  /**
   * Viewport rects for every rendered word, in document order.
   *
   * Read once at the start of a drag rather than on each move: this is a forced layout per
   * word, and doing it on pointermove would put it on the hot path for no benefit — the
   * caption box does not move while a single cue is on screen.
   */
  wordRects(): WordRect[] {
    const rects: WordRect[] = [];
    for (const [id, element] of this.wordElements) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      rects.push({ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    return rects;
  }

  /**
   * Moves the layer under a different host, for the fullscreen rule in SubtitleEngine.
   * `restoreParent` puts it back where the adapter said it belongs.
   */
  reparentTo(host: HTMLElement): void {
    if (this.layer && this.layer.parentElement !== host) host.appendChild(this.layer);
  }

  restoreParent(): void {
    this.reparentTo(this.presentation.mountParent);
  }

  /** Hides the whole layer without tearing it down, for cases we cannot overlay at all. */
  setSuppressed(suppressed: boolean): void {
    if (!this.layer) return;
    if (suppressed) this.layer.setAttribute(ATTR.layerSuppressed, 'true');
    else this.layer.removeAttribute(ATTR.layerSuppressed);
  }

  setDragging(dragging: boolean): void {
    if (!this.layer) return;
    if (dragging) this.layer.setAttribute(ATTR.layerDragging, 'true');
    else this.layer.removeAttribute(ATTR.layerDragging);
  }

  /**
   * Brief confirmation above the caption, e.g. "Copied ✓" (§23).
   *
   * Deliberately tiny and non-interactive: it confirms an action the user just took, and
   * must never become something that covers the video or has to be dismissed.
   */
  flashNotice(text: string, durationMs = 1400): void {
    const layer = this.layer;
    if (!layer) return;

    const notice = this.ensureNotice(layer);
    notice.textContent = text;
    notice.setAttribute('data-ss-show', 'true');

    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      notice.removeAttribute('data-ss-show');
    }, durationMs);
  }

  private ensureNotice(layer: HTMLElement): HTMLElement {
    if (this.notice?.isConnected) return this.notice;

    const notice = this.notice ?? document.createElement('div');
    notice.className = CLASS.notice;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    layer.appendChild(notice);
    this.notice = notice;
    return notice;
  }

  destroy(): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = null;
    this.restoreOriginal();
    this.layer?.remove();
    this.layer = null;
    this.wordElements.clear();
    this.selected.clear();
    this.renderedCueId = null;
  }

  private createToken(word: SubtitleWord): HTMLElement {
    const span = document.createElement('span');
    span.textContent = word.text;

    if (!word.isWordLike) {
      span.className = CLASS.gap;
      return span;
    }

    span.className = CLASS.word;
    span.setAttribute(ATTR.wordId, word.id);
    this.wordElements.set(word.id, span);
    return span;
  }

  private createGap(text: string): HTMLElement {
    const span = document.createElement('span');
    span.className = CLASS.gap;
    span.textContent = text;
    return span;
  }

  /**
   * Hides the player's own caption text so there is never a doubled subtitle (§7).
   *
   * Re-applied on every render because a framework re-render can strip the attribute, and
   * we are already in the right place to notice.
   */
  private hideOriginal(): void {
    const original = this.presentation.originalElement;
    if (!original || !original.isConnected) return;
    if (original.getAttribute(ATTR.hiddenOriginal) !== 'true') {
      original.setAttribute(ATTR.hiddenOriginal, 'true');
    }
  }

  private restoreOriginal(): void {
    this.presentation.originalElement?.removeAttribute(ATTR.hiddenOriginal);
  }
}
