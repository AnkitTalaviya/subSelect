import { describe, expect, it } from 'vitest';
import { scoreVideo, type VideoMetrics } from '@content/ActiveVideoDetector';

const base: VideoMetrics = {
  playing: false,
  fullscreen: false,
  intersectionRatio: 1,
  areaRatio: 0.4,
  audible: false,
  centered: true,
  width: 1280,
  height: 720,
  hidden: false,
  decorative: false,
};

const metrics = (overrides: Partial<VideoMetrics> = {}): VideoMetrics => ({ ...base, ...overrides });

describe('scoreVideo', () => {
  it('rejects a hidden video outright', () => {
    expect(scoreVideo(metrics({ hidden: true, playing: true, fullscreen: true }))).toBe(-100);
  });

  it('prefers a playing video over a paused one', () => {
    expect(scoreVideo(metrics({ playing: true }))).toBeGreaterThan(scoreVideo(metrics({ playing: false })));
  });

  it('ranks a fullscreen video above everything else', () => {
    const fullscreen = scoreVideo(metrics({ fullscreen: true }));
    const playingAudible = scoreVideo(metrics({ playing: true, audible: true }));
    expect(fullscreen).toBeGreaterThan(playingAudible);
  });

  it('penalises a tiny player', () => {
    const tiny = scoreVideo(metrics({ width: 160, height: 90, areaRatio: 0.01 }));
    expect(tiny).toBeLessThan(scoreVideo(metrics()));
  });

  it('penalises a decorative background loop', () => {
    expect(scoreVideo(metrics({ decorative: true }))).toBeLessThan(scoreVideo(metrics()));
  });

  it('picks the real player over a muted autoplay ad of the same size', () => {
    const player = scoreVideo(metrics({ playing: true, audible: true }));
    const ad = scoreVideo(metrics({ playing: true, audible: false, decorative: true }));
    expect(player).toBeGreaterThan(ad);
  });

  it('rejects an offscreen paused video but accepts a visible playing one', () => {
    const offscreen = metrics({ intersectionRatio: 0, areaRatio: 0.01, centered: false, width: 100, height: 60 });
    expect(scoreVideo(offscreen)).toBeLessThanOrEqual(0);
    expect(scoreVideo(metrics({ playing: true }))).toBeGreaterThan(0);
  });
});
