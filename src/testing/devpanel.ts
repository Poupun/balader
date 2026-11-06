// Dev panel (?dev=1 or Ctrl+Shift+D): one-click scenarios for building and
// eyeballing every state of the UI without hunting for real links.

import type { Backend } from '../api/backend';
import type { MockBackend } from '../api/mock';
import { ERRORS } from '../api/mock/fixtures';
import { setFrozen, setTimeScale, motion } from '../fx/motion';
import { deal, fold, grab, setModal, store } from '../state/app';
import { h } from '../ui/dom';
import { fxctx } from '../ui/fxctx';
import { snapshot } from './testapi';

const SCENARIOS: [string, string][] = [
  ['YouTube 4K', 'https://www.youtube.com/watch?v=0cEaNw4vEs0'],
  ['TikTok', 'https://www.tiktok.com/@packlight/video/7300000000000000000'],
  ['SoundCloud', 'https://soundcloud.com/forss/flickermood'],
  ['Archive', 'https://archive.org/details/BigBuckBunny_124'],
  ['Playlist', 'https://www.youtube.com/playlist?list=PLbalader0001'],
  ['Scraped', 'https://example.com/scrape/42'],
  ['Bot check', 'https://www.youtube.com/watch?v=bot'],
  ['Private', 'https://vimeo.com/private/1'],
  ['Unsupported', 'https://example.com/nothing'],
  ['Live', 'https://www.twitch.tv/live_now'],
  ['Fails mid-way', 'https://www.youtube.com/watch?v=fail'],
];

export function mountDevPanel(backend: Backend): void {
  const mock = backend.kind === 'mock' ? (backend as MockBackend) : null;
  const out = h('pre', { class: 'dev__out' });
  const btn = (label: string, fn: () => unknown) => h('button', { class: 'dev__btn', type: 'button', onclick: () => void fn() }, label);
  const panel = h(
    'div',
    { class: 'dev', testid: 'devpanel' },
    h('b', null, `DEV · ${backend.kind.toUpperCase()}`),
    h('div', { class: 'dev__row' }, SCENARIOS.map(([label, url]) => btn(label, () => deal(url)))),
    h(
      'div',
      { class: 'dev__row' },
      btn('Grab selected', () => grab()),
      btn('Fold', () => fold()),
      btn('Settings', () => setModal('settings')),
      btn('Engine', () => setModal('engine')),
      mock ? btn('Engine: missing', () => mock.setEngine('missing')) : null,
      mock ? btn('Next probe: rate-limited', () => (mock.nextProbeError = ERRORS.ratelimit)) : null,
    ),
    h(
      'div',
      { class: 'dev__row' },
      btn('1×', () => setTimeScale(1)),
      btn('4×', () => setTimeScale(4)),
      btn('12×', () => setTimeScale(12)),
      btn('Freeze', () => {
        setFrozen(!motion.frozen);
        if (motion.frozen) fxctx.bg?.freezeAt(12.5);
      }),
      btn('Confetti', () => fxctx.particles?.confetti(innerWidth / 2, innerHeight / 2, 120)),
      btn('Snapshot', () => {
        out.textContent = JSON.stringify(snapshot(), null, 1).slice(0, 4000);
      }),
    ),
    out,
  );
  const style = h(
    'style',
    null,
    `.dev{position:fixed;left:12px;bottom:12px;z-index:90;width:420px;max-height:46vh;overflow:auto;padding:10px;border-radius:12px;background:rgba(5,9,11,.92);box-shadow:0 0 0 2px #ffc93c;font:12px ui-monospace,monospace;color:#f6f1e7}
     .dev b{color:#ffc93c}.dev__row{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
     .dev__btn{padding:3px 6px;border:0;border-radius:5px;background:#2a3f49;font:11px ui-monospace,monospace;color:#f6f1e7;cursor:pointer}
     .dev__btn:hover{background:#ff9a1f;color:#000}.dev__out{white-space:pre-wrap;margin:6px 0 0;max-height:160px;overflow:auto}`,
  );
  document.head.appendChild(style);
  document.body.appendChild(panel);
  const toggle = () => (panel.style.display = panel.style.display === 'none' ? '' : 'none');
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') toggle();
  });
  void store;
}
