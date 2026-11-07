// The cut: grab only part of a video or track. A timeline slides out under
// the showcase: two gold handles (IN / OUT) over a filmstrip made of the
// site's storyboard frames, a little card that pops above the handle and
// shows the frame you're cutting at, time fields you can type into or nudge,
// and FAST / EXACT for video. Values live here while dragging and reach the
// store on release, so the rest of the table only re-renders once.

import { api } from '../api/client';
import type { Storyboard } from '../api/types';
import { pop, shake, squash } from '../fx/juice';
import { motion, ms } from '../fx/motion';
import { sfx } from '../fx/sound';
import { activeCut, cutAvailable, MIN_CUT, mediaDuration, setCut, setCutOpen, setExactCuts, store, type AppState } from '../state/app';
import { h, replace } from './dom';
import { clipLength, clock, parseTime, rulerStep, storyboardFrame } from './format';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { button } from './widgets';

type Which = 'in' | 'out';

interface Drag {
  kind: Which | 'move';
  pointerId: number;
  anchorX: number;
  anchorStart: number;
  anchorEnd: number;
  fine: boolean;
  lastX: number;
  lastAt: number;
  tilt: number;
  bumped: boolean;
  lastTickT: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------ storyboard sheets

const sheetCache = new Map<string, HTMLImageElement | null | 'loading'>();
let onSheet: () => void = () => undefined;

/** A sprite sheet, fetched once through the core (strict CSP: no third-party URLs in the webview). */
function sheetImage(url: string, referer: string | null): HTMLImageElement | null {
  const hit = sheetCache.get(url);
  if (hit === 'loading') return null;
  if (hit !== undefined) return hit;
  sheetCache.set(url, 'loading');
  void api
    .thumbnail(url, referer)
    .then(
      (data) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = data;
        }),
    )
    .catch(() => null)
    .then((im) => {
      sheetCache.set(url, im);
      if (im) onSheet();
    });
  return null;
}

/** Draw frame `t` into a box, cropped to cover it, pixels kept crisp. */
function drawFrame(g: CanvasRenderingContext2D, b: Storyboard, duration: number, t: number, referer: string | null, x: number, y: number, w: number, hgt: number): boolean {
  const f = storyboardFrame(b, duration, t);
  const img = sheetImage(f.url, referer);
  if (!img) return false;
  const fw = Math.min(b.width, img.width - f.sx);
  const fh = Math.min(b.height, img.height - f.sy);
  if (fw <= 0 || fh <= 0) return false;
  const scale = Math.max(w / fw, hgt / fh);
  const cw = w / scale;
  const ch = hgt / scale;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, f.sx + (fw - cw) / 2, f.sy + (fh - ch) / 2, cw, ch, x, y, w, hgt);
  return true;
}

// ------------------------------------------------------------ widget

export interface CutWidget {
  /** The timeline (goes under the showcase). */
  el: HTMLElement;
  /** The CUT button (goes in the showcase's tag row). */
  toggle: HTMLButtonElement;
}

export function mountCut(): CutWidget {
  // --- toggle in the showcase
  const toggleBtn = button([icon('scissors'), h('span', null, 'CUT')], {
    cls: 'btn--sm cut-toggle',
    testid: 'cut-toggle',
    tip: 'Grab only part of it: pick a start and an end  (C)',
    sound: null,
    onClick: () => {
      const on = !store.get().cut.on;
      sfx.play(on ? 'snip' : 'close');
      setCutOpen(on);
    },
  });

  // --- time fields
  const chip = (which: Which) => {
    const value = h('button', { class: 'cut__value', type: 'button', testid: `cut-${which}-value`, 'aria-label': which === 'in' ? 'Start time' : 'End time' }, '0:00.0');
    value.setAttribute('data-tip', 'Click to type a time (1:23.5)\nArrows or wheel: ±1 s · with Shift: ±0.1 s');
    const nudger = (dir: -1 | 1) => {
      const b = button(dir < 0 ? '◀' : '▶', { cls: 'cut__nudge', testid: `cut-${which}-${dir < 0 ? 'earlier' : 'later'}`, sound: null, label: `${which === 'in' ? 'Start' : 'End'} ${dir < 0 ? 'earlier' : 'later'}` });
      b.setAttribute('data-tip', `${dir < 0 ? '−' : '+'}1 s  (Shift: 0.1 s) · hold to keep going`);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const repeat = (shift: boolean, wait: number) => {
        timer = setTimeout(() => {
          nudge(which, dir * (shift ? 0.1 : 1));
          repeat(shift, Math.max(40, wait * 0.85));
        }, wait);
      };
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        nudge(which, dir * (e.shiftKey ? 0.1 : 1));
        repeat(e.shiftKey, ms(380) || 380);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) b.addEventListener(ev, stop);
      // Keyboard activation (pointer presses already nudged on pointerdown).
      b.addEventListener('click', (e) => {
        if (e.detail === 0) nudge(which, dir * (e.shiftKey ? 0.1 : 1));
      });
      return b;
    };
    const el = h('div', { class: `cut__time cut__time--${which}`, testid: `cut-${which}` }, nudger(-1), h('span', { class: 'cut__tlabel' }, which === 'in' ? 'IN' : 'OUT'), value, nudger(1));
    value.addEventListener('click', () => startEdit(which));
    value.addEventListener('pointerenter', () => sfx.play('hover'));
    el.addEventListener(
      'wheel',
      (e) => {
        if (!editing) e.preventDefault();
        if (editing) return;
        const dir = (e.deltaY || -e.deltaX) > 0 ? -1 : 1;
        nudge(which, dir * (e.shiftKey ? 0.1 : 1));
      },
      { passive: false },
    );
    return { el, value };
  };
  const inChip = chip('in');
  const outChip = chip('out');
  const lenValue = h('b', { testid: 'cut-length', 'data-tip': 'Length of the clip' }, '0.0s');

  const fastBtn = button('FAST', { cls: 'cut__mode', testid: 'cut-fast', sound: 'tick', onClick: () => setMode(false) });
  fastBtn.setAttribute('data-tip', 'Fast cut: keeps the original video stream, no re-encoding.\nThe start snaps to the nearest keyframe, so it can begin a second or two early.');
  const exactBtn = button('EXACT', { cls: 'cut__mode', testid: 'cut-exact', sound: 'tick', onClick: () => setMode(true) });
  exactBtn.setAttribute('data-tip', 'Exact cut: starts and ends on the very frame you picked.\nThe clip is re-encoded to H.264 (near-lossless), which takes a little longer.');
  const modes = h('div', { class: 'cut__modes', role: 'radiogroup', testid: 'cut-modes' }, fastBtn, exactBtn);
  const audioNote = h('span', { class: 'cut__note tag tag--ghost', testid: 'cut-audio-note', 'data-tip': 'Audio cuts are always exact, to a few milliseconds.' }, 'EXACT TO THE MS');
  const closeBtn = button(icon('x'), { cls: 'icon-btn cut__close', testid: 'cut-close', tip: 'Back to the whole thing  (C)', sound: 'close', onClick: () => setCutOpen(false) });

  const bar = h('div', { class: 'cut__bar' }, inChip.el, outChip.el, h('div', { class: 'cut__len' }, lenValue), h('span', { class: 'cut__spacer' }), modes, audioNote, closeBtn);

  // --- track
  const film = h('canvas', { class: 'cut__film', testid: 'cut-film' });
  const shadeL = h('div', { class: 'cut__shade cut__shade--l' });
  const shadeR = h('div', { class: 'cut__shade cut__shade--r' });
  const range = h('div', { class: 'cut__range', testid: 'cut-range' });
  const handle = (which: Which) =>
    h(
      'div',
      {
        class: `cut__handle cut__handle--${which}`,
        role: 'slider',
        tabindex: '0',
        testid: `cut-handle-${which}`,
        'aria-label': which === 'in' ? 'Cut start' : 'Cut end',
        'aria-valuemin': '0',
      },
      h('i', { class: 'cut__grip' }),
      h('span', { class: 'cut__hlabel' }, which === 'in' ? 'IN' : 'OUT'),
    );
  const hIn = handle('in');
  const hOut = handle('out');
  const ghost = h('div', { class: 'cut__ghost' });
  const peek = h('canvas', { class: 'cut__peek', width: 320, height: 180 });
  const bubbleTime = h('b', { testid: 'cut-bubble-time' });
  const bubble = h('div', { class: 'cut__bubble', testid: 'cut-bubble', 'aria-hidden': 'true' }, peek, bubbleTime);
  const track = h('div', { class: 'cut__track', testid: 'cut-track' }, film, shadeL, shadeR, range, ghost, hIn, hOut, bubble);
  const ruler = h('div', { class: 'cut__ruler', testid: 'cut-ruler' });

  // "Cut along the dotted line."
  const inner = h('div', { class: 'cut__inner' }, h('span', { class: 'cut__snip', 'aria-hidden': 'true' }, icon('scissors')), bar, track, ruler);
  const el = h('div', { class: 'cut', testid: 'cut', hidden: true }, inner);

  // --- state
  let d = 0;
  let live = { start: 0, end: 0 };
  let drag: Drag | null = null;
  let editing: { which: Which; input: HTMLInputElement } | null = null;
  let open = false;
  let strip: Storyboard | null = null;
  let look: Storyboard | null = null;
  let referer: string | null = null;
  let thumbImg: HTMLImageElement | null = null;
  let thumbSrc: string | null = null;
  let bubbleT: number | null = null;

  const isAudio = () => store.get().mode === 'audio';

  // ---------------------------------------------------------- painting

  const paint = () => {
    track.style.setProperty('--fa', String(d > 0 ? live.start / d : 0));
    track.style.setProperty('--fb', String(d > 0 ? live.end / d : 1));
    if (!editing || editing.which !== 'in') inChip.value.textContent = clock(live.start, 1);
    if (!editing || editing.which !== 'out') outChip.value.textContent = clock(live.end, 1);
    lenValue.textContent = clipLength(live.end - live.start);
    el.dataset.start = String(live.start);
    el.dataset.end = String(live.end);
    const whole = live.start <= 0.0005 && live.end >= d - 0.0005;
    el.classList.toggle('is-whole', whole);
    for (const [hd, t] of [
      [hIn, live.start],
      [hOut, live.end],
    ] as const) {
      hd.setAttribute('aria-valuemax', String(d));
      hd.setAttribute('aria-valuenow', String(t));
      hd.setAttribute('aria-valuetext', clock(t, 1));
    }
  };

  const drawFilm = () => {
    if (!open || d <= 0) return;
    const r = film.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.width * dpr);
    const H = Math.round(r.height * dpr);
    if (film.width !== W || film.height !== H) {
      film.width = W;
      film.height = H;
    }
    const g = film.getContext('2d');
    if (!g) return;
    g.fillStyle = '#081013';
    g.fillRect(0, 0, W, H);
    const video = !isAudio();
    let drawn = false;
    if (strip) {
      const fw = H * (strip.width / strip.height);
      const n = Math.max(1, Math.ceil(W / fw));
      const slot = W / n;
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) / n) * d;
        const x = Math.round(i * slot);
        const w = Math.round((i + 1) * slot) - x;
        if (!drawFrame(g, strip, d, t, referer, x, 0, w, H)) {
          g.fillStyle = i % 2 ? '#0f1c21' : '#122228';
          g.fillRect(x, 0, w, H);
        }
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(x, 0, Math.max(1, dpr), H);
      }
      drawn = true;
    } else if (thumbImg) {
      // No storyboard: the cover, smeared into big pixels, as ambient colour.
      const tw = 40;
      const th = Math.max(1, Math.round((tw * H) / W) || 4);
      const tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      const tg = tmp.getContext('2d');
      if (tg) {
        const s = Math.max(tw / thumbImg.width, th / thumbImg.height);
        tg.drawImage(thumbImg, (tw - thumbImg.width * s) / 2, (th - thumbImg.height * s) / 2, thumbImg.width * s, thumbImg.height * s);
        g.globalAlpha = 0.42;
        g.imageSmoothingEnabled = false;
        g.drawImage(tmp, 0, 0, W, H);
        g.globalAlpha = 1;
        drawn = true;
      }
    }
    // Film perforations (video) or a tape groove (audio).
    if (video) {
      const hole = Math.max(2, Math.round(H * 0.09));
      const gap = hole * 2.6;
      g.fillStyle = drawn ? 'rgba(8,16,19,0.85)' : '#1b2b33';
      for (let x = gap / 2; x < W; x += gap) {
        g.fillRect(Math.round(x), Math.round(hole * 0.5), hole, hole);
        g.fillRect(Math.round(x), H - Math.round(hole * 1.5), hole, hole);
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      for (let y = Math.round(H * 0.3); y < H * 0.75; y += Math.max(2, Math.round(H * 0.12))) g.fillRect(0, y, W, Math.max(1, dpr));
    }
    // Ticks along the bottom: minor fifths, major on the ruler's steps.
    const step = rulerStep(d);
    const minor = step / 5;
    for (let k = 0; k * minor <= d + 1e-6; k++) {
      const x = Math.round(((k * minor) / d) * W);
      const major = k % 5 === 0;
      g.fillStyle = major ? 'rgba(246,241,231,0.7)' : 'rgba(246,241,231,0.28)';
      const th = Math.round(H * (major ? 0.22 : 0.12));
      g.fillRect(x, H - th, Math.max(1, dpr), th);
    }
  };

  const drawRuler = () => {
    if (d <= 0) return replace(ruler);
    const step = rulerStep(d);
    const labels: HTMLElement[] = [];
    for (let k = 0; k * step < d - step * 0.35; k++) {
      labels.push(h('span', { style: { left: `${((k * step) / d) * 100}%` } }, clock(k * step)));
    }
    labels.push(h('span', { class: 'is-end', style: { left: '100%' } }, clock(d)));
    replace(ruler, labels);
  };

  const drawBubble = (t: number) => {
    bubbleT = t;
    bubbleTime.textContent = clock(t, 1);
    const g = peek.getContext('2d');
    const board = look ?? strip;
    bubble.classList.toggle('has-frame', !!board);
    if (!g || !board) return;
    if (!drawFrame(g, board, d, t, referer, 0, 0, peek.width, peek.height)) {
      // The big sheet isn't here yet: show the filmstrip's smaller frame meanwhile.
      if (!(strip && strip !== board && drawFrame(g, strip, d, t, referer, 0, 0, peek.width, peek.height))) {
        g.fillStyle = '#122228';
        g.fillRect(0, 0, peek.width, peek.height);
      }
    }
  };

  const showBubble = (t: number, hover: boolean) => {
    bubble.style.setProperty('--fx', String(d > 0 ? t / d : 0));
    bubble.classList.add('is-on');
    bubble.classList.toggle('is-hover', hover);
    drawBubble(t);
  };
  const hideBubble = () => {
    bubble.classList.remove('is-on');
    bubbleT = null;
  };

  onSheet = () => {
    drawFilm();
    if (bubbleT !== null) drawBubble(bubbleT);
  };

  // ---------------------------------------------------------- commits

  const commit = (start: number, end: number) => {
    const stored = setCut(start, end);
    live = { start: stored.start, end: stored.end };
    paint();
  };

  /** Type or nudge one side; the other side moves along if it has to (keeps the clip length). */
  const applyTime = (which: Which, t: number): boolean => {
    if (d <= 0) return false;
    const len = Math.max(MIN_CUT, live.end - live.start);
    let { start, end } = live;
    const clamped = clamp(t, 0, d);
    if (which === 'in') {
      start = Math.min(clamped, d - MIN_CUT);
      if (end - start < MIN_CUT) end = Math.min(d, start + len);
    } else {
      end = Math.max(clamped, MIN_CUT);
      if (end - start < MIN_CUT) start = Math.max(0, end - len);
    }
    commit(start, end);
    return clamped === t;
  };

  const nudge = (which: Which, delta: number) => {
    if (editing) finishEdit(true);
    const before = which === 'in' ? live.start : live.end;
    const inside = applyTime(which, Math.round((before + delta) * 1000) / 1000);
    const after = which === 'in' ? live.start : live.end;
    const target = which === 'in' ? hIn : hOut;
    if (!inside || after === before) {
      sfx.play('tick', { pitch: 0.5 });
      shake(target, 3, 160);
      return;
    }
    sfx.play('tick', { pitch: 0.75 + (after / d) * 0.8 });
    pop((which === 'in' ? inChip : outChip).value, 0.06);
  };

  const setMode = (exact: boolean) => {
    if ((store.get().settings?.exactCuts ?? true) === exact) return;
    setExactCuts(exact);
    pop(exact ? exactBtn : fastBtn, 0.12);
    const c = centerOf(exact ? exactBtn : fastBtn);
    fxctx.particles?.sparks(c.x, c.y, 6, exact ? ['#fff3c4', '#ffc93c'] : ['#c8f3ff', '#2b95ff']);
  };

  // ---------------------------------------------------------- typing

  const startEdit = (which: Which) => {
    if (editing?.which === which) return;
    if (editing) finishEdit(true);
    const chipEl = which === 'in' ? inChip : outChip;
    const input = h('input', {
      class: 'cut__input',
      type: 'text',
      value: clock(which === 'in' ? live.start : live.end, 1),
      testid: `cut-${which}-input`,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': which === 'in' ? 'Start time' : 'End time',
    });
    chipEl.value.replaceWith(input);
    editing = { which, input };
    sfx.play('click', { pitch: 1.2 });
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEdit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishEdit(false);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = parseTime(input.value) ?? (which === 'in' ? live.start : live.end);
        input.value = clock(clamp(cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1), 0, d), 1);
        sfx.play('tick', { pitch: e.key === 'ArrowUp' ? 1.2 : 0.9 });
      }
    });
    input.addEventListener('blur', () => {
      if (editing?.input === input) finishEdit(true);
    });
  };

  const finishEdit = (save: boolean) => {
    if (!editing) return;
    const { which, input } = editing;
    editing = null;
    const chipEl = which === 'in' ? inChip : outChip;
    input.replaceWith(chipEl.value);
    if (!save) {
      paint();
      sfx.play('close');
      return;
    }
    const t = parseTime(input.value);
    if (t === null) {
      paint();
      sfx.play('error');
      shake(chipEl.el, 6, 300);
      return;
    }
    const inside = applyTime(which, t);
    if (!inside) {
      // Typed past the end: clamped, tell them with a little bump.
      sfx.play('error', { pitch: 1.4 });
      shake(chipEl.el, 4, 220);
    } else {
      sfx.play('select');
      pop(chipEl.value, 0.14);
      const c = centerOf(which === 'in' ? hIn : hOut);
      fxctx.particles?.sparks(c.x, c.y - 20, 8, ['#fff3c4', '#ffc93c']);
    }
  };

  // ---------------------------------------------------------- dragging

  // Times map onto the filmstrip (the track's inner area).
  const timeAt = (clientX: number) => {
    const r = film.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * d;
  };
  const secondsPerPx = () => d / Math.max(1, film.getBoundingClientRect().width);
  const snapStep = (fine: boolean) => {
    const per = secondsPerPx() * (fine ? 0.1 : 1);
    return [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s >= per) ?? 60;
  };
  const snap = (t: number, fine: boolean) => {
    const st = snapStep(fine);
    return Math.round(Math.round(t / st) * st * 1000) / 1000;
  };

  const handleOf = (k: Drag['kind']) => (k === 'out' ? hOut : hIn);

  const beginDrag = (kind: Drag['kind'], e: PointerEvent) => {
    if (d <= 0) return;
    if (editing) finishEdit(true);
    drag = {
      kind,
      pointerId: e.pointerId,
      anchorX: e.clientX,
      anchorStart: live.start,
      anchorEnd: live.end,
      fine: e.shiftKey,
      lastX: e.clientX,
      lastAt: performance.now(),
      tilt: 0,
      bumped: false,
      lastTickT: kind === 'out' ? live.end : live.start,
    };
    track.setPointerCapture(e.pointerId);
    track.classList.add('is-dragging', `is-dragging-${kind}`);
    sfx.play('press', { pitch: kind === 'move' ? 0.9 : 1.15 });
    if (kind !== 'move') squash(handleOf(kind).querySelector('.cut__grip'), 0.18);
    showBubble(kind === 'out' ? live.end : live.start, false);
  };

  const moveDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.shiftKey !== drag.fine) {
      // Re-anchor so switching precision never makes the handle jump.
      drag.fine = e.shiftKey;
      drag.anchorX = e.clientX;
      drag.anchorStart = live.start;
      drag.anchorEnd = live.end;
    }
    const dt = ((e.clientX - drag.anchorX) * secondsPerPx()) * (drag.fine ? 0.1 : 1);
    let { start, end } = live;
    let blocked = false;
    let edge = false;
    if (drag.kind === 'in') {
      const want = snap(drag.anchorStart + dt, drag.fine);
      start = clamp(want, 0, live.end - MIN_CUT);
      blocked = want > live.end - MIN_CUT;
      edge = want <= 0;
    } else if (drag.kind === 'out') {
      const want = snap(drag.anchorEnd + dt, drag.fine);
      end = clamp(want, live.start + MIN_CUT, d);
      blocked = want < live.start + MIN_CUT;
      edge = want >= d;
    } else {
      const len = drag.anchorEnd - drag.anchorStart;
      start = clamp(snap(drag.anchorStart + dt, drag.fine), 0, d - len);
      end = Math.round((start + len) * 1000) / 1000;
      edge = start <= 0 || end >= d;
    }
    // Juice: lean into the motion, tick as time passes, bump at the walls.
    const now = performance.now();
    const v = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastAt);
    drag.lastX = e.clientX;
    drag.lastAt = now;
    drag.tilt = clamp(drag.tilt * 0.6 + v * 9, -14, 14);
    const lean = drag.kind === 'move' ? range : handleOf(drag.kind);
    lean.style.setProperty('--tilt', `${drag.tilt.toFixed(1)}deg`);
    bubble.style.setProperty('--tilt', `${(drag.tilt * 0.5).toFixed(1)}deg`);
    const t = drag.kind === 'out' ? end : start;
    if (Math.abs(t - drag.lastTickT) >= Math.max(snapStep(drag.fine), d / 60)) {
      drag.lastTickT = t;
      sfx.play('tick', { pitch: 0.7 + (t / d) * 0.9 });
    }
    if ((blocked || edge) && !drag.bumped) {
      drag.bumped = true;
      sfx.play(blocked ? 'error' : 'tick', { pitch: blocked ? 1.6 : 0.45 });
      shake(blocked ? range : lean, blocked ? 4 : 2, 180);
    } else if (!blocked && !edge) drag.bumped = false;
    live = { start, end };
    paint();
    showBubble(t, false);
  };

  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const kind = drag.kind;
    drag = null;
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    track.classList.remove('is-dragging', 'is-dragging-in', 'is-dragging-out', 'is-dragging-move');
    for (const x of [hIn, hOut, range]) x.style.setProperty('--tilt', '0deg');
    bubble.style.setProperty('--tilt', '0deg');
    hideBubble();
    const before = activeCut();
    commit(live.start, live.end);
    const target = kind === 'move' ? range : handleOf(kind);
    pop(target, 0.1);
    sfx.play('pop', { pitch: 0.9 + (live.end - live.start) / Math.max(1, d) * 0.5 });
    const c = centerOf(target);
    fxctx.particles?.sparks(c.x, c.y - 26, 7, ['#fff3c4', '#ffc93c', '#ff9a1f']);
    const after = activeCut();
    if (!before && after) sfx.play('snip', { delay: 0.05 });
  };

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || d <= 0) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    if (target.closest('.cut__handle--in')) return beginDrag('in', e);
    if (target.closest('.cut__handle--out')) return beginDrag('out', e);
    const t = timeAt(e.clientX);
    if (t > live.start && t < live.end && live.end - live.start < d - 0.001) return beginDrag('move', e);
    // Outside the window: the nearest side jumps there, then keeps following the pointer.
    const which: Which = Math.abs(t - live.start) <= Math.abs(t - live.end) ? 'in' : 'out';
    const st = snap(t, e.shiftKey);
    if (which === 'in') live = { start: clamp(st, 0, live.end - MIN_CUT), end: live.end };
    else live = { start: live.start, end: clamp(st, live.start + MIN_CUT, d) };
    paint();
    sfx.play('flick', { pitch: 1.2 });
    beginDrag(which, e);
  });
  track.addEventListener('pointermove', (e) => {
    if (drag) return moveDrag(e);
    // Hover scrub: see any moment before cutting there.
    const t = timeAt(e.clientX);
    ghost.style.setProperty('--fx', String(t / Math.max(d, 1e-9)));
    track.classList.add('is-hovering');
    showBubble(t, true);
  });
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('pointerleave', () => {
    if (drag) return;
    track.classList.remove('is-hovering');
    hideBubble();
  });
  track.addEventListener('dblclick', (e) => {
    // Double-click a handle: back to the very start / end.
    const target = e.target as HTMLElement;
    if (target.closest('.cut__handle--in')) applyTime('in', 0);
    else if (target.closest('.cut__handle--out')) applyTime('out', d);
    else return;
    sfx.play('whoosh', { pitch: 1.4 });
  });

  for (const [hd, which] of [
    [hIn, 'in'],
    [hOut, 'out'],
  ] as const) {
    hd.addEventListener('pointerenter', () => sfx.play('hover', { pitch: which === 'in' ? 1 : 1.1 }));
    hd.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
      let handled = true;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudge(which, -step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudge(which, step);
      else if (e.key === 'Home') applyTime(which, 0);
      else if (e.key === 'End') applyTime(which, d);
      else if (e.key === 'Enter') startEdit(which);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    hd.addEventListener('focus', () => showBubble(which === 'in' ? live.start : live.end, false));
    hd.addEventListener('blur', () => {
      if (!drag) hideBubble();
    });
  }

  // ---------------------------------------------------------- open / close

  const animateOpen = (on: boolean) => {
    if (on === open) return;
    open = on;
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.classList.toggle('is-on', on);
    if (on) {
      el.hidden = false;
      drawFilm();
      drawRuler();
      if (motion.frozen) return;
      const hgt = el.scrollHeight;
      el.classList.add('is-moving');
      el.animate([{ height: '0px', opacity: 0 }, { height: `${hgt}px`, opacity: 1 }], { duration: ms(360), easing: 'cubic-bezier(.2,1.25,.4,1)' }).finished.then(
        () => el.classList.remove('is-moving'),
        () => el.classList.remove('is-moving'),
      );
      // The handles drop in from above, one after the other.
      [hIn, hOut].forEach((hd, i) => {
        hd.animate([{ translate: '0 -26px', opacity: 0 }, { translate: '0 3px', opacity: 1, offset: 0.7 }, { translate: '0 0', opacity: 1 }], {
          duration: ms(420),
          delay: ms(140 + i * 90),
          easing: 'cubic-bezier(.3,1.4,.5,1)',
          fill: 'backwards',
        });
        setTimeout(() => sfx.play('flick', { pitch: 1 + i * 0.15 }), ms(160 + i * 90));
      });
    } else {
      if (editing) finishEdit(false);
      hideBubble();
      if (motion.frozen) {
        el.hidden = true;
        return;
      }
      const hgt = el.offsetHeight;
      el.classList.add('is-moving');
      el.animate([{ height: `${hgt}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: ms(220), easing: 'cubic-bezier(.5,0,.75,0)' }).finished.then(
        () => {
          el.classList.remove('is-moving');
          if (!open) el.hidden = true;
        },
        () => el.classList.remove('is-moving'),
      );
    }
  };

  // ---------------------------------------------------------- store sync

  const pickBoards = (s: AppState) => {
    const boards = s.probe?.kind === 'video' ? s.probe.media.storyboards : [];
    strip = boards.find((b) => b.width >= 64) ?? boards[boards.length - 1] ?? null;
    look = [...boards].reverse().find((b) => b.width <= 320) ?? strip;
    referer = s.probe?.kind === 'video' ? s.probe.media.webpageUrl : null;
  };

  const loadThumb = (src: string | null) => {
    if (src === thumbSrc) return;
    thumbSrc = src;
    thumbImg = null;
    if (!src) return;
    const im = new Image();
    im.onload = () => {
      if (thumbSrc === src) {
        thumbImg = im;
        drawFilm();
      }
    };
    im.src = src;
  };

  const syncBadge = (s: AppState) => {
    const badge = el.closest('.showcase')?.querySelector<HTMLElement>('.thumb__badge');
    if (!badge) return;
    const c = activeCut(s);
    const d0 = mediaDuration(s);
    badge.classList.toggle('is-cut', !!c);
    if (c) replace(badge, icon('scissors'), clipLength(c.end - c.start));
    else if (d0) badge.textContent = clock(d0);
  };

  const sync = (s: AppState, prev: AppState | null) => {
    const available = cutAvailable(s);
    toggleBtn.hidden = !available;
    if (!prev || s.probe !== prev.probe) {
      d = mediaDuration(s) ?? 0;
      pickBoards(s);
      drawRuler();
    }
    if (!prev || s.thumb !== prev.thumb) loadThumb(s.thumb);
    if (!drag && (!prev || s.cut !== prev.cut || s.probe !== prev.probe)) {
      live = { start: s.cut.start, end: d > 0 ? Math.min(s.cut.end || d, d) : 0 };
      paint();
    }
    const exact = s.settings?.exactCuts ?? true;
    fastBtn.setAttribute('aria-checked', String(!exact));
    exactBtn.setAttribute('aria-checked', String(exact));
    fastBtn.classList.toggle('is-on', !exact);
    exactBtn.classList.toggle('is-on', exact);
    const audio = s.mode === 'audio';
    modes.hidden = audio;
    audioNote.hidden = !audio;
    el.classList.toggle('is-audio', audio);
    animateOpen(available && s.cut.on);
    if (!prev || s.mode !== prev.mode) drawFilm();
    syncBadge(s);
  };

  store.subscribe((s, prev) => {
    if (s.cut !== prev.cut || s.probe !== prev.probe || s.mode !== prev.mode || s.settings !== prev.settings || s.phase !== prev.phase || s.thumb !== prev.thumb) sync(s, prev);
  });
  new ResizeObserver(() => {
    drawFilm();
  }).observe(track);
  sync(store.get(), null);

  return { el, toggle: toggleBtn };
}

/** Re-sync the thumbnail badge after the showcase was rebuilt. */
export function refreshCutBadge(w: CutWidget): void {
  const s = store.get();
  const badge = w.el.closest('.showcase')?.querySelector<HTMLElement>('.thumb__badge');
  const c = activeCut(s);
  if (badge && c) {
    badge.classList.add('is-cut');
    replace(badge, icon('scissors'), clipLength(c.end - c.start));
  }
}
