// The cut: grabbing only part of a video or track. Driven like a person
// would (mouse on the handles, typing, keys, the wheel) on the mock backend.

import { expect, test, type Page } from '@playwright/test';
import { dealUrl, openApp, snap, until, URLS } from './helpers';

const mock = <T>(page: Page, fn: string) =>
  page.evaluate((f) => {
    const m = (window as unknown as { __balader: { mock: Record<string, unknown> } }).__balader.mock;
    return new Function('m', `return (${f})(m)`)(m);
  }, fn) as Promise<T>;

type Req = { cut: { start: number; end: number; exact: boolean } | null };
const lastRequest = (page: Page) => mock<Req>(page, '(m) => m.lastRequest');
const lastSound = (page: Page) => page.evaluate(() => (window as unknown as { __balader: { sfxLog(): string[] } }).__balader.sfxLog().slice(-4));

async function dealYoutube(page: Page): Promise<void> {
  await openApp(page, { timescale: 12 });
  await dealUrl(page, URLS.youtube);
  await until(page, (s) => s.phase === 'dealt');
}

async function openCut(page: Page): Promise<void> {
  await page.getByTestId('cut-toggle').click();
  await until(page, (s) => s.cut.on);
  await expect(page.getByTestId('cut')).toBeVisible();
}

async function typeTime(page: Page, which: 'in' | 'out', text: string, key = 'Enter'): Promise<void> {
  await page.getByTestId(`cut-${which}-value`).click();
  await page.getByTestId(`cut-${which}-input`).fill(text);
  await page.keyboard.press(key);
}

/** Grab something with the real mouse and drag it sideways. */
async function dragBy(page: Page, testid: string, dx: number): Promise<void> {
  const box = (await page.getByTestId(testid).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test.describe('the cut', () => {
  test('dragging the handles cuts, the grab carries it, the clip is named after it', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    let s = await snap(page);
    expect(s.cut.active, 'opening alone cuts nothing').toBeNull();
    await expect(page.getByTestId('betslip-cut')).toBeHidden();

    await dragBy(page, 'cut-handle-in', 120);
    await dragBy(page, 'cut-handle-out', -150);
    s = await until(page, (s) => s.cut.active !== null && s.cut.start > 60 && s.cut.end < 700);
    const cut = s.cut.active!;
    await expect(page.getByTestId('betslip-cut')).toBeVisible();
    expect(await page.getByTestId('cut').getAttribute('data-start')).toBe(String(cut.start));

    await page.getByTestId('grab').click();
    const done = await until(page, (s) => s.jobs[0]?.status === 'done', 20_000);
    expect((await lastRequest(page)).cut).toEqual(cut);
    expect(done.jobs[0].cut).toEqual(cut);
    expect(done.jobs[0].files[0]).toMatch(/Golden Hour - Relaxing 4K Nature Film \(\d+m\d\ds-\d+m\d\ds\)\.mp4$/);
    await expect(page.getByTestId('job-cut').first()).toBeVisible();
  });

  test('typing exact times', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    await typeTime(page, 'in', '2:05.5');
    await until(page, (s) => s.cut.start === 125.5);
    await typeTime(page, 'out', '2m40');
    await until(page, (s) => s.cut.end === 160);
    await expect(page.getByTestId('cut-length')).toHaveText('34.5s');
    await expect(page.getByTestId('cut-in-value')).toHaveText('2:05.5');

    // Nonsense is refused with a buzz; nothing moves.
    await typeTime(page, 'in', 'soon');
    await expect(page.getByTestId('cut-in-value')).toHaveText('2:05.5');
    expect(await lastSound(page)).toContain('error');

    // Escape gives up the edit.
    await typeTime(page, 'out', '9:00', 'Escape');
    await expect(page.getByTestId('cut-out-value')).toHaveText('2:40.0');

    // A start after the end takes the end along (same clip length).
    await typeTime(page, 'in', '5:00');
    const s = await until(page, (s) => s.cut.start === 300);
    expect(s.cut.end).toBe(334.5);

    // Past the end of the video: clamped.
    await typeTime(page, 'out', '99:00');
    await until(page, (s) => s.cut.end === 754);
  });

  test('nudge buttons, handle keys and the wheel', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    await page.getByTestId('cut-in-later').click();
    await until(page, (s) => s.cut.start === 1);
    await page.getByTestId('cut-in-later').click({ modifiers: ['Shift'] });
    await until(page, (s) => s.cut.start === 1.1);

    await page.getByTestId('cut-handle-in').focus();
    await page.keyboard.press('ArrowRight');
    await until(page, (s) => s.cut.start === 2.1);
    await page.keyboard.press('Shift+ArrowRight');
    await until(page, (s) => s.cut.start === 2.2);
    await page.keyboard.press('Alt+ArrowRight');
    await until(page, (s) => s.cut.start === 12.2);
    await page.keyboard.press('Home');
    await until(page, (s) => s.cut.start === 0);

    await page.getByTestId('cut-handle-out').focus();
    await page.keyboard.press('ArrowLeft');
    await until(page, (s) => s.cut.end === 753);
    await page.keyboard.press('End');
    await until(page, (s) => s.cut.end === 754);

    // The wheel over a time field nudges it (down = earlier).
    await page.getByTestId('cut-out-value').hover();
    await page.mouse.wheel(0, 120);
    await until(page, (s) => s.cut.end === 753);

    // Before zero: a bump, no move.
    await page.getByTestId('cut-in-earlier').click();
    expect((await snap(page)).cut.start).toBe(0);
  });

  test('dragging the window keeps its length', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    await typeTime(page, 'in', '100');
    await typeTime(page, 'out', '200');
    await until(page, (s) => s.cut.start === 100 && s.cut.end === 200);
    await dragBy(page, 'cut-range', 70);
    const s = await until(page, (s) => s.cut.start > 100);
    expect(s.cut.end - s.cut.start).toBeCloseTo(100, 3);
  });

  test('fast or exact is remembered; audio cuts are always exact', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    await expect(page.getByTestId('cut-exact')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('cut-fast').click();
    await until(page, (s) => s.settings?.exactCuts === false);
    await expect(page.getByTestId('cut-fast')).toHaveAttribute('aria-checked', 'true');
    await typeTime(page, 'in', '10');
    await page.getByTestId('grab').click();
    await until(page, (s) => s.jobs.length === 1);
    expect((await lastRequest(page)).cut).toEqual({ start: 10, end: 754, exact: false });

    await page.getByTestId('mode-audio').click();
    await expect(page.getByTestId('cut-modes')).toBeHidden();
    await expect(page.getByTestId('cut-audio-note')).toBeVisible();
    expect((await snap(page)).cut.active?.exact).toBe(true);
  });

  test('cards shrink to the clip; closing brings the whole thing back', async ({ page }) => {
    await dealYoutube(page);
    const whole = (await snap(page)).cards.find((c) => c.key === 'v1080')!.size;
    await openCut(page);
    await typeTime(page, 'out', '1:15.4');
    await until(page, (s) => s.cards.find((c) => c.key === 'v1080')!.size === '~40.8 MB');
    await expect(page.getByTestId('card-v1080').locator('.card__size')).toHaveText('~40.8 MB');
    await expect(page.locator('.thumb__badge')).toContainText('1m 15s');

    await page.getByTestId('cut-close').click();
    await until(page, (s) => !s.cut.on && s.cut.active === null && s.cards.find((c) => c.key === 'v1080')!.size === whole);
    await expect(page.getByTestId('cut')).toBeHidden();
    await expect(page.locator('.thumb__badge')).toHaveText('12:34');
    await page.getByTestId('grab').click();
    await until(page, (s) => s.jobs.length === 1);
    expect((await lastRequest(page)).cut).toBeNull();

    // Reopening remembers the range for this video.
    await page.getByTestId('cut-toggle').click();
    expect((await until(page, (s) => s.cut.on)).cut.active).toEqual({ start: 0, end: 75.4, exact: true });
  });

  test('the filmstrip shows real frames and hovering previews any moment', async ({ page }) => {
    await dealYoutube(page);
    await openCut(page);
    // The mock's storyboard sheets are painted golden-hour frames: the strip can't stay dark.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = document.querySelector('[data-testid="cut-film"]') as HTMLCanvasElement;
          const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
          return sum / (px.length / 4) / 3;
        }),
      )
      .toBeGreaterThan(50);

    const film = (await page.getByTestId('cut-film').boundingBox())!;
    await page.mouse.move(film.x + film.width * 0.25, film.y + film.height / 2);
    await expect(page.getByTestId('cut-bubble')).toHaveClass(/is-on/);
    await expect(page.getByTestId('cut-bubble')).toHaveClass(/has-frame/);
    const label = (await page.getByTestId('cut-bubble-time').textContent()) ?? '';
    const [m, sec] = label.split(':').map(Number);
    expect(Math.abs(m * 60 + sec - 754 * 0.25)).toBeLessThan(3);
    await page.mouse.move(film.x + film.width * 0.25, film.y - 120);
    await expect(page.getByTestId('cut-bubble')).not.toHaveClass(/is-on/);
  });

  test('no cut for playlists; C toggles it; a new link starts whole', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.playlist);
    await until(page, (s) => s.phase === 'dealt');
    await expect(page.getByTestId('cut-toggle')).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('c');
    expect((await snap(page)).cut.on).toBe(false);

    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt' && s.cut.available);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('c');
    await until(page, (s) => s.cut.on);
    await typeTime(page, 'in', '30');
    await until(page, (s) => s.cut.start === 30);

    await dealUrl(page, URLS.tiktok);
    const s = await until(page, (s) => s.phase === 'dealt' && s.probe?.title.includes('carry-on') === true);
    expect(s.cut).toMatchObject({ on: false, start: 0, end: 31, active: null });
    await expect(page.getByTestId('cut-toggle')).toBeVisible();
  });
});
