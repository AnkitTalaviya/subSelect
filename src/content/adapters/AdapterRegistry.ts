import { log } from '@shared/logger';
import { GenericDomAdapter } from './GenericDomAdapter';
import { TextTrackAdapter } from './TextTrackAdapter';
import type { AdapterContext, SubtitleAdapter } from './types';

/**
 * Chooses a subtitle source for a video (§35, §63).
 *
 * Order is the whole point. Generic detection is tried before anything site-specific, so
 * the common path is the one that gets exercised and hardened, and a site adapter only
 * ever exists to cover a case generic detection provably cannot handle.
 *
 * Within generic detection, DOM beats TextTrack: a DOM caption element gives us the
 * player's real geometry and typography to mirror, where a TextTrack gives us only text
 * and forces us to reconstruct a caption box from the video rect.
 *
 * Phase 5 adds site adapters by unshifting factories ahead of `generic-dom`. Nothing else
 * in the pipeline changes, because every adapter produces the same `SubtitleCue`.
 */

type AdapterFactory = () => SubtitleAdapter;

const FACTORIES: AdapterFactory[] = [
  // Phase 5: site adapters go here, ahead of the generic pair, each gated on its own
  // canHandle() so it cannot claim a page it was not written for.
  () => new GenericDomAdapter(),
  () => new TextTrackAdapter(),
];

export function selectAdapter(context: AdapterContext): SubtitleAdapter | null {
  for (const factory of FACTORIES) {
    let adapter: SubtitleAdapter;
    try {
      adapter = factory();
    } catch (error) {
      log.warn('adapter construction failed', error);
      continue;
    }

    try {
      if (!adapter.canHandle(context)) continue;
    } catch (error) {
      log.warn(`${adapter.id}.canHandle threw`, error);
      continue;
    }

    log.debug(`selected adapter: ${adapter.id}`);
    return adapter;
  }

  return null;
}
