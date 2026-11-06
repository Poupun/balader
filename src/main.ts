import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/table.css';

import { selectBackend } from './api/backend';
import { setBackend } from './api/client';
import { Background } from './fx/background';
import { motion, prefersReducedMotion, setFrozen, setReduced, setTimeScale } from './fx/motion';
import { Particles } from './fx/particles';
import { seed } from './fx/rng';
import { sfx } from './fx/sound';
import { boot, deal, store } from './state/app';
import { installTestApi } from './testing/testapi';
import { mountHud, mountTopbar } from './ui/chrome';
import { fxctx } from './ui/fxctx';
import { initDragDrop, initKeyboard } from './ui/input';
import { mountModals } from './ui/modals';
import { initTooltips, toast } from './ui/overlay';
import { mountPile } from './ui/pile';
import { mountTable } from './ui/table';

function platformOf(): string {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'linux';
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.has('seed')) seed(Number(params.get('seed')));
  if (params.has('timescale')) setTimeScale(Number(params.get('timescale')));
  const backend = await selectBackend(params);
  setBackend(backend);
  installTestApi(backend);

  const platform = params.get('platform') ?? platformOf();
  document.body.classList.add(platform === 'macos' ? 'mac' : platform === 'windows' ? 'win' : 'linux');
  if (backend.kind !== 'tauri') document.body.classList.remove('mac');
  if (backend.kind === 'tauri' && platform === 'macos') document.body.classList.add('mac');

  fxctx.bg = new Background(document.getElementById('bg') as HTMLCanvasElement);
  fxctx.particles = new Particles(document.getElementById('fx') as HTMLCanvasElement);

  const root = document.getElementById('app')!;
  mountTopbar(root, platform);
  mountHud(root);
  mountTable(root);
  mountPile(root);
  mountModals();
  initTooltips();
  initKeyboard();
  initDragDrop();

  // Feel settings follow the store.
  store.subscribe((s, prev) => {
    const x = s.settings;
    if (!x || x === prev.settings) return;
    sfx.enabled = x.sound;
    sfx.setVolume(x.volume);
    document.body.classList.toggle('no-crt', !x.crt);
    if (fxctx.bg) fxctx.bg.enabled = x.backgroundMotion;
    motion.shake = x.screenShake;
    if (x.reducedMotion !== prev.settings?.reducedMotion) setReduced(x.reducedMotion || prefersReducedMotion());
  });

  // Audio can only start after a user gesture.
  const unlock = () => sfx.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  window.addEventListener('blur', () => document.body.classList.add('is-blurred'));
  window.addEventListener('focus', () => document.body.classList.remove('is-blurred'));

  if (params.has('freeze')) {
    setFrozen(true);
    fxctx.bg.freezeAt(12.5);
  }
  if (params.get('dev') === '1' || (backend.kind !== 'tauri' && params.get('dev') !== '0')) {
    const { mountDevPanel } = await import('./testing/devpanel');
    mountDevPanel(backend);
  }

  document.body.classList.add('booting');
  setTimeout(() => document.body.classList.remove('booting'), 800);

  try {
    await boot();
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    toast({ title: 'Balader could not start', text: [err.message, err.hint].filter(Boolean).join(' '), color: 'var(--red)', icon: 'warn', duration: 12000 });
    throw e;
  }
  const url = params.get('url');
  if (url) void deal(url);
}

void main();
