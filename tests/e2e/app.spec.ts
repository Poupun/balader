// Functional end-to-end tests on the mock backend. Runs in WebKit (≈ macOS
// app) and Chromium (≈ Windows app): `npm run test:e2e`.

import { expect, test, type Page } from '@playwright/test';
import { clickCard, dealUrl, openApp, snap, until, URLS } from './helpers';

const mock = <T>(page: Page, fn: string) =>
  page.evaluate((f) => {
    const m = (window as unknown as { __balader: { mock: Record<string, unknown> } }).__balader.mock;
    return new Function('m', `return (${f})(m)`)(m);
  }, fn) as Promise<T>;

test.describe('boot', () => {
  test('starts on an empty table with the engine ready', async ({ page }) => {
    await openApp(page);
    const s = await until(page, (s) => s.engine?.ready === true);
    expect(s.phase).toBe('idle');
    expect(s.history).toBe(2);
    await expect(page.getByTestId('engine-chip')).toContainText('ENGINE OK');
    await expect(page.getByTestId('deck-headline')).toContainText('Drop a link');
    await expect(page.getByTestId('grab')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('count-done')).toHaveText('2');
  });

  test('every interactive element has a test id', async ({ page }) => {
    await openApp(page);
    const missing = await page.evaluate(() =>
      [...document.querySelectorAll('button, input, [role=button], [role=switch], [role=slider]')]
        .filter((e) => !e.closest('[data-testid]'))
        .map((e) => e.outerHTML.slice(0, 80)),
    );
    expect(missing).toEqual([]);
  });
});

test.describe('dealing', () => {
  test('deals one card per tier and suggests 1080p', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.youtube);
    const s = await until(page, (s) => s.phase === 'dealt');
    expect(s.cards.map((c) => c.key)).toEqual(['v2160', 'v1440', 'v1080', 'v720', 'v480', 'v360', 'v240', 'v144']);
    expect(s.selected).toBe('v1080');
    await expect(page.getByTestId('media-title')).toContainText('Ocean Waves');
    await expect(page.getByTestId('betslip-title')).toHaveText('1080p60 · H.264 → MP4');
    await expect(page.getByTestId('grab')).toHaveAttribute('aria-disabled', 'false');
  });

  test('MKV flips the faces to original codecs', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('container-next').click();
    const s = await until(page, (s) => s.container === 'mkv');
    expect(s.cards.find((c) => c.key === 'v1080')?.summary).toBe('1080p60 · AV1 → MKV');
    expect(s.selected).toBe('v1080');
    await expect(page.getByTestId('betslip-title')).toHaveText('1080p60 · AV1 → MKV');
  });

  test('switching a stepper fast never stacks labels', async ({ page }) => {
    // Regression: fast clicks left the previous label on screen (MP4 over MKV).
    await openApp(page, { timescale: 1 });
    for (let i = 0; i < 7; i++) await page.getByTestId('container-next').click({ force: true });
    await expect.poll(() => page.getByTestId('container-value').locator('span').count(), { timeout: 2000 }).toBe(1);
    const s = await snap(page);
    expect(s.container).toBe('mkv');
    await expect(page.getByTestId('container-value')).toHaveText('MKV');
  });

  test('audio mode deals bitrates, M4A deals the source tracks', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('mode-audio').click();
    let s = await until(page, (s) => s.mode === 'audio');
    expect(s.cards.map((c) => c.big)).toEqual(['V0', '320', '256', '192', '128']);
    await page.getByTestId('audio-format-next').click();
    s = await until(page, (s) => s.audioFormat === 'm4a');
    expect(s.cards.map((c) => c.key)).toEqual(['a-m4a-140', 'a-m4a-139']);
    expect(s.selected).toBe('a-m4a-140');
  });

  test('audio-only links lock the table to AUDIO', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.soundcloud);
    const s = await until(page, (s) => s.phase === 'dealt');
    expect(s.mode).toBe('audio');
    await page.getByTestId('mode-video').click();
    await page.waitForTimeout(150);
    expect((await snap(page)).mode).toBe('audio');
  });

  test('keyboard: digits pick, arrows move, Escape folds', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('url-input').blur();
    await page.keyboard.press('1');
    await until(page, (s) => s.selected === 'v2160');
    await page.keyboard.press('ArrowRight');
    await until(page, (s) => s.selected === 'v1440');
    await page.keyboard.press('a');
    await until(page, (s) => s.mode === 'audio');
    await page.keyboard.press('Escape');
    await until(page, (s) => s.phase === 'idle' && s.cards.length === 0);
  });

  test('PASTE deals whatever link is on the clipboard', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('paste').click();
    await until(page, (s) => s.phase === 'dealt');
  });

  test('a non-link shakes the slot and says why', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, 'definitely not a link');
    const s = await until(page, (s) => s.phase === 'error');
    expect(s.error?.code).toBe('invalid_url');
    await expect(page.getByTestId('bust-message')).toHaveText("That doesn't look like a link.");
  });
});

test.describe('grabbing', () => {
  test('GRAB IT! runs the job all the way to the stash', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('grab').click();
    let s = await until(page, (s) => s.jobs.length === 1);
    const id = s.jobs[0].id;
    expect(s.jobs[0].summary).toBe('1080p60 · MP4');
    s = await until(page, (s) => s.jobs[0].status === 'done', 20_000);
    expect(s.jobs[0].files[0]).toMatch(/Ocean Waves.*\.mp4$/);
    expect(s.history).toBe(3);
    await expect(page.getByTestId('toast-done')).toBeVisible();
    await page.getByTestId(`job-open-${id}`).click();
    const opened = await mock<string[]>(page, '(m) => m.opened');
    expect(opened.some((o) => o.startsWith('open:') && o.endsWith('.mp4'))).toBe(true);
  });

  test('the request sent to the core is the one the card promised', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('container-next').click();
    await clickCard(page, 'v720');
    await until(page, (s) => s.selected === 'v720');
    await page.getByTestId('grab').click();
    await until(page, (s) => s.jobs.length === 1);
    const req = await mock<Record<string, unknown>>(page, "(m) => m.calls.filter((c) => c.cmd === 'start_download').at(-1).args.request");
    expect(req).toMatchObject({ mode: 'video', tier: 720, container: 'mkv', videoId: '398', audioId: '251', combined: false, pickVcodec: 'AV1' });
    expect(req.url).toBe(URLS.youtube);
  });

  test('cancel folds a running job, retry deals it again', async ({ page }) => {
    await openApp(page, { timescale: 1 });
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('grab').click();
    const s = await until(page, (s) => s.jobs[0]?.status === 'downloading');
    await page.getByTestId(`job-cancel-${s.jobs[0].id}`).click();
    await until(page, (s) => s.jobs[0].status === 'cancelled');
    await page.getByTestId(`job-retry-${s.jobs[0].id}`).click();
    await until(page, (s) => ['queued', 'starting', 'downloading'].includes(s.jobs[0].status));
  });

  test('a download that dies busts with a reason', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.fail);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('grab').click();
    const s = await until(page, (s) => s.jobs[0]?.status === 'error', 20_000);
    expect(s.jobs[0].label).toContain("Couldn't reach");
    await expect(page.getByTestId('toast-error')).toBeVisible();
    await expect(page.getByTestId(`job-retry-${s.jobs[0].id}`)).toBeVisible();
  });

  test('double-clicking a card grabs it on the spot', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.tiktok);
    await until(page, (s) => s.phase === 'dealt');
    await clickCard(page, 'v720', { double: true });
    const s = await until(page, (s) => s.jobs.length === 1);
    expect(s.jobs[0].summary).toBe('720p · MP4');
  });

  test('the parallel limit queues extra grabs', async ({ page }) => {
    await openApp(page, { timescale: 0.5 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('set-parallel-prev').click();
    await until(page, (s) => s.settings?.maxConcurrent === 1);
    await page.keyboard.press('Escape');
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.phase === 'dealt');
    await page.getByTestId('grab').click();
    await clickCard(page, 'v480');
    await page.getByTestId('grab').click();
    // One running, one waiting in line.
    const s = await until(page, (s) => s.jobs.length === 2 && s.jobs.filter((j) => j.status === 'queued').length === 1);
    expect(s.jobs.filter((j) => ['starting', 'downloading'].includes(j.status))).toHaveLength(1);
  });
});

test.describe('errors', () => {
  test('a bot check offers the cookies setting', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.bot);
    const s = await until(page, (s) => s.phase === 'error');
    expect(s.error?.code).toBe('bot_check');
    await page.getByTestId('bust-settings').click();
    await until(page, (s) => s.modal === 'settings');
    await expect(page.getByTestId('set-cookies-value')).toHaveText('OFF');
  });

  test('unsupported pages explain the scraper tried too', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.unsupported);
    await until(page, (s) => s.error?.code === 'unsupported');
    await expect(page.getByTestId('bust-hint')).toContainText('scraped the page');
  });
});

test.describe('engine room', () => {
  test('first run opens the engine room and installs everything', async ({ page }) => {
    await openApp(page, { query: 'engine=missing', timescale: 8 });
    await until(page, (s) => s.modal === 'engine');
    await expect(page.getByTestId('engine-chip')).toContainText('SET UP ENGINE');
    await page.getByTestId('engine-install').click();
    await until(page, (s) => s.engine?.ready === true && s.engine.components.every((c) => c.state === 'ready'), 20_000);
    await expect(page.getByTestId('toast-engine')).toBeVisible();
    await page.getByTestId('engine-done').click();
    await until(page, (s) => s.modal === null);
  });

  test('dealing without an engine sends you to the engine room', async ({ page }) => {
    await openApp(page, { query: 'engine=missing' });
    await until(page, (s) => s.modal === 'engine');
    await page.keyboard.press('Escape');
    await dealUrl(page, URLS.youtube);
    await until(page, (s) => s.modal === 'engine');
  });
});

test.describe('settings', () => {
  test('feel toggles apply at once and reach the core', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('set-crt').click();
    await expect(page.locator('body')).toHaveClass(/no-crt/);
    await expect.poll(() => mock<boolean>(page, '(m) => m.settings.crt'), { timeout: 3000 }).toBe(false);
    await page.getByTestId('set-cookies-next').click();
    await until(page, (s) => s.settings?.cookiesBrowser === 'chrome');
  });

  test('the HUD folder button opens the save folder', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('folder-name').click();
    await expect.poll(() => mock<string[]>(page, '(m) => m.opened')).toContain('open:/Users/you/Downloads/Balader');
  });
});

test.describe('playlists and scraping', () => {
  test('playlist cards grab the whole list', async ({ page }) => {
    await openApp(page, { timescale: 12 });
    await dealUrl(page, URLS.playlist);
    const s = await until(page, (s) => s.phase === 'dealt');
    expect(s.cards[0].key).toBe('pv0');
    await page.getByTestId('grab').click();
    const done = await until(page, (s) => s.jobs[0]?.status === 'done', 25_000);
    expect(done.jobs[0].summary).toContain('PLAYLIST ×24');
    expect(done.jobs[0].files.length).toBeGreaterThan(1);
  });

  test('a scraped page deals one card per media file', async ({ page }) => {
    await openApp(page);
    await dealUrl(page, URLS.scrape);
    const s = await until(page, (s) => s.phase === 'dealt');
    expect(s.probe?.kind).toBe('sniffed');
    expect(s.cards.map((c) => c.big)).toEqual(['MP4', 'M3U8', 'MP3']);
  });
});
