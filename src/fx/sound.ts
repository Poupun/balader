// Every sound is synthesised live with WebAudio: no audio files, no licences.
// Small random pitch drift keeps repeated sounds from feeling robotic.

import { random } from './rng';

export type SfxName =
  | 'hover'
  | 'click'
  | 'press'
  | 'flick'
  | 'select'
  | 'deselect'
  | 'chip'
  | 'whoosh'
  | 'pop'
  | 'error'
  | 'success'
  | 'stamp'
  | 'toggle'
  | 'tick'
  | 'open'
  | 'close'
  | 'shuffle'
  | 'coin'
  | 'paste';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastPlayed = new Map<string, number>();
  enabled = true;
  volume = 0.6;
  /** Names played since load (tests read this). */
  readonly log: string[] = [];

  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0, attack = 0.004): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, f0: number, f1: number, q: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t, random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  play(name: SfxName, opts: { pitch?: number; delay?: number } = {}): void {
    this.log.push(name);
    if (this.log.length > 200) this.log.shift();
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const now = performance.now();
    const minGap = name === 'hover' || name === 'tick' ? 45 : 18;
    if (now - (this.lastPlayed.get(name) ?? 0) < minGap) return;
    this.lastPlayed.set(name, now);
    const p = (opts.pitch ?? 1) * (0.96 + random() * 0.08);
    const d = opts.delay ?? 0;
    switch (name) {
      case 'hover':
        this.tone('sine', 1900 * p, 1500 * p, 0.035, 0.035, d);
        break;
      case 'tick':
        this.tone('square', 2600 * p, 2400 * p, 0.018, 0.012, d);
        break;
      case 'click':
        this.tone('square', 520 * p, 820 * p, 0.06, 0.05, d);
        this.noise(0.03, 3000, 2000, 2, 0.05, d);
        break;
      case 'press':
        this.tone('triangle', 330 * p, 180 * p, 0.08, 0.09, d);
        break;
      case 'flick':
        this.noise(0.05, 4200 * p, 2400 * p, 1.4, 0.16, d);
        break;
      case 'select':
        this.tone('triangle', 660 * p, 660 * p, 0.06, 0.07, d);
        this.tone('triangle', 990 * p, 990 * p, 0.09, 0.07, d + 0.055);
        break;
      case 'deselect':
        this.tone('triangle', 740 * p, 520 * p, 0.09, 0.05, d);
        break;
      case 'chip':
      case 'coin':
        this.tone('sine', 2650 * p, 2600 * p, 0.14, 0.05, d);
        this.tone('sine', 3980 * p, 3900 * p, 0.1, 0.035, d + 0.008);
        if (name === 'coin') this.tone('sine', 5300 * p, 5300 * p, 0.12, 0.02, d + 0.06);
        break;
      case 'whoosh':
        this.noise(0.24, 600 * p, 3600 * p, 0.8, 0.12, d);
        break;
      case 'pop':
        this.tone('sine', 280 * p, 920 * p, 0.07, 0.09, d);
        break;
      case 'paste':
        this.tone('square', 300 * p, 260 * p, 0.05, 0.05, d);
        this.tone('sine', 900 * p, 1300 * p, 0.08, 0.06, d + 0.04);
        break;
      case 'toggle':
        this.tone('square', 880 * p, 880 * p, 0.035, 0.035, d);
        this.tone('square', 1320 * p, 1320 * p, 0.035, 0.03, d + 0.035);
        break;
      case 'error':
        this.tone('sawtooth', 190 * p, 110 * p, 0.26, 0.07, d);
        this.tone('square', 95 * p, 70 * p, 0.3, 0.05, d + 0.02);
        break;
      case 'stamp':
        this.noise(0.12, 300, 120, 0.7, 0.4, d);
        this.tone('sine', 120, 60, 0.18, 0.2, d);
        break;
      case 'success': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.tone('triangle', f * p, f * p, 0.16, 0.08, d + i * 0.075));
        this.tone('sine', 2093 * p, 2093 * p, 0.3, 0.03, d + 0.3);
        break;
      }
      case 'open':
        this.tone('triangle', 400 * p, 800 * p, 0.12, 0.06, d);
        break;
      case 'close':
        this.tone('triangle', 700 * p, 350 * p, 0.1, 0.05, d);
        break;
      case 'shuffle':
        for (let i = 0; i < 6; i++) this.noise(0.035, 3800, 2600, 1.6, 0.09, d + i * 0.045);
        break;
    }
  }
}

export const sfx = new Sfx();
