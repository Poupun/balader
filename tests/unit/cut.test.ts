import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend, normalizeCut } from '../../src/api/mock';
import * as fx from '../../src/api/mock/fixtures';
import type { CoreEvent, JobSnapshot } from '../../src/api/types';
import { emptyRequest } from '../../src/api/types';
import { buildCards } from '../../src/state/cards';
import { clipLength, clock, compactTime, parseTime, rulerStep, storyboardFrame } from '../../src/ui/format';

// Same cases as crates/balader-core/src/cut.rs: the UI and the core must agree.
describe('cut times', () => {
  it('parses what people type', () => {
    const cases: [string, number][] = [
      ['83', 83],
      [' 83.5 ', 83.5],
      ['1:23', 83],
      ['1:23.5', 83.5],
      ['1:23,25', 83.25],
      ['01:02:03.25', 3723.25],
      ['75:00', 4500],
      ['1h2m3s', 3723],
      ['2m', 120],
      ['1m30', 90],
      ['1h30', 5400],
      ['4.5s', 4.5],
      ['0', 0],
    ];
    for (const [text, secs] of cases) expect(parseTime(text), text).toBe(secs);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', ' ', 'abc', '1:75', '1:2:3:4', '-5', '1..5', '1:-3', '1s2m', '1m1m', '1.2:30', '5x', '.', ':30']) {
      expect(parseTime(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('labels', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(83.5)).toBe('1:23.5');
    expect(clock(3723.25)).toBe('1:02:03.25');
    expect(clock(59.9996)).toBe('1:00');
    expect(clock(12, 1)).toBe('0:12.0');
    expect(clock(83.25, 1)).toBe('1:23.25');
    expect(compactTime(5)).toBe('5s');
    expect(compactTime(5.5)).toBe('5.5s');
    expect(compactTime(65)).toBe('1m05s');
    expect(compactTime(3723.5)).toBe('1h02m03.5s');
    expect(clipLength(41.04)).toBe('41.0s');
    expect(clipLength(125)).toBe('2m 05s');
    expect(clipLength(3725)).toBe('1h 02m');
  });

  it('ruler steps fit about six labels', () => {
    expect(rulerStep(19)).toBe(5);
    expect(rulerStep(754)).toBe(300);
    expect(rulerStep(3 * 3600)).toBe(1800);
  });

  it('finds the storyboard frame for a moment', () => {
    const b = { width: 160, height: 90, columns: 5, rows: 5, frames: 128, sheets: ['s0', 's1', 's2', 's3', 's4', 's5'] };
    expect(storyboardFrame(b, 635, 0)).toEqual({ url: 's0', sx: 0, sy: 0 });
    // Frame 6 (t ≈ 30 s): second row, second column of the first sheet.
    expect(storyboardFrame(b, 635, 30)).toEqual({ url: 's0', sx: 160, sy: 90 });
    // Frame 25 starts the second sheet.
    expect(storyboardFrame(b, 635, (25 * 635) / 128 + 0.01)).toEqual({ url: 's1', sx: 0, sy: 0 });
    expect(storyboardFrame(b, 635, 635)).toEqual({ url: 's5', sx: 2 * 160, sy: 0 }, 'the very end is the last frame');
  });
});

describe('cards for a clip', () => {
  const yt = { kind: 'video' as const, media: fx.youtube() };

  it('video sizes shrink to the clip share and say so', () => {
    const whole = buildCards(yt, 'video', 'mp4', 'mp3').find((c) => c.key === 'v1080')!;
    const clip = buildCards(yt, 'video', 'mp4', 'mp3', 75.4).find((c) => c.key === 'v1080')!;
    expect(whole.request.expectedVideo).toBeGreaterThan(0);
    expect(clip.request.expectedVideo).toBe(Math.round(whole.request.expectedVideo! / 10));
    expect(clip.size.startsWith('~')).toBe(true);
    expect(clip.tip).toContain('for the 1m 15s clip');
    expect(whole.tip).not.toContain('clip');
  });

  it('audio estimates use the clip length', () => {
    const whole = buildCards(yt, 'audio', 'mp4', 'mp3').find((c) => c.key === 'a-320')!;
    const clip = buildCards(yt, 'audio', 'mp4', 'mp3', 60).find((c) => c.key === 'a-320')!;
    expect(clip.request.expectedAudio).toBe(320 * 125 * 60);
    expect(whole.request.expectedAudio).toBe(320 * 125 * 754);
  });
});

describe('mock cuts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('normalizes like the core', () => {
    const c = (start: number, end: number) => ({ start, end, exact: true });
    expect(normalizeCut(null, 60)).toBeNull();
    expect(normalizeCut(c(0, 60), 60)).toBeNull();
    expect(normalizeCut(c(0, 75), 60)).toBeNull();
    expect(normalizeCut(c(10, 75), 60)).toEqual(c(10, 60));
    expect(normalizeCut(c(1.23456, 2), null)).toEqual(c(1.235, 2));
    expect(() => normalizeCut(c(61, 70), 60)).toThrow();
    expect(() => normalizeCut(c(5, 4), null)).toThrow();
    expect(() => normalizeCut(c(5, 5.05), null)).toThrow();
    expect(normalizeCut(c(5, 5.1), null)).toEqual(c(5, 5.1));
  });

  it('runs a cut as one pass and names the clip', async () => {
    const m = new MockBackend({ latency: 10, history: false });
    const events: CoreEvent[] = [];
    m.onEvent((e) => events.push(e));
    const req = { ...emptyRequest('https://youtu.be/xyz'), title: 'Clip', duration: 754, videoId: '299', audioId: '140', expectedVideo: 2_000_000, expectedAudio: 200_000, cut: { start: 125, end: 160.5, exact: true } };
    const p = m.call<JobSnapshot>('start_download', { request: req });
    await vi.advanceTimersByTimeAsync(200);
    const job = await p;
    expect(job.cut).toEqual({ start: 125, end: 160.5, exact: true });
    await vi.advanceTimersByTimeAsync(30_000);
    const stages = [...new Set(events.filter((e): e is Extract<CoreEvent, { type: 'job' }> => e.type === 'job' && e.job.id === job.id).map((e) => e.job.stage))];
    expect(stages).toEqual(['queued', 'extract', 'cut', 'embed', 'tags', 'move', 'done']);
    const last = (await m.call<JobSnapshot[]>('list_jobs'))[0];
    expect(last.files).toEqual(['/Users/you/Downloads/Balader/Clip (2m05s-2m40.5s).mp4']);
    expect(m.history[0].cut).toEqual({ start: 125, end: 160.5, exact: true });
  });

  it('refuses a cut past the end and ignores cuts on playlists', async () => {
    const m = new MockBackend({ latency: 10, history: false });
    const bad = { ...emptyRequest('https://youtu.be/xyz'), duration: 60, cut: { start: 70, end: 80, exact: true } };
    const check = expect(m.call('start_download', { request: bad })).rejects.toMatchObject({ code: 'bad_request' });
    await vi.advanceTimersByTimeAsync(200);
    await check;
    const pl = { ...emptyRequest('https://youtube.com/playlist?list=1'), playlist: true, cut: { start: 1, end: 2, exact: true } };
    const p = m.call<JobSnapshot>('start_download', { request: pl });
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).cut).toBeNull();
  });
});
