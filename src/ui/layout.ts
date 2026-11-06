// Pure layout maths for the hand of cards (unit-tested).

export interface Slot {
  x: number;
  y: number;
  r: number;
  z: number;
}

export interface FanOptions {
  /** Max distance between card origins (cards spread out when there is room). */
  maxStep?: number;
  /** How far the outer cards sink (px). */
  arc?: number;
  /** Rotation of the outermost cards (deg). */
  maxRot?: number;
  /** Top padding so lifted cards don't clip. */
  top?: number;
}

/** Fan n cards across `width`: squeeze when crowded, arc and tilt toward the edges. */
export function fanLayout(n: number, width: number, cardW: number, o: FanOptions = {}): Slot[] {
  if (n <= 0) return [];
  const maxStep = o.maxStep ?? cardW + 16;
  const avail = Math.max(0, width - cardW);
  const step = n > 1 ? Math.min(maxStep, avail / (n - 1)) : 0;
  const total = step * (n - 1);
  const x0 = (width - cardW - total) / 2;
  const maxRot = o.maxRot ?? Math.min(12, 1.8 * n);
  const arc = o.arc ?? Math.min(26, 3.2 * n);
  const top = o.top ?? 44;
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;
    return {
      x: Math.round(x0 + i * step),
      y: Math.round(top + arc * 4 * t * t),
      r: Math.round(t * 2 * maxRot * 100) / 100,
      z: i + 1,
    };
  });
}

/** Overlap ratio (0 = side by side, 1 = fully stacked) for a given layout. */
export function overlap(slots: Slot[], cardW: number): number {
  if (slots.length < 2) return 0;
  const step = slots[1].x - slots[0].x;
  return Math.max(0, Math.min(1, 1 - step / cardW));
}
