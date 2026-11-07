// The real thing: web UI → HTTP → `balader serve` → Rust core → yt-dlp/ffmpeg
// → files on disk. Needs network and an installed engine.
// Run: npm run test:e2e:real   (builds the CLI first)

import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clickCard, dealUrl, until } from './helpers';

const PORT = 4318;
const TOKEN = 'e2e-real';
const ROOT = resolve('tests/e2e/.output/real');

/** Same folder the app and `balader engine install` use, so nothing is re-downloaded. */
function engineDir(): string {
  if (process.env.BALADER_ENGINE_DIR) return process.env.BALADER_ENGINE_DIR;
  const id = 'com.balader.desktop';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', id, 'engine');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), id, 'engine');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), id, 'engine');
}

/** Length and codecs of a file, from the engine's own ffprobe. */
function probeFile(file: string): { duration: number; codecs: string[] } {
  const bin = join(engineDir(), 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const out = JSON.parse(execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', file], { encoding: 'utf8' }));
  return { duration: Number(out.format.duration), codecs: (out.streams as { codec_name: string }[]).map((x) => x.codec_name) };
}

async function typeTime(page: Page, which: 'in' | 'out', text: string): Promise<void> {
  await page.getByTestId(`cut-${which}-value`).click();
  await page.getByTestId(`cut-${which}-input`).fill(text);
  await page.keyboard.press('Enter');
}

let server: ChildProcess | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const bin = resolve('target', 'debug', process.platform === 'win32' ? 'balader.exe' : 'balader');
  if (!existsSync(bin)) throw new Error('Build the CLI first: cargo build -p balader-cli');
  server = spawn(bin, ['--home', join(ROOT, 'home'), '--engine-dir', engineDir(), '--out-dir', join(ROOT, 'downloads'), 'serve', '--port', String(PORT), '--token', TOKEN], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('balader serve did not start')), 30_000);
    server!.stdout!.on('data', (d) => {
      if (String(d).includes('BALADER_SERVE')) {
        clearTimeout(timer);
        res();
      }
    });
    server!.on('exit', (code) => rej(new Error(`balader serve exited (${code})`)));
  });
});

test.afterAll(() => {
  server?.kill();
});

async function open(page: Page): Promise<void> {
  await page.goto(`/?backend=http&api=http://127.0.0.1:${PORT}&token=${TOKEN}&dev=0`);
  await page.waitForFunction(() => (window as unknown as { __balader?: { snapshot(): { ready: boolean } } }).__balader?.snapshot().ready === true);
}

test('the real engine reports ready', async ({ page }) => {
  await open(page);
  const s = await until(page, (s) => s.engine !== null, 60_000);
  expect(s.engine!.ready, 'run `npm run cli -- engine install` first').toBe(true);
  expect(s.backend).toBe('http');
});

test('direct MP4 link: deal, grab, file lands on disk', async ({ page }) => {
  await open(page);
  await dealUrl(page, 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  const s = await until(page, (s) => s.phase === 'dealt' || s.phase === 'error', 90_000);
  expect(s.phase, JSON.stringify(s.error)).toBe('dealt');
  expect(s.cards[0].big).toBe('BEST');
  expect(s.cards[0].size).toBe('991 KB');
  await page.getByTestId('grab').click();
  const done = await until(page, (s) => ['done', 'error'].includes(s.jobs[0]?.status ?? ''), 120_000);
  expect(done.jobs[0].status, done.jobs[0].label).toBe('done');
  expect(statSync(done.jobs[0].files[0]).size).toBeGreaterThan(500_000);
});

test('grabbing the audio of a saved video never touches the video', async ({ page }) => {
  // Regression: yt-dlp used to reuse the saved MP4 as the MP3 source, then delete it.
  const CLIP = 'https://www.w3schools.com/html/mov_bbb.mp4';
  const find = (s: { jobs: { title: string; summary: string; status: string; files: string[]; label: string }[] }, kind: string) =>
    s.jobs.find((j) => j.title === 'mov_bbb' && j.summary.startsWith(kind));
  await open(page);
  await dealUrl(page, CLIP);
  await until(page, (s) => s.phase === 'dealt', 90_000);
  await page.getByTestId('grab').click();
  let s = await until(page, (s) => ['done', 'error'].includes(find(s, 'BEST')?.status ?? ''), 120_000);
  const video = find(s, 'BEST')!;
  expect(video.status, video.label).toBe('done');
  const videoSize = statSync(video.files[0]).size;

  await page.getByTestId('mode-audio').click();
  await until(page, (s) => s.mode === 'audio' && s.selected !== null);
  await page.getByTestId('grab').click();
  s = await until(page, (s) => ['done', 'error'].includes(find(s, 'MP3')?.status ?? ''), 120_000);
  const audio = find(s, 'MP3')!;
  expect(audio.status, audio.label).toBe('done');
  expect(audio.files[0]).toMatch(/mov_bbb\.mp3$/);
  expect(statSync(video.files[0]).size, 'the earlier video must be untouched').toBe(videoSize);
});

test('a silent video explains there is no sound to grab', async ({ page }) => {
  await open(page);
  await dealUrl(page, 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  await until(page, (s) => s.phase === 'dealt', 90_000);
  await page.getByTestId('mode-audio').click();
  await until(page, (s) => s.mode === 'audio' && s.selected !== null);
  await page.getByTestId('grab').click();
  const s = await until(page, (s) => s.jobs.some((j) => j.summary.startsWith('MP3') && j.status === 'error'), 120_000);
  expect(s.jobs.find((j) => j.summary.startsWith('MP3'))!.label).toBe("There's no sound in this one.");
});

test('SoundCloud track: audio-only table, MP3 at 192K', async ({ page }) => {
  await open(page);
  await dealUrl(page, 'https://soundcloud.com/forss/flickermood');
  const s = await until(page, (s) => s.phase === 'dealt' || s.phase === 'error', 90_000);
  expect(s.phase, JSON.stringify(s.error)).toBe('dealt');
  expect(s.mode).toBe('audio');
  await clickCard(page, 'a-192');
  await until(page, (s) => s.selected === 'a-192');
  await page.getByTestId('grab').click();
  // The server keeps earlier jobs: find this one by title.
  const mine = (s: { jobs: { title: string; status: string }[] }) => s.jobs.find((j) => j.title === 'Flickermood');
  const done = await until(page, (s) => ['done', 'error'].includes(mine(s)?.status ?? ''), 180_000);
  const job = done.jobs.find((j) => j.title === 'Flickermood')!;
  expect(job.status, job.label).toBe('done');
  const file = job.files[0];
  expect(file).toMatch(/\.mp3$/);
  expect(statSync(file).size).toBeGreaterThan(3_000_000);
});

test('the cut: an exact clip of a direct video, the length asked for', async ({ page }) => {
  await open(page);
  await dealUrl(page, 'https://www.w3schools.com/html/mov_bbb.mp4');
  const s = await until(page, (s) => s.phase === 'dealt' || s.phase === 'error', 90_000);
  expect(s.phase, JSON.stringify(s.error)).toBe('dealt');
  expect(s.cut.available, 'ffprobe gives direct links a length, so they can be cut').toBe(true);
  // Earlier tests leave the table in AUDIO (a remembered setting).
  await page.getByTestId('mode-video').click();
  await until(page, (s) => s.mode === 'video' && s.selected !== null);
  await page.getByTestId('cut-toggle').click();
  await typeTime(page, 'in', '2');
  await typeTime(page, 'out', '5.5');
  await until(page, (s) => s.cut.active?.start === 2 && s.cut.active?.end === 5.5);
  await page.getByTestId('grab').click();
  const mine = (s: { jobs: { cut: { start: number } | null; status: string }[] }) => s.jobs.find((j) => j.cut?.start === 2);
  const done = await until(page, (s) => ['done', 'error'].includes(mine(s)?.status ?? ''), 120_000);
  const job = done.jobs.find((j) => j.cut?.start === 2)!;
  expect(job.status, job.label).toBe('done');
  expect(job.files[0]).toMatch(/mov_bbb \(2s-5\.5s\)\.mp4$/);
  const f = probeFile(job.files[0]);
  expect(Math.abs(f.duration - 3.5), `clip is ${f.duration}s`).toBeLessThan(0.1);
  expect(f.codecs).toContain('h264');
});

test('the cut: a SoundCloud track becomes an MP3 of the length asked for', async ({ page }) => {
  await open(page);
  await dealUrl(page, 'https://soundcloud.com/forss/flickermood');
  const s = await until(page, (s) => s.phase === 'dealt' || s.phase === 'error', 90_000);
  expect(s.phase, JSON.stringify(s.error)).toBe('dealt');
  await page.getByTestId('cut-toggle').click();
  await typeTime(page, 'in', '0:30');
  await typeTime(page, 'out', '0:45');
  await clickCard(page, 'a-192');
  await until(page, (s) => s.selected === 'a-192' && s.cut.active?.end === 45);
  await page.getByTestId('grab').click();
  const mine = (s: { jobs: { cut: { start: number } | null; status: string }[] }) => s.jobs.find((j) => j.cut?.start === 30);
  const done = await until(page, (s) => ['done', 'error'].includes(mine(s)?.status ?? ''), 180_000);
  const job = done.jobs.find((j) => j.cut?.start === 30)!;
  expect(job.status, job.label).toBe('done');
  expect(job.files[0]).toMatch(/Flickermood \(30s-45s\)\.mp3$/);
  const f = probeFile(job.files[0]);
  expect(Math.abs(f.duration - 15), `clip is ${f.duration}s`).toBeLessThan(0.15);
  expect(f.codecs).toContain('mp3');
});
