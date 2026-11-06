// Shared effect singletons (set once at boot).
import type { Background } from '../fx/background';
import type { Particles } from '../fx/particles';

export const fxctx: { bg: Background | null; particles: Particles | null } = { bg: null, particles: null };

export function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
