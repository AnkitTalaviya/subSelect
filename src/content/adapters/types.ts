import type { SubtitleCue } from '@shared/types';

export interface AdapterContext {
  video: HTMLVideoElement;
  /** Container that normally goes fullscreen; the default overlay mount point. */
  playerRoot: HTMLElement;
  /** User-configured subtitle language, used when the site does not declare one. */
  language?: string;
  /**
   * Asks the engine to tear down and rebuild this binding.
   *
   * An adapter calls this when its presentation has changed in a way it cannot patch — a
   * caption container replaced by a different element, say. The overlay's mount point and
   * measurement target are captured once at bind time, so the honest response to that is
   * a clean rebind rather than mutating state the renderer already read.
   */
  invalidate: () => void;
}

/**
 * How the overlay should be positioned.
 *
 *  - `mirror`  — the site renders caption text into the DOM, so we copy that element's
 *                geometry and typography and hide it. Always preferred: mirrored geometry
 *                is faithful by construction.
 *  - `derived` — the text came from a TextTrack the browser was rendering itself, so
 *                there is no DOM to measure and the box has to be computed from the video
 *                rect and the cue's own line/align hints.
 */
export type PresentationMode = 'mirror' | 'derived';

export interface AdapterPresentation {
  mode: PresentationMode;
  /** Element our overlay is appended to. */
  mountParent: HTMLElement;
  /** Mirror mode only: the element to measure and hide. */
  originalElement?: HTMLElement;
  /** Derived mode only: text alignment the cue asked for. */
  textAlign?: string;
}

/**
 * Common interface for every subtitle source (§35).
 *
 * Extends the brief's interface with `attach`/`detach`/`getPresentation`. Adapters own
 * real resources — MutationObservers, and in the TextTrack case a forced `track.mode`
 * that must be handed back — so ownership has to be explicit rather than implied, and the
 * renderer has to know whether geometry is measured or computed.
 */
export interface SubtitleAdapter {
  readonly id: string;

  /** Cheap, side-effect-free test. Must not mutate the page. */
  canHandle(context: AdapterContext): boolean;

  attach(context: AdapterContext): void;

  /** Every cue the source knows about. TextTrack knows all of them; DOM knows only the current one. */
  detectSubtitles(): SubtitleCue[];

  getCurrentCue(): SubtitleCue | null;

  /** Subscribes to cue changes. The returned function unsubscribes. */
  observeChanges(callback: (cue: SubtitleCue | null) => void): () => void;

  getPresentation(): AdapterPresentation | null;

  /** Releases every resource and restores anything that was changed on the page. */
  detach(): void;
}
