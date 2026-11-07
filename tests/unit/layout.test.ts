import { describe, expect, it } from 'vitest';
import { fanLayout, hitsCard, overlap, PICK_GAP } from '../../src/ui/layout';

describe('fanLayout', () => {
  it('handles empty and single hands', () => {
    expect(fanLayout(0, 600, 116)).toEqual([]);
    const [one] = fanLayout(1, 600, 116);
    expect(one.x).toBe(242);
    expect(one.r).toBe(0);
  });

  it('stays inside the table and is symmetric', () => {
    for (const n of [2, 3, 5, 8, 12]) {
      const slots = fanLayout(n, 566, 141);
      expect(slots[0].x).toBeGreaterThanOrEqual(0);
      expect(slots[n - 1].x + 141).toBeLessThanOrEqual(566 + 1);
      expect(slots[0].r).toBeCloseTo(-slots[n - 1].r, 5);
      expect(slots[0].y).toBe(slots[n - 1].y);
      for (let i = 1; i < n; i++) expect(slots[i].x).toBeGreaterThan(slots[i - 1].x);
    }
  });

  it('spreads out when there is room and squeezes when crowded', () => {
    expect(overlap(fanLayout(3, 1200, 116), 116)).toBe(0);
    expect(overlap(fanLayout(9, 566, 141), 141)).toBeGreaterThan(0.4);
  });

  it('arcs the outer cards down and tilts them out', () => {
    const s = fanLayout(7, 700, 116);
    expect(s[0].y).toBeGreaterThan(s[3].y);
    expect(s[0].r).toBeLessThan(0);
    expect(s[6].r).toBeGreaterThan(0);
    expect(s.map((x) => x.z)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('fanLayout with a picked card', () => {
  /** Widest strip of a card a person can click: the pick floats above everything, and each card covers the left part of the next. */
  function strips(n: number, width: number, cardW: number, pick: number, scale = 1.1): { strips: number[]; left: number; right: number } {
    const s = fanLayout(n, width, cardW, { pick, pickScale: scale });
    const pickL = s[pick].x + (cardW - cardW * scale) / 2;
    const pickR = pickL + cardW * scale;
    const out = s.map((slot, i) => {
      if (i === pick) return cardW * scale;
      const covers: [number, number][] = [[pickL, pickR], ...s.filter((_, j) => j > i && j !== pick).map((o): [number, number] => [o.x, o.x + cardW])];
      let segs: [number, number][] = [[slot.x, slot.x + cardW]];
      for (const [c, d] of covers) {
        segs = segs.flatMap(([a, b]): [number, number][] => [
          [a, Math.min(b, c)],
          [Math.max(a, d), b],
        ]).filter(([a, b]) => b > a);
      }
      return Math.max(0, ...segs.map(([a, b]) => b - a));
    });
    return { strips: out, left: Math.min(pickL, s[0].x), right: Math.max(pickR, s[n - 1].x + cardW) };
  }

  it('changes nothing without a pick', () => {
    expect(fanLayout(8, 572, 141.5, { pick: -1 })).toEqual(fanLayout(8, 572, 141.5));
    expect(fanLayout(8, 572, 141.5, { pick: 8 })).toEqual(fanLayout(8, 572, 141.5));
  });

  it('never buries a neighbour of the default window hand, whichever card is picked', () => {
    // 1200x780 window, a 4K YouTube video: 8 cards, 572 px of table, cards at 1.22x.
    for (let pick = 0; pick < 8; pick++) {
      const { strips: w } = strips(8, 572, 141.5, pick);
      w.forEach((px, i) => {
        if (i !== pick) expect(px, `card ${i} with card ${pick} picked`).toBeGreaterThanOrEqual(40);
      });
    }
  });

  it('gives every other card the same strip and stays on the table', () => {
    for (const [width, cardW] of [[572, 141.5], [686, 92.6], [420, 81.2], [900, 141.5]]) {
      for (const n of [2, 3, 5, 8, 12]) {
        for (let pick = 0; pick < n; pick++) {
          const { strips: w, left, right } = strips(n, width, cardW, pick);
          const others = w.filter((_, i) => i !== pick && i !== n - 1);
          if (others.length) {
            expect(Math.min(...others), `n=${n} width=${width} pick=${pick}`).toBeGreaterThan(0);
            // The left neighbour also gets the pick's breathing room; rounding moves cards by a pixel.
            expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(PICK_GAP + 2);
          }
          expect(left).toBeGreaterThanOrEqual(-1);
          expect(right).toBeLessThanOrEqual(width + 1);
        }
      }
    }
  });

  it('keeps cards side by side when there is room', () => {
    const { strips: w } = strips(3, 1200, 116, 1);
    expect(w).toEqual([116, 116 * 1.1, 116]);
    const s = fanLayout(3, 1200, 116, { pick: 1 });
    expect(s[1].x - (s[0].x + 116)).toBeGreaterThanOrEqual(16);
    expect(s[2].x - (s[1].x + 116)).toBeGreaterThanOrEqual(16);
  });

  it('keeps the arc, the tilt and the stacking order', () => {
    const plain = fanLayout(8, 572, 141.5);
    const picked = fanLayout(8, 572, 141.5, { pick: 2 });
    expect(picked.map(({ y, r, z }) => ({ y, r, z }))).toEqual(plain.map(({ y, r, z }) => ({ y, r, z })));
    for (let i = 1; i < 8; i++) expect(picked[i].x).toBeGreaterThan(picked[i - 1].x);
  });
});

describe('hitsCard', () => {
  // A 116x162 box resting at (100, 50): centre (158, 131).
  const slot = { x: 100, y: 50, r: 0, z: 1 };
  const box = { w: 116, h: 162 };

  it('hits inside the box and misses outside', () => {
    expect(hitsCard(158, 131, slot, box)).toBe(true);
    expect(hitsCard(101, 51, slot, box)).toBe(true);
    expect(hitsCard(99, 131, slot, box)).toBe(false);
    expect(hitsCard(158, 213, slot, box)).toBe(false);
  });

  it('follows the scale, the lift and the reach', () => {
    // 1.22x around the same centre: 141.5 px wide.
    expect(hitsCard(88, 131, slot, { ...box, scale: 1.22 })).toBe(true);
    expect(hitsCard(86, 131, slot, { ...box, scale: 1.22 })).toBe(false);
    // Lifted 38 px: both edges move up.
    expect(hitsCard(158, 20, slot, { ...box, lift: -38 })).toBe(true);
    expect(hitsCard(158, 180, slot, { ...box, lift: -38 })).toBe(false);
    expect(hitsCard(158, 180, slot, box)).toBe(true);
    // Reach: the risen top of a hovered card still counts.
    expect(hitsCard(158, 40, slot, { ...box, reach: 16 })).toBe(true);
    expect(hitsCard(158, 40, slot, box)).toBe(false);
  });

  it('turns with the card', () => {
    const turned = { ...slot, r: 90 };
    // On its side, the card is 162 wide and 116 tall.
    expect(hitsCard(158 + 75, 131, turned, box)).toBe(true);
    expect(hitsCard(158, 131 + 75, turned, box)).toBe(false);
  });
});
