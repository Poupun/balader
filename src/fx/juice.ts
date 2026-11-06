// Juice: springs, pops, shakes, count-ups, flying cards. Springs are sampled
// into keyframes for the Web Animations API, so they run off the main thread
// and work the same in WKWebView (macOS) and WebView2 (Windows).

import { motion, ms } from './motion';
import { random } from './rng';

export interface SpringOpts {
  stiffness?: number;
  damping?: number;
  mass?: number;
  delay?: number;
}

/** Damped spring from 0 → 1, sampled at 120 Hz until it settles. */
export function springCurve(stiffness = 260, damping = 14, mass = 1): { values: number[]; duration: number } {
  const dt = 1 / 120;
  let x = 0;
  let v = 0;
  const values: number[] = [0];
  for (let i = 0; i < 720; i++) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    values.push(x);
    if (i > 12 && Math.abs(x - 1) < 0.0015 && Math.abs(v) < 0.02) break;
  }
  values[values.length - 1] = 1;
  return { values, duration: values.length * dt * 1000 };
}

export function spring(el: Element, frame: (v: number) => Keyframe, opts: SpringOpts = {}): Animation | null {
  if (!el || motion.frozen) return null;
  const { values, duration } = springCurve(opts.stiffness, opts.damping, opts.mass);
  const step = Math.max(1, Math.ceil(values.length / 48));
  const sampled = values.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== 1) sampled.push(1);
  return el.animate(sampled.map(frame), { duration: ms(duration), delay: ms(opts.delay ?? 0), easing: 'linear', fill: 'none' });
}

/** Scale kick that springs back (with overshoot). */
export function pop(el: Element | null, amount = 0.18, opts: SpringOpts = {}): void {
  if (!el) return;
  spring(el, (v) => ({ transform: `scale(${1 + amount * (1 - v)})` }), { stiffness: 380, damping: 11, ...opts });
}

/** Squash & stretch, for presses. */
export function squash(el: Element | null, amount = 0.14): void {
  if (!el) return;
  spring(el, (v) => ({ transform: `scale(${1 + amount * (1 - v)}, ${1 - amount * (1 - v)})` }), { stiffness: 420, damping: 10 });
}

/** Little rotational wobble (hover juice). */
export function wobble(el: Element | null, deg = 4): void {
  if (!el) return;
  spring(el, (v) => ({ transform: `rotate(${deg * (1 - v)}deg) scale(${1 + 0.04 * (1 - v)})` }), { stiffness: 300, damping: 7 });
}

export function shake(el: Element | null, px = 8, duration = 420): void {
  if (!el || motion.frozen) return;
  const n = 9;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= n; i++) {
    const d = 1 - i / n;
    const x = (i % 2 ? 1 : -1) * px * d;
    frames.push({ transform: i === n ? 'none' : `translateX(${x}px) rotate(${x * 0.25}deg)` });
  }
  el.animate(frames, { duration: ms(duration), easing: 'linear' });
}

export function screenShake(px = 6): void {
  if (!motion.shake || motion.reduced || motion.frozen) return;
  const app = document.getElementById('app');
  if (!app) return;
  app.style.setProperty('--shake', `${px}px`);
  app.classList.remove('shake');
  void app.offsetWidth;
  app.classList.add('shake');
  setTimeout(() => app.classList.remove('shake'), 450);
}

/** Count a number up with a slot-machine jitter. */
export function countUp(el: HTMLElement, from: number, to: number, fmt: (n: number) => string, duration = 800): void {
  if (motion.frozen || motion.reduced || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const d = ms(duration);
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / d);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * e);
    el.style.transform = t < 1 ? `translate(${(random() - 0.5) * 2}px, ${(random() - 0.5) * 2}px)` : '';
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Fly a clone of `source` along an arc to `target`, then remove it. */
export function flyTo(source: HTMLElement, target: DOMRect, opts: { duration?: number; spin?: number } = {}): Promise<void> {
  const from = source.getBoundingClientRect();
  if (motion.frozen || motion.reduced || !from.width) return Promise.resolve();
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add('flyer');
  clone.removeAttribute('data-testid');
  Object.assign(clone.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: '0', transform: 'none' });
  document.body.appendChild(clone);
  const dx = target.left + target.width / 2 - (from.left + from.width / 2);
  const dy = target.top + target.height / 2 - (from.top + from.height / 2);
  const lift = -Math.max(80, Math.abs(dx) * 0.35);
  const spin = opts.spin ?? 22;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = dx * ease;
    const y = dy * ease + lift * 4 * t * (1 - t);
    const sc = 1 - 0.62 * ease + 0.12 * Math.sin(t * Math.PI);
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(${spin * Math.sin(t * Math.PI)}deg) scale(${sc})`, opacity: t > 0.9 ? 1 - (t - 0.9) * 10 : 1 });
  }
  const anim = clone.animate(frames, { duration: ms(opts.duration ?? 620), easing: 'linear', fill: 'forwards' });
  return anim.finished.then(
    () => clone.remove(),
    () => clone.remove(),
  );
}

/** Split text into per-letter spans (for waves and hops). */
export function letters(text: string, cls = ''): HTMLSpanElement[] {
  return [...text].map((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch === ' ' ? ' ' : ch;
    if (cls) s.className = cls;
    s.style.setProperty('--i', String(i));
    return s;
  });
}

/** Typewriter reveal. */
export function typeIn(el: HTMLElement, text: string, cps = 90): void {
  if (motion.frozen || motion.reduced) {
    el.textContent = text;
    return;
  }
  let i = 0;
  const d = 1000 / cps / motion.timeScale;
  const t = setInterval(() => {
    i = Math.min(text.length, i + 2);
    el.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(t);
  }, d);
}
