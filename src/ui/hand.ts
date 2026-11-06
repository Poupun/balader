// The hand: quality cards fanned on the table. Deals in from the deck with a
// flip, bobs while idle, tilts toward the pointer with a moving glare, lifts
// on hover, jumps when picked. Container changes re-flip faces in place.

import { pop, spring } from '../fx/juice';
import { motion, ms } from '../fx/motion';
import { random } from '../fx/rng';
import { sfx } from '../fx/sound';
import type { CardModel } from '../state/cards';
import { grab, select, store, type AppState } from '../state/app';
import { h, replace } from './dom';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { fanLayout } from './layout';
import { toast } from './overlay';
import { flyToPile } from './pile';

// Base card box (CSS). Cards are scaled up/down to fit the table height.
const CARD_W = 116;
const CARD_H = 162;

export function cardFace(c: CardModel): HTMLElement {
  return h(
    'div',
    { class: 'card__face' },
    h('div', { class: 'card__corner' }, h('b', null, c.corner), c.cornerSub ? h('i', null, c.cornerSub) : null),
    h('div', { class: 'card__pip' }, icon(c.icon)),
    h('div', { class: 'card__plaque' }, h('span', { class: 'card__big' }, c.big), h('span', { class: 'card__name' }, c.name)),
    h(
      'div',
      { class: 'card__chips' },
      c.chips.map((ch) => h('span', { class: `tag ${ch.hot ? 'tag--hot' : ''}` }, ch.text)),
    ),
    h('div', { class: 'card__size' }, c.size),
    h('div', { class: 'card__glare' }),
  );
}

function faceSignature(c: CardModel): string {
  return JSON.stringify([c.big, c.corner, c.cornerSub, c.name, c.cls, c.foil, c.chips, c.size, c.disabled, c.icon]);
}

interface CardView {
  el: HTMLElement;
  inner: HTMLElement;
  sig: string;
  model: CardModel;
}

export function mountHand(parent: HTMLElement): void {
  const hint = h('div', { class: 'hand__hint ink', testid: 'hand-hint' });
  const hand = h('div', { class: 'hand', testid: 'hand' }, hint);
  parent.appendChild(hand);

  const views = new Map<string, CardView>();
  let order: string[] = [];
  let dealt = -1;

  const layout = (animate = true) => {
    const H = hand.clientHeight;
    const base = Math.max(0.85, Math.min(1.22, (H - 84) / CARD_H));
    hand.style.setProperty('--base', base.toFixed(3));
    const effW = CARD_W * base;
    const effH = CARD_H * base;
    const arc = Math.min(26, 3.2 * order.length);
    const top = Math.max(16, Math.round((H - effH - arc) / 2) + 8);
    // Boxes stay 116x162 and scale around their centre: shift so the visual lands on the slot.
    const dx = (effW - CARD_W) / 2;
    const dy = (effH - CARD_H) / 2;
    const W = hand.clientWidth;
    let raw = fanLayout(order.length, W, effW, { top, arc });
    // Make room around the selected card so its neighbours never get buried.
    const f = store.get().selected ? order.indexOf(store.get().selected!) : -1;
    if (f >= 0 && raw.length > 1) {
      const step = raw[1].x - raw[0].x;
      const push = Math.max(0, Math.min(effW * 0.42, effW - step + 14));
      if (push > 0) {
        raw = fanLayout(order.length, Math.max(effW, W - 2 * push), effW, { top, arc }).map((s, i) => ({
          ...s,
          x: s.x + push + (i < f ? -push : i > f ? push : 0),
        }));
      }
    }
    const slots = raw.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
    order.forEach((key, i) => {
      const v = views.get(key);
      if (!v) return;
      const s = slots[i];
      if (!animate) v.el.style.transition = 'none';
      v.el.style.setProperty('--x', `${s.x}px`);
      v.el.style.setProperty('--y', `${s.y}px`);
      v.el.style.setProperty('--r', `${s.r}deg`);
      v.el.style.setProperty('--z', String(s.z));
      if (!animate) {
        void v.el.offsetWidth;
        v.el.style.transition = '';
      }
    });
    return slots;
  };

  new ResizeObserver(() => layout(false)).observe(hand);

  const tilt = (v: CardView, e: PointerEvent) => {
    const r = v.el.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    v.el.classList.add('is-tilting');
    v.el.style.setProperty('--ry', `${(px - 0.5) * 26}deg`);
    v.el.style.setProperty('--rx', `${(0.5 - py) * 22}deg`);
    v.el.style.setProperty('--gx', `${px * 100}%`);
    v.el.style.setProperty('--gy', `${py * 100}%`);
    v.el.style.setProperty('--fx', `${px * 100}%`);
    v.el.style.setProperty('--fy', `${py * 100}%`);
  };

  const untilt = (v: CardView) => {
    v.el.classList.remove('is-tilting', 'is-hover');
    for (const p of ['--rx', '--ry']) v.el.style.setProperty(p, '0deg');
  };

  const makeCard = (c: CardModel, index: number): CardView => {
    const inner = h('div', { class: 'card__inner' }, cardFace(c), h('div', { class: 'card__back' }));
    const el = h(
      'div',
      {
        class: `card ${c.cls}${c.foil ? ' is-foil' : ''}${c.disabled ? ' is-disabled' : ''}`,
        'data-key': c.key,
        testid: `card-${c.key}`,
        role: 'button',
        tabindex: '0',
        'aria-pressed': 'false',
        'aria-label': `${c.summary}. ${c.size}`,
        'data-tip': c.tip,
      },
      h('div', { class: 'card__float', style: { '--bob': `${-(index * 0.37 + random() * 0.4).toFixed(2)}s` } as Record<string, string> }, h('div', { class: 'card__lift' }, inner)),
    );
    (el.firstElementChild as HTMLElement).style.setProperty('--bob', `${-(index * 0.37 + random() * 0.4).toFixed(2)}s`);
    const view: CardView = { el, inner, sig: faceSignature(c), model: c };
    el.addEventListener('pointerenter', () => {
      el.classList.add('is-hover');
      sfx.play('hover', { pitch: 0.9 + index * 0.03 });
    });
    el.addEventListener('pointermove', (e) => tilt(view, e));
    el.addEventListener('pointerleave', () => untilt(view));
    el.addEventListener('click', () => pick(view));
    el.addEventListener('dblclick', () => {
      if (store.get().selected !== view.model.key) select(view.model.key);
      void play();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (e.key === 'Enter' && store.get().selected === view.model.key) void play();
        else pick(view);
      }
    });
    return view;
  };

  const pick = (v: CardView) => {
    if (v.model.disabled) {
      sfx.play('error');
      return;
    }
    const was = store.get().selected === v.model.key;
    select(v.model.key);
    if (was) sfx.play('deselect');
    else {
      sfx.play('select');
      const c = centerOf(v.el);
      fxctx.particles?.sparks(c.x, c.y - 40, 10);
      fxctx.particles?.chips(c.x, c.y - 30, 6, v.model.foil ? ['#ffc93c', '#ff6fa8', '#2cc4bd'] : undefined);
    }
  };

  const play = async () => {
    const s = store.get();
    const v = s.selected ? views.get(s.selected) : null;
    if (!v) return;
    try {
      const job = await grab();
      if (job) {
        sfx.play('whoosh');
        sfx.play('chip', { delay: 0.25 });
        void flyToPile(v.el.querySelector('.card__lift') as HTMLElement);
        fxctx.bg?.pulse(0.5);
      }
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      sfx.play('error');
      toast({ title: err.message ?? 'Could not start', text: err.hint ?? undefined, color: 'var(--red)', icon: 'warn' });
    }
  };
  hand.addEventListener('grab', () => void play());

  const removeAll = () => {
    for (const v of views.values()) {
      const el = v.el;
      el.style.pointerEvents = 'none';
      if (motion.frozen) {
        el.remove();
        continue;
      }
      const a = el.animate(
        [
          { opacity: 1, translate: '0 0', rotate: '0deg' },
          { opacity: 0, translate: `${(random() - 0.5) * 120}px 140px`, rotate: `${(random() - 0.5) * 40}deg` },
        ],
        { duration: ms(320), easing: 'cubic-bezier(.5,0,.75,0)' },
      );
      a.finished.then(
        () => el.remove(),
        () => el.remove(),
      );
    }
    views.clear();
    order = [];
  };

  const deal = (cards: CardModel[]) => {
    removeAll();
    order = cards.map((c) => c.key);
    cards.forEach((c, i) => {
      const v = makeCard(c, i);
      views.set(c.key, v);
      hand.appendChild(v.el);
    });
    const slots = layout(false);
    if (motion.frozen) return;
    const ox = hand.clientWidth + 60;
    const oy = -170;
    cards.forEach((c, i) => {
      const v = views.get(c.key)!;
      const s = slots[i];
      const delay = 90 + i * 70;
      spring(
        v.el,
        (t) => ({
          transform: `translate3d(${ox + (s.x - ox) * t}px, ${oy + (s.y - oy) * t}px, 0) rotate(${28 + (s.r - 28) * t}deg)`,
        }),
        { stiffness: 170, damping: 15, delay },
      );
      v.el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1 }], { duration: ms(delay + 200), easing: 'linear' });
      // Flip from the back: rotation and the back's visibility switch at the
      // same instant (edge-on), so no engine ever shows the wrong side.
      const flip = { duration: ms(560), delay: ms(delay), fill: 'backwards' as const };
      v.inner.animate(
        [
          { transform: 'perspective(700px) rotateY(180deg)', easing: 'cubic-bezier(.5,0,.75,0)' },
          { transform: 'perspective(700px) rotateY(180deg)', offset: 0.3, easing: 'cubic-bezier(.5,0,.75,0)' },
          { transform: 'perspective(700px) rotateY(90deg)', offset: 0.6, easing: 'cubic-bezier(.3,1.5,.5,1)' },
          { transform: 'perspective(700px) rotateY(0deg)' },
        ],
        flip,
      );
      const back = v.inner.querySelector('.card__back') as HTMLElement;
      back.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], flip);
      const face = v.inner.querySelector('.card__face') as HTMLElement;
      face.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }], flip);
      setTimeout(() => sfx.play('flick', { pitch: 0.9 + i * 0.04 }), ms(delay));
    });
    const sel = store.get().selected;
    if (sel) {
      const v = views.get(sel);
      const after = 90 + cards.length * 70 + 380;
      setTimeout(() => {
        if (!v || store.get().selected !== sel) return;
        pop(v.inner, 0.12);
        const c = centerOf(v.el);
        fxctx.particles?.sparks(c.x, c.y - 40, 8);
        sfx.play('pop', { pitch: 1.2 });
      }, ms(after));
    }
  };

  const refresh = (cards: CardModel[]) => {
    // Same hand, new faces (container switch): flip each changed card in place.
    cards.forEach((c, i) => {
      const v = views.get(c.key);
      if (!v) return;
      v.model = c;
      v.el.setAttribute('data-tip', c.tip);
      v.el.setAttribute('aria-label', `${c.summary}. ${c.size}`);
      const sig = faceSignature(c);
      if (sig === v.sig) return;
      v.sig = sig;
      const swap = () => {
        v.el.className = `card ${c.cls}${c.foil ? ' is-foil' : ''}${c.disabled ? ' is-disabled' : ''}${store.get().selected === c.key ? ' is-selected' : ''}`;
        v.inner.replaceChild(cardFace(c), v.inner.firstElementChild!);
      };
      if (motion.frozen) return swap();
      setTimeout(swap, ms(110 + i * 35));
      v.inner.animate([{ transform: 'perspective(700px) rotateY(0)' }, { transform: 'perspective(700px) rotateY(90deg)', offset: 0.5 }, { transform: 'perspective(700px) rotateY(0)' }], {
        duration: ms(240),
        delay: ms(i * 35),
        easing: 'ease-in-out',
      });
      setTimeout(() => sfx.play('flick', { pitch: 1.3 }), ms(i * 35));
    });
  };

  const syncSelection = (s: AppState) => {
    hand.classList.toggle('has-selection', !!s.selected);
    layout(true);
    for (const [key, v] of views) {
      const on = key === s.selected;
      if (v.el.classList.contains('is-selected') !== on) {
        v.el.classList.toggle('is-selected', on);
        v.el.setAttribute('aria-pressed', String(on));
        if (on) pop(v.inner, 0.1);
      }
    }
  };

  const syncHint = (s: AppState) => {
    let text = '';
    if (s.phase === 'dealt' && s.cards.length === 0) text = s.mode === 'video' ? 'No video in there. Switch to AUDIO.' : 'No audio in there.';
    else if (s.phase === 'dealt' && !s.selected) text = 'Pick a card. Double-click to grab it right away.';
    hint.textContent = text;
    hint.style.opacity = text ? '1' : '0';
  };

  store.subscribe((s, prev) => {
    if (s.dealSeq !== dealt || (s.cards.length === 0 && views.size > 0)) {
      dealt = s.dealSeq;
      if (s.cards.length) deal(s.cards);
      else removeAll();
    } else if (s.cards !== prev.cards) {
      const sameKeys = s.cards.length === order.length && s.cards.every((c, i) => c.key === order[i]);
      if (sameKeys) refresh(s.cards);
      else deal(s.cards);
    }
    if (s.selected !== prev.selected || s.cards !== prev.cards) syncSelection(s);
    if (s.phase !== prev.phase || s.cards !== prev.cards || s.selected !== prev.selected) syncHint(s);
  });

  // Keyboard helpers used by the global shortcuts.
  hand.addEventListener('select-index', (e) => {
    const i = (e as CustomEvent<number>).detail;
    const key = order[i];
    const v = key ? views.get(key) : null;
    if (v) pick(v);
  });
  hand.addEventListener('select-step', (e) => {
    const dir = (e as CustomEvent<number>).detail;
    if (!order.length) return;
    const cur = store.get().selected ? order.indexOf(store.get().selected!) : -1;
    const next = order[(cur + dir + order.length) % order.length];
    const v = views.get(next);
    if (v && store.get().selected !== next) pick(v);
  });

  replace(hint, '');
}
