import type { SubtitleCue } from '@shared/types';
import { log } from '@shared/logger';
import { buildCue } from '../SubtitleParser';
import { Disposer } from '../dom';
import type { AdapterContext, AdapterPresentation, SubtitleAdapter } from './types';

/**
 * Reads cues the browser has already parsed from a `<track>` (§1.1 of FEASIBILITY).
 *
 * The browser renders these itself, inside a closed user-agent shadow tree that no
 * extension can reach. So to make them interactive we switch the track from `showing` to
 * `hidden` — a documented TextTrack mode that keeps cues parsed and `cuechange` firing
 * while stopping UA rendering — and draw the same text ourselves.
 *
 * Two rules follow from that:
 *
 *  - We only ever take over a track the user already turned on (`mode === 'showing'`).
 *    Rendering a `hidden` track would put captions on screen that nobody asked for, and a
 *    `hidden` track usually means the site is rendering its own DOM captions from it — in
 *    which case GenericDomAdapter is the better source and wins the registry anyway.
 *  - The original mode is recorded and restored on detach, unconditionally. If SubSelect
 *    goes away, the site's captions come back exactly as they were.
 *
 * Nothing here fetches, parses or stores a subtitle file. We read cues the page already
 * loaded, through the standard API.
 */

const SUBTITLE_KINDS = new Set(['subtitles', 'captions']);

export class TextTrackAdapter implements SubtitleAdapter {
  readonly id = 'text-track';

  private context: AdapterContext | null = null;
  private track: TextTrack | null = null;
  private originalMode: TextTrackMode | null = null;
  private readonly disposer = new Disposer();
  private lastCueId: string | null = null;
  private currentAlign: string | undefined;

  canHandle(context: AdapterContext): boolean {
    return this.findShowingTrack(context.video) !== null;
  }

  attach(context: AdapterContext): void {
    this.context = context;
    this.takeOver(this.findShowingTrack(context.video));
  }

  detach(): void {
    this.release();
    this.disposer.dispose();
    this.context = null;
    this.lastCueId = null;
  }

  getPresentation(): AdapterPresentation | null {
    if (!this.context) return null;
    const presentation: AdapterPresentation = {
      mode: 'derived',
      mountParent: this.context.playerRoot,
    };
    if (this.currentAlign) presentation.textAlign = this.currentAlign;
    return presentation;
  }

  getCurrentCue(): SubtitleCue | null {
    const active = this.track?.activeCues;
    if (!active || active.length === 0) {
      this.currentAlign = undefined;
      return null;
    }

    const parts: string[] = [];
    let startTime = Number.POSITIVE_INFINITY;
    let endTime = 0;
    let align: string | undefined;

    for (const cue of active) {
      const text = cueText(cue);
      if (text) parts.push(text);
      startTime = Math.min(startTime, cue.startTime);
      endTime = Math.max(endTime, cue.endTime);
      if (align === undefined && 'align' in cue) align = (cue as VTTCue).align;
    }

    this.currentAlign = align === 'left' || align === 'right' ? align : 'center';

    const input: Parameters<typeof buildCue>[0] = {
      raw: parts.join('\n'),
      source: 'texttrack',
      startTime: Number.isFinite(startTime) ? startTime : undefined,
      endTime: endTime > 0 ? endTime : undefined,
    };
    const language = this.track?.language || this.context?.language;
    if (language) input.language = language;

    return buildCue(input);
  }

  detectSubtitles(): SubtitleCue[] {
    const cues = this.track?.cues;
    if (!cues) return [];

    const language = this.track?.language || this.context?.language;
    const result: SubtitleCue[] = [];

    for (const cue of cues) {
      const built = buildCue({
        raw: cueText(cue),
        source: 'texttrack',
        startTime: cue.startTime,
        endTime: cue.endTime,
        ...(language ? { language } : {}),
      });
      if (built) result.push(built);
    }

    return result;
  }

  observeChanges(callback: (cue: SubtitleCue | null) => void): () => void {
    const emit = (force = false): void => {
      const cue = this.getCurrentCue();
      if (!force && cue?.id === this.lastCueId) return;
      this.lastCueId = cue?.id ?? null;
      callback(cue);
    };

    const onCueChange = (): void => emit();

    // Bound per track, not per subscription: switching caption language replaces the
    // track object, and the listener has to follow it without leaking the old one.
    let unbindTrack: (() => void) | null = null;
    const bindTrack = (): void => {
      const track = this.track;
      if (!track) return;
      track.addEventListener('cuechange', onCueChange);
      unbindTrack = () => track.removeEventListener('cuechange', onCueChange);
    };

    bindTrack();
    this.disposer.add(() => unbindTrack?.());

    /*
     * Follows the viewer switching captions: another language, off, or back on.
     *
     * The "same track" case is not a no-op, which is what this used to assume. Two things
     * can change without the track object changing at all:
     *
     *  - The viewer turns captions **off**. The player sets `mode = 'disabled'`, cues stop
     *    firing, and the overlay is left frozen on whatever was last on screen.
     *  - The viewer turns them **back on**. The player sets `mode = 'showing'`, which undoes
     *    our takeover — so the browser starts drawing its own captions over the top of ours
     *    and nothing re-hides them.
     *
     * Both were invisible here because `findShowingTrack` returned our own track whatever
     * its mode, so `next === this.track` and this returned early every time. The feature
     * then looked dead until the extension was toggled off and on.
     */
    const onTrackListChange = (): void => {
      const next = this.findShowingTrack(this.context?.video);

      if (next === this.track) {
        if (!next) return;
        // Captions were switched on again over a track we already hold: take it back,
        // otherwise the player renders its captions and ours at the same time.
        if (next.mode === 'showing') {
          try {
            next.mode = 'hidden';
            log.debug('re-hid the track after the player turned captions back on');
          } catch (error) {
            log.warn('could not re-hide the track', error);
          }
        }
        return;
      }

      unbindTrack?.();
      unbindTrack = null;
      this.release();
      this.takeOver(next);
      bindTrack();
      // With no track this emits a null cue, which is what clears the overlay when the
      // viewer turns captions off.
      emit(true);
    };

    const tracks = this.context?.video.textTracks;
    if (tracks) {
      for (const type of ['change', 'addtrack', 'removetrack'] as const) {
        tracks.addEventListener(type, onTrackListChange);
        this.disposer.add(() => tracks.removeEventListener(type, onTrackListChange));
      }
    }

    emit(true);

    return () => this.disposer.dispose();
  }

  /** Switches the chosen track to `hidden`, remembering what it was. */
  private takeOver(track: TextTrack | null): void {
    this.track = track;
    if (!track) return;

    this.originalMode = track.mode;
    try {
      track.mode = 'hidden';
      log.debug(`text-track took over "${track.label || track.language}"`);
    } catch (error) {
      log.warn('could not switch track to hidden', error);
      this.originalMode = null;
    }
  }

  /** Hands the track back exactly as we found it (§58). */
  private release(): void {
    const track = this.track;
    if (track && this.originalMode) {
      try {
        /*
         * Only a track still in the state we left it in is ours to hand back.
         *
         * We set `hidden`; anything else means the player or the viewer has since taken it
         * back. Restoring the remembered `showing` over their `disabled` would switch
         * captions on again moments after they turned them off — the extension overruling
         * the person watching, which is the one thing it must never do (§58).
         */
        if (track.mode === 'hidden') track.mode = this.originalMode;
      } catch {
        // The track may already be gone with the media element; nothing to restore.
      }
    }
    this.originalMode = null;
    this.track = null;
  }

  private findShowingTrack(video: HTMLVideoElement | undefined): TextTrack | null {
    if (!video) return null;

    for (const track of video.textTracks) {
      if (!SUBTITLE_KINDS.has(track.kind)) continue;

      /*
       * A track we have already taken over reports `hidden` because we set it, so it has to
       * be recognised as still on — but only while it is not `disabled`. That exception
       * used to come first and unconditionally, which meant a track the viewer had switched
       * off still counted as showing: captions were off, cues had stopped, and this kept
       * answering "that one, still". Nothing downstream could see the change.
       */
      if (track === this.track) {
        if (track.mode !== 'disabled') return track;
        continue;
      }

      if (track.mode === 'showing') return track;
    }

    return null;
  }
}

/**
 * Plain text of a cue.
 *
 * WebVTT cue payloads may carry markup (`<b>`, `<v Speaker>`, `<c.classname>`). `VTTCue`
 * exposes `getCueAsHTML()`, which hands back a parsed fragment; reading its text is
 * safer than regex-stripping the raw string, and it never touches the page DOM.
 */
function cueText(cue: TextTrackCue): string {
  const vtt = cue as VTTCue;
  try {
    if (typeof vtt.getCueAsHTML === 'function') {
      return fragmentText(vtt.getCueAsHTML());
    }
  } catch {
    // Fall through to the raw payload.
  }
  return typeof vtt.text === 'string' ? vtt.text.replace(/<[^>]*>/g, '') : '';
}

function fragmentText(fragment: DocumentFragment): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeName === 'BR') {
      parts.push('\n');
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(fragment);
  return parts.join('');
}
