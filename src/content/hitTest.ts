/**
 * Pointer → word resolution for drag selection (§5, §39).
 *
 * Kept pure and geometry-only so the behaviour that decides what a drag selects can be
 * tested without a DOM. `SelectionManager` reads the rects once at the start of a drag
 * and feeds them in here on every move, which also keeps `getBoundingClientRect` off the
 * pointermove path.
 *
 * Exact hits are the easy case. The interesting one is everything else: the spaces
 * between words are not part of any word span, and a drag naturally overshoots the end of
 * a line or wanders below the last one. Falling back to "nearest word" is what makes a
 * drag feel continuous instead of snagging.
 */

export interface WordRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How much more a vertical miss costs than a horizontal one.
 *
 * Captions are lines of text, so the line the pointer is on matters far more than how far
 * along it the pointer sits. Without this, dragging past the end of line 1 would jump to
 * whatever word on line 2 happened to be closest in raw distance.
 */
const VERTICAL_PENALTY = 4;

function axisDistance(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

/**
 * The word at a point, or the nearest one.
 *
 * Returns null only when there are no candidates, or when the nearest is further away
 * than `maxDistance` — used to stop a drag that has left the caption area entirely from
 * dragging a selection along with it.
 */
export function pickWordAtPoint(
  x: number,
  y: number,
  rects: readonly WordRect[],
  maxDistance = Number.POSITIVE_INFINITY,
): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const rect of rects) {
    const dx = axisDistance(x, rect.left, rect.right);
    const dy = axisDistance(y, rect.top, rect.bottom);

    // Inside a word: nothing can beat it, so take it immediately.
    if (dx === 0 && dy === 0) return rect.id;

    const score = dx + dy * VERTICAL_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = rect.id;
    }
  }

  return bestScore <= maxDistance ? best : null;
}
