// Top bar + left HUD.

import { countUp, pop, wobble } from '../fx/juice';
import { ms } from '../fx/motion';
import { sfx } from '../fx/sound';
import { api } from '../api/client';
import type { AudioFormat, Container, Settings } from '../api/types';
import { pickFolder, setAudioFormat, setContainer, setModal, setMode, store, updateSettings, type AppState } from '../state/app';
import { h, replace } from './dom';
import { basename, bytes } from './format';
import { centerOf, fxctx } from './fxctx';
import { icon } from './icons';
import { letters } from '../fx/juice';
import { button, EMBED_COPY, iconButton, stepper, toggle } from './widgets';

const LOGO_COLORS: [string, string][] = [
  ['var(--red)', 'var(--red-lip)'],
  ['var(--orange)', 'var(--orange-lip)'],
  ['var(--gold)', 'var(--gold-lip)'],
  ['var(--green)', 'var(--green-lip)'],
  ['var(--teal)', 'var(--teal-lip)'],
  ['var(--blue)', 'var(--blue-lip)'],
  ['var(--purple)', 'var(--purple-lip)'],
];

// ------------------------------------------------------------ top bar

export function mountTopbar(parent: HTMLElement, platform: string): void {
  const logo = h('div', { class: 'logo', testid: 'logo', title: 'Balader' }, letters('BALADER'));
  [...logo.children].forEach((s, i) => {
    const [c, l] = LOGO_COLORS[i % LOGO_COLORS.length];
    (s as HTMLElement).style.setProperty('--lc', c);
    (s as HTMLElement).style.setProperty('--ll', l);
  });
  logo.appendChild(h('span', { class: 'logo__sub', 'data-tauri-drag-region': '' }, 'GRAB ANYTHING'));
  logo.addEventListener('pointerenter', () => sfx.play('hover'));
  logo.addEventListener('click', () => {
    sfx.play('coin');
    sfx.play('success', { delay: 0.1 });
    const c = centerOf(logo);
    fxctx.particles?.confetti(c.x, c.y + 10, 70);
    fxctx.bg?.pulse(0.7);
    [...logo.querySelectorAll('span')].forEach((s, i) => setTimeout(() => pop(s, 0.5), ms(i * 50)));
  });

  const engineChip = button([h('span', { class: 'dot' }), h('span', { class: 'txt' }, 'ENGINE')], {
    cls: 'engine-chip',
    testid: 'engine-chip',
    tip: 'The engine room: yt-dlp, FFmpeg and Deno',
    onClick: () => setModal('engine'),
  });
  const soundBtn = iconButton('sound', { testid: 'sound-toggle', tip: 'Sound on/off', sound: null, onClick: () => toggleSound() });
  const settingsBtn = iconButton('gear', { testid: 'open-settings', tip: 'House rules (settings)  ⌘,', onClick: () => setModal('settings') });
  const pileBtn = iconButton('list', { cls: 'pile-toggle', testid: 'pile-toggle', tip: 'Show the pile', onClick: () => document.body.classList.toggle('pile-open') });
  settingsBtn.addEventListener('click', () => wobble(settingsBtn.querySelector('svg'), 90));

  const right: HTMLElement[] = [engineChip, pileBtn, soundBtn, settingsBtn];
  if (platform === 'windows' || platform === 'linux') {
    right.push(
      h(
        'div',
        { class: 'winctl' },
        iconButton('minus', { tip: 'Minimize', testid: 'win-min', sound: 'tick', onClick: () => void api.windowAction('minimize') }),
        iconButton('square', { tip: 'Maximize', testid: 'win-max', sound: 'tick', onClick: () => void api.windowAction('maximize') }),
        iconButton('x', { cls: 'close', tip: 'Close', testid: 'win-close', sound: 'close', onClick: () => void api.windowAction('close') }),
      ),
    );
  }
  const bar = h('header', { class: 'topbar', 'data-tauri-drag-region': '', testid: 'topbar' }, logo, h('div', { class: 'topbar__spacer', 'data-tauri-drag-region': '' }), ...right);
  parent.appendChild(bar);

  const toggleSound = () => {
    const s = store.get().settings;
    if (!s) return;
    const on = !s.sound;
    updateSettings({ sound: on });
    sfx.enabled = on;
    if (on) sfx.play('toggle');
  };

  store.subscribe((s, prev) => {
    if (s.engine !== prev.engine || s.install !== prev.install) {
      const e = s.engine;
      const installing = e?.components.some((c) => c.state === 'installing');
      engineChip.classList.toggle('is-missing', !!e && !e.ready && !installing);
      engineChip.classList.toggle('is-busy', !!installing || !e);
      const txt = engineChip.querySelector('.txt')!;
      const label = !e ? 'CHECKING' : installing ? 'INSTALLING' : e.ready ? (e.components.some((c) => c.updateAvailable) ? 'UPDATE' : 'ENGINE OK') : 'SET UP ENGINE';
      if (txt.textContent !== label) {
        txt.textContent = label;
        pop(engineChip, 0.12);
      }
    }
    if (s.settings?.sound !== prev.settings?.sound) {
      replace(soundBtn, icon(s.settings?.sound === false ? 'mute' : 'sound'));
    }
  });
}

// ------------------------------------------------------------ HUD

const CONTAINERS: readonly Container[] = ['mp4', 'mkv'];
const AUDIO_FORMATS: readonly AudioFormat[] = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
const AUDIO_HINTS: Record<AudioFormat, string> = {
  mp3: 'plays on everything',
  m4a: 'AAC, Apple-friendly',
  opus: 'small and sharp',
  flac: 'lossless box',
  wav: 'raw, for editors',
};

export function mountHud(parent: HTMLElement): void {
  const s0 = store.get();
  const videoBtn = button([icon('video'), 'VIDEO'], { cls: 'modebtn', testid: 'mode-video', sound: 'select', onClick: () => setMode('video') });
  const audioBtn = button([icon('note'), 'AUDIO'], { cls: 'modebtn', testid: 'mode-audio', sound: 'select', onClick: () => setMode('audio') });
  videoBtn.dataset.mode = 'video';
  audioBtn.dataset.mode = 'audio';
  videoBtn.setAttribute('data-tip', 'Grab the video (with its sound)');
  audioBtn.setAttribute('data-tip', 'Just the sound: MP3, M4A, Opus, FLAC or WAV');

  const container = stepper<Container>({
    values: CONTAINERS,
    get: () => store.get().container,
    set: (v) => {
      setContainer(v);
      sfx.play('flick');
    },
    hint: (v) => (v === 'mp4' ? 'plays everywhere (H.264 first)' : 'original codecs, best quality'),
    testid: 'container',
  });
  const audioFmt = stepper<AudioFormat>({
    values: AUDIO_FORMATS,
    get: () => store.get().audioFormat,
    set: (v) => setAudioFormat(v),
    hint: (v) => AUDIO_HINTS[v],
    testid: 'audio-format',
  });
  const optLabel = h('span', { class: 'label' }, 'FORMAT');
  const optSlot = h('div', null);

  const setting = <K extends keyof Settings>(key: K) => ({
    get: () => Boolean(store.get().settings?.[key]),
    set: (v: boolean) => updateSettings({ [key]: v } as Partial<Settings>),
  });
  const cover = toggle({ ...EMBED_COPY.cover, ...setting('embedThumbnail'), testid: 'opt-cover' });
  const tags = toggle({ ...EMBED_COPY.tags, ...setting('embedMetadata'), testid: 'opt-tags' });
  const subs = toggle({ ...EMBED_COPY.subs, ...setting('embedSubs'), testid: 'opt-subs' });

  const folderName = h('button', { class: 'folder__name', type: 'button', testid: 'folder-name' }, '…');
  folderName.addEventListener('click', () => {
    const dir = store.get().settings?.outputDir;
    if (dir) void api.openPath(dir).catch(() => undefined);
    sfx.play('click');
  });
  const changeBtn = button('CHANGE', { cls: 'btn--sm btn--ghost', testid: 'folder-change', onClick: () => void pickFolder() });

  const statCount = h('b', { testid: 'stat-count' }, '0');
  const statSize = h('b', { testid: 'stat-size' }, '0 B');
  const statBest = h('b', { testid: 'stat-best' }, '-');
  const statRun = h('b', { testid: 'stat-run' }, '0');
  const statEls = {
    count: h('div', { class: 'stat', style: { '--sc': 'var(--gold)' } }, statCount, h('span', { class: 'label' }, 'GRABBED')),
    run: h('div', { class: 'stat', style: { '--sc': 'var(--green)' } }, statRun, h('span', { class: 'label' }, 'THIS RUN')),
    size: h('div', { class: 'stat stat--wide', style: { '--sc': 'var(--orange)' } }, statSize, h('span', { class: 'label' }, 'STASH SIZE')),
    best: h('div', { class: 'stat stat--wide', style: { '--sc': 'var(--teal)' } }, statBest, h('span', { class: 'label' }, 'TOP SPEED')),
  };
  const foot = h('div', { class: 'hud__foot', testid: 'hud-foot' });

  const hud = h(
    'aside',
    { class: 'hud', testid: 'hud' },
    h('section', { class: 'hud__section panel' }, h('span', { class: 'label' }, 'WHAT TO GRAB'), h('div', { class: 'modeswitch' }, videoBtn, audioBtn)),
    h('section', { class: 'hud__section panel' }, optLabel, optSlot, h('div', { class: 'hud__opts', style: { marginTop: '8px' } }, cover.el, tags.el, subs.el)),
    h('section', { class: 'hud__section panel' }, h('span', { class: 'label' }, 'SAVE TO'), h('div', { class: 'folder' }, folderName, changeBtn)),
    h('section', { class: 'hud__section panel' }, h('span', { class: 'label' }, 'SCOREBOARD'), h('div', { class: 'stats' }, statEls.count, statEls.run, statEls.size, statEls.best)),
    foot,
  );
  parent.appendChild(hud);

  let topSpeed = 0;
  let doneThisRun = 0;
  const seenDone = new Set<string>();

  const syncMode = (s: AppState) => {
    videoBtn.setAttribute('aria-pressed', String(s.mode === 'video'));
    audioBtn.setAttribute('aria-pressed', String(s.mode === 'audio'));
    document.documentElement.dataset.mode = s.mode;
    replace(optSlot, s.mode === 'video' ? container.el : audioFmt.el);
    optLabel.textContent = s.mode === 'video' ? 'CONTAINER' : 'AUDIO FORMAT';
    subs.el.style.display = s.mode === 'video' ? '' : 'none';
    const noVideo = s.probe?.kind === 'video' && !s.probe.media.hasVideo;
    videoBtn.classList.toggle('is-disabled', noVideo);
    fxctx.bg?.setPalette(s.mode);
  };

  store.subscribe((s, prev) => {
    if (s.mode !== prev.mode || s.probe !== prev.probe) {
      syncMode(s);
      if (s.mode !== prev.mode) {
        pop(s.mode === 'video' ? videoBtn : audioBtn, 0.12);
        fxctx.bg?.pulse(0.35);
      }
    }
    if (s.container !== prev.container) container.update(s.container);
    if (s.audioFormat !== prev.audioFormat) audioFmt.update(s.audioFormat);
    if (s.settings !== prev.settings && s.settings) {
      cover.update(s.settings.embedThumbnail);
      tags.update(s.settings.embedMetadata);
      subs.update(s.settings.embedSubs);
      folderName.textContent = `\u200e${basename(s.settings.outputDir)}\u200e`;
      folderName.setAttribute('data-tip', `${s.settings.outputDir}\n(click to open)`);
      if (prev.settings && prev.settings.outputDir !== s.settings.outputDir) pop(folderName, 0.1);
    }
    if (s.history !== prev.history) {
      const from = Number(statCount.textContent) || 0;
      countUp(statCount, from, s.history.length, (n) => String(Math.round(n)), 700);
      const total = s.history.reduce((a, e) => a + e.size, 0);
      countUp(statSize, Number(statSize.dataset.v ?? 0), total, (n) => bytes(n), 900);
      statSize.dataset.v = String(total);
      if (prev.history.length && s.history.length > from) {
        for (const el of [statEls.count, statEls.size]) {
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
        }
        sfx.play('coin', { delay: 0.35 });
      }
    }
    if (s.jobs !== prev.jobs) {
      for (const j of s.jobs) {
        if (j.speed && j.speed > topSpeed) {
          topSpeed = j.speed;
          statBest.textContent = `${bytes(topSpeed)}/s`;
        }
        if (j.status === 'done' && !seenDone.has(j.id)) {
          seenDone.add(j.id);
          doneThisRun++;
          countUp(statRun, doneThisRun - 1, doneThisRun, (n) => String(Math.round(n)), 500);
          statEls.run.classList.remove('flash');
          void statEls.run.offsetWidth;
          statEls.run.classList.add('flash');
        }
      }
    }
    if (s.info !== prev.info || s.engine !== prev.engine) {
      const yt = s.engine?.components.find((c) => c.id === 'ytdlp')?.version;
      foot.textContent = `Balader ${s.info?.version ?? ''}${yt ? ` · yt-dlp ${yt}` : ''}${s.backend !== 'tauri' ? ` · ${s.backend.toUpperCase()} BACKEND` : ''}`;
    }
  });
  syncMode(s0);
}
