// Pure formatting helpers (unit-tested).

export function bytes(n: number | null | undefined, approx = false): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const num = i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${approx ? '~' : ''}${num} ${units[i]}`;
}

export function speed(bps: number | null | undefined): string {
  if (!bps || bps <= 0) return '';
  return `${bytes(bps)}/s`;
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function eta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  return duration(sec);
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20240301" → "Mar 1, 2024" */
export function uploadDate(d: string | null | undefined): string {
  if (!d || !/^\d{8}$/.test(d)) return '';
  const m = Number(d.slice(4, 6)) - 1;
  return `${MONTHS[m] ?? '?'} ${Number(d.slice(6, 8))}, ${d.slice(0, 4)}`;
}

/** Flavour names for resolution tiers (short side). */
export function tierName(label: number): string {
  if (label === 0) return 'BEST';
  if (label >= 4320) return '8K';
  if (label >= 2160) return 'ULTRA';
  if (label >= 1440) return 'QUAD';
  if (label >= 1080) return 'FULL HD';
  if (label >= 720) return 'HD';
  if (label >= 480) return 'SD';
  if (label >= 360) return 'LITE';
  if (label >= 240) return 'TINY';
  return 'POTATO';
}

export function tierClass(label: number): string {
  if (label === 0 || label >= 2160) return 't-gold';
  if (label >= 1440) return 't-purple';
  if (label >= 1080) return 't-red';
  if (label >= 720) return 't-blue';
  if (label >= 480) return 't-green';
  if (label >= 360) return 't-teal';
  return 't-gray';
}

/** Big number shown on a card: 2160 → "4K" reads better. */
export function tierBig(label: number): string {
  if (label === 0) return 'BEST';
  if (label >= 4320) return '8K';
  if (label >= 2160) return '4K';
  if (label >= 1440) return '2K';
  return String(label);
}

export function audioName(kbps: number | 'best' | 'lossless'): string {
  if (kbps === 'best') return 'STUDIO';
  if (kbps === 'lossless') return 'MASTER';
  if (kbps >= 300) return 'PRIME';
  if (kbps >= 240) return 'RICH';
  if (kbps >= 150) return 'CLEAN';
  if (kbps >= 110) return 'POCKET';
  return 'RADIO';
}

export function audioClass(kbps: number | 'best' | 'lossless'): string {
  if (kbps === 'best' || kbps === 'lossless') return 't-gold';
  if (kbps >= 300) return 't-purple';
  if (kbps >= 240) return 't-blue';
  if (kbps >= 150) return 't-teal';
  if (kbps >= 110) return 't-green';
  return 't-gray';
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return /^https?:\/\/\S+\.\S+/i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(t);
}

/** Pull the first link out of arbitrary pasted text. */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[),.;!?]+$/, '');
  const t = text.trim();
  return looksLikeUrl(t) ? t : null;
}

// ------------------------------------------------------------ cut times
// Same rules as the Rust core (crates/balader-core/src/cut.rs).

function parseNumber(n: string): number | null {
  if (!n || n === '.' || !/^[0-9.]+$/.test(n) || (n.match(/\./g)?.length ?? 0) > 1) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** What people type → seconds: `83`, `1:23.5`, `01:02:03`, `1h2m3s`, `1m30`, `1:23,5`. */
export function parseTime(input: string): number | null {
  const s = input.trim().replace(',', '.').toLowerCase();
  if (!s) return null;
  let total = 0;
  if (/[hms]/.test(s)) {
    const rank: Record<string, number> = { h: 0, m: 1, s: 2 };
    const scale: Record<string, number> = { h: 3600, m: 60, s: 1 };
    let num = '';
    let last: string | null = null;
    for (const c of s) {
      if (/[0-9.]/.test(c)) num += c;
      else if (c in rank) {
        if (last !== null && rank[last] >= rank[c]) return null;
        const v = parseNumber(num);
        if (v === null) return null;
        total += v * scale[c];
        num = '';
        last = c;
      } else if (c !== ' ') return null;
    }
    if (num) {
      const v = parseNumber(num);
      if (v === null || (last !== 'h' && last !== 'm')) return null;
      total += v * (last === 'h' ? 60 : 1);
    }
  } else {
    const parts = s.split(':').map((p) => p.trim());
    if (parts.length > 3) return null;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      if (!last && !/^[0-9]*$/.test(parts[i])) return null;
      const v = parseNumber(parts[i]);
      if (v === null || (i > 0 && v >= 60)) return null;
      total = total * 60 + v;
    }
  }
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function splitMs(t: number): [number, number, number, number] {
  const ms = Math.round(Math.max(0, t) * 1000);
  return [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60, ms % 1000];
}

/** `0:05`, `1:23.5`, `1:02:03.25`. With `minDecimals` the fraction is always shown (`0:12.0`). */
export function clock(t: number, minDecimals = 0): string {
  const [h, m, s, ms] = splitMs(t);
  let frac = String(ms).padStart(3, '0').replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  const tail = frac ? `.${frac}` : '';
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}${tail}` : `${m}:${ss}${tail}`;
}

/** File-name friendly (no colons): `5s`, `1m05s`, `1h02m03.5s`. */
export function compactTime(t: number): string {
  const [h, m, s, ms] = splitMs(t);
  const frac = ms ? `.${String(ms).padStart(3, '0').replace(/0+$/, '')}` : '';
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}${frac}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}${frac}s`;
  return `${s}${frac}s`;
}

/** Clip length for humans: `41.5s`, `2m 05s`, `1h 02m`. */
export function clipLength(t: number): string {
  if (t < 60) return `${(Math.round(t * 10) / 10).toFixed(1)}s`;
  const [h, m, s] = splitMs(t);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

/** A "nice" ruler step (seconds) so that about `target` labels fit. */
export function rulerStep(duration: number, target = 6): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((st) => duration / st <= target) ?? 7200;
}

/** Where moment `t` sits in a storyboard: the sheet URL and the frame's top-left corner in it. */
export function storyboardFrame(b: { width: number; height: number; columns: number; rows: number; frames: number; sheets: string[] }, duration: number, t: number): { url: string; sx: number; sy: number } {
  const idx = Math.max(0, Math.min(b.frames - 1, Math.floor((t / duration) * b.frames)));
  const per = b.columns * b.rows;
  const sheet = Math.min(b.sheets.length - 1, Math.floor(idx / per));
  const cell = idx - sheet * per;
  return { url: b.sheets[sheet], sx: (cell % b.columns) * b.width, sy: Math.floor(cell / b.columns) * b.height };
}
