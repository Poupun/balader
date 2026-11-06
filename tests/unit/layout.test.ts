import { describe, expect, it } from 'vitest';
import { fanLayout, overlap } from '../../src/ui/layout';

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
