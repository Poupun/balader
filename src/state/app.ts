// App state + actions. UI widgets read the store and call these actions;
// tests (window.__balader) drive the very same functions.

import { api, getBackend } from '../api/client';
import type { BackendKind } from '../api/backend';
import type {
  AppInfo,
  AudioFormat,
  Container,
  CoreEvent,
  Cut,
  DownloadRequest,
  EngineStatus,
  ErrorPayload,
  HistoryEntry,
  InstallStage,
  JobSnapshot,
  Mode,
  ProbeResult,
  Settings,
} from '../api/types';
import { emptyRequest, toError } from '../api/types';
import { extractUrl } from '../ui/format';
import { buildCards, defaultSelection, type CardModel } from './cards';
import { createStore } from './store';

export type Phase = 'idle' | 'probing' | 'dealt' | 'error';
export type ModalName = 'settings' | 'engine' | 'about' | null;

export interface InstallProgress {
  stage: InstallStage;
  downloaded: number;
  total: number | null;
  message: string | null;
}

/** The cut: grab only [start, end] of the dealt video or track. */
export interface CutState {
  /** The timeline is open. A cut applies when the range isn't the whole thing. */
  on: boolean;
  start: number;
  end: number;
}

/** Shortest clip (seconds), same as the core. */
export const MIN_CUT = 0.1;

export interface AppState {
  ready: boolean;
  backend: BackendKind;
  info: AppInfo | null;
  url: string;
  phase: Phase;
  probe: ProbeResult | null;
  probeUrl: string | null;
  error: ErrorPayload | null;
  mode: Mode;
  container: Container;
  audioFormat: AudioFormat;
  cards: CardModel[];
  selected: string | null;
  cut: CutState;
  /** Bumped whenever the hand is (re)dealt: triggers the deal animation. */
  dealSeq: number;
  jobs: JobSnapshot[];
  history: HistoryEntry[];
  engine: EngineStatus | null;
  install: Record<string, InstallProgress>;
  settings: Settings | null;
  modal: ModalName;
  pileTab: 'active' | 'done';
  thumb: string | null;
  /** Last event seen (tests). */
  lastEvent: CoreEvent | null;
}

export const store = createStore<AppState>({
  ready: false,
  backend: 'mock',
  info: null,
  url: '',
  phase: 'idle',
  probe: null,
  probeUrl: null,
  error: null,
  mode: 'video',
  container: 'mp4',
  audioFormat: 'mp3',
  cards: [],
  selected: null,
  cut: { on: false, start: 0, end: 0 },
  dealSeq: 0,
  jobs: [],
  history: [],
  engine: null,
  install: {},
  settings: null,
  modal: null,
  pileTab: 'active',
  thumb: null,
  lastEvent: null,
});

const recentEvents: CoreEvent[] = [];
export const eventLog = (): CoreEvent[] => [...recentEvents];

function sortJobs(jobs: JobSnapshot[]): JobSnapshot[] {
  return [...jobs].sort((a, b) => b.createdAt - a.createdAt);
}

/** Length of the dealt single video/track, when known. */
export function mediaDuration(s: AppState = store.get()): number | null {
  const d = s.probe?.kind === 'video' ? s.probe.media.duration : null;
  return d && Number.isFinite(d) && d > 0 ? d : null;
}

/** Only single videos/tracks of known length can be cut (not playlists or scraped files). */
export function cutAvailable(s: AppState = store.get()): boolean {
  return s.phase === 'dealt' && s.probe?.kind === 'video' && mediaDuration(s) !== null && (s.mode === 'audio' ? s.probe.media.audio.available : s.probe.media.hasVideo);
}

/** The cut that goes into the request, or null for the whole thing. */
export function activeCut(s: AppState = store.get()): Cut | null {
  const d = mediaDuration(s);
  if (!s.cut.on || !cutAvailable(s) || d === null) return null;
  const start = Math.max(0, s.cut.start);
  const end = Math.min(d, s.cut.end);
  if (start <= 0.0005 && end >= d - 0.0005) return null;
  if (end - start < MIN_CUT - 1e-9) return null;
  return { start, end, exact: s.mode === 'audio' ? true : s.settings?.exactCuts ?? true };
}

function rebuild(patch: Partial<AppState> = {}): Partial<AppState> {
  const s = { ...store.get(), ...patch };
  const c = activeCut(s);
  const cards = buildCards(s.probe, s.mode, s.container, s.audioFormat, c ? c.end - c.start : null);
  const keep = s.selected && cards.some((c) => c.key === s.selected && !c.disabled) ? s.selected : null;
  return { ...patch, cards, selected: keep };
}

// ------------------------------------------------------------ events

function onEvent(e: CoreEvent): void {
  recentEvents.push(e);
  if (recentEvents.length > 200) recentEvents.shift();
  switch (e.type) {
    case 'job': {
      const jobs = store.get().jobs.filter((j) => j.id !== e.job.id);
      store.set({ jobs: sortJobs([...jobs, e.job]), lastEvent: e });
      break;
    }
    case 'jobRemoved':
      store.set({ jobs: store.get().jobs.filter((j) => j.id !== e.id), lastEvent: e });
      break;
    case 'historyChanged':
      void api.getHistory().then((history) => store.set({ history }));
      store.set({ lastEvent: e });
      break;
    case 'engineStatus':
      store.set({ engine: e.status, lastEvent: e });
      break;
    case 'engineProgress':
      store.set({
        install: { ...store.get().install, [e.component]: { stage: e.stage, downloaded: e.downloaded, total: e.total, message: e.message } },
        lastEvent: e,
      });
      break;
    case 'settingsChanged':
      store.set({ settings: e.settings, lastEvent: e });
      break;
  }
}

// ------------------------------------------------------------ actions

export async function boot(): Promise<void> {
  const backend = getBackend();
  backend.onEvent(onEvent);
  const [info, settings, jobs, history] = await Promise.all([
    api.appInfo(),
    api.getSettings(),
    api.listJobs().catch(() => [] as JobSnapshot[]),
    api.getHistory().catch(() => [] as HistoryEntry[]),
  ]);
  store.set({
    backend: backend.kind,
    info,
    settings,
    jobs: sortJobs(jobs),
    history,
    mode: settings.mode,
    container: settings.container,
    audioFormat: settings.audioFormat,
    ready: true,
  });
  // The engine scan can take a second on first launch: don't block the UI.
  void api.engineStatus().then((engine) => {
    store.set({ engine });
    if (!engine.ready) store.set({ modal: 'engine' });
  });
}

export function setUrl(url: string): void {
  store.set({ url });
}

export function setModal(modal: ModalName): void {
  store.set({ modal });
}

export function setPileTab(pileTab: 'active' | 'done'): void {
  store.set({ pileTab });
}

let probeSeq = 0;

export async function deal(input?: string): Promise<boolean> {
  const raw = input ?? store.get().url;
  const url = extractUrl(raw);
  if (input !== undefined) store.set({ url: raw.trim() });
  if (!url) {
    store.set({ phase: 'error', error: { code: 'invalid_url', message: raw.trim() ? "That doesn't look like a link." : 'Paste a link first.', hint: null, detail: null }, probe: null, cards: [], selected: null });
    return false;
  }
  const engine = store.get().engine;
  if (engine && !engine.ready) {
    store.set({ modal: 'engine' });
    return false;
  }
  const seq = ++probeSeq;
  store.set({ phase: 'probing', error: null, probe: null, cards: [], selected: null, probeUrl: url, thumb: null, cut: { on: false, start: 0, end: 0 } });
  try {
    const probe = await api.probe(url);
    if (seq !== probeSeq) return false;
    let mode = store.get().mode;
    if (probe.kind === 'video' && !probe.media.hasVideo) mode = 'audio';
    const duration = probe.kind === 'video' ? probe.media.duration ?? 0 : 0;
    const patch = rebuild({ probe, phase: 'dealt', mode, dealSeq: store.get().dealSeq + 1, cut: { on: false, start: 0, end: duration } });
    patch.selected = defaultSelection(patch.cards ?? []);
    store.set(patch);
    void loadThumb(probe);
    return true;
  } catch (e) {
    if (seq !== probeSeq) return false;
    store.set({ phase: 'error', error: toError(e), probe: null, cards: [] });
    return false;
  }
}

async function loadThumb(probe: ProbeResult): Promise<void> {
  const src = probe.kind === 'video' ? probe.media.thumbnail : probe.kind === 'playlist' ? probe.playlist.thumbnail : null;
  const referer = probe.kind === 'video' ? probe.media.webpageUrl : null;
  if (!src) return;
  if (src.startsWith('data:')) {
    store.set({ thumb: src });
    return;
  }
  try {
    const data = await api.thumbnail(src, referer);
    if (store.get().probe === probe) store.set({ thumb: data });
  } catch {
    /* a missing thumbnail is not worth an error */
  }
}

export async function pasteAndDeal(): Promise<boolean> {
  const text = await api.readClipboard().catch(() => null);
  const url = text ? extractUrl(text) : null;
  if (!url) {
    store.set({ phase: 'error', error: { code: 'invalid_url', message: 'No link on your clipboard.', hint: 'Copy a video link, then hit PASTE again.', detail: null } });
    return false;
  }
  return deal(url);
}

export function fold(): void {
  probeSeq++;
  store.set({ phase: 'idle', probe: null, cards: [], selected: null, error: null, url: '', probeUrl: null, thumb: null, cut: { on: false, start: 0, end: 0 } });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function updateSettings(patch: Partial<Settings>, immediate = false): void {
  const current = store.get().settings;
  if (!current) return;
  const next = { ...current, ...patch };
  store.set({ settings: next });
  if (saveTimer) clearTimeout(saveTimer);
  const save = () => void api.saveSettings(next).then((saved) => store.set({ settings: saved }));
  if (immediate) save();
  else saveTimer = setTimeout(save, 350);
}

export function setMode(mode: Mode): void {
  if (mode === store.get().mode) return;
  const probe = store.get().probe;
  if (mode === 'video' && probe?.kind === 'video' && !probe.media.hasVideo) return;
  const patch = rebuild({ mode, dealSeq: store.get().dealSeq + 1 });
  patch.selected = defaultSelection(patch.cards ?? []);
  store.set(patch);
  updateSettings({ mode });
}

export function setContainer(container: Container): void {
  store.set(rebuild({ container }));
  updateSettings({ container });
}

export function setAudioFormat(audioFormat: AudioFormat): void {
  const patch = rebuild({ audioFormat, dealSeq: store.get().mode === 'audio' ? store.get().dealSeq + 1 : store.get().dealSeq });
  if (!patch.selected) patch.selected = defaultSelection(patch.cards ?? []);
  store.set(patch);
  updateSettings({ audioFormat });
}

export function select(key: string | null): void {
  const s = store.get();
  if (key === null) {
    store.set({ selected: null });
    return;
  }
  const card = s.cards.find((c) => c.key === key);
  if (!card || card.disabled) return;
  store.set({ selected: s.selected === key ? null : key });
}

// ------------------------------------------------------------ the cut

/** Open (or close) the cut timeline. Opening keeps the last range for this video. */
export function setCutOpen(on: boolean): void {
  const s = store.get();
  if (on && !cutAvailable(s)) return;
  if (on === s.cut.on) return;
  store.set(rebuild({ cut: { ...s.cut, on } }));
}

/** Clamp and store a range (rounded to the millisecond). Returns what was stored. */
export function setCut(start: number, end: number): CutState {
  const s = store.get();
  const d = mediaDuration(s) ?? Math.max(end, start + MIN_CUT);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  let a = r(Math.min(Math.max(0, start), d - MIN_CUT));
  let b = r(Math.max(Math.min(d, end), a + MIN_CUT));
  if (b > d) {
    b = r(d);
    a = r(Math.max(0, b - MIN_CUT));
  }
  const cut = { on: s.cut.on, start: a, end: b };
  if (cut.start !== s.cut.start || cut.end !== s.cut.end) store.set(rebuild({ cut }));
  return cut;
}

/** Frame-exact (re-encode) vs keyframe-fast video cuts. Remembered. */
export function setExactCuts(exactCuts: boolean): void {
  updateSettings({ exactCuts }, true);
  store.set(rebuild({}));
}

export function selectedCard(): CardModel | null {
  const s = store.get();
  return s.cards.find((c) => c.key === s.selected) ?? null;
}

/** Build the request the core receives for the selected card. */
export function buildRequest(card: CardModel): DownloadRequest {
  const s = store.get();
  const probe = s.probe;
  const base = emptyRequest(s.probeUrl ?? s.url);
  base.container = s.container;
  base.audioFormat = s.audioFormat;
  if (probe?.kind === 'video') {
    const m = probe.media;
    Object.assign(base, { url: m.webpageUrl, title: m.title, thumbnail: s.thumb ?? null, platform: m.platform, duration: m.duration });
  } else if (probe?.kind === 'playlist') {
    const p = probe.playlist;
    Object.assign(base, { url: p.webpageUrl, title: p.title, thumbnail: s.thumb ?? null, platform: p.platform });
  } else if (probe?.kind === 'sniffed') {
    base.title = card.detail.split('/').pop() || card.summary;
  }
  return { ...base, ...card.request, summary: card.short, cut: activeCut(s) };
}

export async function grab(): Promise<JobSnapshot | null> {
  const card = selectedCard();
  if (!card) return null;
  const job = await api.startDownload(buildRequest(card));
  const jobs = store.get().jobs.filter((j) => j.id !== job.id);
  store.set({ jobs: sortJobs([...jobs, job]), pileTab: 'active' });
  return job;
}

export const cancelJob = (id: string) => api.cancelJob(id);
export const retryJob = (id: string) => api.retryJob(id);
export const removeJob = (id: string) => api.removeJob(id);
export const clearFinished = () => api.clearFinished();

export async function installEngine(force = false, components: string[] = []): Promise<void> {
  try {
    const engine = await api.engineInstall(components, force);
    store.set({ engine });
  } catch (e) {
    const engine = await api.engineStatus().catch(() => null);
    if (engine) store.set({ engine });
    throw toError(e);
  }
}

export async function checkUpdates(): Promise<EngineStatus> {
  const engine = await api.engineCheckUpdates();
  store.set({ engine });
  return engine;
}

export async function pickFolder(): Promise<string | null> {
  const current = store.get().settings?.outputDir;
  const picked = await api.pickFolder(current);
  if (picked) updateSettings({ outputDir: picked }, true);
  return picked;
}

export const removeHistory = (id: string) => api.removeHistory(id);
export const clearHistory = () => api.clearHistory();
