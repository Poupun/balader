// The pile: live downloads (ACTIVE) and the trophy shelf (DONE / history).
// Rows update in place; status changes trigger the big moments.

import { countUp, flyTo, pop, screenShake, shake } from '../fx/juice';
import { ms } from '../fx/motion';
import { sfx } from '../fx/sound';
import { api } from '../api/client';
import type { HistoryEntry, JobSnapshot } from '../api/types';
import { cancelJob, clearFinished, removeHistory, removeJob, retryJob, setPileTab, store, type AppState } from '../state/app';
import { h, replace } from './dom';
import { bytes, eta, plural, speed } from './format';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { toast } from './overlay';
import { button, iconButton, tabs } from './widgets';

const SEGMENTS = 20;
let listEl: HTMLElement | null = null;

/** Grab animation target. */
export function flyToPile(source: HTMLElement): Promise<void> {
  const target = listEl ?? document.querySelector('.pile');
  if (!target) return Promise.resolve();
  const r = target.getBoundingClientRect();
  const dest = new DOMRect(r.left + 10, r.top + 10, Math.min(r.width - 20, 260), 70);
  document.body.classList.add('pile-open');
  return flyTo(source, dest, { duration: 640, spin: 24 }).then(() => {
    const first = listEl?.querySelector('.job');
    if (first) pop(first, 0.06);
  });
}

function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function thumbBox(src: string | null, mode: string): HTMLElement {
  return h('div', { class: 'job__thumb' }, src ? h('img', { src, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, icon(mode === 'audio' ? 'note' : 'video')));
}

interface JobView {
  el: HTMLElement;
  bar: HTMLElement;
  segs: HTMLElement[];
  stage: HTMLElement;
  pct: HTMLElement;
  stats: HTMLElement;
  buttons: HTMLElement;
  status: string;
  lit: number;
}

function buildJob(j: JobSnapshot): JobView {
  const segs = Array.from({ length: SEGMENTS }, () => h('i'));
  const bar = h('div', { class: 'pbar', style: { '--seg': j.mode === 'audio' ? 'var(--blue)' : 'var(--orange)' } }, segs);
  const stage = h('span', { class: 'job__stage' });
  const pct = h('span', { class: 'pct' });
  const stats = h('div', { class: 'job__stats' }, pct, h('span', { class: 'spd' }), h('span', { class: 'eta' }));
  const buttons = h('div', { class: 'job__buttons' });
  const el = h(
    'div',
    { class: 'job', testid: `job-${j.id}`, 'data-id': j.id },
    thumbBox(j.thumbnail, j.mode),
    h(
      'div',
      { class: 'job__body' },
      h('div', { class: 'job__title', 'data-tip': j.title }, j.title),
      h('div', { class: 'job__meta' }, h('span', { class: 'tag' }, j.summary), stage),
      bar,
      stats,
      buttons,
    ),
  );
  return { el, bar, segs, stage, pct, stats, buttons, status: '', lit: 0 };
}

function jobButtons(v: JobView, j: JobSnapshot): void {
  const items: HTMLElement[] = [];
  if (['queued', 'starting', 'downloading', 'processing'].includes(j.status)) {
    items.push(
      iconButton('x', {
        cls: 'icon-btn--sm job__x',
        tip: 'Fold (cancel)',
        testid: `job-cancel-${j.id}`,
        onClick: () => {
          sfx.play('close');
          void cancelJob(j.id);
        },
      }),
    );
  } else {
    if (j.status === 'done' && j.files.length) {
      const file = j.files[0];
      items.push(button(h('span', null, 'OPEN'), { cls: 'btn--sm btn--gold', testid: `job-open-${j.id}`, onClick: () => void api.openPath(file).catch(() => void api.openPath(j.outputDir)) }));
      items.push(button(h('span', null, 'SHOW'), { cls: 'btn--sm btn--ghost', testid: `job-show-${j.id}`, onClick: () => void api.revealPath(file).catch(() => void api.openPath(j.outputDir)) }));
    } else if (j.status === 'done') {
      items.push(button('FOLDER', { cls: 'btn--sm btn--gold', onClick: () => void api.openPath(j.outputDir) }));
    }
    if (j.status === 'error' || j.status === 'cancelled') {
      items.push(button(h('span', null, icon('retry'), 'RETRY'), { cls: 'btn--sm btn--blue', testid: `job-retry-${j.id}`, onClick: () => void retryJob(j.id) }));
    }
    items.push(
      iconButton('x', {
        cls: 'icon-btn--sm job__x',
        tip: 'Remove from the pile',
        testid: `job-remove-${j.id}`,
        onClick: () => {
          v.el.classList.add('out');
          sfx.play('flick');
          setTimeout(() => void removeJob(j.id), ms(260));
        },
      }),
    );
  }
  replace(v.buttons, items.filter((b) => !b.classList.contains('job__x')));
  v.el.querySelector('.job__x')?.remove();
  const x = items.find((b) => b.classList.contains('job__x'));
  if (x) v.el.appendChild(x);
}

function updateJob(v: JobView, j: JobSnapshot): void {
  const lit = j.status === 'done' ? SEGMENTS : Math.floor(j.progress * SEGMENTS);
  v.segs.forEach((s, i) => {
    const on = i < lit;
    if (on && !s.classList.contains('on')) {
      s.classList.add('on', 'pop');
      setTimeout(() => s.classList.remove('pop'), 400);
    } else if (!on) s.classList.remove('on');
    s.classList.toggle('head', i === lit && ['downloading', 'processing', 'starting'].includes(j.status));
  });
  if (lit > v.lit && lit < SEGMENTS && j.status === 'downloading') sfx.play('tick', { pitch: 0.8 + lit / 25 });
  v.lit = lit;
  const live = ['starting', 'downloading', 'processing'].includes(j.status);
  const item = !live ? '' : j.items && j.item ? ` · ${j.item}/${j.items}` : j.parts && j.part ? ` · ${j.part}/${j.parts}` : '';
  v.stage.textContent = `${j.stageLabel}${item}`;
  v.pct.textContent = j.status === 'done' ? '100%' : `${Math.floor(j.progress * 100)}%`;
  const spd = v.stats.querySelector('.spd')!;
  const et = v.stats.querySelector('.eta')!;
  if (j.status === 'downloading') {
    spd.textContent = speed(j.speed);
    et.textContent = j.eta ? `ETA ${eta(j.eta)}` : '';
  } else if (j.status === 'done') {
    spd.textContent = j.total ? bytes(j.total) : '';
    et.textContent = j.alreadyExisted ? 'already had it' : '';
  } else {
    spd.textContent = '';
    et.textContent = j.status === 'queued' ? 'in line' : '';
  }
  if (v.status !== j.status) {
    const prev = v.status;
    v.status = j.status;
    v.el.setAttribute('data-status', j.status);
    jobButtons(v, j);
    v.el.querySelector('.job__stamp')?.remove();
    if (j.status === 'done') {
      v.el.appendChild(h('div', { class: 'job__stamp job__stamp--done' }, j.alreadyExisted ? 'HAD IT' : 'SAVED!'));
      if (prev) celebrate(v.el, j);
    } else if (j.status === 'error') {
      v.el.appendChild(h('div', { class: 'job__stamp job__stamp--error' }, 'BUST'));
      v.el.setAttribute('data-tip', [j.error?.message, j.error?.hint].filter(Boolean).join('\n'));
      if (prev) {
        shake(v.el, 9, 480);
        sfx.play('error');
        sfx.play('stamp', { delay: 0.05 });
        fxctx.bg?.setPalette('error');
        fxctx.bg?.pulse(0.4);
        setTimeout(() => fxctx.bg?.setPalette(store.get().mode), ms(1100));
        toast({ title: 'BUST!', text: j.error?.message ?? 'The download failed.', color: 'var(--red)', icon: 'warn', testid: 'toast-error' });
      }
    } else if (j.status === 'cancelled' && prev) {
      v.el.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.85)' }, { transform: 'scaleY(1)' }], { duration: ms(260) });
    }
  }
}

function celebrate(el: HTMLElement, j: JobSnapshot): void {
  sfx.play('success');
  sfx.play('stamp', { delay: 0.12 });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  const c = centerOf(el);
  fxctx.particles?.confetti(c.x, c.y, 50);
  fxctx.particles?.chips(c.x, c.y, 16);
  screenShake(5);
  fxctx.bg?.setPalette('success');
  fxctx.bg?.pulse(0.8);
  setTimeout(() => fxctx.bg?.setPalette(store.get().mode), ms(1300));
  if (!j.alreadyExisted) toast({ title: 'JACKPOT!', text: `${j.title.slice(0, 60)} is in your stash.`, color: 'var(--gold)', icon: 'star', duration: 3200, testid: 'toast-done' });
}

function historyRow(e: HistoryEntry): HTMLElement {
  const file = e.files[0];
  return h(
    'div',
    { class: 'job', 'data-status': 'done', testid: `history-${e.id}` },
    thumbBox(e.thumbnail, e.mode),
    h(
      'div',
      { class: 'job__body' },
      h('div', { class: 'job__title', 'data-tip': file ?? e.title }, e.title),
      h('div', { class: 'job__meta' }, h('span', { class: 'tag' }, e.summary), h('span', { class: 'job__stage' }, `${bytes(e.size)} · ${timeAgo(e.finishedAt)}`)),
      h(
        'div',
        { class: 'job__buttons' },
        file ? button('OPEN', { cls: 'btn--sm btn--gold', testid: `history-open-${e.id}`, onClick: () => void api.openPath(file).catch(() => toast({ title: 'File moved?', text: 'Balader can’t find it anymore.', color: 'var(--red)', icon: 'warn' })) }) : null,
        file ? button('SHOW', { cls: 'btn--sm btn--ghost', onClick: () => void api.revealPath(file).catch(() => undefined) }) : null,
      ),
    ),
    iconButton('x', { cls: 'icon-btn--sm job__x', tip: 'Forget this one', onClick: () => void removeHistory(e.id) }),
  );
}

export function mountPile(parent: HTMLElement): void {
  const t = tabs<'active' | 'done'>({
    items: [
      { value: 'active', label: [h('span', null, 'ACTIVE'), h('span', { class: 'count', testid: 'count-active' }, '0')], testid: 'tab-active' },
      { value: 'done', label: [h('span', null, 'DONE'), h('span', { class: 'count', testid: 'count-done' }, '0')], testid: 'tab-done' },
    ],
    get: () => store.get().pileTab,
    set: setPileTab,
  });
  const clearBtn = iconButton('x', {
    cls: 'icon-btn--sm',
    tip: 'Clear finished',
    testid: 'pile-clear',
    onClick: () => {
      sfx.play('flick');
      void clearFinished();
    },
  });
  const list = h('div', { class: 'pile__list', testid: 'pile-list' });
  listEl = list;
  const pile = h('aside', { class: 'pile panel', testid: 'pile' }, h('div', { class: 'pile__head' }, h('h2', { class: 'ink' }, 'THE PILE'), clearBtn), t.el, list);
  parent.appendChild(pile);

  const views = new Map<string, JobView>();
  let shownTab: string | null = null;

  const empty = (text: string) => h('div', { class: 'pile__empty', testid: 'pile-empty' }, h('div', { class: 'ghost-card' }), text);

  const renderActive = (s: AppState) => {
    if (shownTab !== 'active') {
      replace(list);
      views.clear();
      shownTab = 'active';
    }
    list.querySelector('.pile__empty')?.remove();
    const ids = new Set(s.jobs.map((j) => j.id));
    for (const [id, v] of views) {
      if (!ids.has(id)) {
        v.el.remove();
        views.delete(id);
      }
    }
    s.jobs.forEach((j, i) => {
      let v = views.get(j.id);
      if (!v) {
        v = buildJob(j);
        views.set(j.id, v);
      }
      if (list.children[i] !== v.el) list.insertBefore(v.el, list.children[i] ?? null);
      updateJob(v, j);
    });
    if (!s.jobs.length) list.appendChild(empty('Grabs land here. Pick a card and hit GRAB IT!'));
  };

  const renderDone = (s: AppState) => {
    shownTab = 'done';
    views.clear();
    replace(list, s.history.length ? s.history.map(historyRow) : empty('Nothing in the stash yet.'));
  };

  store.subscribe((s, prev) => {
    const active = s.jobs.filter((j) => ['queued', 'starting', 'downloading', 'processing'].includes(j.status)).length;
    const countA = pile.querySelector('[data-testid="count-active"]') as HTMLElement;
    const countD = pile.querySelector('[data-testid="count-done"]') as HTMLElement;
    if (countA.textContent !== String(active)) {
      countA.textContent = String(active);
      pop(countA, 0.4);
    }
    if (countD.textContent !== String(s.history.length)) {
      const from = Number(countD.textContent) || 0;
      countUp(countD, from, s.history.length, (n) => String(Math.round(n)), 500);
      if (s.history.length > from) pop(countD, 0.4);
    }
    if (s.pileTab !== prev.pileTab) t.update(s.pileTab);
    if (s.pileTab === 'active' && (s.jobs !== prev.jobs || shownTab !== 'active')) renderActive(s);
    if (s.pileTab === 'done' && (s.history !== prev.history || shownTab !== 'done')) renderDone(s);
    clearBtn.style.visibility = s.pileTab === 'active' && s.jobs.some((j) => !['queued', 'starting', 'downloading', 'processing'].includes(j.status)) ? 'visible' : 'hidden';
    pile.setAttribute('aria-label', `The pile: ${plural(active, 'active download')}`);
  });
}
