// The table: URL slot on top, the stage (deck / showcase / bust) and the hand,
// then the bet slip with GRAB IT! and FOLD.

import { pop, shake, squash, typeIn } from '../fx/juice';
import { motion, ms } from '../fx/motion';
import { pick as pickRandom } from '../fx/rng';
import { sfx } from '../fx/sound';
import type { ErrorPayload, ProbeResult } from '../api/types';
import { deal, fold, pasteAndDeal, selectedCard, setModal, setUrl, store, type AppState } from '../state/app';
import { h, replace } from './dom';
import { compact, duration, looksLikeUrl, plural, uploadDate } from './format';
import { centerOf, fxctx } from './fxctx';
import { mountHand } from './hand';
import { icon } from './icons';
import { button, setDisabled } from './widgets';

const QUIPS = [
  'Shuffling the deck',
  'Reading the table',
  'Counting the formats',
  'Asking the dealer',
  'Peeking at the cards',
  'Cutting the deck',
];

const PLATFORMS = ['YouTube', 'TikTok', 'Instagram', 'X', 'Vimeo', 'SoundCloud', 'Twitch', 'Reddit', '+1800'];

// ------------------------------------------------------------ slot

function mountSlot(parent: HTMLElement): void {
  const input = h('input', {
    type: 'text',
    placeholder: 'Paste a link from YouTube, TikTok, anywhere…',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    testid: 'url-input',
    'aria-label': 'Video link',
  });
  const linkIcon = icon('link', 'slot__icon');
  const field = h('div', { class: 'slot__field' }, linkIcon, input);
  const paste = button([icon('paste'), 'PASTE'], { cls: 'btn--ghost', testid: 'paste', tip: 'Paste the link on your clipboard and deal (⌘V / Ctrl+V)', sound: 'paste', onClick: () => void pasteAndDeal() });
  const dealBtn = button([h('span', { class: 'lbl' }, 'DEAL'), icon('play')], { cls: 'btn--mode btn--deal', testid: 'deal', tip: 'Read the link and deal the quality cards (Enter)', onClick: () => void deal() });
  parent.appendChild(h('div', { class: 'slot panel', testid: 'slot' }, field, paste, dealBtn));

  const validate = () => {
    const v = input.value.trim();
    field.classList.toggle('is-valid', looksLikeUrl(v));
    field.classList.toggle('is-invalid', false);
  };

  input.addEventListener('input', () => {
    setUrl(input.value);
    validate();
    sfx.play('tick', { pitch: 1.6 });
  });
  input.addEventListener('paste', () => {
    setTimeout(() => {
      setUrl(input.value);
      validate();
      squash(field, 0.05);
      sfx.play('paste');
      if (looksLikeUrl(input.value)) {
        pop(linkIcon, 0.6);
        setTimeout(() => void deal(), ms(180));
      }
    }, 0);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dealBtn.click();
    }
  });

  store.subscribe((s, prev) => {
    if (s.url !== prev.url && s.url !== input.value) {
      input.value = s.url;
      validate();
    }
    if (s.phase !== prev.phase || s.url !== prev.url) {
      const probing = s.phase === 'probing';
      setDisabled(dealBtn, probing);
      dealBtn.querySelector('.lbl')!.textContent = probing ? 'DEALING' : 'DEAL';
      dealBtn.classList.toggle('is-ready', !probing && looksLikeUrl(s.url) && s.phase !== 'dealt');
    }
    if (s.phase === 'error' && prev.phase !== 'error' && s.error?.code === 'invalid_url') {
      field.classList.add('is-invalid');
      shake(field, 8);
    }
  });
}

// ------------------------------------------------------------ stage

function deckEl(shuffling: boolean): HTMLElement {
  return h(
    'div',
    { class: `deck${shuffling ? ' is-shuffling' : ''}`, testid: 'deck' },
    Array.from({ length: 6 }, (_, i) => h('div', { class: 'card-back', style: { '--i': String(i) } })),
  );
}

/** Draw the thumbnail chunky first, then sharpen: a little "focus pull". */
function pixelReveal(canvas: HTMLCanvasElement, src: string): void {
  const img = new Image();
  img.onload = () => {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(box.width * dpr));
    const H = Math.max(1, Math.round(box.height * dpr));
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return;
    // object-fit: cover
    const scale = Math.max(W / img.width, H / img.height);
    const sw = W / scale;
    const sh = H / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    const steps = motion.frozen || motion.reduced ? [1] : [28, 16, 9, 5, 3, 1];
    const tmp = document.createElement('canvas');
    steps.forEach((block, i) => {
      setTimeout(() => {
        const w = Math.max(1, Math.round(W / block));
        const hh = Math.max(1, Math.round(H / block));
        tmp.width = w;
        tmp.height = hh;
        const t = tmp.getContext('2d')!;
        t.imageSmoothingEnabled = true;
        t.drawImage(img, sx, sy, sw, sh, 0, 0, w, hh);
        g.imageSmoothingEnabled = block === 1;
        g.clearRect(0, 0, W, H);
        g.drawImage(tmp, 0, 0, w, hh, 0, 0, W, H);
        if (block > 1) sfx.play('tick', { pitch: 0.7 + i * 0.15 });
      }, ms(i * 85));
    });
  };
  img.src = src;
}

function platformTag(name: string, color: string): HTMLElement {
  return h('span', { class: 'tag platform', style: { '--pc': color } }, name);
}

function showcase(p: ProbeResult, thumb: string | null, s: AppState): HTMLElement {
  const canvas = h('canvas', { testid: 'thumb-canvas' });
  let title = '';
  let sub = '';
  let dur = '';
  const tags: HTMLElement[] = [];
  let placeholder = 'video';
  if (p.kind === 'video') {
    const m = p.media;
    title = m.title;
    sub = [m.uploader ? `by ${m.uploader}` : '', m.viewCount ? `${compact(m.viewCount)} views` : '', uploadDate(m.uploadDate)].filter(Boolean).join(' · ');
    dur = duration(m.duration);
    tags.push(platformTag(m.platform.name, m.platform.color));
    if (m.hasVideo) tags.push(h('span', { class: 'tag' }, plural(m.tiers.length, 'tier')));
    else tags.push(h('span', { class: 'tag tag--blue' }, 'AUDIO ONLY'));
    if (m.tiers.some((t) => t.label >= 2160)) tags.push(h('span', { class: 'tag tag--gold' }, '4K'));
    if (m.tiers.some((t) => t.mp4.hdr || t.mkv.hdr)) tags.push(h('span', { class: 'tag tag--purple' }, 'HDR'));
    if (m.tiers.some((t) => (t.mp4.fps ?? 0) > 30)) tags.push(h('span', { class: 'tag tag--red' }, '60FPS'));
    if (m.subtitles.length) tags.push(h('span', { class: 'tag tag--ghost' }, `SUBS ${m.subtitles.slice(0, 3).join(' ').toUpperCase()}`));
    if (!m.hasVideo) placeholder = 'note';
  } else if (p.kind === 'playlist') {
    const pl = p.playlist;
    title = pl.title;
    sub = [plural(pl.count, 'item'), pl.uploader ? `by ${pl.uploader}` : ''].filter(Boolean).join(' · ');
    dur = `${pl.count}×`;
    tags.push(platformTag(pl.platform.name, pl.platform.color), h('span', { class: 'tag tag--purple' }, 'PLAYLIST'));
    placeholder = 'list';
  } else {
    title = `Scraped ${plural(p.candidates.length, 'media file')}`;
    sub = new URL(p.page).hostname;
    tags.push(h('span', { class: 'tag tag--gold' }, 'BALADER SCRAPER'), h('span', { class: 'tag tag--ghost' }, 'NO EXTRACTOR NEEDED'));
    placeholder = 'globe';
  }
  tags.forEach((t, i) => t.style.setProperty('--i', String(i)));
  const titleEl = h('h2', { class: 'showcase__title ink', testid: 'media-title', 'data-tip': title }, '');
  const thumbBox = h('div', { class: 'thumb' }, thumb ? canvas : h('div', { class: 'thumb__ph' }, icon(placeholder)), dur ? h('div', { class: 'thumb__badge' }, dur) : null);
  const el = h(
    'div',
    { class: 'showcase panel', testid: 'showcase', 'data-kind': p.kind },
    thumbBox,
    h('div', { class: 'showcase__meta' }, titleEl, h('div', { class: 'showcase__sub', testid: 'media-sub' }, sub), h('div', { class: 'showcase__tags' }, tags)),
  );
  typeIn(titleEl, title, 140);
  if (thumb) requestAnimationFrame(() => pixelReveal(canvas, thumb));
  void s;
  return el;
}

function bust(err: ErrorPayload): HTMLElement {
  const actions: HTMLElement[] = [];
  if (['bot_check', 'login_required', 'private', 'rate_limited'].includes(err.code)) {
    actions.push(button('COOKIES', { cls: 'btn--sm btn--gold', testid: 'bust-settings', tip: 'Open Settings → Cookies from browser', onClick: () => setModal('settings') }));
  }
  if (err.code === 'engine_missing') actions.push(button('ENGINE', { cls: 'btn--sm btn--gold', onClick: () => setModal('engine') }));
  if (err.code !== 'invalid_url') actions.push(button('RETRY', { cls: 'btn--sm btn--blue', testid: 'bust-retry', onClick: () => void deal() }));
  return h(
    'div',
    { class: 'bust panel', testid: 'bust', 'data-code': err.code, 'data-tip': err.detail ? err.detail.slice(-600) : undefined },
    h('div', { class: 'bust__stamp' }, 'BUST!'),
    h('div', { class: 'bust__text' }, h('b', { testid: 'bust-message' }, err.message), err.hint ? h('span', { testid: 'bust-hint' }, err.hint) : null),
    h('div', { class: 'bust__actions' }, actions),
  );
}

function mountStage(parent: HTMLElement): HTMLElement {
  const top = h('div', { class: 'stage__top', testid: 'stage-top' });
  const stage = h('div', { class: 'stage', testid: 'stage' }, top);
  parent.appendChild(stage);
  let quipTimer: ReturnType<typeof setInterval> | null = null;

  const render = (s: AppState) => {
    if (quipTimer) clearInterval(quipTimer);
    quipTimer = null;
    stage.classList.toggle('is-empty', s.phase === 'idle' || s.phase === 'probing');
    if (s.phase === 'dealt' && s.probe) {
      replace(top, showcase(s.probe, s.thumb, s));
      return;
    }
    if (s.phase === 'error' && s.error) {
      replace(top, bust(s.error));
      return;
    }
    const probing = s.phase === 'probing';
    const headline = h('h3', { class: 'ink', testid: 'deck-headline' }, probing ? h('span', { class: 'dots' }, QUIPS[0]) : 'Drop a link, deal a hand.');
    const copy = h(
      'div',
      { class: 'deck-copy' },
      headline,
      h('p', { class: 'ink' }, probing ? 'Asking the site what it has. Big videos take a few seconds.' : 'Paste any video or music link. Balader reads it and deals one card per quality.'),
      probing ? null : h('div', { class: 'platforms' }, PLATFORMS.map((p) => h('span', { class: 'tag tag--ghost' }, p))),
    );
    replace(top, h('div', { class: 'deck-zone' }, deckEl(probing), copy));
    if (probing) {
      sfx.play('shuffle');
      quipTimer = setInterval(() => {
        const span = headline.querySelector('span');
        if (span) span.textContent = pickRandom(QUIPS);
        sfx.play('shuffle');
      }, ms(1400));
    }
  };

  store.subscribe((s, prev) => {
    if (s.phase !== prev.phase || s.probe !== prev.probe || s.error !== prev.error) {
      render(s);
      if (s.phase === 'probing') fxctx.bg?.setEnergy(1);
      else fxctx.bg?.setEnergy(0);
      if (s.phase === 'error' && prev.phase !== 'error') {
        sfx.play('error');
        sfx.play('stamp', { delay: 0.08 });
        fxctx.bg?.setPalette('error');
        fxctx.bg?.pulse(0.3);
        setTimeout(() => fxctx.bg?.setPalette(store.get().mode), ms(900));
      }
      if (s.phase === 'dealt' && prev.phase === 'probing') {
        fxctx.bg?.pulse(0.45);
        sfx.play('pop');
      }
    } else if (s.thumb !== prev.thumb && s.thumb && s.phase === 'dealt') {
      const canvas = top.querySelector('canvas') as HTMLCanvasElement | null;
      const box = top.querySelector('.thumb');
      if (canvas) pixelReveal(canvas, s.thumb);
      else if (box) {
        const c = h('canvas', { testid: 'thumb-canvas' });
        box.querySelector('.thumb__ph')?.replaceWith(c);
        requestAnimationFrame(() => pixelReveal(c, s.thumb!));
      }
    }
  });
  render(store.get());
  return stage;
}

// ------------------------------------------------------------ actions

function mountActions(parent: HTMLElement, hand: () => HTMLElement | null): void {
  const title = h('b', { testid: 'betslip-title', class: 'ink' });
  const detail = h('span', { testid: 'betslip-detail' });
  const slip = h('div', { class: 'betslip', testid: 'betslip' }, title, detail);
  const grabBtn = button([h('span', null, 'GRAB IT!'), h('span', { class: 'kbd' }, '↵')], {
    cls: 'btn--lg btn--grab',
    testid: 'grab',
    sound: 'coin',
    onClick: () => {
      hand()?.dispatchEvent(new CustomEvent('grab'));
      const c = centerOf(grabBtn);
      fxctx.particles?.chips(c.x, c.y - 20, 14);
    },
  });
  const foldBtn = button([h('span', null, 'FOLD'), h('span', { class: 'kbd' }, 'esc')], {
    cls: 'btn--red',
    testid: 'fold',
    tip: 'Clear the table',
    sound: 'close',
    onClick: () => fold(),
  });
  parent.appendChild(h('div', { class: 'actions panel', testid: 'actions' }, slip, grabBtn, foldBtn));

  grabBtn.addEventListener('blocked', () => {
    const s = store.get();
    title.textContent = s.phase === 'dealt' ? 'Pick a card first!' : 'Deal a hand first!';
    pop(slip, 0.12);
  });

  const sync = (s: AppState) => {
    const c = selectedCard();
    slip.classList.toggle('is-empty', !c);
    if (c) {
      title.textContent = c.summary;
      detail.textContent = c.detail;
    } else if (s.phase === 'dealt') {
      title.textContent = s.cards.length ? 'Pick a card' : 'Nothing to grab here';
      detail.textContent = s.cards.length ? `${plural(s.cards.length, 'card')} on the table` : '';
    } else if (s.phase === 'probing') {
      title.textContent = 'Dealing…';
      detail.textContent = s.probeUrl ?? '';
    } else {
      title.textContent = 'Empty table';
      detail.textContent = 'Paste a link to get started';
    }
    setDisabled(grabBtn, !c);
    setDisabled(foldBtn, s.phase === 'idle');
  };
  store.subscribe((s, prev) => {
    if (s.selected !== prev.selected || s.cards !== prev.cards || s.phase !== prev.phase) {
      sync(s);
      if (s.selected && s.selected !== prev.selected) pop(title, 0.08);
    }
  });
  sync(store.get());
}

export function mountTable(parent: HTMLElement): void {
  const table = h('main', { class: 'table', testid: 'table' });
  parent.appendChild(table);
  mountSlot(table);
  const stage = mountStage(table);
  mountHand(stage);
  mountActions(table, () => stage.querySelector('.hand'));
  if (motion.frozen) return;
}
