// Tooltips (any element with data-tip) and toasts.

import { sfx } from '../fx/sound';
import { h } from './dom';
import { icon } from './icons';

// ------------------------------------------------------------ tooltips

let tipEl: HTMLElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;

export function hideTip(): void {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  tipEl?.remove();
  tipEl = null;
}

/** Show `text` above `anchor` after the usual delay (the hand drives its cards' tips itself). */
export function showTip(anchor: HTMLElement, text: string): void {
  hideTip();
  tipTimer = setTimeout(() => {
    if (!anchor.isConnected) return;
    const tip = h('div', { class: 'tooltip', role: 'tooltip', testid: 'tooltip' }, text);
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = r.top - t.height - 10;
    if (top < 8) top = r.bottom + 10;
    const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tipEl = tip;
  }, 380);
}

export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const target = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (!target) return;
    const text = target.getAttribute('data-tip');
    if (text) showTip(target, text);
  });
  document.addEventListener('pointerout', (e) => {
    const from = (e.target as Element | null)?.closest?.('[data-tip]');
    const to = (e.relatedTarget as Element | null)?.closest?.('[data-tip]');
    if (from && from !== to) hideTip();
  });
  document.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('blur', hideTip);
}

// ------------------------------------------------------------ toasts

let toastRoot: HTMLElement | null = null;

export interface ToastOpts {
  title: string;
  text?: string;
  color?: string;
  icon?: string;
  duration?: number;
  testid?: string;
}

export function toast(o: ToastOpts): HTMLElement {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  const el = h(
    'div',
    { class: 'toast', role: 'status', testid: o.testid ?? 'toast', style: { '--tc': o.color ?? 'var(--panel-3)' } as Record<string, string> },
    h('div', { class: 'toast__icon' }, icon(o.icon ?? 'star')),
    h('div', { class: 'toast__text' }, h('b', null, o.title), o.text ? h('span', null, o.text) : null),
  );
  el.style.setProperty('--tc', o.color ?? 'var(--panel-3)');
  const dismiss = () => {
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener('click', () => {
    sfx.play('tick');
    dismiss();
  });
  toastRoot.appendChild(el);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild?.remove();
  setTimeout(dismiss, o.duration ?? 4200);
  return el;
}
