import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../../src/api/mock';
import type { CoreEvent, JobSnapshot, ProbeResult } from '../../src/api/types';
import { emptyRequest } from '../../src/api/types';
import { createStore, changed } from '../../src/state/store';

describe('store', () => {
  it('notifies with next/prev and skips no-op updates', () => {
    const s = createStore({ a: 1, b: 'x' });
    const seen: [number, number][] = [];
    s.subscribe((n, p) => seen.push([n.a, p.a]));
    s.set({ a: 2 });
    s.set({ a: 2 });
    s.set((st) => ({ a: st.a + 1 }));
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(changed({ a: 1, b: 2 }, { a: 1, b: 3 }, 'a')).toBe(false);
    expect(changed({ a: 1, b: 2 }, { a: 1, b: 3 }, 'a', 'b')).toBe(true);
  });
});

describe('MockBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  async function settle<T>(p: Promise<T>, ms = 5000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return p;
  }

  it('routes probes by keyword like the real engine would answer', async () => {
    const m = new MockBackend({ latency: 10 });
    const r = await settle(m.call<ProbeResult>('probe', { url: 'https://youtu.be/xyz' }));
    expect(r.kind).toBe('video');
    // Attach the expectation before time moves, or the rejection is "unhandled".
    const rejects = async (url: string, code: string) => {
      const check = expect(m.call('probe', { url })).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(5000);
      await check;
    };
    await rejects('https://www.youtube.com/watch?v=bot', 'bot_check');
    await rejects('not a link', 'invalid_url');
    expect((await settle(m.call<ProbeResult>('probe', { url: 'https://youtube.com/playlist?list=1' }))).kind).toBe('playlist');
    expect((await settle(m.call<ProbeResult>('probe', { url: 'https://example.com/scrape' }))).kind).toBe('sniffed');
    await expect(m.call('nope')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('runs a two-part job through every stage to done', async () => {
    const m = new MockBackend({ latency: 10, history: false });
    const events: CoreEvent[] = [];
    m.onEvent((e) => events.push(e));
    const req = { ...emptyRequest('https://youtu.be/xyz'), title: 'Clip', videoId: '299', audioId: '140', expectedVideo: 20_000_000, expectedAudio: 2_000_000 };
    const job = await settle(m.call<JobSnapshot>('start_download', { request: req }), 200);
    await vi.advanceTimersByTimeAsync(30_000);
    const stages = [...new Set(events.filter((e): e is Extract<CoreEvent, { type: 'job' }> => e.type === 'job' && e.job.id === job.id).map((e) => e.job.stage))];
    expect(stages).toEqual(['queued', 'extract', 'video', 'audio', 'merge', 'embed', 'tags', 'move', 'done']);
    const last = (await m.call<JobSnapshot[]>('list_jobs'))[0];
    expect(last.status).toBe('done');
    expect(last.files).toEqual(['/Users/you/Downloads/Balader/Clip.mp4']);
    expect(m.history).toHaveLength(1);
    const progresses = events.filter((e): e is Extract<CoreEvent, { type: 'job' }> => e.type === 'job').map((e) => e.job.progress);
    expect(progresses).toEqual([...progresses].sort((a, b) => a - b));
  });

  it('respects the parallel limit, cancels and retries', async () => {
    const m = new MockBackend({ latency: 10 });
    m.settings.maxConcurrent = 1;
    const a = await settle(m.call<JobSnapshot>('start_download', { request: emptyRequest('https://youtu.be/a') }), 100);
    const b = await settle(m.call<JobSnapshot>('start_download', { request: emptyRequest('https://youtu.be/b') }), 100);
    let jobs = await m.call<JobSnapshot[]>('list_jobs');
    expect(jobs.find((j) => j.id === b.id)?.status).toBe('queued');
    await m.call('cancel_job', { id: a.id });
    await vi.advanceTimersByTimeAsync(300);
    jobs = await m.call<JobSnapshot[]>('list_jobs');
    expect(jobs.find((j) => j.id === a.id)?.status).toBe('cancelled');
    expect(jobs.find((j) => j.id === b.id)?.status).not.toBe('queued');
    await m.call('retry_job', { id: a.id });
    jobs = await m.call<JobSnapshot[]>('list_jobs');
    expect(jobs.find((j) => j.id === a.id)?.status).toBe('queued');
  });

  it('installs a missing engine with progress events', async () => {
    const m = new MockBackend({ engine: 'missing' });
    const stages: string[] = [];
    m.onEvent((e) => e.type === 'engineProgress' && stages.push(`${e.component}:${e.stage}`));
    const st = await settle(m.call<{ ready: boolean }>('engine_install', {}), 20_000);
    expect(st.ready).toBe(true);
    expect(stages).toContain('ytdlp:verify');
    expect(stages.at(-1)).toBe('deno:done');
  });
});
