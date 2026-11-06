// Modals: House Rules (settings), the Engine Room, About.

import { pop } from '../fx/juice';
import { ms, setReduced } from '../fx/motion';
import { sfx } from '../fx/sound';
import type { ComponentStatus, FilenameStyle, Settings } from '../api/types';
import { checkUpdates, installEngine, pickFolder, setModal, store, updateSettings, type AppState, type ModalName } from '../state/app';
import { h, replace } from './dom';
import { bytes } from './format';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { toast } from './overlay';
import { button, EMBED_COPY, iconButton, slider, stepper, toggle } from './widgets';

interface ModalView {
  el: HTMLElement;
  update(s: AppState, prev: AppState): void;
}

// ------------------------------------------------------------ shared bits

function field(label: string, sub: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('div', { class: 'field__label' }, h('b', null, label), h('span', null, sub)), control);
}

const FILENAMES: readonly FilenameStyle[] = ['title', 'titleId', 'uploaderTitle', 'dateTitle'];
const FILENAME_LABEL: Record<FilenameStyle, string> = { title: 'TITLE', titleId: 'TITLE [ID]', uploaderTitle: 'ARTIST - TITLE', dateTitle: 'DATE - TITLE' };
const FILENAME_EXAMPLE: Record<FilenameStyle, string> = {
  title: 'Ocean Waves.mp4',
  titleId: 'Ocean Waves [0cEaNw4vEs0].mp4',
  uploaderTitle: 'Slow Planet - Ocean Waves.mp4',
  dateTitle: '2025-06-14 - Ocean Waves.mp4',
};
const BROWSERS = ['off', 'chrome', 'firefox', 'safari', 'edge', 'brave', 'chromium', 'opera', 'vivaldi'] as const;
type Browser = (typeof BROWSERS)[number];
const PARALLEL = ['1', '2', '3', '4'] as const;

// ------------------------------------------------------------ settings

function settingsView(): ModalView {
  const S = () => store.get().settings!;
  const set = (patch: Partial<Settings>) => updateSettings(patch);
  const bool = (key: keyof Settings) => ({ get: () => Boolean(S()[key]), set: (v: boolean) => set({ [key]: v } as Partial<Settings>) });

  const folder = h('div', { class: 'folder' }, h('button', { class: 'folder__name', type: 'button', testid: 'settings-folder' }, `\u200e${S().outputDir}\u200e`), button('CHANGE', { cls: 'btn--sm btn--blue', onClick: () => void pickFolder() }));
  const filename = stepper<FilenameStyle>({ values: FILENAMES, get: () => S().filename, set: (v) => set({ filename: v }), label: (v) => FILENAME_LABEL[v], hint: (v) => FILENAME_EXAMPLE[v], testid: 'set-filename' });
  const parallel = stepper<(typeof PARALLEL)[number]>({ values: PARALLEL, get: () => String(S().maxConcurrent) as '1', set: (v) => set({ maxConcurrent: Number(v) }), hint: (v) => (v === '1' ? 'one at a time' : `${v} at once`), testid: 'set-parallel' });
  const cookies = stepper<Browser>({
    values: BROWSERS,
    get: () => (S().cookiesBrowser ?? 'off') as Browser,
    set: (v) => set({ cookiesBrowser: v === 'off' ? null : v }),
    hint: (v) => (v === 'off' ? 'not used' : `uses your ${v} sign-in`),
    testid: 'set-cookies',
  });
  const subLangs = h('input', { class: 'text-input', value: S().subLangs, testid: 'set-sublangs', spellcheck: 'false' });
  subLangs.addEventListener('change', () => set({ subLangs: subLangs.value }));

  const t = {
    cover: toggle({ ...EMBED_COPY.cover, ...bool('embedThumbnail'), testid: 'set-cover' }),
    tags: toggle({ ...EMBED_COPY.tags, ...bool('embedMetadata'), testid: 'set-tags' }),
    subs: toggle({ ...EMBED_COPY.subs, ...bool('embedSubs'), testid: 'set-subs' }),
    sound: toggle({ label: 'Sound effects', ...bool('sound'), testid: 'set-sound' }),
    crt: toggle({ label: 'CRT screen', sub: 'scanlines and glow', ...bool('crt'), testid: 'set-crt' }),
    motion: toggle({ label: 'Living background', sub: 'the swirl keeps moving', ...bool('backgroundMotion'), testid: 'set-bgmotion' }),
    shake: toggle({ label: 'Screen shake', sub: 'on big wins', ...bool('screenShake'), testid: 'set-shake' }),
    reduced: toggle({ label: 'Reduce motion', sub: 'calmer, fewer bounces', ...bool('reducedMotion'), testid: 'set-reduced' }),
    auto: toggle({ label: 'Keep yt-dlp fresh', sub: 'auto-update when idle', ...bool('autoUpdate'), testid: 'set-autoupdate' }),
  };
  const volume = slider({ get: () => S().volume, set: (v) => set({ volume: v }), testid: 'set-volume' });

  const body = h(
    'div',
    { class: 'modal__body' },
    h('div', { class: 'section-title' }, 'DOWNLOADS'),
    field('Save to', 'where grabs land', folder),
    field('File names', 'how files are named', filename.el),
    field('Parallel grabs', 'downloads running together', parallel.el),
    field('Cookies from', 'for private, age-gated or "are you a bot?" videos', cookies.el),
    field('Subtitle languages', 'e.g. en.*,fr  (or "all")', subLangs),
    h('div', { class: 'section-title' }, 'EXTRAS'),
    t.cover.el,
    t.tags.el,
    t.subs.el,
    h('div', { class: 'section-title' }, 'FEEL'),
    t.sound.el,
    field('Volume', 'clicks, chips and jackpots', volume.el),
    t.crt.el,
    t.motion.el,
    t.shake.el,
    t.reduced.el,
    h('div', { class: 'section-title' }, 'ENGINE'),
    t.auto.el,
    h('div', { style: { display: 'flex', gap: '10px', marginTop: '8px' } }, button([icon('bolt'), 'ENGINE ROOM'], { cls: 'btn--sm btn--gold', onClick: () => setModal('engine') })),
  );

  return {
    el: body,
    update(s, prev) {
      if (!s.settings || s.settings === prev.settings) return;
      const x = s.settings;
      (folder.firstElementChild as HTMLElement).textContent = `\u200e${x.outputDir}\u200e`;
      filename.update(x.filename);
      parallel.update(String(x.maxConcurrent) as '1');
      cookies.update((x.cookiesBrowser ?? 'off') as Browser);
      t.cover.update(x.embedThumbnail);
      t.tags.update(x.embedMetadata);
      t.subs.update(x.embedSubs);
      t.sound.update(x.sound);
      t.crt.update(x.crt);
      t.motion.update(x.backgroundMotion);
      t.shake.update(x.screenShake);
      t.reduced.update(x.reducedMotion);
      t.auto.update(x.autoUpdate);
      volume.update(x.volume);
      if (x.reducedMotion !== prev.settings?.reducedMotion) setReduced(x.reducedMotion);
    },
  };
}

// ------------------------------------------------------------ engine room

const COMPONENT_ICON: Record<string, string> = { ytdlp: 'globe', ffmpeg: 'video', deno: 'bolt' };

function componentCard(c: ComponentStatus, s: AppState): HTMLElement {
  const p = s.install[c.id];
  const installing = c.state === 'installing';
  const pct = p && p.total ? Math.min(1, p.downloaded / p.total) : 0;
  const stageText = installing && p ? (p.stage === 'download' ? `downloading ${bytes(p.downloaded)}${p.total ? ` / ${bytes(p.total)}` : ''}` : p.stage === 'verify' ? 'checking the signature…' : p.stage === 'extract' ? 'unpacking…' : p.stage === 'check' ? 'test run…' : 'ready') : '';
  const stateTag =
    c.state === 'ready'
      ? h('span', { class: 'tag tag--green' }, c.source === 'system' ? 'READY · SYSTEM' : 'READY')
      : c.state === 'installing'
        ? h('span', { class: 'tag tag--gold' }, 'INSTALLING')
        : c.state === 'error'
          ? h('span', { class: 'tag tag--red' }, 'ERROR')
          : h('span', { class: `tag ${c.required ? 'tag--red' : 'tag--ghost'}` }, c.required ? 'MISSING' : 'OPTIONAL');
  const segs = Array.from({ length: 20 }, (_, i) => h('i', { class: i < Math.round(pct * 20) ? 'on' : '' }));
  return h(
    'div',
    { class: 'engine-card', 'data-state': c.state, testid: `engine-${c.id}` },
    h('div', { class: 'engine-card__icon' }, icon(COMPONENT_ICON[c.id] ?? 'gear')),
    h(
      'div',
      { class: 'engine-card__body' },
      h('div', { class: 'engine-card__top' }, h('b', null, c.name), stateTag, c.updateAvailable ? h('span', { class: 'tag tag--blue' }, `NEW ${c.latest}`) : null),
      h('span', { class: 'dim' }, c.role),
      installing ? h('div', { class: 'pbar', style: { '--seg': 'var(--gold)' } }, segs) : null,
      h('span', { class: 'engine-card__meta' }, installing ? stageText : c.state === 'ready' ? `${c.version ?? ''}` : c.error ?? `~${bytes(c.downloadSize)} download`),
    ),
  );
}

function engineView(): ModalView {
  const list = h('div', { class: 'engine-list', testid: 'engine-list' });
  const note = h('p', { class: 'dim engine-note' });
  const actions = h('div', { class: 'engine-actions' });
  const body = h(
    'div',
    { class: 'modal__body' },
    h('p', { class: 'engine-intro' }, 'Balader drives three trusty open-source tools. They install once into Balader’s own folder, each download checked against its published SHA-256 before it runs.'),
    list,
    note,
    actions,
  );
  let busy = false;

  const run = async (force: boolean, components: string[] = []) => {
    if (busy) return;
    busy = true;
    sfx.play('whoosh');
    render(store.get());
    try {
      await installEngine(force, components);
      const r = list.getBoundingClientRect();
      fxctx.particles?.confetti(r.left + r.width / 2, r.top + 20, 80);
      sfx.play('success');
      toast({ title: 'ENGINE READY', text: 'Deal away.', color: 'var(--green)', icon: 'bolt', testid: 'toast-engine' });
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      sfx.play('error');
      toast({ title: 'Install failed', text: [err.message, err.hint].filter(Boolean).join(' '), color: 'var(--red)', icon: 'warn' });
    } finally {
      busy = false;
      render(store.get());
    }
  };

  const render = (s: AppState) => {
    const e = s.engine;
    if (!e) {
      replace(list, h('div', { class: 'dim' }, h('span', { class: 'dots' }, 'Checking the engine')));
      replace(actions);
      return;
    }
    replace(list, e.components.map((c) => componentCard(c, s)));
    const missing = e.components.filter((c) => c.state !== 'ready' && c.state !== 'installing');
    const updates = e.components.filter((c) => c.updateAvailable);
    const installing = e.components.some((c) => c.state === 'installing') || busy;
    note.textContent = e.jsRuntime ? `JS runtime: ${e.jsRuntime}. Engine folder: ${e.engineDir}` : `No JavaScript runtime yet: YouTube may offer fewer qualities until Deno is installed. Engine folder: ${e.engineDir}`;
    const btns: HTMLElement[] = [];
    if (missing.length) {
      const size = missing.reduce((a, c) => a + c.downloadSize, 0);
      const b = button([icon('down'), `INSTALL ${missing.length === e.components.length ? 'EVERYTHING' : 'MISSING'} (~${bytes(size)})`], {
        cls: 'btn--green',
        testid: 'engine-install',
        onClick: () => void run(false),
      });
      if (installing) b.classList.add('is-disabled');
      btns.push(b);
    }
    if (updates.length) btns.push(button(`UPDATE ${updates.map((u) => u.name).join(' + ')}`, { cls: 'btn--blue', testid: 'engine-update', onClick: () => void run(true, updates.map((u) => u.id)) }));
    btns.push(
      button('CHECK UPDATES', {
        cls: 'btn--ghost btn--sm',
        testid: 'engine-check',
        onClick: async () => {
          const st = await checkUpdates();
          const n = st.components.filter((c) => c.updateAvailable).length;
          toast({ title: n ? `${n} update${n > 1 ? 's' : ''} available` : 'All fresh', text: n ? 'Hit UPDATE when the pile is empty.' : 'Every tool is on its latest version.', color: n ? 'var(--blue)' : 'var(--green)', icon: n ? 'down' : 'check' });
        },
      }),
    );
    if (e.ready) btns.push(button("LET'S PLAY", { cls: 'btn--gold', testid: 'engine-done', onClick: () => setModal(null) }));
    replace(actions, btns);
  };

  render(store.get());
  return {
    el: body,
    update(s, prev) {
      if (s.engine !== prev.engine || s.install !== prev.install) {
        const wasReady = prev.engine?.ready;
        render(s);
        if (s.engine?.ready && wasReady === false) {
          const stamp = h('div', { class: 'engine-stamp' }, 'READY!');
          body.appendChild(stamp);
          sfx.play('stamp');
          setTimeout(() => stamp.remove(), ms(1800));
        }
      }
    },
  };
}

// ------------------------------------------------------------ about

function aboutView(): ModalView {
  const body = h(
    'div',
    { class: 'modal__body about' },
    h('p', null, 'Balader grabs video and sound from YouTube, TikTok, Instagram, X, SoundCloud and 1800+ other sites, with a card table instead of a form.'),
    h('p', { class: 'dim' }, 'Engine: yt-dlp (Unlicense), FFmpeg (GPL builds), Deno (MIT), all fetched from their official releases. Fonts: Jersey 10/15 and Silkscreen (SIL Open Font License). Sounds are synthesised live.'),
    h('p', { class: 'dim' }, 'Only grab what you have the right to keep: your own uploads, public-domain and Creative Commons works, or content the creator allows offline.'),
  );
  return { el: body, update() {} };
}

// ------------------------------------------------------------ mount

const TITLES: Record<Exclude<ModalName, null>, string> = { settings: 'HOUSE RULES', engine: 'THE ENGINE ROOM', about: 'ABOUT BALADER' };

export function mountModals(): void {
  let current: { name: ModalName; root: HTMLElement; view: ModalView } | null = null;

  const close = () => {
    if (!current) return;
    const root = current.root;
    current = null;
    root.classList.add('out');
    sfx.play('close');
    setTimeout(() => root.remove(), ms(200));
  };

  const open = (name: Exclude<ModalName, null>) => {
    const view = name === 'settings' ? settingsView() : name === 'engine' ? engineView() : aboutView();
    const closeBtn = iconButton('x', { tip: 'Close (esc)', testid: 'modal-close', sound: null, onClick: () => setModal(null) });
    const modal = h('div', { class: 'modal panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': TITLES[name], testid: `modal-${name}` }, h('div', { class: 'modal__head' }, h('h2', { class: 'ink' }, TITLES[name]), closeBtn), view.el);
    const root = h('div', { class: 'modal-backdrop', testid: 'modal-backdrop' }, modal);
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) setModal(null);
    });
    document.body.appendChild(root);
    sfx.play('open');
    current = { name, root, view };
    requestAnimationFrame(() => {
      const c = centerOf(modal);
      fxctx.particles?.sparks(c.x, c.y - modal.offsetHeight / 2, 10);
      pop(modal.querySelector('h2'), 0.1);
    });
  };

  store.subscribe((s, prev) => {
    if (s.modal !== prev.modal) {
      close();
      if (s.modal) open(s.modal);
    } else current?.view.update(s, prev);
  });
}
