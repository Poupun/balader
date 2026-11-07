// window.__balader: the app's test & automation surface. Same object in the
// mock browser build, with the real engine over HTTP, and inside the desktop
// app (reachable from the terminal through the dev bridge).

import type { Backend } from '../api/backend';
import type { MockBackend } from '../api/mock';
import { setFrozen, setReduced, setTimeScale, motion } from '../fx/motion';
import { seed } from '../fx/rng';
import { sfx } from '../fx/sound';
import * as app from '../state/app';
import { fxctx } from '../ui/fxctx';

export interface Snapshot {
  ready: boolean;
  backend: string;
  phase: string;
  url: string;
  mode: string;
  container: string;
  audioFormat: string;
  selected: string | null;
  cut: { on: boolean; start: number; end: number; available: boolean; active: { start: number; end: number; exact: boolean } | null };
  cards: { key: string; big: string; name: string; size: string; summary: string; selected: boolean }[];
  probe: { kind: string; title: string } | null;
  error: { code: string; message: string; hint: string | null } | null;
  jobs: { id: string; status: string; stage: string; label: string; progress: number; title: string; summary: string; cut: { start: number; end: number; exact: boolean } | null; files: string[] }[];
  history: number;
  engine: { ready: boolean; components: { id: string; state: string; version: string | null }[] } | null;
  modal: string | null;
  pileTab: string;
  settings: Record<string, unknown> | null;
}

export function snapshot(): Snapshot {
  const s = app.store.get();
  const probeTitle = !s.probe ? '' : s.probe.kind === 'video' ? s.probe.media.title : s.probe.kind === 'playlist' ? s.probe.playlist.title : s.probe.page;
  return {
    ready: s.ready,
    backend: s.backend,
    phase: s.phase,
    url: s.url,
    mode: s.mode,
    container: s.container,
    audioFormat: s.audioFormat,
    selected: s.selected,
    cut: { ...s.cut, available: app.cutAvailable(s), active: app.activeCut(s) },
    cards: s.cards.map((c) => ({ key: c.key, big: c.big, name: c.name, size: c.size, summary: c.summary, selected: c.key === s.selected })),
    probe: s.probe ? { kind: s.probe.kind, title: probeTitle } : null,
    error: s.error ? { code: s.error.code, message: s.error.message, hint: s.error.hint } : null,
    jobs: s.jobs.map((j) => ({ id: j.id, status: j.status, stage: j.stage, label: j.stageLabel, progress: Math.round(j.progress * 1000) / 1000, title: j.title, summary: j.summary, cut: j.cut, files: j.files })),
    history: s.history.length,
    engine: s.engine ? { ready: s.engine.ready, components: s.engine.components.map((c) => ({ id: c.id, state: c.state, version: c.version })) } : null,
    modal: s.modal,
    pileTab: s.pileTab,
    settings: s.settings ? { ...s.settings } : null,
  };
}

async function waitFor<T>(fn: () => T | Promise<T>, timeout = 8000, every = 50): Promise<T> {
  const start = performance.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (performance.now() - start > timeout) throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

export function installTestApi(backend: Backend): void {
  const api = {
    version: 1,
    backend: backend.kind,
    snapshot,
    store: app.store,
    actions: app,
    events: app.eventLog,
    sfxLog: () => [...sfx.log],
    particles: () => fxctx.particles?.count ?? 0,
    mock: backend.kind === 'mock' ? (backend as MockBackend) : null,
    waitFor,
    /** Wait until the snapshot satisfies a predicate. */
    until: (pred: (s: Snapshot) => boolean, timeout?: number) => waitFor(() => (pred(snapshot()) ? snapshot() : null), timeout),
    fx: {
      timeScale: (v: number) => setTimeScale(v),
      freeze: (v = true) => {
        setFrozen(v);
        if (v) fxctx.bg?.freezeAt(12.5);
      },
      reduced: (v = true) => setReduced(v),
      shake: (v: boolean) => {
        motion.shake = v;
      },
      seed: (n: number) => seed(n),
      /** Freeze the background on a given time (shader previews). */
      bgAt: (t: number) => fxctx.bg?.freezeAt(t),
    },
    dom: {
      click: (id: string) => {
        const el = byTestId(id);
        if (!el) throw new Error(`no element [data-testid="${id}"]`);
        el.click();
        return true;
      },
      text: (id: string) => byTestId(id)?.textContent ?? null,
      exists: (id: string) => !!byTestId(id),
      rect: (id: string) => byTestId(id)?.getBoundingClientRect().toJSON() ?? null,
      type: (id: string, text: string) => {
        const el = byTestId(id) as HTMLInputElement | null;
        if (!el) throw new Error(`no input [data-testid="${id}"]`);
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      testids: () => [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')),
    },
  };
  (window as unknown as { __balader: typeof api }).__balader = api;
}

export type BaladerTestApi = ReturnType<typeof snapshot>;
