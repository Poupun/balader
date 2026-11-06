// Reusable juicy widgets: buttons, steppers, toggles, tabs, slider.

import { pop, shake, squash, wobble } from '../fx/juice';
import { motion, ms } from '../fx/motion';
import { sfx, type SfxName } from '../fx/sound';
import { h } from './dom';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';

type Child = Parameters<typeof h>[2];

export interface JuicyOpts {
  sound?: SfxName | null;
  hover?: boolean;
}

/** Hover tick + wobble, press squash, click sound. Disabled → shake + buzz. */
export function juicy(el: HTMLElement, opts: JuicyOpts = {}): HTMLElement {
  const hover = opts.hover ?? true;
  el.addEventListener('pointerenter', () => {
    if (isDisabled(el)) return;
    sfx.play('hover');
    if (hover) wobble(el, 2.5);
  });
  el.addEventListener('pointerdown', () => {
    if (!isDisabled(el)) el.classList.add('is-pressed');
  });
  const up = () => el.classList.remove('is-pressed');
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener(
    'click',
    (e) => {
      if (isDisabled(el)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        shake(el, 6, 320);
        sfx.play('error');
        el.dispatchEvent(new CustomEvent('blocked', { bubbles: true }));
        return;
      }
      squash(el, 0.1);
      if (opts.sound !== null) sfx.play(opts.sound ?? 'click');
    },
    { capture: true },
  );
  return el;
}

export function isDisabled(el: HTMLElement): boolean {
  return el.classList.contains('is-disabled') || (el as HTMLButtonElement).disabled === true;
}

export function setDisabled(el: HTMLElement, v: boolean): void {
  // Keep it clickable (so it can shake), but look and announce disabled.
  el.classList.toggle('is-disabled', v);
  el.setAttribute('aria-disabled', String(v));
}

export interface ButtonOpts {
  cls?: string;
  testid?: string;
  tip?: string;
  sound?: SfxName | null;
  label?: string;
  onClick?: (e: MouseEvent) => void;
}

export function button(content: Child, opts: ButtonOpts = {}): HTMLButtonElement {
  const b = h('button', { class: `btn ${opts.cls ?? ''}`.trim(), type: 'button', testid: opts.testid, 'data-tip': opts.tip, 'aria-label': opts.label }, content);
  juicy(b, { sound: opts.sound });
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export function iconButton(name: string, opts: ButtonOpts = {}): HTMLButtonElement {
  return button(icon(name), { ...opts, cls: `icon-btn ${opts.cls ?? ''}`.trim(), label: opts.label ?? opts.tip });
}

// ------------------------------------------------------------ stepper

export interface Stepper<T extends string> {
  el: HTMLElement;
  update(v: T): void;
}

export function stepper<T extends string>(opts: {
  values: readonly T[];
  get: () => T;
  set: (v: T) => void;
  label?: (v: T) => string;
  hint?: (v: T) => string;
  testid: string;
}): Stepper<T> {
  const label = opts.label ?? ((v: T) => v.toUpperCase());
  let shown = h('span', { 'data-current': '' }, label(opts.get()));
  const valueBox = h('div', { class: 'stepper__value', testid: `${opts.testid}-value` }, shown);
  const hint = h('div', { class: 'stepper__hint' }, opts.hint?.(opts.get()) ?? '');
  let current = opts.get();

  const go = (dir: 1 | -1) => {
    const i = opts.values.indexOf(current);
    const next = opts.values[(i + dir + opts.values.length) % opts.values.length];
    opts.set(next);
  };
  const left = button('◀', { cls: 'stepper__arrow', testid: `${opts.testid}-prev`, sound: 'tick', label: 'previous', onClick: () => go(-1) });
  const right = button('▶', { cls: 'stepper__arrow', testid: `${opts.testid}-next`, sound: 'tick', label: 'next', onClick: () => go(1) });
  const el = h('div', { class: 'stepper', testid: opts.testid }, left, valueBox, right, opts.hint ? hint : null);

  return {
    el,
    update(v: T) {
      if (v === current) return;
      const oldIdx = opts.values.indexOf(current);
      const newIdx = opts.values.indexOf(v);
      const dir = newIdx > oldIdx || (oldIdx === opts.values.length - 1 && newIdx === 0) ? 1 : -1;
      current = v;
      // Fast clicking: whatever is still sliding out from an earlier switch
      // goes right away, so at most two labels ever exist (old out, new in).
      for (const child of [...valueBox.children]) if (child !== shown) child.remove();
      const old = shown;
      const fresh = h('span', { 'data-current': '' }, label(v));
      old.removeAttribute('data-current');
      old.setAttribute('aria-hidden', 'true');
      valueBox.appendChild(fresh);
      shown = fresh;
      if (!motion.frozen) {
        for (const a of old.getAnimations()) a.cancel();
        old.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-dir * 60}%)`, opacity: 0 }], { duration: ms(180), easing: 'ease-in', fill: 'forwards' }).finished.then(
          () => old.remove(),
          () => old.remove(),
        );
        fresh.animate([{ transform: `translateX(${dir * 70}%) scale(.8)`, opacity: 0 }, { transform: 'translateX(-4%) scale(1.06)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], {
          duration: ms(280),
          easing: 'cubic-bezier(.2,1.4,.4,1)',
        });
      } else old.remove();
      hint.textContent = opts.hint?.(v) ?? '';
      pop(hint, 0.08);
    },
  };
}

// ------------------------------------------------------------ toggle

export interface Toggle {
  el: HTMLButtonElement;
  update(v: boolean): void;
}

export function toggle(opts: { label: string; sub?: string; tip?: string; get: () => boolean; set: (v: boolean) => void; testid: string }): Toggle {
  const box = h('span', { class: 'toggle__box' }, icon('check'));
  const el = h(
    'button',
    { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(opts.get()), testid: opts.testid, 'data-tip': opts.tip },
    box,
    h('span', { class: 'toggle__text' }, opts.label, opts.sub ? h('small', null, opts.sub) : null),
  );
  el.addEventListener('pointerenter', () => sfx.play('hover'));
  el.addEventListener('click', () => {
    const v = !opts.get();
    opts.set(v);
    sfx.play('toggle', { pitch: v ? 1.15 : 0.85 });
    pop(box, 0.35);
    if (v) {
      const c = centerOf(box);
      fxctx.particles?.sparks(c.x, c.y, 8, ['#c8ffe4', '#33c98a']);
    }
  });
  return {
    el,
    update(v: boolean) {
      el.setAttribute('aria-checked', String(v));
    },
  };
}

/** What the embed options do, in plain words (HUD + house rules). */
export const EMBED_COPY = {
  cover: {
    label: 'Embed cover art',
    sub: 'the thumbnail, inside the file',
    tip: "Puts the video's thumbnail inside the file as its artwork.\nYou see it in Finder, Explorer, Apple Music, VLC and on your phone.",
  },
  tags: {
    label: 'Embed title & tags',
    sub: 'title, channel, date, chapters',
    tip: 'Writes the title, the channel (as artist), the upload date,\nthe description and the chapters into the file, so players\nshow real names instead of just the file name.',
  },
  subs: {
    label: 'Embed subtitles',
    sub: 'switch them on in your player',
    tip: "Adds the video's subtitles as tracks you can switch on in\nQuickTime or VLC (video only). Languages are set in House rules\n(default: English). Auto-generated captions aren't included.",
  },
};

// ------------------------------------------------------------ tabs

export function tabs<T extends string>(opts: { items: { value: T; label: Child; testid: string }[]; get: () => T; set: (v: T) => void }): {
  el: HTMLElement;
  buttons: Map<T, HTMLButtonElement>;
  update(v: T): void;
} {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: 'tabs', role: 'tablist' });
  for (const it of opts.items) {
    const b = button(it.label, { cls: 'tab', testid: it.testid, sound: 'tick', onClick: () => opts.set(it.value) });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(opts.get() === it.value));
    buttons.set(it.value, b);
    el.appendChild(b);
  }
  return {
    el,
    buttons,
    update(v: T) {
      for (const [k, b] of buttons) b.setAttribute('aria-selected', String(k === v));
    },
  };
}

// ------------------------------------------------------------ slider (0..1, 10 steps)

export function slider(opts: { get: () => number; set: (v: number) => void; testid: string }): { el: HTMLElement; update(v: number): void } {
  const cells = Array.from({ length: 10 }, () => h('i'));
  const el = h('div', { class: 'slider', role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '1', tabindex: '0', testid: opts.testid }, cells);
  const paint = (v: number) => {
    const on = Math.round(v * 10);
    cells.forEach((c, i) => c.classList.toggle('on', i < on));
    el.setAttribute('aria-valuenow', v.toFixed(1));
  };
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, Math.ceil(((e.clientX - r.left) / r.width) * 10) / 10));
    opts.set(v);
    sfx.play('tick', { pitch: 0.6 + v });
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (el.hasPointerCapture(e.pointerId)) fromEvent(e);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') opts.set(Math.min(1, opts.get() + 0.1));
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') opts.set(Math.max(0, opts.get() - 0.1));
  });
  paint(opts.get());
  return { el, update: paint };
}
