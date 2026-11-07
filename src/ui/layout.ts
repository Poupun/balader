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
  /** Index of the picked card: drawn on top and bigger, so the others make room. */
  pick?: number;
  /** How much bigger the picked card is drawn (its CSS scale). */
  pickScale?: number;
}

/** Breathing room on each side of the picked card (px). */
export const PICK_GAP = 4;

/** Fan n cards across `width`: squeeze when crowded, arc and tilt toward the edges. */
export function fanLayout(n: number, width: number, cardW: number, o: FanOptions = {}): Slot[] {
  if (n <= 0) return [];
  const maxStep = o.maxStep ?? cardW + 16;
  const pick = o.pick ?? -1;
  const xs = n > 1 && pick >= 0 && pick < n ? pickedXs(n, width, cardW, maxStep, pick, o.pickScale ?? 1.1) : evenXs(n, width, cardW, maxStep);
  const maxRot = o.maxRot ?? Math.min(12, 1.8 * n);
  const arc = o.arc ?? Math.min(26, 3.2 * n);
  const top = o.top ?? 44;
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) - 0.5 : 0;
    return {
      x: Math.round(xs[i]),
      y: Math.round(top + arc * 4 * t * t),
      r: Math.round(t * 2 * maxRot * 100) / 100,
      z: i + 1,
    };
  });
}

function evenXs(n: number, width: number, cardW: number, maxStep: number): number[] {
  const step = n > 1 ? Math.min(maxStep, Math.max(0, width - cardW) / (n - 1)) : 0;
  const x0 = (width - cardW - step * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => x0 + i * step);
}

/**
 * The picked card floats above the others, bigger. Each card covers the left
 * part of the next one, so the pick buries whatever starts under it: the cards
 * after it start where it ends, and every other card keeps the same strip.
 */
function pickedXs(n: number, width: number, cardW: number, maxStep: number, pick: number, scale: number): number[] {
  const hole = cardW * scale + 2 * PICK_GAP;
  const before = pick;
  const after = n - 1 - pick;
  // Width of the whole hand for a step s between the other cards.
  const span = (s: number) => before * s + hole + (after > 0 ? Math.max(0, s - cardW) + (after - 1) * s + cardW : 0);
  let s: number;
  if (after === 0) s = (width - hole) / (n - 1);
  else if (n === 2) s = width - hole;
  else {
    s = (width - hole - cardW) / (n - 2);
    // Room to spare: the cards sit side by side and the gaps count too.
    if (s > cardW) s = (width - hole) / (n - 1);
  }
  s = Math.max(0, Math.min(maxStep, s));
  const x0 = (width - span(s)) / 2;
  const holeLeft = x0 + before * s;
  return Array.from({ length: n }, (_, i) => {
    if (i < pick) return x0 + i * s;
    if (i === pick) return holeLeft + (hole - cardW) / 2;
    return holeLeft + hole + Math.max(0, s - cardW) + (i - pick - 1) * s;
  });
}

export interface CardShape {
  /** Box size before scaling (px). */
  w: number;
  h: number;
  /** Drawn size relative to the box (scaled around its centre). */
  scale?: number;
  /** Shift along the card's own vertical axis (negative = up), unscaled. */
  lift?: number;
  /** Extra room above the top edge that still counts as this card. */
  reach?: number;
}

/**
 * Is the point (px, py) on a card whose box rests at `slot` (top-left x/y,
 * rotated r degrees around its centre)? Same coordinates as the slot.
 */
export function hitsCard(px: number, py: number, slot: Slot, c: CardShape): boolean {
  const a = (slot.r * Math.PI) / 180;
  const dx = px - (slot.x + c.w / 2);
  const dy = py - (slot.y + c.h / 2);
  // Into the card's own frame (undo the rotation), then undo the lift.
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a) - (c.lift ?? 0);
  const s = c.scale ?? 1;
  return Math.abs(lx) <= (c.w * s) / 2 && ly >= -(c.h * s) / 2 - (c.reach ?? 0) && ly <= (c.h * s) / 2;
}

/** Overlap ratio (0 = side by side, 1 = fully stacked) for a given layout. */
export function overlap(slots: Slot[], cardW: number): number {
  if (slots.length < 2) return 0;
  const step = slots[1].x - slots[0].x;
  return Math.max(0, Math.min(1, 1 - step / cardW));
}
