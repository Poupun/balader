// The shipped bundle (dist/) under the exact Content-Security-Policy the
// desktop app enforces. Catches things the dev server never shows: a blocked
// font, an inline script, a forbidden fetch.
// Run: npm run build && npx playwright test --project=prod

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dealUrl, until, URLS } from './helpers';

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const CSP: string = conf.app.security.csp;

test('the production bundle runs under the app CSP', async ({ page }) => {
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/content security policy|refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = CSP;
    await route.fulfill({ response: res, headers });
  });

  await page.goto('/?backend=mock&dev=0&timescale=8');
  await page.waitForFunction(() => (window as unknown as { __balader?: { snapshot(): { ready: boolean } } }).__balader?.snapshot().ready === true);
  // Fonts are bundled, so they must load under font-src 'self'.
  expect(await page.evaluate(() => document.fonts.check('20px "Jersey 15"'))).toBe(true);
  await dealUrl(page, URLS.youtube);
  await until(page, (s) => s.phase === 'dealt');
  // The cut: storyboard sheets come in as data URLs and are drawn on canvases.
  await page.getByTestId('cut-toggle').click();
  await page.getByTestId('cut-in-later').click();
  const film = (await page.getByTestId('cut-film').boundingBox())!;
  await page.mouse.move(film.x + film.width / 2, film.y + film.height / 2);
  await expect(page.getByTestId('cut-bubble')).toHaveClass(/has-frame/);
  await until(page, (s) => s.cut.active !== null);
  await page.getByTestId('grab').click();
  await until(page, (s) => s.jobs[0]?.status === 'done', 20_000);
  await page.screenshot({ path: 'tests/e2e/.output/shots/prod-csp.png' });

  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});
