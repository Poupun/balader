// Realistic probe results for the mock backend. Shapes mirror what the Rust
// core produces for real sites (see crates/balader-core/src/formats.rs tests).
// Thumbnails are painted procedurally so tests never touch the network.

import type { AudioTrack, ErrorPayload, MediaInfo, PlatformInfo, PlaylistInfo, SniffCandidate, Storyboard, TierPick, VideoTier } from '../types';
import { clock } from '../../ui/format';

export const PLATFORMS: Record<string, PlatformInfo> = {
  youtube: { key: 'youtube', name: 'YouTube', color: '#ff4e45' },
  tiktok: { key: 'tiktok', name: 'TikTok', color: '#2ee6e6' },
  instagram: { key: 'instagram', name: 'Instagram', color: '#f2547d' },
  x: { key: 'x', name: 'X', color: '#d7dde2' },
  vimeo: { key: 'vimeo', name: 'Vimeo', color: '#36b8f0' },
  soundcloud: { key: 'soundcloud', name: 'SoundCloud', color: '#ff7a2e' },
  twitch: { key: 'twitch', name: 'Twitch', color: '#9b6bff' },
  reddit: { key: 'reddit', name: 'Reddit', color: '#ff6a33' },
  archive: { key: 'archive', name: 'Archive.org', color: '#c9b28a' },
  web: { key: 'web', name: 'example.com', color: '#9aa9b4' },
};

export function platformForUrl(url: string): PlatformInfo {
  const u = url.toLowerCase();
  if (u.includes('youtu')) return PLATFORMS.youtube;
  if (u.includes('tiktok')) return PLATFORMS.tiktok;
  if (u.includes('instagram')) return PLATFORMS.instagram;
  if (u.includes('x.com') || u.includes('twitter')) return PLATFORMS.x;
  if (u.includes('vimeo')) return PLATFORMS.vimeo;
  if (u.includes('soundcloud')) return PLATFORMS.soundcloud;
  if (u.includes('twitch')) return PLATFORMS.twitch;
  if (u.includes('reddit')) return PLATFORMS.reddit;
  if (u.includes('archive.org')) return PLATFORMS.archive;
  try {
    return { ...PLATFORMS.web, name: new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '') };
  } catch {
    return PLATFORMS.web;
  }
}

// ------------------------------------------------------------ thumbnails

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

const PAINTERS: Record<string, Painter> = {
  ocean(g, w, h) {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2b1a4f');
    sky.addColorStop(0.45, '#ff7a45');
    sky.addColorStop(0.62, '#ffcf6b');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff1b8';
    g.beginPath();
    g.arc(w * 0.62, h * 0.55, h * 0.16, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 9; i++) {
      const y = h * 0.62 + i * (h * 0.045);
      g.fillStyle = i % 2 ? '#1d4e7a' : '#246294';
      g.fillRect(0, y, w, h * 0.05);
      g.fillStyle = 'rgba(255,220,150,0.5)';
      g.fillRect(w * 0.5 + Math.sin(i) * 20, y + 2, w * 0.24 - i * 6, 3);
    }
  },
  travel(g, w, h) {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#16c6c0');
    bg.addColorStop(1, '#ff5ea8');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffd34d';
    g.fillRect(w * 0.3, h * 0.35, w * 0.4, h * 0.42);
    g.fillStyle = '#ff8a1f';
    g.fillRect(w * 0.3, h * 0.35, w * 0.4, h * 0.08);
    g.fillStyle = '#3a2a10';
    g.fillRect(w * 0.44, h * 0.27, w * 0.12, h * 0.08);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `bold ${Math.round(h * 0.12)}px sans-serif`;
    g.fillText('30s', w * 0.4, h * 0.2);
  },
  music(g, w, h) {
    g.fillStyle = '#2a1650';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 48; i++) {
      const bh = (Math.sin(i * 0.7) * 0.5 + 0.5) * h * 0.6 + h * 0.08;
      g.fillStyle = i % 3 ? '#9b6bff' : '#ff6fa8';
      g.fillRect((i * w) / 48 + 1, (h - bh) / 2, w / 48 - 3, bh);
    }
  },
  meadow(g, w, h) {
    g.fillStyle = '#7ec8ff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#4caf50';
    g.fillRect(0, h * 0.6, w, h * 0.4);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(w * 0.5, h * 0.55, w * 0.1, h * 0.14, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(w * 0.46, h * 0.28, w * 0.025, h * 0.18);
    g.fillRect(w * 0.515, h * 0.28, w * 0.025, h * 0.18);
  },
  grid(g, w, h) {
    const colors = ['#ff5146', '#2b95ff', '#33c98a', '#ffc93c', '#9b6bff', '#2cc4bd'];
    const cols = 4;
    const rows = 2;
    for (let i = 0; i < cols * rows; i++) {
      g.fillStyle = colors[i % colors.length];
      g.fillRect((i % cols) * (w / cols), Math.floor(i / cols) * (h / rows), w / cols - 2, h / rows - 2);
    }
  },
};

const cache = new Map<string, string>();

export function paintThumb(kind: keyof typeof PAINTERS | string, w = 480, h = 270): string | null {
  const key = `${kind}:${w}x${h}`;
  if (cache.has(key)) return cache.get(key)!;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  (PAINTERS[kind] ?? PAINTERS.grid)(g, w, h);
  let url: string | null = null;
  try {
    url = c.toDataURL('image/png');
  } catch {
    url = null;
  }
  if (url) cache.set(key, url);
  return url;
}

// ------------------------------------------------------------ storyboards

/** Two levels like YouTube's: sheet URLs are `mock://storyboard/…`, painted on demand by the mock's `thumbnail`. */
export function storyboards(id: string, duration: number): Storyboard[] {
  const level = (n: number, width: number, height: number, columns: number, rows: number, frames: number): Storyboard => ({
    width,
    height,
    columns,
    rows,
    frames,
    sheets: Array.from({ length: Math.ceil(frames / (columns * rows)) }, (_, i) => `mock://storyboard/${id}/${n}/${i}?d=${duration}&f=${frames}&w=${width}&h=${height}&c=${columns}&r=${rows}`),
  });
  return [level(0, 80, 45, 10, 10, 100), level(1, 160, 90, 5, 5, 150)];
}

/** One sheet of the golden-hour film: the sun sinks frame by frame, each frame stamped with its time. */
export function paintStoryboardSheet(url: string): string | null {
  if (cache.has(url)) return cache.get(url)!;
  if (typeof document === 'undefined') return null;
  const m = url.match(/^mock:\/\/storyboard\/[^/]+\/\d+\/(\d+)\?d=([\d.]+)&f=(\d+)&w=(\d+)&h=(\d+)&c=(\d+)&r=(\d+)$/);
  if (!m) return null;
  const [sheet, d, frames, w, h, cols, rows] = m.slice(1).map(Number);
  const c = document.createElement('canvas');
  c.width = w * cols;
  c.height = h * rows;
  const g = c.getContext('2d');
  if (!g) return null;
  const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;
  for (let k = 0; k < cols * rows; k++) {
    const x0 = (k % cols) * w;
    const y0 = Math.floor(k / cols) * h;
    const f = sheet * cols * rows + k;
    if (f >= frames) {
      g.fillStyle = '#000';
      g.fillRect(x0, y0, w, h);
      continue;
    }
    const t = (f * d) / frames;
    const u = t / d;
    const sky = g.createLinearGradient(0, y0, 0, y0 + h * 0.62);
    sky.addColorStop(0, mix([43, 26, 79], [12, 8, 34], u));
    sky.addColorStop(0.7, mix([255, 122, 69], [176, 52, 90], u));
    sky.addColorStop(1, mix([255, 207, 107], [255, 110, 70], u));
    g.fillStyle = sky;
    g.fillRect(x0, y0, w, h);
    g.fillStyle = mix([255, 241, 184], [255, 150, 90], u);
    g.beginPath();
    g.arc(x0 + w * (0.2 + 0.6 * u), y0 + h * (0.3 + 0.32 * u), h * 0.13, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 5; i++) {
      g.fillStyle = i % 2 ? mix([29, 78, 122], [18, 40, 70], u) : mix([36, 98, 148], [24, 52, 88], u);
      g.fillRect(x0, y0 + h * (0.62 + i * 0.08), w, h * 0.08);
    }
    g.font = `bold ${Math.max(8, Math.round(h * 0.2))}px monospace`;
    g.fillStyle = '#000';
    g.fillText(clock(t), x0 + 4, y0 + h - 4);
    g.fillStyle = '#fff';
    g.fillText(clock(t), x0 + 3, y0 + h - 5);
  }
  let data: string | null = null;
  try {
    data = c.toDataURL('image/jpeg', 0.8);
  } catch {
    data = null;
  }
  if (data) cache.set(url, data);
  return data;
}

// ------------------------------------------------------------ builders

function tp(p: Partial<TierPick> & { videoId: string; vcodec: string }, duration: number, kbps: number, audioKbps = 0): TierPick {
  const vs = Math.round(kbps * 125 * duration);
  const as = audioKbps ? Math.round(audioKbps * 125 * duration) : null;
  return {
    audioId: null,
    combined: false,
    silent: false,
    acodec: null,
    ext: 'mp4',
    fps: 30,
    hdr: false,
    width: null,
    height: null,
    videoSize: vs,
    audioSize: as,
    size: vs + (as ?? 0),
    sizeExact: false,
    ...p,
  };
}

function track(formatId: string, codec: string, ext: string, abr: number, duration: number): AudioTrack {
  return { formatId, codec, ext, abr, size: Math.round(abr * 125 * duration), sizeExact: false, language: 'en' };
}

export function youtube(url = 'https://www.youtube.com/watch?v=0cEaNw4vEs0'): MediaInfo {
  const d = 754;
  const t = (label: number, mp4: TierPick, mkv: TierPick): VideoTier => ({ label, mp4, mkv });
  const w = (h: number) => Math.round((h * 16) / 9);
  return {
    id: '0cEaNw4vEs0',
    title: 'Ocean Waves at Golden Hour - Relaxing 4K Nature Film',
    uploader: 'Slow Planet',
    duration: d,
    thumbnail: paintThumb('ocean'),
    platform: platformForUrl(url),
    extractor: 'youtube',
    webpageUrl: url,
    viewCount: 1_284_330,
    likeCount: 48_120,
    uploadDate: '20250614',
    live: false,
    hasVideo: true,
    tiers: [
      t(2160, tp({ videoId: '401', audioId: '140', vcodec: 'AV1', acodec: 'AAC', fps: 60, width: 3840, height: 2160 }, d, 14000, 129.5), tp({ videoId: '315', audioId: '251', vcodec: 'VP9', acodec: 'Opus', fps: 60, ext: 'webm', width: 3840, height: 2160 }, d, 18000, 133.4)),
      t(1440, tp({ videoId: '400', audioId: '140', vcodec: 'AV1', acodec: 'AAC', fps: 60, width: 2560, height: 1440 }, d, 7000, 129.5), tp({ videoId: '308', audioId: '251', vcodec: 'VP9', acodec: 'Opus', fps: 60, ext: 'webm', width: 2560, height: 1440 }, d, 9000, 133.4)),
      t(1080, tp({ videoId: '299', audioId: '140', vcodec: 'H.264', acodec: 'AAC', fps: 60, width: w(1080), height: 1080 }, d, 4200, 129.5), tp({ videoId: '399', audioId: '251', vcodec: 'AV1', acodec: 'Opus', fps: 60, width: w(1080), height: 1080 }, d, 2100, 133.4)),
      t(720, tp({ videoId: '298', audioId: '140', vcodec: 'H.264', acodec: 'AAC', fps: 60, width: 1280, height: 720 }, d, 1500, 129.5), tp({ videoId: '398', audioId: '251', vcodec: 'AV1', acodec: 'Opus', fps: 60, width: 1280, height: 720 }, d, 900, 133.4)),
      t(480, tp({ videoId: '135', audioId: '140', vcodec: 'H.264', acodec: 'AAC', width: 854, height: 480 }, d, 800, 129.5), tp({ videoId: '244', audioId: '251', vcodec: 'VP9', acodec: 'Opus', ext: 'webm', width: 854, height: 480 }, d, 550, 133.4)),
      t(360, tp({ videoId: '18', vcodec: 'H.264', acodec: 'AAC', combined: true, width: 640, height: 360 }, d, 520), tp({ videoId: '243', audioId: '251', vcodec: 'VP9', acodec: 'Opus', ext: 'webm', width: 640, height: 360 }, d, 300, 133.4)),
      t(240, tp({ videoId: '133', audioId: '140', vcodec: 'H.264', acodec: 'AAC', width: 426, height: 240 }, d, 250, 129.5), tp({ videoId: '242', audioId: '251', vcodec: 'VP9', acodec: 'Opus', ext: 'webm', width: 426, height: 240 }, d, 180, 133.4)),
      t(144, tp({ videoId: '160', audioId: '139', vcodec: 'H.264', acodec: 'AAC', width: 256, height: 144 }, d, 110, 48.8), tp({ videoId: '278', audioId: '249', vcodec: 'VP9', acodec: 'Opus', ext: 'webm', width: 256, height: 144 }, d, 90, 50)),
    ],
    audio: {
      available: true,
      fromCombined: false,
      best: track('251', 'Opus', 'webm', 133.4, d),
      tracks: [track('251', 'Opus', 'webm', 133.4, d), track('140', 'AAC', 'm4a', 129.5, d), track('250', 'Opus', 'webm', 70, d), track('139', 'AAC', 'm4a', 48.8, d)],
    },
    subtitles: ['en', 'fr', 'ja'],
    formatCount: 34,
    storyboards: storyboards('0cEaNw4vEs0', d),
  };
}

export function tiktok(url = 'https://www.tiktok.com/@packlight/video/7300000000000000000'): MediaInfo {
  const d = 31;
  const v = (id: string, codec: string, h: number, kbps: number) =>
    tp({ videoId: id, vcodec: codec, acodec: 'AAC', combined: true, width: Math.round((h * 9) / 16), height: h, fps: 30 }, d, kbps);
  return {
    id: '7300000000000000000',
    title: 'how I pack a carry-on in 30 seconds #travel #packinghacks',
    uploader: 'packlight',
    duration: d,
    thumbnail: paintThumb('travel', 270, 480),
    platform: platformForUrl(url),
    extractor: 'TikTok',
    webpageUrl: url,
    viewCount: 3_400_000,
    likeCount: 512_000,
    uploadDate: '20251002',
    live: false,
    hasVideo: true,
    tiers: [
      { label: 1080, mp4: v('h264_1080p', 'H.264', 1920, 2600), mkv: v('bytevc1_1080p', 'HEVC', 1920, 1600) },
      { label: 720, mp4: v('h264_720p', 'H.264', 1280, 1300), mkv: v('bytevc1_720p', 'HEVC', 1280, 800) },
      { label: 576, mp4: v('h264_540p', 'H.264', 1024, 700), mkv: v('h264_540p', 'H.264', 1024, 700) },
    ],
    audio: { available: true, fromCombined: true, best: { formatId: 'h264_1080p', codec: 'AAC', ext: 'mp4', abr: 128, size: null, sizeExact: false, language: null }, tracks: [] },
    subtitles: [],
    formatCount: 9,
    storyboards: [],
  };
}

export function soundcloud(url = 'https://soundcloud.com/forss/flickermood'): MediaInfo {
  const d = 214;
  return {
    id: '293',
    title: 'Flickermood',
    uploader: 'Forss',
    duration: d,
    thumbnail: paintThumb('music', 300, 300),
    platform: platformForUrl(url),
    extractor: 'soundcloud',
    webpageUrl: url,
    viewCount: 520_000,
    likeCount: null,
    uploadDate: '20080917',
    live: false,
    hasVideo: false,
    tiers: [],
    audio: { available: true, fromCombined: false, best: track('hls_aac_160k', 'AAC', 'm4a', 160, d), tracks: [track('hls_aac_160k', 'AAC', 'm4a', 160, d), track('hls_opus_64k', 'Opus', 'opus', 64, d)] },
    subtitles: [],
    formatCount: 2,
    storyboards: [],
  };
}

export function archive(url = 'https://archive.org/details/BigBuckBunny_124'): MediaInfo {
  const d = 596;
  const c = (id: string, codec: string, ext: string, h: number, kbps: number) => tp({ videoId: id, vcodec: codec, ext, combined: true, fps: null, width: null, height: h }, d, kbps);
  return {
    id: 'BigBuckBunny_124',
    title: 'Big Buck Bunny',
    uploader: 'Blender Foundation',
    duration: d,
    thumbnail: paintThumb('meadow'),
    platform: platformForUrl(url),
    extractor: 'archive.org',
    webpageUrl: url,
    viewCount: null,
    likeCount: null,
    uploadDate: null,
    live: false,
    hasVideo: true,
    tiers: [
      { label: 720, mp4: c('2', 'AVI', 'avi', 720, 4450), mkv: c('2', 'AVI', 'avi', 720, 4450) },
      { label: 360, mp4: c('1', 'MP4', 'mp4', 360, 830), mkv: c('1', 'MP4', 'mp4', 360, 830) },
      { label: 300, mp4: c('0', 'OGV', 'ogv', 300, 630), mkv: c('0', 'OGV', 'ogv', 300, 630) },
    ],
    audio: { available: true, fromCombined: true, best: { formatId: '2', codec: 'MP4', ext: 'avi', abr: null, size: null, sizeExact: false, language: null }, tracks: [] },
    subtitles: [],
    formatCount: 3,
    storyboards: [],
  };
}

const SONGS = [
  'Neon Harbor', 'Paper Moons', 'Copper Tide', 'Static Bloom', 'Velvet Engine', 'Glass Orchard',
  'Midnight Arcade', 'Saltwater Static', 'Lantern Club', 'Hollow Comet', 'Pixel Rain', 'Low Sun',
  'Chalk Lines', 'Silver Thread', 'Kite Season', 'Ember Waltz', 'Cloud Atlas Bus', 'Orbit Diner',
  'Quiet Riot Club', 'Cobalt Dreams', 'Little Thunder', 'Tin Roof', 'Night Garden', 'Last Ferry',
];

export function playlist(url = 'https://www.youtube.com/playlist?list=PLbalader0001'): PlaylistInfo {
  return {
    id: 'PLbalader0001',
    title: 'Late Night Lo-fi Mix',
    uploader: 'Slow Planet',
    platform: platformForUrl(url),
    webpageUrl: url,
    count: SONGS.length,
    thumbnail: paintThumb('grid'),
    entries: SONGS.map((title, i) => ({
      id: `e${i}`,
      title,
      url: `https://www.youtube.com/watch?v=e${i}`,
      duration: 150 + ((i * 37) % 120),
      thumbnail: null,
      uploader: 'Slow Planet',
    })),
  };
}

export function sniffed(page = 'https://example.com/watch/42'): SniffCandidate[] {
  return [
    { url: 'https://cdn.example.com/media/clip-1080.mp4', kind: 'video', ext: 'mp4', label: 'MP4 video', source: 'og tags' },
    { url: 'https://stream.example.com/master.m3u8', kind: 'stream', ext: 'm3u8', label: 'M3U8 stream', source: 'page source' },
    { url: `${page}/podcast.mp3`, kind: 'audio', ext: 'mp3', label: 'MP3 audio', source: '<video> tag' },
  ];
}

export const ERRORS: Record<string, ErrorPayload> = {
  botcheck: {
    code: 'bot_check',
    message: "The site wants to check you're human.",
    hint: 'Turn on "Cookies from browser" in Settings, using a browser where you\'re signed in.',
    detail: "ERROR: [youtube] x: Sign in to confirm you're not a bot",
  },
  private: { code: 'private', message: 'This video is private.', hint: 'If you can watch it while signed in, use "Cookies from browser" in Settings.', detail: null },
  unsupported: {
    code: 'unsupported',
    message: 'No video found on that page.',
    hint: 'Balader asked yt-dlp and scraped the page itself: nothing playable there.',
    detail: null,
  },
  live: { code: 'live', message: 'This stream is live right now.', hint: "Live recording isn't supported yet. Come back once it has ended.", detail: null },
  network: { code: 'network', message: "Couldn't reach the site.", hint: 'Check your connection.', detail: null },
  ratelimit: { code: 'rate_limited', message: 'The site is rate-limiting this network.', hint: 'Wait a few minutes, or turn on "Cookies from browser" in Settings.', detail: null },
  invalid: { code: 'invalid_url', message: "That doesn't look like a link.", hint: null, detail: null },
};
