import type { SubtitleCue } from '@shared/types';
import { ATTR, CLASS } from '@shared/constants';
import { log } from '@shared/logger';
import { buildCue } from '../SubtitleParser';
import { Disposer, collectShadowRoots, throttleTrailing } from '../dom';
import type { AdapterContext, AdapterPresentation, SubtitleAdapter } from './types';

/**
 * Finds caption text the player has already rendered into the DOM (§1.2 of FEASIBILITY).
 *
 * This is the source that covers most of the web, and it is the only one that gives us
 * exact on-screen geometry. Detection is layered (§63) rather than resting on any one
 * selector:
 *
 *   1. content   — holds a plausible amount of text (required)
 *   2. geometry  — sits over the video, in its lower part, narrower than it (required)
 *   3. semantics — role / aria-label / aria-live (qualifies, and ranks highest)
 *   4. naming    — `caption`, `subtitle`, `timedtext`, … in class/id/data-* (qualifies,
 *                  ranks lower)
 *
 * Content and geometry are necessary but not sufficient: a watermark, a title card and a
 * "now playing" strip all look identical from here. So a candidate must also declare
 * *something* — accessibility markup or a caption-ish name. Either one alone is enough,
 * which is what keeps a site's CSS rename from breaking detection outright, and a player
 * that offers neither is a case for a Phase 5 site adapter rather than a lucky guess.
 */

/** Cheap first-pass net. Broad on purpose — scoring does the real work. */
const CANDIDATE_SELECTORS = [
  '[role="region"]',
  '[aria-live]',
  '[class*="caption" i]',
  '[class*="subtitle" i]',
  '[class*="timedtext" i]',
  '[class*="timed-text" i]',
  '[class*="untertitel" i]',
  '[class*="cue" i]',
  '[id*="caption" i]',
  '[id*="subtitle" i]',
  '[data-testid*="caption" i]',
  '[data-testid*="subtitle" i]',
  '.shaka-text-container',
  '.vjs-text-track-display',
  '.plyr__captions',
].join(',');

const NAME_HINTS = /caption|subtitle|untertitel|timedtext|timed-text|\bcue\b|\bcc\b|text-track/i;
const LABEL_HINTS = /caption|subtitle|untertitel|sous-titre|subtítulo/i;

/** A caption container should hold a line or two, not a page of text. */
const MAX_CUE_LENGTH = 700;

interface Candidate {
  element: HTMLElement;
  score: number;
}

function attributeBlob(element: HTMLElement): string {
  const parts = [element.className, element.id];
  for (const attr of element.attributes) {
    if (attr.name.startsWith('data-')) parts.push(attr.name, attr.value);
  }
  return parts.join(' ');
}

/**
 * Reads caption text while preserving line structure.
 *
 * `textContent` would run the lines together, and players build each caption line as its
 * own block element. Our own overlay is skipped so we never read our own output back.
 */
export function extractCaptionText(root: HTMLElement): string {
  const out: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains(CLASS.layer)) return;

    if (node.tagName === 'BR') {
      out.push('\n');
      return;
    }

    let isBlock = false;
    try {
      const display = getComputedStyle(node).display;
      isBlock = display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item';
    } catch {
      isBlock = node.tagName === 'DIV' || node.tagName === 'P';
    }

    if (isBlock) out.push('\n');
    for (const child of node.childNodes) walk(child);
    if (isBlock) out.push('\n');
  };

  for (const child of root.childNodes) walk(child);
  return out.join('');
}

export class GenericDomAdapter implements SubtitleAdapter {
  readonly id = 'generic-dom';

  private context: AdapterContext | null = null;
  private container: HTMLElement | null = null;
  /**
   * The element the overlay is mounted into, remembered rather than read back.
   *
   * A container that has just been replaced is already detached, so its `parentElement` is
   * null — asking it where it lived reports "nowhere" and makes every in-place swap look
   * like a move to somewhere else.
   */
  private parent: HTMLElement | null = null;
  private readonly disposer = new Disposer();
  private textObserver: MutationObserver | null = null;
  private parentObserver: MutationObserver | null = null;
  private rootObserver: MutationObserver | null = null;
  private lastCueId: string | null = null;
  /** Memo so `canHandle` followed by `attach` costs one scan, not two. */
  private resolved: { context: AdapterContext; container: HTMLElement | null } | null = null;

  canHandle(context: AdapterContext): boolean {
    return this.resolveContainer(context) !== null;
  }

  attach(context: AdapterContext): void {
    this.context = context;
    this.container = this.resolveContainer(context);
    this.parent = this.container?.parentElement ?? null;
    log.debug('generic-dom attached to', this.container);
  }

  detach(): void {
    this.stopObservers();
    this.disposer.dispose();
    this.container = null;
    this.parent = null;
    this.context = null;
    this.lastCueId = null;
  }

  getPresentation(): AdapterPresentation | null {
    if (!this.container) return null;

    /*
     * The overlay is mounted in the player, not in the caption element's own parent.
     *
     * A caption container belongs to the player and gets rewritten wholesale: YouTube
     * clears its entire caption-window container in the silence between two lines. Our
     * overlay was a child of that container, so the player deleted it along with its own
     * markup several times a minute. The engine saw a missing layer, concluded the binding
     * was dead, rebuilt everything, and then raced the next cue — losing often enough to
     * drop roughly every other subtitle.
     *
     * The player root is the element the engine already trusts to be stable: it is where
     * the context menu is mounted and what the health check watches. Nothing about
     * positioning depends on the choice, because the tracker measures the caption's real
     * rect and offsets it against whatever the layer's offsetParent turns out to be.
     */
    const mountParent = this.context?.playerRoot ?? this.parent ?? this.container.parentElement;
    if (!mountParent) return null;

    /*
     * `originalElement` is a live getter, not a snapshot.
     *
     * Subscription players rebuild the caption element for every single cue rather than
     * writing into it, so a snapshot is stale within seconds — the tracker would measure a
     * detached node and the health check would call the binding dead. Reading it through
     * the adapter lets the element be swapped underneath without anything above having to
     * be torn down, which is what keeps an open panel open while the film carries on.
     */
    const self = this;
    return {
      mode: 'mirror',
      mountParent,
      get originalElement(): HTMLElement | undefined {
        return self.container ?? undefined;
      },
    };
  }

  getCurrentCue(): SubtitleCue | null {
    if (!this.container || !this.container.isConnected) return null;

    const raw = extractCaptionText(this.container);
    if (raw.length > MAX_CUE_LENGTH) return null;

    const input: Parameters<typeof buildCue>[0] = { raw, source: 'dom' };
    const language = this.detectLanguage();
    if (language) input.language = language;

    return buildCue(input);
  }

  detectSubtitles(): SubtitleCue[] {
    // A DOM source only ever exposes what is on screen right now; there is no cue list to
    // read, and reconstructing one would mean recording everything the user watches (§32).
    const cue = this.getCurrentCue();
    return cue ? [cue] : [];
  }

  observeChanges(callback: (cue: SubtitleCue | null) => void): () => void {
    const emit = (force = false): void => {
      const cue = this.getCurrentCue();
      if (!force && cue?.id === this.lastCueId) return;
      this.lastCueId = cue?.id ?? null;
      callback(cue);
    };

    // Caption text changes: the tightest, highest-frequency observer, on the container only.
    const onText = throttleTrailing(() => emit(), 16);
    this.disposer.add(() => onText.cancel());

    // Some players swap the whole caption container on every cue, which silently kills the
    // observer above. Watching the parent's child list catches that immediately.
    const onParent = throttleTrailing(() => {
      if (this.container?.isConnected) {
        emit();
        return;
      }
      this.rebind(emit);
    }, 50);
    this.disposer.add(() => onParent.cancel());

    /*
     * Widest and slowest: catches captions being switched on long after we attached, and
     * captions *moving* to a different element.
     *
     * The guard is "still carrying text", not "still in the document". A player that
     * re-renders can leave its old caption node in place and empty and start writing into
     * a new one — nothing disconnects, so an isConnected check sees a healthy binding while
     * the captions have moved on without it. That is the state where the extension looks
     * on but does nothing until the page is reloaded.
     *
     * Reading `textContent` on one element is cheap, and the scan behind `rebind` only
     * happens while our container has no caption in it — never on the hot path where cues
     * are arriving normally.
     */
    const onRoot = throttleTrailing(() => {
      if (this.hasCaptionText()) return;
      this.rebind(emit);
    }, 250);
    this.disposer.add(() => onRoot.cancel());

    this.textObserver = new MutationObserver(() => onText());
    this.parentObserver = new MutationObserver(() => onParent());
    this.rootObserver = new MutationObserver(() => onRoot());

    this.bindObservers();

    if (this.context) {
      this.rootObserver.observe(this.context.playerRoot, { childList: true, subtree: true });
    }

    emit(true);

    return () => {
      this.stopObservers();
      this.disposer.dispose();
    };
  }

  private bindObservers(): void {
    /*
     * The parent is watched even when there is no container to watch.
     *
     * A player that deletes its caption element between subtitles leaves nothing to observe,
     * and binding observers only to a container we no longer have meant the *insertion of
     * the next caption* was seen by nothing tighter than the 250ms whole-player sweep. At a
     * normal speaking pace that sweep loses the race often enough to drop roughly every
     * other subtitle. The element appearing under the parent is the precise event that says
     * the captions are back, so that is what we listen for.
     */
    const parent = this.container?.parentElement ?? this.parent;
    if (parent?.isConnected) this.parentObserver?.observe(parent, { childList: true });

    if (!this.container) return;
    this.textObserver?.observe(this.container, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  /** Whether the container we hold is still the one the player is writing captions into. */
  private hasCaptionText(): boolean {
    const container = this.container;
    if (!container?.isConnected) return false;
    return extractCaptionText(container).trim().length > 0;
  }

  private rebind(emit: (force?: boolean) => void): void {
    if (!this.context) return;

    this.textObserver?.disconnect();
    this.parentObserver?.disconnect();

    // A fresh scan, never the memo: the memo exists so `canHandle` and `attach` cost one
    // scan between them, and it is served as long as the cached element is *connected* —
    // which is exactly the case this is trying to get out of.
    const next = this.resolveContainer(this.context, true);

    /*
     * A scan that finds nothing must not take a live container away.
     *
     * Between two cues the caption element is legitimately empty, and an empty element
     * scores zero — so the scan comes back with nothing. Dropping our container there would
     * unbind us from the very element the next cue is about to arrive in.
     */
    if (!next && this.container?.isConnected) {
      this.bindObservers();
      return;
    }

    if (next === this.container) {
      this.bindObservers();
      return;
    }

    if (next && this.container) {
      /*
       * A replacement under the same parent is swapped in place, not rebuilt.
       *
       * Players that rebuild the caption element per cue — subscription services do this —
       * used to force a full engine rebind every few seconds, and a rebind destroys the
       * context menu. So a word could be clicked, its panel read for two seconds, and then
       * the next subtitle would silently take the panel away: the exact opposite of the
       * rule that a caption change is not the viewer saying they are finished.
       *
       * Nothing above needs rebuilding here. The mount point is the same element, the
       * presentation reads `originalElement` live, and the tracker re-measures every frame
       * anyway. Only a move to a *different* parent genuinely invalidates the overlay.
       */
      if (next.parentElement !== null && next.parentElement === this.parent) {
        // Let the element we are leaving become visible again if it is still in the page.
        if (this.container.isConnected) {
          this.container.removeAttribute(ATTR.hiddenOriginal);
        }
        this.container = next;
        this.bindObservers();
        log.debug('generic-dom caption container swapped in place');
        emit(true);
        return;
      }

      log.debug('generic-dom caption container moved elsewhere; requesting rebind');
      this.context.invalidate();
      return;
    }

    this.container = next;
    this.parent = next?.parentElement ?? this.parent;
    this.bindObservers();
    log.debug('generic-dom bound to', next);
    emit(true);
  }

  private stopObservers(): void {
    this.textObserver?.disconnect();
    this.parentObserver?.disconnect();
    this.rootObserver?.disconnect();
    this.textObserver = null;
    this.parentObserver = null;
    this.rootObserver = null;
  }

  /**
   * The caption's language, from the site's own declaration where there is one (§25).
   *
   * A `lang` attribute is only trusted when it sits **inside the player**. The document
   * root's `lang` is the interface language, not the subtitle language — trusting it meant
   * German captions on an English-language page were looked up as English, and a
   * dictionary would report no entry for a perfectly ordinary German word.
   */
  private detectLanguage(): string | undefined {
    const tracks = this.context?.video.textTracks;
    if (tracks) {
      for (const track of tracks) {
        if (track.mode !== 'disabled' && track.language) return track.language;
      }
    }

    const root = this.context?.playerRoot;
    const tagged = this.container?.closest('[lang]');
    if (tagged && root && root.contains(tagged)) {
      const declared = tagged.getAttribute('lang');
      if (declared) return declared;
    }

    return this.context?.language;
  }

  /** Scores every candidate in and around the player and returns the best, or null. */
  private resolveContainer(context: AdapterContext, fresh = false): HTMLElement | null {
    // Only a live container is served from the memo. A cached *null* must never be, or
    // captions switched on after we gave up would never be picked up — and `fresh` skips
    // it entirely for callers re-detecting after the captions moved.
    if (!fresh && this.resolved?.context === context && this.resolved.container?.isConnected) {
      return this.resolved.container;
    }

    const container = this.scanForContainer(context);
    this.resolved = { context, container };
    return container;
  }

  private scanForContainer(context: AdapterContext): HTMLElement | null {
    const videoRect = context.video.getBoundingClientRect();
    if (videoRect.width < 1 || videoRect.height < 1) return null;

    const roots: ParentNode[] = [context.playerRoot, ...collectShadowRoots(context.playerRoot, 4000)];
    const seen = new Set<HTMLElement>();
    const candidates: Candidate[] = [];

    for (const root of roots) {
      for (const element of root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTORS)) {
        if (seen.has(element)) continue;
        seen.add(element);

        const score = this.scoreCandidate(element, videoRect);
        if (score > 0) candidates.push({ element, score });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]!.element;
  }

  private scoreCandidate(element: HTMLElement, videoRect: DOMRect): number {
    if (element.classList.contains(CLASS.layer)) return 0;
    if (element.querySelector('video, audio, canvas, iframe')) return 0;

    const text = extractCaptionText(element).trim();
    if (!text || text.length > MAX_CUE_LENGTH) return 0;

    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 6) return 0;

    // Must actually sit over the video: a sidebar transcript is not a caption layer.
    const overlapX = Math.max(0, Math.min(rect.right, videoRect.right) - Math.max(rect.left, videoRect.left));
    const overlapY = Math.max(0, Math.min(rect.bottom, videoRect.bottom) - Math.max(rect.top, videoRect.top));
    if (overlapX < rect.width * 0.5 || overlapY < rect.height * 0.5) return 0;

    // 1. Accessibility semantics — the most trustworthy signal, and the most stable.
    const label = `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`;
    const labelled = LABEL_HINTS.test(label);
    const live = element.hasAttribute('aria-live');
    const named = NAME_HINTS.test(attributeBlob(element));

    // Text over the lower half of a video is not enough on its own: a watermark, a title
    // card or a "now playing" strip all look the same from here. At least one declared
    // signal — an accessibility hint or a caption-ish name — has to be present. Where a
    // player offers neither, the right answer is a site adapter, not a lucky guess.
    if (!labelled && !live && !named) return 0;

    let score = 20; // has text, is over the video, and declared something

    if (element.getAttribute('role') === 'region' && labelled) score += 40;
    else if (labelled) score += 25;
    if (live) score += 25;
    if (element.hasAttribute('aria-atomic')) score += 5;

    // 2. Geometry — captions live low and are narrower than the frame.
    const verticalCentre = (rect.top + rect.height / 2 - videoRect.top) / Math.max(1, videoRect.height);
    if (verticalCentre > 0.45) score += 25;
    else if (verticalCentre > 0.25) score += 5;
    if (rect.width <= videoRect.width * 1.02) score += 10;
    if (rect.height <= videoRect.height * 0.5) score += 10;

    // 3. Naming hints — rank, and qualify only in the absence of any aria signal.
    if (named) score += 20;

    return score;
  }

}
