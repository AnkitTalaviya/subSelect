/**
 * Where the context menu goes (§16, §47).
 *
 * Pure geometry, so the rules can be tested without a DOM or a video.
 *
 * Two constraints shape it. The menu must not cover the subtitle it describes, which
 * rules out centring it on the selection; and it must stay inside the player, because it
 * is mounted inside the player container so that it survives fullscreen — which also
 * means anything outside those bounds risks being clipped by the player's `overflow`.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlacementInput {
  /** Union of the selected word rects, in viewport coordinates. */
  anchor: Box;
  menu: { width: number; height: number };
  /** The area to stay inside — the player box, in viewport coordinates. */
  bounds: Box;
  /** Space between the menu and the selection. */
  gap: number;
  /** Space kept between the menu and the edge of the bounds. */
  margin: number;
  preference: 'auto' | 'above' | 'below';
}

export interface Placement {
  /** Viewport coordinates of the menu's top-left corner. */
  x: number;
  y: number;
  side: 'above' | 'below';
}

function clamp(value: number, min: number, max: number): number {
  // When the menu is wider than the space available, min can exceed max; preferring min
  // keeps the left edge visible, which is the readable failure.
  return max < min ? min : Math.min(Math.max(value, min), max);
}

export function placeMenu(input: PlacementInput): Placement {
  const { anchor, menu, bounds, gap, margin, preference } = input;

  const above = anchor.top - gap - menu.height;
  const below = anchor.bottom + gap;

  const fitsAbove = above >= bounds.top + margin;
  const fitsBelow = below + menu.height <= bounds.bottom - margin;

  let side: 'above' | 'below';
  if (preference === 'above') side = fitsAbove || !fitsBelow ? 'above' : 'below';
  else if (preference === 'below') side = fitsBelow || !fitsAbove ? 'below' : 'above';
  // Auto prefers above: captions sit low in the frame, so above is both where the room is
  // and where the menu is least likely to cover the picture.
  else if (fitsAbove) side = 'above';
  else if (fitsBelow) side = 'below';
  else side = anchor.top - bounds.top >= bounds.bottom - anchor.bottom ? 'above' : 'below';

  const y = clamp(
    side === 'above' ? above : below,
    bounds.top + margin,
    bounds.bottom - margin - menu.height,
  );

  const centred = anchor.left + (anchor.right - anchor.left) / 2 - menu.width / 2;
  const x = clamp(centred, bounds.left + margin, bounds.right - margin - menu.width);

  return { x, y, side };
}
