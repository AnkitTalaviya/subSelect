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
  /**
   * Height cap for the chosen side. The menu scrolls its result area rather than growing
   * past this, which is what keeps it off the subtitle.
   */
  maxHeight: number;
}

/**
 * Never shrink the menu below this, even in a very short player — a two-line menu is
 * useless. Below this point it is better to overhang the player box a little.
 */
const MIN_HEIGHT = 96;

function clamp(value: number, min: number, max: number): number {
  // When the menu is wider than the space available, min can exceed max; preferring min
  // keeps the left edge visible, which is the readable failure.
  return max < min ? min : Math.min(Math.max(value, min), max);
}

export function placeMenu(input: PlacementInput): Placement {
  const { anchor, menu, bounds, gap, margin, preference } = input;

  // Room between the selection and the edge of the player, on each side.
  const roomAbove = anchor.top - gap - (bounds.top + margin);
  const roomBelow = bounds.bottom - margin - (anchor.bottom + gap);

  const fitsAbove = roomAbove >= menu.height;
  const fitsBelow = roomBelow >= menu.height;

  let side: 'above' | 'below';
  if (preference === 'above') side = fitsAbove || !fitsBelow ? 'above' : 'below';
  else if (preference === 'below') side = fitsBelow || !fitsAbove ? 'below' : 'above';
  // Auto prefers above: captions sit low in the frame, so above is both where the room is
  // and where the menu is least likely to cover the picture.
  else if (fitsAbove) side = 'above';
  else if (fitsBelow) side = 'below';
  else side = roomAbove >= roomBelow ? 'above' : 'below';

  /*
   * The menu is capped to the room on its side instead of being clamped into the player.
   *
   * Clamping was the original approach and it is wrong: on a small player neither side
   * fits, and forcing the box inside the video parks it directly on top of the subtitle it
   * is describing — covering the words, and swallowing the clicks meant for them. Capping
   * the height means the menu always starts on the far side of the gap from the selection,
   * so it can never overlap it.
   */
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(side === 'above' ? roomAbove : roomBelow));
  const height = Math.min(menu.height, maxHeight);

  const y = side === 'above' ? anchor.top - gap - height : anchor.bottom + gap;

  const centred = anchor.left + (anchor.right - anchor.left) / 2 - menu.width / 2;
  const x = clamp(centred, bounds.left + margin, bounds.right - margin - menu.width);

  return { x, y, side, maxHeight };
}
