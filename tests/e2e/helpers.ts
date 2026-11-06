import { expect, type Page } from '@playwright/test';

/** Shape returned by window.__balader.snapshot() (see src/testing/testapi.ts). */
export interface Snap {
  ready: boolean;
  backend: string;
  phase: string;
  url: string;
  mode: string;
  container: string;
  audioFormat: string;
  selected: string | null;
  cards: { key: string; big: string; name: string; size: string; summary: string; selected: boolean }[];
  probe: { kind: string; title: string } | null;
  error: { code: string; message: string; hint: string | null } | null;
  jobs: { id: string; status: string; stage: string; label: string; progress: number; title: string; summary: string; files: string[] }[];
  history: number;
  engine: { ready: boolean; components: { id: string; state: string; version: string | null }[] } | null;
  modal: string | null;
  pileTab: string;
  settings: Record<string, unknown> | null;
}

export const URLS = {
  youtube: 'https://www.youtube.com/watch?v=0cEaNw4vEs0',
  tiktok: 'https://www.tiktok.com/@packlight/video/7300000000000000000',
  soundcloud: 'https://soundcloud.com/forss/flickermood',
  archive: 'https://archive.org/details/BigBuckBunny_124',
  playlist: 'https://www.youtube.com/playlist?list=PLbalader0001',
  scrape: 'https://example.com/scrape/42',
  bot: 'https://www.youtube.com/watch?v=bot',
  unsupported: 'https://example.com/nothing',
  fail: 'https://www.youtube.com/watch?v=fail',
};

/**
 * Open the app on the mock backend. `timescale` speeds up the simulated
 * downloads; `freeze` settles every animation (stable screenshots).
 */
export async function openApp(page: Page, opts: { query?: string; timescale?: number; freeze?: boolean } = {}): Promise<void> {
  const q = new URLSearchParams({ backend: 'mock', dev: '0', seed: '7', timescale: String(opts.timescale ?? 6) });
  if (opts.freeze) q.set('freeze', '1');
  await page.goto(`/?${q}${opts.query ? `&${opts.query}` : ''}`);
  await page.waitForFunction(() => (window as unknown as { __balader?: { snapshot(): { ready: boolean } } }).__balader?.snapshot().ready === true);
  // The CRT power-on scales the whole window for ~0.8 s: let it finish.
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
}

export function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => (window as unknown as { __balader: { snapshot(): Snap } }).__balader.snapshot());
}

/** Poll the snapshot until the predicate (a JS expression over `s`) is true. */
export async function until(page: Page, predicate: (s: Snap) => boolean, timeout = 15_000): Promise<Snap> {
  let last: Snap | null = null;
  await expect
    .poll(
      async () => {
        last = await snap(page);
        return predicate(last);
      },
      { timeout, intervals: [50, 100, 200] },
    )
    .toBe(true);
  return last!;
}

export async function dealUrl(page: Page, url: string): Promise<void> {
  await page.getByTestId('url-input').fill(url);
  await page.getByTestId('url-input').press('Enter');
}

export const tid = (page: Page, id: string) => page.getByTestId(id);

/**
 * Cards overlap like a real hand, and a lifted card covers its neighbours.
 * Find a point where this card is really on top (like a person would aim)
 * and use the real mouse there.
 */
export async function cardPoint(page: Page, key: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((key) => {
    const el = document.querySelector(`[data-testid="card-${key}"]`);
    const face = el?.querySelector('.card__face');
    if (!el || !face) return null;
    const r = face.getBoundingClientRect();
    for (const fy of [0.3, 0.45, 0.6, 0.75, 0.15, 0.9]) {
      for (const fx of [0.12, 0.25, 0.4, 0.55, 0.7, 0.85]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit)) return { x, y };
      }
    }
    return null;
  }, key);
  if (!p) throw new Error(`card ${key} is not visible anywhere`);
  return p;
}

export async function hoverCard(page: Page, key: string): Promise<void> {
  const p = await cardPoint(page, key);
  await page.mouse.move(p.x, p.y, { steps: 4 });
}

export async function clickCard(page: Page, key: string, opts: { double?: boolean } = {}): Promise<void> {
  await hoverCard(page, key);
  await page.waitForTimeout(60);
  const p = await cardPoint(page, key);
  if (opts.double) await page.mouse.dblclick(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}
