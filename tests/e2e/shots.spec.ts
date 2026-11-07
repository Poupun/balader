// @shots: a visual tour of every state, written to tests/e2e/.output/shots/.
// Not assertions: these PNGs are for eyes (yours or an agent's) to review.
// Run: npm run test:shots

import { test, type Page } from '@playwright/test';
import { clickCard, dealUrl, hoverCard, openApp, until, URLS } from './helpers';

const DIR = 'tests/e2e/.output/shots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${DIR}/${name}.png` });

test.describe('@shots', () => {
  test('01 empty table', async ({ page }) => {
    await openApp(page, { freeze: true });
    await shot(page, '01-empty');
  });

  test('02 dealing (mid-animation)', async ({ page }) => {
    await openApp(page, { timescale: 1 });
    await dealUrl(page, URLS.youtube);
    await page.waitForTimeout(500);
    await shot(page, '02a-probing');
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(380);
    await shot(page, '02b-dealing');
    await page.waitForTimeout(1600);
    await shot(page, '02c-dealt-live');
  });

  test('03 dealt video hand', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(300);
    await shot(page, '03-dealt-video');
    await hoverCard(page, 'v720');
    await page.waitForTimeout(200);
    await shot(page, '03b-hover-720');
  });

  test('04 audio hand', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('mode-audio').click();
    await page.waitForTimeout(300);
    await shot(page, '04-audio-mp3');
    await page.getByTestId('audio-format-next').click();
    await page.waitForTimeout(300);
    await shot(page, '04b-audio-m4a');
  });

  test('05 tiktok + soundcloud + archive', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.tiktok);
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(300);
    await shot(page, '05a-tiktok');
    await dealUrl(page, URLS.soundcloud);
    await until(page, (s) => s.phase === 'dealt' && s.mode === 'audio');
    await page.waitForTimeout(300);
    await shot(page, '05b-soundcloud');
    // VIDEO is disabled while an audio-only link is on the table: deal first, then switch.
    await dealUrl(page, URLS.archive);
    await until(page, (s) => s.phase === 'dealt' && s.probe?.title === 'Big Buck Bunny');
    await page.getByTestId('mode-video').click();
    await until(page, (s) => s.mode === 'video' && s.cards.length === 3);
    await page.waitForTimeout(300);
    await shot(page, '05c-archive');
  });

  test('06 playlist + scraped', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.playlist);
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(300);
    await shot(page, '06a-playlist');
    await dealUrl(page, URLS.scrape);
    await until(page, (s) => s.phase === 'dealt' && s.probe?.kind === 'sniffed');
    await page.waitForTimeout(300);
    await shot(page, '06b-scraped');
  });

  test('07 errors', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.bot);
    await until(page, (s) => s.phase === 'error');
    await page.waitForTimeout(300);
    await shot(page, '07a-bust-botcheck');
    await dealUrl(page, 'not a link');
    await until(page, (s) => s.error?.code === 'invalid_url');
    await shot(page, '07b-invalid');
  });

  test('08 downloads in the pile', async ({ page }) => {
    await openApp(page, { timescale: 2 });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(1500);
    await page.getByTestId('grab').click();
    await clickCard(page, 'v480');
    await page.getByTestId('grab').click();
    await until(page, (s) => s.jobs.some((j) => j.status === 'downloading' && j.progress > 0.3), 20_000);
    await shot(page, '08a-downloading');
    await until(page, (s) => s.jobs.some((j) => j.status === 'done'), 30_000);
    await page.waitForTimeout(250);
    await shot(page, '08b-jackpot');
  });

  test('09 modals', async ({ page }) => {
    await openApp(page, { freeze: true });
    await page.getByTestId('open-settings').click();
    await page.waitForTimeout(200);
    await shot(page, '09a-settings');
    await page.keyboard.press('Escape');
    await page.getByTestId('engine-chip').click();
    await page.waitForTimeout(200);
    await shot(page, '09b-engine-ready');
  });

  test('10 first run (engine missing)', async ({ page }) => {
    await openApp(page, { freeze: true, query: 'engine=missing' });
    await until(page, (s) => s.modal === 'engine');
    await page.waitForTimeout(200);
    await shot(page, '10a-engine-missing');
    await page.getByTestId('engine-install').click();
    await page.waitForTimeout(700);
    await shot(page, '10b-engine-installing');
  });

  test('11 narrow window + history', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 680 });
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.waitForTimeout(300);
    await shot(page, '11a-narrow');
    await page.getByTestId('pile-toggle').click();
    await page.getByTestId('tab-done').click();
    await page.waitForTimeout(300);
    await shot(page, '11b-narrow-pile-done');
  });

  test('12 the cut', async ({ page }) => {
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('cut-toggle').click();
    await page.evaluate(() => (window as unknown as { __balader: { actions: { setCut(a: number, b: number): void } } }).__balader.actions.setCut(125, 160.5));
    await page.waitForTimeout(400);
    await shot(page, '12a-cut-video');
    // Drag the OUT handle: the frame card pops above it.
    const box = (await page.getByTestId('cut-handle-out').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(300);
    await shot(page, '12b-cut-dragging');
    await page.mouse.up();
    await page.getByTestId('cut-in-value').click();
    await page.keyboard.type('2:00.5');
    await shot(page, '12c-cut-typing');
    await page.keyboard.press('Enter');
    await page.getByTestId('mode-audio').click();
    await page.waitForTimeout(300);
    await shot(page, '12d-cut-audio');
    await dealUrl(page, URLS.soundcloud);
    await until(page, (s) => s.phase === 'dealt' && s.mode === 'audio');
    await page.getByTestId('cut-toggle').click();
    await page.evaluate(() => (window as unknown as { __balader: { actions: { setCut(a: number, b: number): void } } }).__balader.actions.setCut(30, 95));
    await page.waitForTimeout(300);
    await shot(page, '12e-cut-soundcloud');
  });

  test('13 narrow window with the cut', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 640 });
    await openApp(page, { freeze: true });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('cut-toggle').click();
    await page.evaluate(() => (window as unknown as { __balader: { actions: { setCut(a: number, b: number): void } } }).__balader.actions.setCut(61.2, 74));
    await page.waitForTimeout(400);
    await shot(page, '13-cut-narrow');
  });

  test('14 a cut in the pile', async ({ page }) => {
    await openApp(page, { timescale: 0.6 });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('cut-toggle').click();
    await page.evaluate(() => (window as unknown as { __balader: { actions: { setCut(a: number, b: number): void } } }).__balader.actions.setCut(125, 160.5));
    await page.getByTestId('grab').click();
    await until(page, (s) => s.jobs[0]?.stage === 'cut' && s.jobs[0].progress > 0.2, 20_000);
    await page.getByTestId('pile').screenshot({ path: `${DIR}/14-cut-in-pile.png` });
  });
});
