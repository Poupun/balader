// Probe result + choices → the hand of cards. Pure (unit-tested).

import type { AudioFormat, Container, DownloadRequest, MediaInfo, Mode, PlaylistInfo, ProbeResult, SniffCandidate, TierPick } from '../api/types';
import { audioClass, audioName, bytes, clipLength, tierBig, tierClass, tierName } from '../ui/format';

export interface Chip {
  text: string;
  hot?: boolean;
}

export interface CardModel {
  key: string;
  kind: 'video' | 'audio' | 'playlist' | 'sniff';
  big: string;
  corner: string;
  cornerSub: string;
  name: string;
  cls: string;
  foil: boolean;
  icon: 'video' | 'note' | 'list' | 'globe';
  chips: Chip[];
  size: string;
  disabled: boolean;
  tip: string;
  /** Bet slip headline. */
  summary: string;
  /** Short label shown on the job in the pile. */
  short: string;
  detail: string;
  request: Partial<DownloadRequest>;
}

const QUICKTIME_OK = new Set(['H.264', 'HEVC']);
/** When a site doesn't name the codec, the core reports the container instead. */
const CONTAINER_NAMES = new Set(['MP4', 'MKV', 'WEBM', 'MOV', 'AVI', 'OGV', 'FLV', '3GP', 'TS', 'M4V', 'VIDEO']);

/** A clip: its length and the share of the whole it represents. */
interface Clip {
  len: number;
  frac: number;
}

const part = (n: number | null, clip: Clip | null) => (n !== null && clip ? Math.round(n * clip.frac) : n);

function videoCard(label: number, p: TierPick, container: Container, clip: Clip | null = null): CardModel {
  const fps = p.fps && p.fps > 30 ? p.fps : null;
  const chips: Chip[] = [{ text: p.vcodec }];
  if (fps) chips.push({ text: `${fps}FPS`, hot: true });
  if (p.hdr) chips.push({ text: 'HDR', hot: true });
  if (p.silent) chips.push({ text: 'NO SOUND' });
  // A clip is roughly its share of the full file (exact cuts re-encode, so it's an estimate).
  const size = bytes(part(p.size, clip), !p.sizeExact || !!clip);
  const forClip = clip ? ` for the ${clipLength(clip.len)} clip` : '';
  const dims = p.width && p.height ? `${p.width}×${p.height}` : label ? `${label}p` : 'best available';
  const codecs = `${p.vcodec}${p.acodec ? ` + ${p.acodec}` : ''}`;
  const caveat = container === 'mp4' && !QUICKTIME_OK.has(p.vcodec) && p.vcodec !== 'MP4' ? '\nMay not play in QuickTime (try VLC).' : '';
  return {
    key: `v${label}`,
    kind: 'video',
    big: tierBig(label),
    corner: label ? String(label) : '★',
    cornerSub: label ? (fps ? `P${fps}` : 'P') : '',
    name: tierName(label),
    cls: tierClass(label),
    foil: label >= 2160,
    icon: 'video',
    chips,
    size: p.size ? size : '',
    disabled: false,
    tip: `${dims} · ${codecs}\n${p.size ? size : 'size unknown'}${forClip} → ${container.toUpperCase()}${caveat}`,
    summary: CONTAINER_NAMES.has(p.vcodec)
      ? `${label ? `${label}p${fps ?? ''}` : 'Best quality'} → ${container.toUpperCase()}`
      : `${label ? `${label}p${fps ?? ''}` : 'Best'} · ${p.vcodec} → ${container.toUpperCase()}`,
    short: `${label ? `${label}p${fps ?? ''}` : 'BEST'} · ${container.toUpperCase()}`,
    detail: `${p.size ? size : 'size unknown'} · ${codecs} · ${p.combined ? `format ${p.videoId}` : `${p.videoId}${p.audioId ? `+${p.audioId}` : ''}`}`,
    request: {
      mode: 'video',
      tier: label || null,
      container,
      videoId: p.videoId,
      audioId: p.audioId,
      combined: p.combined,
      silent: p.silent,
      pickVcodec: p.vcodec,
      pickExt: p.ext,
      expectedVideo: part(p.videoSize, clip),
      expectedAudio: part(p.audioSize, clip),
    },
  };
}

interface AudioOpt {
  key: string;
  big: string;
  sub: string;
  kbps: number | 'best' | 'lossless';
  quality: string;
  sourceId: string | null;
  estKbps: number | null;
  chips: Chip[];
  tip: string;
}

function audioOptions(audio: MediaInfo['audio'] | null, fmt: AudioFormat): AudioOpt[] {
  const best = audio && !audio.fromCombined ? audio.best?.formatId ?? null : null;
  const tracksOf = (codec: string) => (audio && !audio.fromCombined ? audio.tracks.filter((t) => t.codec === codec) : []);
  switch (fmt) {
    case 'mp3':
      return [
        { key: 'best', big: 'V0', sub: 'VBR', kbps: 'best', quality: 'best', sourceId: best, estKbps: 245, chips: [{ text: 'MP3' }, { text: 'TOP VBR', hot: true }], tip: 'Highest-quality MP3 (VBR ~245 kbps)' },
        ...[320, 256, 192, 128].map((k) => ({
          key: String(k),
          big: String(k),
          sub: 'K',
          kbps: k,
          quality: String(k),
          sourceId: best,
          estKbps: k,
          chips: [{ text: 'MP3' }, { text: `${k} KBPS` }],
          tip: `MP3 at a constant ${k} kbps`,
        })),
      ];
    case 'm4a':
    case 'opus': {
      const codec = fmt === 'm4a' ? 'AAC' : 'Opus';
      const tracks = tracksOf(codec);
      if (tracks.length) {
        return tracks.map((t, i) => {
          const k = Math.round(t.abr ?? 0);
          return {
            key: `${fmt}-${t.formatId}`,
            big: k ? String(k) : 'SRC',
            sub: k ? 'K' : '',
            kbps: i === 0 ? ('best' as const) : k,
            quality: 'original',
            sourceId: t.formatId,
            estKbps: k || null,
            chips: [{ text: codec.toUpperCase() }, { text: 'NO RE-ENCODE', hot: i === 0 }],
            tip: `${codec} ${k ? `${k} kbps` : ''} straight from the source, untouched`,
          };
        });
      }
      return [
        { key: `${fmt}-orig`, big: fmt === 'm4a' ? 'AAC' : 'OPUS', sub: '', kbps: 'best', quality: 'best', sourceId: best, estKbps: 160, chips: [{ text: 'CONVERTED' }], tip: `Best audio, converted to ${codec}` },
      ];
    }
    case 'flac':
      return [{ key: 'flac', big: 'FLAC', sub: '', kbps: 'lossless', quality: 'best', sourceId: best, estKbps: 900, chips: [{ text: 'LOSSLESS BOX' }], tip: 'Lossless container (no quality above the source)' }];
    case 'wav':
      return [{ key: 'wav', big: 'WAV', sub: '', kbps: 'lossless', quality: 'best', sourceId: best, estKbps: 1536, chips: [{ text: 'PCM' }], tip: 'Uncompressed PCM, big but editor-friendly' }];
  }
}

function audioCards(audio: MediaInfo['audio'] | null, fmt: AudioFormat, duration: number | null, playlistCount?: number): CardModel[] {
  return audioOptions(audio, fmt).map((o) => {
    const est = o.estKbps && duration ? Math.round(o.estKbps * 125 * duration) : null;
    const size = playlistCount ? `${playlistCount} tracks` : est ? bytes(est, true) : '';
    const label = o.kbps === 'best' ? 'Best' : o.kbps === 'lossless' ? 'Lossless' : `${o.kbps}K`;
    return {
      key: `a-${o.key}`,
      kind: 'audio',
      big: o.big,
      corner: o.big,
      cornerSub: o.sub,
      name: audioName(o.kbps),
      cls: audioClass(o.kbps),
      foil: o.kbps === 'best' || o.kbps === 'lossless',
      icon: 'note',
      chips: o.chips,
      size,
      disabled: false,
      tip: `${o.tip}${size ? `\n${size}` : ''}`,
      summary: `${fmt.toUpperCase()} · ${o.big}${o.sub === 'K' ? 'K' : ''}${label === 'Best' ? ' (best)' : ''}`,
      short: `${fmt.toUpperCase()} · ${o.big}${o.sub === 'K' ? 'K' : ''}`,
      detail: `${size || 'size unknown'}${o.sourceId ? ` · source ${o.sourceId}` : ''}`,
      request: { mode: 'audio', audioFormat: fmt, audioQuality: o.quality, audioSourceId: o.sourceId, expectedAudio: est },
    };
  });
}

const PLAYLIST_TIERS = [0, 2160, 1440, 1080, 720, 480, 360];

function playlistCards(pl: PlaylistInfo, mode: Mode, container: Container, fmt: AudioFormat): CardModel[] {
  const base = { playlist: true, playlistCount: pl.count };
  if (mode === 'audio') {
    return audioCards(null, fmt, null, pl.count).map((c) => ({ ...c, key: `p${c.key}`, kind: 'playlist' as const, short: `PLAYLIST ×${pl.count} · ${c.short}`, request: { ...c.request, ...base } }));
  }
  return PLAYLIST_TIERS.map((label) => ({
    key: `pv${label}`,
    kind: 'playlist' as const,
    big: tierBig(label),
    corner: label ? String(label) : '★',
    cornerSub: label ? 'P' : '',
    name: tierName(label),
    cls: tierClass(label),
    foil: label === 0 || label >= 2160,
    icon: 'list' as const,
    chips: [{ text: `×${pl.count}`, hot: true }, { text: container.toUpperCase() }],
    size: `${pl.count} videos`,
    disabled: false,
    tip: label ? `Every video at up to ${label}p (or the closest below)` : 'Every video at the best quality available',
    summary: `Playlist · ${label ? `${label}p max` : 'best'} → ${container.toUpperCase()}`,
    short: `PLAYLIST ×${pl.count} · ${label ? `${label}p` : 'BEST'}`,
    detail: `${pl.count} videos · ${pl.title}`,
    request: { ...base, mode: 'video' as const, tier: label || null, container },
  }));
}

function sniffCards(page: string, candidates: SniffCandidate[], mode: Mode, container: Container, fmt: AudioFormat): CardModel[] {
  return candidates.map((c, i) => ({
    key: `s${i}`,
    kind: 'sniff' as const,
    big: (c.ext ?? c.kind).toUpperCase().slice(0, 4),
    corner: String(i + 1),
    cornerSub: '',
    name: c.kind.toUpperCase(),
    cls: c.kind === 'audio' ? 't-blue' : c.kind === 'stream' ? 't-purple' : 't-pink',
    foil: false,
    icon: 'globe' as const,
    chips: [{ text: c.source }],
    size: '',
    disabled: false,
    tip: `${c.label}\n${c.url}`,
    summary: `${c.label} → ${mode === 'audio' ? fmt.toUpperCase() : container.toUpperCase()}`,
    short: `SCRAPED · ${mode === 'audio' ? fmt.toUpperCase() : container.toUpperCase()}`,
    detail: c.url,
    request: { url: c.url, referer: page, mode, container, audioFormat: fmt, audioQuality: 'best' },
  }));
}

/** `clipLen`: length of the cut in seconds (null = the whole thing): sizes shrink to match. */
export function buildCards(probe: ProbeResult | null, mode: Mode, container: Container, fmt: AudioFormat, clipLen: number | null = null): CardModel[] {
  if (!probe) return [];
  switch (probe.kind) {
    case 'video': {
      const m = probe.media;
      const clip = clipLen && m.duration ? { len: clipLen, frac: Math.min(1, clipLen / m.duration) } : null;
      if (mode === 'video') return m.tiers.map((t) => videoCard(t.label, container === 'mp4' ? t.mp4 : t.mkv, container, clip));
      return m.audio.available ? audioCards(m.audio, fmt, clip ? clip.len : m.duration) : [];
    }
    case 'playlist':
      return playlistCards(probe.playlist, mode, container, fmt);
    case 'sniffed':
      return sniffCards(probe.page, probe.candidates, mode, container, fmt);
  }
}

/** Default pick when the hand is dealt: 1080 (or the best below), else the first card. */
export function defaultSelection(cards: CardModel[]): string | null {
  if (!cards.length) return null;
  const video = cards.filter((c) => c.kind === 'video' && c.request.tier);
  const sweet = video.find((c) => (c.request.tier ?? 0) <= 1080);
  return (sweet ?? cards[0]).key;
}
