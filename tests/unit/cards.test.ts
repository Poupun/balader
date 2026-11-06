import { describe, expect, it } from 'vitest';
import * as fx from '../../src/api/mock/fixtures';
import { buildCards, defaultSelection } from '../../src/state/cards';

describe('buildCards', () => {
  const yt = { kind: 'video' as const, media: fx.youtube() };

  it('video: one card per tier, MP4 favours H.264', () => {
    const cards = buildCards(yt, 'video', 'mp4', 'mp3');
    expect(cards.map((c) => c.big)).toEqual(['4K', '2K', '1080', '720', '480', '360', '240', '144']);
    const c1080 = cards.find((c) => c.key === 'v1080')!;
    expect(c1080.summary).toBe('1080p60 · H.264 → MP4');
    expect(c1080.short).toBe('1080p60 · MP4');
    expect(c1080.request).toMatchObject({ videoId: '299', audioId: '140', tier: 1080, container: 'mp4', combined: false });
    expect(cards[0].foil).toBe(true);
    expect(cards[0].tip).toContain('QuickTime');
    expect(c1080.tip).not.toContain('QuickTime');
  });

  it('video: MKV picks the original codecs', () => {
    const c = buildCards(yt, 'video', 'mkv', 'mp3').find((c) => c.key === 'v1080')!;
    expect(c.request).toMatchObject({ videoId: '399', audioId: '251', container: 'mkv', pickVcodec: 'AV1' });
  });

  it('audio: MP3 bitrates, M4A/Opus source tracks, lossless single card', () => {
    expect(buildCards(yt, 'audio', 'mp4', 'mp3').map((c) => c.request.audioQuality)).toEqual(['best', '320', '256', '192', '128']);
    const m4a = buildCards(yt, 'audio', 'mp4', 'm4a');
    expect(m4a.map((c) => c.request.audioSourceId)).toEqual(['140', '139']);
    expect(m4a.every((c) => c.request.audioQuality === 'original')).toBe(true);
    const opus = buildCards(yt, 'audio', 'mp4', 'opus');
    expect(opus.map((c) => c.big)).toEqual(['133', '70']);
    expect(buildCards(yt, 'audio', 'mp4', 'flac')).toHaveLength(1);
    const wav = buildCards(yt, 'audio', 'mp4', 'wav')[0];
    expect(wav.size).toMatch(/^~\d/);
  });

  it('audio from a combined file (TikTok) converts instead of picking tracks', () => {
    const tt = { kind: 'video' as const, media: fx.tiktok() };
    const m4a = buildCards(tt, 'audio', 'mp4', 'm4a');
    expect(m4a).toHaveLength(1);
    expect(m4a[0].request.audioSourceId).toBeNull();
    expect(buildCards(tt, 'audio', 'mp4', 'mp3')[1].request.audioSourceId).toBeNull();
  });

  it('playlists get generic tiers that carry the playlist flag', () => {
    const pl = { kind: 'playlist' as const, playlist: fx.playlist() };
    const cards = buildCards(pl, 'video', 'mp4', 'mp3');
    expect(cards.map((c) => c.request.tier)).toEqual([null, 2160, 1440, 1080, 720, 480, 360]);
    expect(cards.every((c) => c.request.playlist && c.request.playlistCount === 24)).toBe(true);
    const audio = buildCards(pl, 'audio', 'mp4', 'mp3');
    expect(audio.every((c) => c.request.playlist && c.request.mode === 'audio')).toBe(true);
  });

  it('scraped media keeps the page as referer', () => {
    const sn = { kind: 'sniffed' as const, page: 'https://example.com/watch/42', candidates: fx.sniffed() };
    const cards = buildCards(sn, 'video', 'mp4', 'mp3');
    expect(cards[0].request).toMatchObject({ url: 'https://cdn.example.com/media/clip-1080.mp4', referer: 'https://example.com/watch/42' });
  });

  it('suggests 1080 or the best below it', () => {
    expect(defaultSelection(buildCards(yt, 'video', 'mp4', 'mp3'))).toBe('v1080');
    const archive = buildCards({ kind: 'video', media: fx.archive() }, 'video', 'mp4', 'mp3');
    expect(defaultSelection(archive)).toBe('v720');
    expect(defaultSelection([])).toBeNull();
  });
});
