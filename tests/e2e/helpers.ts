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
  cut: { on: boolean; start: number; end: number; available: boolean; active: { start: number; end: number; exact: boolean } | null };
  cards: { key: string; big: string; name: string; size: string; summary: string; selected: boolean }[];
  probe: { kind: string; title: string } | null;
  error: { code: string; message: string; hint: string | null } | null;
  jobs: { id: string; status: string; stage: string; label: string; progress: number; title: string; summary: string; cut: { start: number; end: number; exact: boolean } | null; files: string[] }[];
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
export async function cardPoint(page: Page, key: string, timeout = 4000): Promise<{ x: number; y: number }> {
  // Cards may still be flying in (slow time scales): wait like a person would.
  const deadline = Date.now() + timeout;
  for (;;) {
    const p = await visiblePoint(page, key);
    if (p) return p;
    if (Date.now() > deadline) throw new Error(`card ${key} is not visible anywhere`);
    await page.waitForTimeout(50);
  }
}

async function visiblePoint(page: Page, key: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((key) => {
    const el = document.querySelector(`[data-testid="card-${key}"]`);
    const face = el?.querySelector('.card__face');
    if (!el || !face) return null;
    const r = face.getBoundingClientRect();
    const on = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && el.contains(hit);
    };
    // Aim well inside what shows, never at its edge: cards bob and lift, and
    // a click that slips onto the picked neighbour unpicks it.
    const ring = [[-14, 0], [14, 0], [0, -14], [0, 14], [-28, 0], [28, 0], [0, -28], [0, 28]];
    let best: { x: number; y: number; score: number } | null = null;
    for (const fy of [0.3, 0.4, 0.5, 0.6, 0.7, 0.2, 0.8, 0.12, 0.9]) {
      for (const fx of [0.12, 0.2, 0.28, 0.36, 0.44, 0.52, 0.6, 0.68, 0.76, 0.85]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (!on(x, y)) continue;
        const score = ring.filter(([dx, dy]) => on(x + dx, y + dy)).length;
        if (score === ring.length) return { x, y };
        if (!best || score > best.score) best = { x, y, score };
      }
    }
    return best && { x: best.x, y: best.y };
  }, key);
}

/**
 * Wait until the hand stops moving, like a person waits for the deal to land:
 * cards spring into place and the picked card pops a moment later (2 s at
 * timescale 0.5), growing over its neighbours. The idle bob loops forever and
 * doesn't count.
 */
export async function handSettled(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const hand = document.querySelector('[data-testid="hand"]');
      if (!hand) return true;
      return hand.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity);
    },
    undefined,
    { timeout, polling: 50 },
  );
}

/**
 * A hovered card jumps on top and can bury its neighbours, so: start with the
 * pointer off the hand, wait for the hand to settle, jump straight to the card
 * (a glide would lift every card on the way) and check it really is the one
 * under the pointer.
 */
export async function hoverCard(page: Page, key: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await page.mouse.move(1, 1);
    await handSettled(page);
    const p = await cardPoint(page, key);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(30);
    const onTarget = await page.evaluate(
      ({ key, x, y }) => !!document.elementFromPoint(x, y)?.closest(`[data-testid="card-${key}"]`),
      { key, ...p },
    );
    if (onTarget) return;
    if (attempt >= 5) throw new Error(`card ${key} keeps ending up under another card`);
    await page.waitForTimeout(100);
  }
}

export async function clickCard(page: Page, key: string, opts: { double?: boolean } = {}): Promise<void> {
  await hoverCard(page, key);
  // Let the card finish lifting before aiming the click.
  await handSettled(page);
  const p = await cardPoint(page, key);
  if (opts.double) await page.mouse.dblclick(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}
