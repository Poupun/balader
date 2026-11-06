// Pixel particles on a full-window canvas: chip bursts, confetti, sparks.

import { motion } from './motion';
import { random, range, pick } from './rng';

type Shape = 'square' | 'confetti' | 'chip' | 'spark';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  shape: Shape;
  gravity: number;
  drag: number;
}

export interface BurstOptions {
  count?: number;
  colors?: string[];
  speed?: [number, number];
  angle?: number;
  spread?: number;
  gravity?: number;
  life?: [number, number];
  size?: [number, number];
  shape?: Shape;
  drag?: number;
}

export const CHIP_COLORS = ['#ffc93c', '#ff9a1f', '#ff5146', '#f6f1e7'];
export const COOL_COLORS = ['#2b95ff', '#2cc4bd', '#9b6bff', '#f6f1e7'];
export const RAINBOW = ['#ff5146', '#ff9a1f', '#ffc93c', '#33c98a', '#2b95ff', '#9b6bff', '#ff6fa8'];

export class Particles {
  private g: CanvasRenderingContext2D | null;
  private list: P[] = [];
  private raf = 0;
  private last = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
  }

  get count(): number {
    return this.list.length;
  }

  burst(x: number, y: number, o: BurstOptions = {}): void {
    if (motion.reduced || motion.frozen || !this.g) return;
    const n = o.count ?? 24;
    for (let i = 0; i < n; i++) {
      const angle = (o.angle ?? -Math.PI / 2) + (random() - 0.5) * (o.spread ?? Math.PI * 2);
      const sp = range(...(o.speed ?? [3, 9]));
      const max = range(...(o.life ?? [0.6, 1.2]));
      this.list.push({
        x,
        y,
        vx: Math.cos(angle) * sp * 60,
        vy: Math.sin(angle) * sp * 60,
        life: max,
        max,
        size: Math.round(range(...(o.size ?? [3, 7]))),
        color: pick(o.colors ?? CHIP_COLORS),
        rot: random() * Math.PI * 2,
        vr: range(-12, 12),
        shape: o.shape ?? 'square',
        gravity: (o.gravity ?? 0.35) * 60 * 30,
        drag: o.drag ?? 0.985,
      });
    }
    if (this.list.length > 900) this.list.splice(0, this.list.length - 900);
    this.start();
  }

  confetti(x: number, y: number, count = 60): void {
    this.burst(x, y, { count, colors: RAINBOW, speed: [6, 15], spread: Math.PI * 0.9, gravity: 0.4, life: [1.2, 2.2], size: [5, 9], shape: 'confetti', drag: 0.975 });
  }

  chips(x: number, y: number, count = 18, colors = CHIP_COLORS): void {
    this.burst(x, y, { count, colors, speed: [4, 10], gravity: 0.45, life: [0.7, 1.3], size: [6, 10], shape: 'chip' });
  }

  sparks(x: number, y: number, count = 12, colors = ['#fff6c9', '#ffc93c']): void {
    this.burst(x, y, { count, colors, speed: [2, 6], gravity: 0.05, life: [0.3, 0.6], size: [2, 4], shape: 'spark', drag: 0.92 });
  }

  /** Sparkles scattered over an element's rectangle. */
  sparkleRect(r: DOMRect, count = 10, colors?: string[]): void {
    for (let i = 0; i < count; i++) this.sparks(r.left + random() * r.width, r.top + random() * r.height, 2, colors);
  }

  private start(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    const g = this.g!;
    const dt = Math.min(0.05, (now - this.last) / 1000) * motion.timeScale;
    this.last = now;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    for (const p of this.list) {
      p.life -= dt;
      p.vx *= Math.pow(p.drag, dt * 60);
      p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const a = Math.max(0, Math.min(1, p.life / (p.max * 0.35)));
      g.globalAlpha = a;
      g.fillStyle = p.color;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      const s = p.size;
      switch (p.shape) {
        case 'confetti': {
          const w = Math.max(1, Math.round(s * Math.abs(Math.cos(p.rot))));
          g.fillRect(x - w / 2, y - s / 2, w, s * 0.6);
          break;
        }
        case 'chip':
          g.fillRect(x - s / 2 + 1, y - s / 2, s - 2, s);
          g.fillRect(x - s / 2, y - s / 2 + 1, s, s - 2);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          g.fillRect(x - s / 2 + 2, y + s / 2 - 2, s - 4, 1);
          break;
        case 'spark':
          g.fillRect(x - s, y, s * 2 + 1, 1);
          g.fillRect(x, y - s, 1, s * 2 + 1);
          break;
        default:
          g.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    g.globalAlpha = 1;
    this.list = this.list.filter((p) => p.life > 0 && p.y < window.innerHeight + 40);
    if (this.list.length) this.raf = requestAnimationFrame(this.loop);
    else {
      this.raf = 0;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };
}
