import { describe, expect, it } from 'vitest';
import { placeMenu, type PlacementInput } from '@content/menuPlacement';

/** A 1280×720 player at the top-left of the viewport. */
const bounds = { left: 0, top: 0, right: 1280, bottom: 720 };
const menu = { width: 200, height: 120 };

/** A caption low in the frame, where subtitles actually sit. */
const lowAnchor = { left: 500, top: 620, right: 780, bottom: 650 };

function place(overrides: Partial<PlacementInput> = {}) {
  return placeMenu({
    anchor: lowAnchor,
    menu,
    bounds,
    gap: 10,
    margin: 8,
    preference: 'auto',
    ...overrides,
  });
}

describe('placeMenu — side', () => {
  it('prefers above, where captions leave room and the picture is not covered', () => {
    const placement = place();
    expect(placement.side).toBe('above');
    expect(placement.y).toBe(620 - 10 - 120);
  });

  it('flips below when the caption is at the very top', () => {
    const placement = place({ anchor: { left: 500, top: 10, right: 780, bottom: 40 } });
    expect(placement.side).toBe('below');
    expect(placement.y).toBe(50);
  });

  it('honours an explicit preference that fits', () => {
    const placement = place({ preference: 'below', anchor: { left: 500, top: 60, right: 780, bottom: 90 } });
    expect(placement.side).toBe('below');
  });

  it('overrides a preference that cannot fit', () => {
    // Asked for below, but the caption is at the bottom edge — above is the only option.
    const placement = place({ preference: 'below', anchor: { left: 500, top: 660, right: 780, bottom: 700 } });
    expect(placement.side).toBe('above');
  });

  it('picks the roomier side when neither fits', () => {
    const tall = { width: 200, height: 700 };
    expect(place({ menu: tall, anchor: { left: 500, top: 600, right: 780, bottom: 640 } }).side).toBe('above');
    expect(place({ menu: tall, anchor: { left: 500, top: 80, right: 780, bottom: 120 } }).side).toBe('below');
  });
});

describe('placeMenu — horizontal', () => {
  it('centres the menu on the selection', () => {
    // Anchor centre is 640; a 200-wide menu starts at 540.
    expect(place().x).toBe(540);
  });

  it('centres on the whole phrase, not on one word', () => {
    const narrow = place({ anchor: { left: 600, top: 620, right: 680, bottom: 650 } });
    const wide = place({ anchor: { left: 400, top: 620, right: 880, bottom: 650 } });
    expect(narrow.x).toBe(600 + 40 - 100);
    expect(wide.x).toBe(400 + 240 - 100);
  });

  it('keeps the menu inside the player at the left edge', () => {
    const placement = place({ anchor: { left: 0, top: 620, right: 60, bottom: 650 } });
    expect(placement.x).toBe(8);
  });

  it('keeps the menu inside the player at the right edge', () => {
    const placement = place({ anchor: { left: 1220, top: 620, right: 1280, bottom: 650 } });
    expect(placement.x).toBe(1280 - 8 - 200);
  });

  it('respects a player that is not at the viewport origin', () => {
    const offset = { left: 300, top: 100, right: 1580, bottom: 820 };
    const placement = place({ bounds: offset, anchor: { left: 300, top: 700, right: 360, bottom: 730 } });
    expect(placement.x).toBe(308);
  });
});

describe('placeMenu — degenerate cases', () => {
  it('keeps the left edge visible when the menu is wider than the player', () => {
    const placement = place({ menu: { width: 900, height: 120 }, bounds: { left: 0, top: 0, right: 400, bottom: 300 } });
    expect(placement.x).toBe(8);
  });

  it('keeps the top edge visible when the menu is taller than the player', () => {
    const placement = place({ menu: { width: 200, height: 900 }, bounds: { left: 0, top: 0, right: 400, bottom: 300 } });
    expect(placement.y).toBe(8);
  });
});
