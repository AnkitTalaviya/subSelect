import { describe, expect, it } from 'vitest';
import { pickWordAtPoint, type WordRect } from '@content/hitTest';

/**
 * Two caption lines, laid out the way a centred subtitle actually sits:
 *
 *   line 0 (y 100–120):   [Ich 10-40] [habe 50-90] [gestern 100-170]
 *   line 1 (y 130–150):   [einen 10-60] [interessanten 70-190]
 */
const rects: WordRect[] = [
  { id: 'ich', left: 10, right: 40, top: 100, bottom: 120 },
  { id: 'habe', left: 50, right: 90, top: 100, bottom: 120 },
  { id: 'gestern', left: 100, right: 170, top: 100, bottom: 120 },
  { id: 'einen', left: 10, right: 60, top: 130, bottom: 150 },
  { id: 'interessanten', left: 70, right: 190, top: 130, bottom: 150 },
];

describe('pickWordAtPoint — direct hits', () => {
  it('returns the word under the pointer', () => {
    expect(pickWordAtPoint(25, 110, rects)).toBe('ich');
    expect(pickWordAtPoint(70, 110, rects)).toBe('habe');
    expect(pickWordAtPoint(120, 140, rects)).toBe('interessanten');
  });

  it('counts the edges of a word as inside it', () => {
    expect(pickWordAtPoint(10, 100, rects)).toBe('ich');
    expect(pickWordAtPoint(40, 120, rects)).toBe('ich');
  });
});

describe('pickWordAtPoint — gaps and overshoot', () => {
  it('picks the nearer word when the pointer is in the space between two', () => {
    expect(pickWordAtPoint(43, 110, rects)).toBe('ich');
    expect(pickWordAtPoint(47, 110, rects)).toBe('habe');
  });

  it('stays on the last word when the drag overshoots the end of a line', () => {
    // Far to the right of "gestern" but still on line 0 — a word on line 1 is closer in
    // raw distance, and picking it would make the selection jump a line.
    expect(pickWordAtPoint(400, 110, rects)).toBe('gestern');
  });

  it('stays on the first word when the drag overshoots to the left', () => {
    expect(pickWordAtPoint(-200, 110, rects)).toBe('ich');
  });

  it('moves to the line below once the pointer is genuinely on it', () => {
    expect(pickWordAtPoint(120, 145, rects)).toBe('interessanten');
    expect(pickWordAtPoint(30, 145, rects)).toBe('einen');
  });

  it('picks a word on the nearest line when the pointer is below everything', () => {
    expect(['einen', 'interessanten']).toContain(pickWordAtPoint(100, 400, rects));
  });
});

describe('pickWordAtPoint — bounds', () => {
  it('returns null when there is nothing to pick', () => {
    expect(pickWordAtPoint(10, 10, [])).toBeNull();
  });

  it('gives up once the pointer strays past maxDistance', () => {
    expect(pickWordAtPoint(25, 2000, rects, 220)).toBeNull();
    expect(pickWordAtPoint(25, 115, rects, 220)).toBe('ich');
  });

  it('weighs a vertical miss more heavily than a horizontal one', () => {
    // Equal raw distance from line 0, one sideways and one downwards: the sideways
    // candidate must win, or dragging along a line would slip onto its neighbour.
    const sideways = pickWordAtPoint(200, 110, rects);
    expect(sideways).toBe('gestern');
  });
});
