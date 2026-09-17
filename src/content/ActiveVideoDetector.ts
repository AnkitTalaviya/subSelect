import { ACTIVE_VIDEO_MIN_SCORE, TIMING } from '@shared/constants';
import { log } from '@shared/logger';
import { Disposer, deepQueryAll, throttleTrailing } from './dom';

/**
 * Picks the page's primary video (§9, §10).
 *
 * A page routinely holds ads, autoplay previews, hero-banner loops and hidden preload
 * elements, so the first `<video>` in the document is very often the wrong one. Instead of
 * guessing we score, and we re-score only when something actually happened.
 *
 * Discovery is event-driven. Media events (`play`, `playing`, `loadedmetadata`, …) do not
 * bubble, but a capture-phase listener on `document` still receives them, because the
 * capture phase runs from the root down to the target. That gives us notification of every
 * new video in the document without a polling loop.
 */

/** Everything scoring needs, separated from the DOM so the policy is unit testable. */
export interface VideoMetrics {
  playing: boolean;
  fullscreen: boolean;
  /** 0..1 fraction of the element inside the viewport. */
  intersectionRatio: number;
  /** Element area as a fraction of the viewport area. */
  areaRatio: number;
  audible: boolean;
  centered: boolean;
  width: number;
  height: number;
  hidden: boolean;
  /** Muted + looping + autoplaying: the signature of a decorative background video. */
  decorative: boolean;
}

/** Pure scoring policy (§10). Higher wins; anything below the threshold is rejected. */
export function scoreVideo(metrics: VideoMetrics): number {
  if (metrics.hidden) return -100;

  let score = 0;
  if (metrics.playing) score += 50;
  if (metrics.fullscreen) score += 100;
  if (metrics.intersectionRatio >= 0.1) score += 30;
  if (metrics.areaRatio >= 0.25) score += 20;
  if (metrics.audible) score += 20;
  if (metrics.centered) score += 10;
  if (metrics.width < 200 || metrics.height < 120) score -= 30;
  if (metrics.decorative) score -= 50;

  return score;
}

export function measureVideo(video: HTMLVideoElement): VideoMetrics {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);

  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const viewportArea = viewportWidth * viewportHeight;

  const hidden =
    rect.width <= 1 ||
    rect.height <= 1 ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number(style.opacity) < 0.01;

  const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  const elementArea = Math.max(1, rect.width * rect.height);

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const fullscreenElement = document.fullscreenElement;

  return {
    playing: !video.paused && !video.ended && video.readyState >= 2,
    fullscreen: Boolean(fullscreenElement && (fullscreenElement === video || fullscreenElement.contains(video))),
    intersectionRatio: (visibleWidth * visibleHeight) / elementArea,
    areaRatio: elementArea / viewportArea,
    audible: !video.muted && video.volume > 0,
    centered:
      centerX > viewportWidth * 0.2 &&
      centerX < viewportWidth * 0.8 &&
      centerY > viewportHeight * 0.1 &&
      centerY < viewportHeight * 0.9,
    width: rect.width,
    height: rect.height,
    hidden,
    decorative: video.muted && video.loop && video.autoplay,
  };
}

/** Discovery retries after start, then never again — see startDiscovery. */
const DISCOVERY_RETRIES = 5;

/** Media events that can change which video matters. None of them bubble. */
const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'ended',
  'loadedmetadata',
  'canplay',
  'durationchange',
  'volumechange',
  'emptied',
  'resize',
] as const;

export class ActiveVideoDetector {
  private readonly disposer = new Disposer();
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retriesLeft = 0;
  /** True once the finite discovery burst has been used up for the current unbound spell. */
  private burstSpent = false;
  private current: HTMLVideoElement | null = null;
  private running = false;
  private readonly reevaluate = throttleTrailing(() => this.evaluate(), 150);

  constructor(private readonly onChange: (video: HTMLVideoElement | null) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const type of MEDIA_EVENTS) {
      // Capture phase: non-bubbling media events still reach a document-level listener.
      this.disposer.listen(document, type, () => this.reevaluate(), { capture: true, passive: true });
    }

    this.disposer.listen(document, 'fullscreenchange', () => this.reevaluate());
    this.disposer.listen(window, 'resize', () => this.reevaluate(), { passive: true });

    this.observer = new IntersectionObserver(() => this.reevaluate(), {
      threshold: [0, 0.1, 0.5],
    });

    // A wide observer is acceptable only while nothing is bound; it is disconnected the
    // moment a video is found, and only reconnected if that video goes away.
    this.startDiscovery();
    this.evaluate();
  }

  stop(): void {
    this.running = false;
    this.reevaluate.cancel();
    this.stopDiscovery();
    this.observer?.disconnect();
    this.observer = null;
    this.disposer.dispose();
    this.current = null;
  }

  getCurrent(): HTMLVideoElement | null {
    return this.current;
  }

  /** Re-runs scoring now, e.g. after the engine has torn down a stale binding. */
  refresh(): void {
    this.evaluate();
  }

  private startDiscovery(): void {
    if (!this.running) return;

    if (!this.mutationObserver) {
      const onMutate = throttleTrailing(() => this.evaluate(), TIMING.discoveryObserverMs);
      this.mutationObserver = new MutationObserver(onMutate);
      this.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Safety net for videos that arrive inside a shadow root, whose media events are not
    // composed and therefore never reach our document listeners.
    //
    // Strictly finite: a handful of attempts, then it stops for good. A frame with no
    // video — an ad iframe, say — must not be left holding a repeating timer, so once
    // this burst is spent the MutationObserver above is the only thing still watching.
    if (this.retryTimer === null && !this.burstSpent) {
      this.retriesLeft = DISCOVERY_RETRIES;
      this.retryTimer = setInterval(() => {
        if (--this.retriesLeft <= 0) {
          this.burstSpent = true;
          this.stopRetryTimer();
        }
        this.evaluate();
      }, TIMING.discoveryRetryMs);
    }
  }

  private stopDiscovery(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.stopRetryTimer();
    // A video was found (or we are shutting down), so the next unbound spell — an SPA
    // navigation, say — gets a fresh burst.
    this.burstSpent = false;
  }

  private stopRetryTimer(): void {
    if (this.retryTimer !== null) clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.retriesLeft = 0;
  }

  private evaluate(): void {
    if (!this.running) return;

    const videos = deepQueryAll<HTMLVideoElement>(document, 'video');
    let best: HTMLVideoElement | null = null;
    let bestScore = ACTIVE_VIDEO_MIN_SCORE - 1;
    let bestArea = 0;

    for (const video of videos) {
      let metrics: VideoMetrics;
      try {
        metrics = measureVideo(video);
      } catch {
        continue;
      }

      const score = scoreVideo(metrics);
      const area = metrics.width * metrics.height;
      if (score > bestScore || (score === bestScore && area > bestArea)) {
        best = video;
        bestScore = score;
        bestArea = area;
      }
    }

    if (bestScore < ACTIVE_VIDEO_MIN_SCORE) best = null;

    // Keep observing whatever we found so visibility changes re-trigger scoring.
    if (this.observer) {
      this.observer.disconnect();
      for (const video of videos) this.observer.observe(video);
    }

    if (best === this.current) {
      if (!best) this.startDiscovery();
      return;
    }

    log.debug(best ? `active video bound (score ${bestScore})` : 'no active video', best);
    this.current = best;

    if (best) this.stopDiscovery();
    else this.startDiscovery();

    this.onChange(best);
  }
}
