// Deterministic in-browser simulation of the Rust core. Same commands, same
// event shapes, same job stages, so the whole UI can be built and tested
// without the engine. Time follows `motion.timeScale` (tests run it fast).
//
// URL keywords pick scenarios: bot, private, unsupported, live, offline,
// ratelimit, scrape, playlist/list=, tiktok, soundcloud/.mp3, archive.org,
// and "fail" (download dies halfway). Anything else → a 4K YouTube video.

import type { Backend, WindowAction } from '../backend';
import type {
  AppInfo,
  ComponentStatus,
  CoreEvent,
  Cut,
  DownloadRequest,
  EngineStatus,
  ErrorPayload,
  HistoryEntry,
  JobSnapshot,
  ProbeResult,
  Settings,
} from '../types';
import { motion } from '../../fx/motion';
import { random, range, seed as seedRng } from '../../fx/rng';
import { clock, compactTime, extractUrl } from '../../ui/format';
import * as fx from './fixtures';

export interface MockOptions {
  engine?: 'ready' | 'missing';
  seed?: number;
  latency?: number;
  history?: boolean;
}

interface Part {
  fmt: string;
  kind: 'video' | 'audio' | 'media' | 'cut';
  size: number;
  done: number;
}

interface Sim {
  job: JobSnapshot;
  req: DownloadRequest;
  phase: 'queued' | 'extract' | 'download' | 'post' | 'done';
  t: number;
  parts: Part[];
  part: number;
  item: number;
  items: number;
  speed: number;
  fail: boolean;
  post: [string, string, number][];
  postIdx: number;
}

const OUT = '/Users/you/Downloads/Balader';

function defaultSettings(): Settings {
  return {
    outputDir: OUT,
    filename: 'title',
    maxConcurrent: 2,
    cookiesBrowser: null,
    embedThumbnail: true,
    embedMetadata: true,
    embedSubs: false,
    subLangs: 'en.*',
    exactCuts: true,
    mode: 'video',
    container: 'mp4',
    audioFormat: 'mp3',
    audioQuality: 'best',
    sound: true,
    volume: 0.6,
    crt: true,
    backgroundMotion: true,
    reducedMotion: false,
    screenShake: true,
    autoUpdate: true,
  };
}

function component(id: string, ready: boolean): ComponentStatus {
  const meta: Record<string, [string, string, boolean, string, number]> = {
    ytdlp: ['yt-dlp', 'Reads 1800+ sites', true, '2026.10.26', 54_000_000],
    ffmpeg: ['FFmpeg', 'Merges, converts, embeds', true, '9.0.2', 62_000_000],
    deno: ['Deno', "Solves YouTube's JS challenge", false, '2.9.8', 42_000_000],
  };
  const [name, role, required, version, size] = meta[id];
  return {
    id,
    name,
    role,
    required,
    state: ready ? 'ready' : 'missing',
    source: ready ? 'managed' : null,
    path: ready ? `/Users/you/Library/Application Support/com.balader.desktop/engine/${id}` : null,
    version: ready ? version : null,
    latest: version,
    updateAvailable: false,
    error: null,
    downloadSize: size,
  };
}

/** Same checks as the core's cut::normalize. */
export function normalizeCut(cut: Cut | null | undefined, duration: number | null | undefined): Cut | null {
  if (!cut) return null;
  if (![cut.start, cut.end].every(Number.isFinite) || cut.start < 0 || cut.end < 0) throw err('bad_request', "The cut times don't make sense.");
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const start = r(cut.start);
  let end = r(cut.end);
  if (duration && duration > 0) {
    if (start >= duration) throw err('bad_request', `The cut starts after the end (${clock(duration)}).`);
    end = Math.min(end, r(duration));
    if (start <= 0 && end >= r(duration)) return null;
  }
  if (end <= start) throw err('bad_request', 'The cut ends before it starts.', 'Put the end after the start.');
  if (end - start < 0.1 - 1e-9) throw err('bad_request', 'That cut is too short.', 'Leave at least a tenth of a second between start and end.');
  return { start, end, exact: cut.exact };
}

function err(code: ErrorPayload['code'], message: string, hint: string | null = null): ErrorPayload {
  return { code, message, hint, detail: null };
}

export class MockBackend implements Backend {
  readonly kind = 'mock' as const;
  private listeners = new Set<(e: CoreEvent) => void>();
  private sims: Sim[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private idSeq = 1;
  settings: Settings = defaultSettings();
  history: HistoryEntry[] = [];
  engine: EngineStatus;
  latency: number;
  /** Simulated download speed multiplier. */
  speed = 1;
  /** Force the next probe to fail with this error (dev panel / tests). */
  nextProbeError: ErrorPayload | null = null;
  /** Paths the UI asked to open/reveal (tests assert on these). */
  readonly opened: string[] = [];
  /** The last download request, as the core would see it (tests). */
  lastRequest: DownloadRequest | null = null;
  readonly calls: { cmd: string; args: unknown }[] = [];

  constructor(opts: MockOptions = {}) {
    seedRng(opts.seed ?? 7);
    this.latency = opts.latency ?? 1100;
    const ready = opts.engine !== 'missing';
    this.engine = this.engineStatus(ready ? ['ytdlp', 'ffmpeg', 'deno'] : []);
    if (opts.history !== false) this.seedHistory();
  }

  private engineStatus(readyIds: string[]): EngineStatus {
    const components = ['ytdlp', 'ffmpeg', 'deno'].map((id) => component(id, readyIds.includes(id)));
    return {
      components,
      ready: components.filter((c) => c.required).every((c) => c.state === 'ready'),
      engineDir: '/Users/you/Library/Application Support/com.balader.desktop/engine',
      platform: 'macos',
      arch: 'aarch64',
      jsRuntime: readyIds.includes('deno') ? 'deno (managed)' : null,
    };
  }

  private seedHistory(): void {
    const now = Date.now();
    const a = fx.soundcloud();
    const b = fx.archive();
    this.history = [
      { id: 'h2', url: a.webpageUrl, title: a.title, thumbnail: a.thumbnail, platform: a.platform, mode: 'audio', summary: 'MP3 · 320K', cut: null, files: [`${OUT}/Flickermood.mp3`], size: 8_587_902, finishedAt: now - 3_600_000 },
      { id: 'h1', url: b.webpageUrl, title: b.title, thumbnail: b.thumbnail, platform: b.platform, mode: 'video', summary: '360p · MP4', cut: null, files: [`${OUT}/Big Buck Bunny.mp4`], size: 61_900_000, finishedAt: now - 86_400_000 },
    ];
  }

  // ------------------------------------------------------------ plumbing

  emit(e: CoreEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private wait(duration: number): Promise<void> {
    return new Promise((r) => setTimeout(r, duration / motion.timeScale));
  }

  async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ cmd, args });
    return (await this.dispatch(cmd, args)) as T;
  }

  private async dispatch(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'ping':
        return 'pong';
      case 'app_info':
        return {
          version: '0.1.0',
          platform: navigator.platform.toLowerCase().includes('win') ? 'windows' : 'macos',
          arch: 'aarch64',
          configDir: '/Users/you/Library/Application Support/com.balader.desktop',
          dataDir: '/Users/you/Library/Application Support/com.balader.desktop',
          engineDir: this.engine.engineDir,
          defaultOutputDir: OUT,
          host: 'mock',
        } satisfies AppInfo;
      case 'engine_status':
        await this.wait(120);
        return this.engine;
      case 'engine_install':
        return this.installEngine(Boolean(args.force));
      case 'engine_check_updates':
        await this.wait(300);
        return this.engine;
      case 'probe':
        return this.probe(String(args.url ?? ''));
      case 'sniff':
        await this.wait(this.latency / 2);
        return fx.sniffed(String(args.url ?? ''));
      case 'start_download':
        return this.start(args.request as DownloadRequest);
      case 'list_jobs':
        return this.sims.map((s) => s.job);
      case 'cancel_job':
        return this.cancel(String(args.id));
      case 'retry_job':
        return this.retry(String(args.id));
      case 'remove_job': {
        const id = String(args.id);
        this.sims = this.sims.filter((s) => s.job.id !== id);
        this.emit({ type: 'jobRemoved', id });
        return true;
      }
      case 'clear_finished': {
        const gone = this.sims.filter((s) => ['done', 'error', 'cancelled'].includes(s.job.status)).map((s) => s.job.id);
        this.sims = this.sims.filter((s) => !gone.includes(s.job.id));
        for (const id of gone) this.emit({ type: 'jobRemoved', id });
        return gone;
      }
      case 'get_settings':
        return this.settings;
      case 'save_settings':
        this.settings = { ...this.settings, ...(args.settings as Settings), maxConcurrent: Math.max(1, Math.min(4, (args.settings as Settings).maxConcurrent ?? 2)) };
        this.emit({ type: 'settingsChanged', settings: this.settings });
        this.pump();
        return this.settings;
      case 'get_history':
        return this.history;
      case 'remove_history':
        this.history = this.history.filter((h) => h.id !== args.id);
        this.emit({ type: 'historyChanged' });
        return true;
      case 'clear_history':
        this.history = [];
        this.emit({ type: 'historyChanged' });
        return true;
      case 'thumbnail': {
        const url = String(args.url ?? '');
        if (url.startsWith('mock://storyboard/')) {
          await this.wait(40);
          const data = fx.paintStoryboardSheet(url);
          if (!data) throw err('unknown', 'not an image');
          return data;
        }
        return url;
      }
      case 'open_path':
      case 'reveal_path':
        this.opened.push(`${cmd}:${String(args.path)}`);
        return true;
      case 'default_output_dir':
        return OUT;
      default:
        throw err('bad_request', `unknown command \`${cmd}\``);
    }
  }

  // ------------------------------------------------------------ engine

  private async installEngine(force: boolean): Promise<EngineStatus> {
    const todo = this.engine.components.filter((c) => force || c.state !== 'ready').map((c) => c.id);
    const ready = this.engine.components.filter((c) => c.state === 'ready' && !todo.includes(c.id)).map((c) => c.id);
    for (const id of todo) {
      this.engine = { ...this.engine, components: this.engine.components.map((c) => (c.id === id ? { ...c, state: 'installing' } : c)) };
      this.emit({ type: 'engineStatus', status: this.engine });
      const total = component(id, false).downloadSize;
      for (let i = 0; i <= 12; i++) {
        this.emit({ type: 'engineProgress', component: id, stage: 'download', downloaded: Math.round((total * i) / 12), total, message: null });
        await this.wait(110);
      }
      for (const stage of ['verify', 'extract', 'check'] as const) {
        this.emit({ type: 'engineProgress', component: id, stage, downloaded: total, total, message: null });
        await this.wait(160);
      }
      ready.push(id);
      this.engine = this.engineStatus(ready);
      this.emit({ type: 'engineProgress', component: id, stage: 'done', downloaded: total, total, message: null });
      this.emit({ type: 'engineStatus', status: this.engine });
    }
    return this.engine;
  }

  // ------------------------------------------------------------ probe

  private async probe(input: string): Promise<ProbeResult> {
    const url = extractUrl(input);
    await this.wait(url ? this.latency : 150);
    if (!url) throw fx.ERRORS.invalid;
    if (!this.engine.ready) throw err('engine_missing', "The engine isn't installed yet.", 'Open the engine room and install it (one click).');
    if (this.nextProbeError) {
      const e = this.nextProbeError;
      this.nextProbeError = null;
      throw e;
    }
    const u = url.toLowerCase();
    if (u.includes('bot')) throw fx.ERRORS.botcheck;
    if (u.includes('private')) throw fx.ERRORS.private;
    if (u.includes('unsupported') || u.includes('nothing')) throw fx.ERRORS.unsupported;
    if (u.includes('live')) throw fx.ERRORS.live;
    if (u.includes('offline')) throw fx.ERRORS.network;
    if (u.includes('ratelimit')) throw fx.ERRORS.ratelimit;
    if (u.includes('scrape') || u.includes('sniff')) return { kind: 'sniffed', page: url, candidates: fx.sniffed(url) };
    if (u.includes('playlist') || u.includes('list=') || u.includes('/sets/')) return { kind: 'playlist', playlist: fx.playlist(url) };
    if (u.includes('tiktok')) return { kind: 'video', media: fx.tiktok(url) };
    if (u.includes('soundcloud') || u.endsWith('.mp3')) return { kind: 'video', media: fx.soundcloud(url) };
    if (u.includes('archive.org')) return { kind: 'video', media: fx.archive(url) };
    return { kind: 'video', media: fx.youtube(url) };
  }

  // ------------------------------------------------------------ jobs

  private snapshot(req: DownloadRequest): JobSnapshot {
    return {
      id: `j${this.idSeq++}`,
      url: req.url,
      title: req.title ?? req.url,
      thumbnail: req.thumbnail,
      platform: req.platform,
      mode: req.mode,
      summary: req.summary ?? (req.mode === 'audio' ? `${req.audioFormat.toUpperCase()} · ${req.audioQuality.toUpperCase()}` : `${req.tier ?? 'BEST'}p · ${req.container.toUpperCase()}`),
      cut: req.cut ?? null,
      status: 'queued',
      stage: 'queued',
      stageLabel: 'Waiting in line',
      progress: 0,
      item: null,
      items: req.playlist ? (req.playlistLimit ?? req.playlistCount) : null,
      part: null,
      parts: null,
      downloaded: 0,
      total: null,
      speed: null,
      eta: null,
      files: [],
      outputDir: this.settings.outputDir,
      error: null,
      warnings: [],
      alreadyExisted: false,
      createdAt: Date.now(),
      finishedAt: null,
    };
  }

  private plan(req: DownloadRequest): Part[] {
    // One FFmpeg pass reads just the clip, video and audio together.
    if (req.cut) return [{ fmt: 'cut', kind: 'cut', size: (req.mode === 'audio' ? req.expectedAudio : (req.expectedVideo ?? 0) + (req.expectedAudio ?? 0)) || 6_000_000, done: 0 }];
    if (req.mode === 'audio') return [{ fmt: req.audioSourceId ?? 'ba', kind: 'audio', size: req.expectedAudio ?? 9_000_000, done: 0 }];
    if (req.combined || !req.audioId) return [{ fmt: req.videoId ?? 'b', kind: 'media', size: req.expectedVideo ?? 30_000_000, done: 0 }];
    return [
      { fmt: req.videoId ?? 'bv', kind: 'video', size: req.expectedVideo ?? 80_000_000, done: 0 },
      { fmt: req.audioId, kind: 'audio', size: req.expectedAudio ?? 8_000_000, done: 0 },
    ];
  }

  private async start(input: DownloadRequest): Promise<JobSnapshot> {
    await this.wait(80);
    if (!input?.url) throw err('bad_request', 'bad arguments: missing url');
    if (!this.engine.ready) throw err('engine_missing', "The engine isn't installed yet.");
    const req: DownloadRequest = { ...input, cut: input.playlist ? null : normalizeCut(input.cut, input.duration) };
    this.lastRequest = req;
    const items = req.playlist ? Math.min(req.playlistLimit ?? req.playlistCount ?? 3, 6) : 1;
    const post: [string, string, number][] =
      req.mode === 'audio'
        ? [['convert', `Converting to ${req.audioFormat.toUpperCase()}`, 900], ['embed', 'Embedding cover', 300], ['tags', 'Writing tags', 220], ['move', 'Moving to folder', 120]]
        : req.cut
          ? [['embed', 'Embedding cover', 300], ['tags', 'Writing tags', 200], ['move', 'Moving to folder', 120]]
          : req.combined
          ? [['remux', 'Rewrapping', 400], ['embed', 'Embedding cover', 300], ['tags', 'Writing tags', 200], ['move', 'Moving to folder', 120]]
          : [['merge', 'Merging', 800], ['embed', 'Embedding cover', 300], ['tags', 'Writing tags', 200], ['move', 'Moving to folder', 120]];
    const sim: Sim = {
      job: this.snapshot(req),
      req,
      phase: 'queued',
      t: 0,
      parts: this.plan(req),
      part: 0,
      item: 1,
      items,
      speed: range(5e6, 12e6),
      fail: req.url.toLowerCase().includes('fail'),
      post,
      postIdx: 0,
    };
    this.sims.push(sim);
    this.emit({ type: 'job', job: sim.job });
    this.pump();
    this.ensureTimer();
    return sim.job;
  }

  private cancel(id: string): JobSnapshot {
    const sim = this.sims.find((s) => s.job.id === id);
    if (!sim) throw err('not_found', 'No such download.');
    if (['queued', 'starting', 'downloading', 'processing'].includes(sim.job.status)) {
      sim.phase = 'done';
      this.update(sim, { status: 'cancelled', stage: 'cancelled', stageLabel: 'Folded', speed: null, eta: null, finishedAt: Date.now() });
      this.pump();
    }
    return sim.job;
  }

  private retry(id: string): JobSnapshot {
    const sim = this.sims.find((s) => s.job.id === id);
    if (!sim) throw err('not_found', 'No such download.');
    if (['error', 'cancelled'].includes(sim.job.status)) {
      sim.phase = 'queued';
      sim.t = 0;
      sim.part = 0;
      sim.item = 1;
      sim.postIdx = 0;
      sim.fail = false;
      sim.parts = this.plan(sim.req);
      this.update(sim, { status: 'queued', stage: 'queued', stageLabel: 'Waiting in line', progress: 0, error: null, finishedAt: null, downloaded: 0 });
      this.pump();
      this.ensureTimer();
    }
    return sim.job;
  }

  private update(sim: Sim, patch: Partial<JobSnapshot>): void {
    sim.job = { ...sim.job, ...patch };
    this.emit({ type: 'job', job: sim.job });
  }

  private pump(): void {
    const running = this.sims.filter((s) => s.phase === 'extract' || s.phase === 'download' || s.phase === 'post').length;
    let free = this.settings.maxConcurrent - running;
    for (const s of this.sims) {
      if (free <= 0) break;
      if (s.phase === 'queued' && s.job.status === 'queued') {
        s.phase = 'extract';
        s.t = 0;
        this.update(s, { status: 'starting', stage: 'extract', stageLabel: 'Shuffling the deck' });
        free--;
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    const now = performance.now();
    const dt = (now - this.last) * motion.timeScale;
    this.last = now;
    let active = false;
    for (const sim of this.sims) {
      if (sim.phase === 'queued' || sim.phase === 'done') {
        active ||= sim.phase === 'queued';
        continue;
      }
      active = true;
      sim.t += dt;
      if (sim.phase === 'extract') {
        if (sim.t > 650) {
          sim.phase = 'download';
          sim.t = 0;
        }
        continue;
      }
      if (sim.phase === 'download') this.tickDownload(sim, dt);
      else if (sim.phase === 'post') this.tickPost(sim);
    }
    if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tickDownload(sim: Sim, dt: number): void {
    sim.speed = Math.max(1.5e6, Math.min(22e6, sim.speed * range(0.9, 1.1)));
    const part = sim.parts[sim.part];
    part.done = Math.min(part.size, part.done + (sim.speed * this.speed * dt) / 1000);
    const total = sim.parts.reduce((a, p) => a + p.size, 0);
    const done = sim.parts.reduce((a, p) => a + p.done, 0);
    const inItem = (done / total) * 0.94;
    const progress = ((sim.item - 1) + inItem) / sim.items;
    if (sim.fail && progress > 0.42) {
      sim.phase = 'done';
      this.update(sim, {
        status: 'error',
        stage: 'error',
        stageLabel: "Couldn't reach the site.",
        error: err('network', "Couldn't reach the site.", 'Check your connection, then retry.'),
        speed: null,
        eta: null,
        finishedAt: Date.now(),
      });
      this.pump();
      return;
    }
    const label =
      part.kind === 'cut' ? (sim.req.mode === 'audio' ? 'Cutting the track' : 'Cutting the clip') : part.kind === 'video' ? 'Downloading video' : part.kind === 'audio' ? 'Downloading audio' : 'Downloading';
    this.update(sim, {
      status: 'downloading',
      stage: part.kind,
      stageLabel: label,
      progress: Math.max(sim.job.progress, progress),
      downloaded: Math.round(done),
      total,
      speed: sim.speed * this.speed,
      eta: (total - done) / (sim.speed * this.speed),
      part: sim.parts.length > 1 ? sim.part + 1 : null,
      parts: sim.parts.length > 1 ? sim.parts.length : null,
      item: sim.items > 1 ? sim.item : null,
      items: sim.items > 1 ? sim.items : null,
    });
    if (part.done >= part.size) {
      if (sim.part < sim.parts.length - 1) sim.part++;
      else {
        sim.phase = 'post';
        sim.t = 0;
        sim.postIdx = 0;
      }
    }
  }

  private tickPost(sim: Sim): void {
    const [key, label, dur] = sim.post[sim.postIdx];
    if (sim.job.stage !== key) {
      const progress = ((sim.item - 1) + 0.97) / sim.items;
      this.update(sim, { status: 'processing', stage: key, stageLabel: label, speed: null, eta: null, progress: Math.max(sim.job.progress, progress) });
    }
    if (sim.t < dur) return;
    sim.t = 0;
    sim.postIdx++;
    if (sim.postIdx < sim.post.length) return;
    if (sim.item < sim.items) {
      sim.item++;
      sim.parts = this.plan(sim.req);
      sim.part = 0;
      sim.phase = 'extract';
      this.update(sim, { status: 'starting', stage: 'extract', stageLabel: `Reading card ${sim.item} of ${sim.items}` });
      return;
    }
    this.finish(sim);
  }

  private finish(sim: Sim): void {
    sim.phase = 'done';
    const ext = sim.req.mode === 'audio' ? sim.req.audioFormat : sim.req.container;
    const cut = sim.req.cut;
    const base = `${(sim.req.title ?? 'video').replace(/[\\/:*?"<>|]/g, '_')}${cut ? ` (${compactTime(cut.start)}-${compactTime(cut.end)})` : ''}`;
    const files = sim.req.playlist
      ? Array.from({ length: sim.items }, (_, i) => `${OUT}/${base}/${String(i + 1).padStart(3, '0')} - ${fx.playlist().entries[i]?.title ?? 'item'}.${ext}`)
      : [`${OUT}/${base}.${ext}`];
    const size = sim.parts.reduce((a, p) => a + p.size, 0) * sim.items;
    this.update(sim, { status: 'done', stage: 'done', stageLabel: 'Saved', progress: 1, files, speed: null, eta: null, downloaded: size, total: size, finishedAt: Date.now() });
    this.history = [
      { id: sim.job.id, url: sim.job.url, title: sim.job.title, thumbnail: sim.job.thumbnail, platform: sim.job.platform, mode: sim.job.mode, summary: sim.job.summary, cut: sim.job.cut, files, size, finishedAt: Date.now() },
      ...this.history.filter((h) => h.id !== sim.job.id),
    ];
    this.emit({ type: 'historyChanged' });
    this.pump();
  }

  // ------------------------------------------------------------ native bits

  async pickFolder(start?: string): Promise<string | null> {
    await this.wait(200);
    return start ? `${start.replace(/\/$/, '')}-picked` : `${OUT}-picked`;
  }

  async readClipboard(): Promise<string | null> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return 'https://www.youtube.com/watch?v=0cEaNw4vEs0';
    }
  }

  async openPath(path: string): Promise<void> {
    this.opened.push(`open:${path}`);
  }

  async revealPath(path: string): Promise<void> {
    this.opened.push(`reveal:${path}`);
  }

  async windowAction(action: WindowAction): Promise<void> {
    this.opened.push(`window:${action}`);
  }

  // ------------------------------------------------------------ test controls

  setEngine(state: 'ready' | 'missing'): void {
    this.engine = this.engineStatus(state === 'ready' ? ['ytdlp', 'ffmpeg', 'deno'] : []);
    this.emit({ type: 'engineStatus', status: this.engine });
  }

  /** Random but replayable, handy for flaky-looking UI states. */
  jitter(): number {
    return random();
  }
}
