import type { SubtitleBox } from '@shared/types';
import { TIMING } from '@shared/constants';
import type { AdapterPresentation } from './adapters/types';
import { Disposer, createFrameBurst, throttleTrailing } from './dom';

/**
 * Keeps the overlay aligned with whatever the player is doing (§38).
 *
 * In `mirror` mode the numbers are measured from the player's own caption element, so the
 * overlay follows theater mode, fullscreen, zoom, user caption-size settings and any
 * layout change the player makes, without us having to know about any of them. That is
 * the whole reason the original is hidden with `visibility` rather than `display`: it
 * keeps its box, so it stays measurable.
 *
 * In `derived` mode there is nothing to measure, and the box is computed from the video
 * rect with the cue's alignment applied.
 *
 * Recomputation is strictly event-driven, plus a bounded animation-frame burst after each
 * event so a CSS transition on the player's caption box settles. There is no standing rAF
 * loop and no timer.
 */

/** Caption defaults for derived mode, modelled on user-agent cue rendering. */
const DERIVED = {
  widthRatio: 0.9,
  bandTopRatio: 0.45,
  bottomInsetRatio: 0.05,
  minBottomInset: 16,
  fontRatio: 0.045,
  minFontSize: 14,
  maxFontSize: 48,
  color: '#ffffff',
  background: 'rgba(8, 8, 8, 0.75)',
  padding: '0.1em 0.4em',
  borderRadius: '2px',
  textShadow: 'none',
} as const;

export class PositionTracker {
  private readonly disposer = new Disposer();
  private resizeObserver: ResizeObserver | null = null;
  private readonly burst = createFrameBurst(() => this.emit(), TIMING.repositionFrames);
  private readonly schedule = throttleTrailing(() => this.burst.trigger(), TIMING.repositionDebounceMs);
  private fixed = false;

  constructor(
    private readonly layer: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly presentation: AdapterPresentation,
    private readonly onBox: (box: SubtitleBox) => void,
  ) {}

  start(): void {
    const targets: Element[] = [this.video, this.presentation.mountParent];
    if (this.presentation.originalElement) targets.push(this.presentation.originalElement);

    this.resizeObserver = new ResizeObserver(() => this.schedule());
    for (const target of targets) {
      try {
        this.resizeObserver.observe(target);
      } catch {
        // An element already removed from the document cannot be observed; harmless.
      }
    }

    this.disposer.listen(window, 'resize', () => this.schedule(), { passive: true });
    this.disposer.listen(document, 'fullscreenchange', () => this.schedule());
    this.disposer.listen(document, 'webkitfullscreenchange', () => this.schedule());
    // Only meaningful in the viewport-coordinate fallback; a no-op otherwise.
    this.disposer.listen(document, 'scroll', () => {
      if (this.fixed) this.schedule();
    }, { passive: true, capture: true });

    this.emit();
  }

  stop(): void {
    this.schedule.cancel();
    this.burst.cancel();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposer.dispose();
  }

  /** Forces a re-measure now, e.g. immediately after a new cue has been rendered. */
  refresh(): void {
    this.emit();
    this.burst.trigger();
  }

  private emit(): void {
    const box = this.measure();
    if (box) this.onBox(box);
  }

  /**
   * Coordinates are resolved against the layer's own `offsetParent`.
   *
   * The alternative would be setting `position: relative` on the player's container, and
   * we do not write layout properties onto the site's elements. When there is no
   * positioned ancestor to resolve against, the layer switches to `position: fixed` and
   * viewport coordinates instead.
   */
  private resolveOrigin(): { x: number; y: number; fixed: boolean } {
    const parent = this.layer.offsetParent;
    if (parent instanceof HTMLElement) {
      const rect = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      return {
        x: rect.left + parseFloat(style.borderLeftWidth || '0'),
        y: rect.top + parseFloat(style.borderTopWidth || '0'),
        fixed: false,
      };
    }
    return { x: 0, y: 0, fixed: true };
  }

  private measure(): SubtitleBox | null {
    const videoRect = this.video.getBoundingClientRect();
    if (videoRect.width < 1 || videoRect.height < 1) return null;

    const origin = this.resolveOrigin();
    this.fixed = origin.fixed;

    return this.presentation.mode === 'mirror'
      ? this.measureMirror(origin)
      : this.measureDerived(videoRect, origin);
  }

  private measureMirror(origin: { x: number; y: number; fixed: boolean }): SubtitleBox | null {
    const original = this.presentation.originalElement;
    if (!original || !original.isConnected) return null;

    const rect = original.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;

    const style = getComputedStyle(findStyleSource(original));

    return {
      x: rect.left - origin.x,
      y: rect.top - origin.y,
      width: rect.width,
      height: rect.height,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      textShadow: style.textShadow,
      textAlign: style.textAlign || 'center',
      textStroke: style.webkitTextStrokeWidth === '0px' ? 'unset' : `${style.webkitTextStrokeWidth} ${style.webkitTextStrokeColor}`,
      background: style.backgroundColor,
      padding: style.padding,
      borderRadius: style.borderRadius,
      fixed: origin.fixed,
    };
  }

  private measureDerived(videoRect: DOMRect, origin: { x: number; y: number; fixed: boolean }): SubtitleBox {
    const width = videoRect.width * DERIVED.widthRatio;
    const bottomInset = Math.max(DERIVED.minBottomInset, videoRect.height * DERIVED.bottomInsetRatio);
    const top = videoRect.top + videoRect.height * DERIVED.bandTopRatio;
    const height = Math.max(0, videoRect.bottom - bottomInset - top);

    const fontSize = Math.round(
      Math.min(DERIVED.maxFontSize, Math.max(DERIVED.minFontSize, videoRect.height * DERIVED.fontRatio)),
    );

    return {
      x: videoRect.left + (videoRect.width - width) / 2 - origin.x,
      y: top - origin.y,
      width,
      height,
      fontFamily: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: `${fontSize}px`,
      fontWeight: '500',
      lineHeight: '1.35',
      letterSpacing: 'normal',
      color: DERIVED.color,
      textShadow: DERIVED.textShadow,
      textAlign: this.presentation.textAlign ?? 'center',
      textStroke: 'unset',
      background: DERIVED.background,
      padding: DERIVED.padding,
      borderRadius: DERIVED.borderRadius,
      fixed: origin.fixed,
    };
  }
}

/**
 * Players commonly put positioning on an outer box and typography on an inner one, so the
 * font has to be read from whichever element actually carries the text.
 */
function findStyleSource(element: HTMLElement, maxDepth = 3): HTMLElement {
  let current = element;

  for (let depth = 0; depth < maxDepth; depth++) {
    const children = [...current.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (children.length !== 1) break;
    const only = children[0]!;
    if (!only.textContent?.trim()) break;
    current = only;
  }

  return current;
}
