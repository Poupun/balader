// The hand: quality cards fanned on the table. Deals in from the deck with a
// flip, bobs while idle, tilts toward the pointer with a moving glare, lifts
// on hover, jumps when picked. Container changes re-flip faces in place.

import { pop, spring, springCurve } from '../fx/juice';
import { motion, ms } from '../fx/motion';
import { random } from '../fx/rng';
import { sfx } from '../fx/sound';
import type { CardModel } from '../state/cards';
import { grab, select, store, type AppState } from '../state/app';
import { h, replace } from './dom';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { fanLayout, hitsCard, type Slot } from './layout';
import { hideTip, showTip, toast } from './overlay';
import { flyToPile } from './pile';

// Base card box (CSS). Cards are scaled up/down to fit the table height.
const CARD_W = 116;
const CARD_H = 162;
/** The picked card's extra size and lift: `.card.is-selected { --scale; --lift }` in table.css. */
const PICK_SCALE = 1.1;
const PICK_LIFT = -38;
/** How far a hovered card rises: `.card.is-hover { --lift }`. */
const HOVER_RISE = 16;
/** The deal's spring (stiffness, damping): cards land when it settles. */
const DEAL_SPRING = { stiffness: 170, damping: 15 };

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

/** What needs a flip to change. The size label alone just ticks over in place (cuts change it a lot). */
function faceSignature(c: CardModel): string {
  return JSON.stringify([c.big, c.corner, c.cornerSub, c.name, c.cls, c.foil, c.chips, c.disabled, c.icon]);
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
  // Where each card rests: the pointer finds cards by where they rest, not by
  // where a hovered card has risen to (see cardAt).
  const rest = new Map<string, Slot>();
  let restBase = 1;
  let hovered: CardView | null = null;
  let pointer: { x: number; y: number } | null = null;
  // Until then the cards are still flying in: trust what's drawn.
  let landedAt = 0;

  const layout = (animate = true) => {
    const H = hand.clientHeight;
    // Room above for the picked card's lift, so it never covers the panel above.
    const base = Math.max(0.7, Math.min(1.22, (H - 110) / CARD_H));
    hand.style.setProperty('--base', base.toFixed(3));
    restBase = base;
    const effW = CARD_W * base;
    const effH = CARD_H * base;
    const arc = Math.min(26, 3.2 * order.length);
    const top = Math.max(46, Math.round((H - effH - arc) / 2) + 8);
    // Boxes stay 116x162 and scale around their centre: shift so the visual lands on the slot.
    const dx = (effW - CARD_W) / 2;
    const dy = (effH - CARD_H) / 2;
    const W = hand.clientWidth;
    // The picked card floats on top, bigger: the others make room so none gets buried.
    const sel = store.get().selected;
    const raw = fanLayout(order.length, W, effW, { top, arc, pick: sel ? order.indexOf(sel) : -1, pickScale: PICK_SCALE });
    const slots = raw.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
    rest.clear();
    order.forEach((key, i) => {
      const v = views.get(key);
      if (!v) return;
      const s = slots[i];
      rest.set(key, s);
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
      },
      h('div', { class: 'card__float', style: { '--bob': `${-(index * 0.37 + random() * 0.4).toFixed(2)}s` } as Record<string, string> }, h('div', { class: 'card__lift' }, inner)),
    );
    (el.firstElementChild as HTMLElement).style.setProperty('--bob', `${-(index * 0.37 + random() * 0.4).toFixed(2)}s`);
    const view: CardView = { el, inner, sig: faceSignature(c), model: c };
    // Pointer hover and clicks are handled by the hand (cardAt); keys stay here.
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

  /**
   * The card under the pointer, judged by where the cards rest. A hovered card
   * rises to the front and grows: judged by what's drawn, it hid the next two
   * cards from the pointer, and sweeping right skipped them. The picked card
   * really sits on top, so it counts lifted and bigger.
   */
  const cardAt = (x: number, y: number): CardView | null => {
    if (performance.now() < landedAt) {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.card');
      return (el && views.get(el.dataset.key ?? '')) || null;
    }
    const box = hand.getBoundingClientRect();
    const sel = store.get().selected;
    // Topmost first: the picked card, then the hand from right to left.
    const keys = order.filter((k) => k !== sel).reverse();
    if (sel && views.has(sel)) keys.unshift(sel);
    for (const key of keys) {
      const s = rest.get(key);
      const v = views.get(key);
      if (!s || !v) continue;
      const picked = key === sel;
      const shape = {
        w: CARD_W,
        h: CARD_H,
        scale: restBase * (picked ? PICK_SCALE : 1),
        lift: picked ? PICK_LIFT : 0,
        // The risen top of the hovered card is still that card.
        reach: v === hovered && !picked ? HOVER_RISE : 0,
      };
      if (hitsCard(x - box.left, y - box.top, s, shape)) return v;
    }
    return null;
  };

  const setHover = (v: CardView | null, e?: PointerEvent) => {
    if (v !== hovered) {
      if (hovered) untilt(hovered);
      hovered = v;
      if (v) {
        v.el.classList.add('is-hover');
        sfx.play('hover', { pitch: 0.9 + order.indexOf(v.model.key) * 0.03 });
        showTip(v.el, v.model.tip);
      } else hideTip();
    }
    if (v && e) tilt(v, e);
  };

  hand.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    setHover(cardAt(e.clientX, e.clientY), e);
  });
  hand.addEventListener('pointerleave', () => {
    pointer = null;
    setHover(null);
  });
  // A click takes the card that is lifted under the pointer (what you see is
  // what you pick, even on the pixel where two strips meet); taps that never
  // hovered fall back to the card at the tap.
  hand.addEventListener('click', (e) => {
    const v = hovered ?? cardAt(e.clientX, e.clientY);
    if (!v) return;
    v.el.focus({ preventScroll: true });
    pick(v);
  });
  hand.addEventListener('dblclick', (e) => {
    const v = hovered ?? cardAt(e.clientX, e.clientY);
    if (!v) return;
    if (store.get().selected !== v.model.key) select(v.model.key);
    void play();
  });

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
    rest.clear();
    order = [];
    if (hovered) {
      hovered = null;
      hideTip();
    }
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
    landedAt = 0;
    if (motion.frozen) return;
    landedAt = performance.now() + ms(90 + (cards.length - 1) * 70 + springCurve(DEAL_SPRING.stiffness, DEAL_SPRING.damping).duration);
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
        { ...DEAL_SPRING, delay },
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
      v.el.setAttribute('aria-label', `${c.summary}. ${c.size}`);
      const sig = faceSignature(c);
      if (sig === v.sig) {
        const size = v.inner.querySelector<HTMLElement>('.card__size');
        if (size && size.textContent !== c.size) {
          size.textContent = c.size;
          if (!motion.frozen) size.animate([{ transform: 'scale(1.25)', color: '#e0582b' }, { transform: 'scale(1)' }], { duration: ms(360), easing: 'cubic-bezier(.2,1.4,.4,1)' });
        }
        return;
      }
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
    // The hand just moved under a still pointer: hover what is there now.
    if (pointer) setHover(cardAt(pointer.x, pointer.y));
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
