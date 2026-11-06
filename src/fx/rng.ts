// Seeded randomness (mulberry32) so particles, jitter and the mock backend
// can be replayed exactly in tests (`?seed=42`).

let state = (Date.now() ^ 0x9e3779b9) >>> 0;

export function seed(n: number): void {
  state = n >>> 0;
}

export function random(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const range = (min: number, max: number) => min + random() * (max - min);
export const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
