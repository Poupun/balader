// Global motion switches. Tests use them to make the juicy UI deterministic:
// `timeScale` speeds up JS-driven animation and the mock backend clock,
// `frozen` pauses every CSS animation for pixel-stable screenshots.

export const motion = {
  timeScale: 1,
  reduced: false,
  frozen: false,
  shake: true,
};

export function ms(duration: number): number {
  if (motion.frozen) return 0;
  if (motion.reduced) return Math.min(duration, 140);
  return duration / motion.timeScale;
}

export function setReduced(v: boolean): void {
  motion.reduced = v;
  document.body.classList.toggle('reduced', v);
}

export function setFrozen(v: boolean): void {
  motion.frozen = v;
  document.body.classList.toggle('frozen', v);
}

export function setTimeScale(v: number): void {
  motion.timeScale = Math.max(0.05, Math.min(50, v));
  for (const a of document.getAnimations?.() ?? []) a.playbackRate = motion.timeScale;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export const sleep = (duration: number) => new Promise<void>((r) => setTimeout(r, ms(duration)));
