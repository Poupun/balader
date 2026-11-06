import { describe, expect, it } from 'vitest';
import { basename, bytes, compact, duration, eta, extractUrl, looksLikeUrl, tierBig, tierClass, tierName, uploadDate } from '../../src/ui/format';

describe('format', () => {
  it('bytes', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1_500)).toBe('1.5 KB');
    expect(bytes(142_000_000)).toBe('142 MB');
    expect(bytes(2_400_000_000, true)).toBe('~2.4 GB');
    expect(bytes(null)).toBe('?');
    expect(bytes(-1)).toBe('?');
  });

  it('durations and ETAs', () => {
    expect(duration(754)).toBe('12:34');
    expect(duration(3725)).toBe('1:02:05');
    expect(duration(null)).toBe('--:--');
    expect(eta(4.2)).toBe('4s');
    expect(eta(0.2)).toBe('1s');
    expect(eta(95)).toBe('1:35');
    expect(eta(undefined)).toBe('');
  });

  it('compact counts and dates', () => {
    expect(compact(1_284_330)).toBe('1.3M');
    expect(compact(48_000)).toBe('48K');
    expect(compact(999)).toBe('999');
    expect(uploadDate('20250614')).toBe('Jun 14, 2025');
    expect(uploadDate('nope')).toBe('');
  });

  it('tier flavour', () => {
    expect(tierName(2160)).toBe('ULTRA');
    expect(tierName(1080)).toBe('FULL HD');
    expect(tierName(144)).toBe('POTATO');
    expect(tierBig(2160)).toBe('4K');
    expect(tierBig(1440)).toBe('2K');
    expect(tierBig(720)).toBe('720');
    expect(tierBig(0)).toBe('BEST');
    expect(tierClass(4320)).toBe('t-gold');
    expect(tierClass(360)).toBe('t-teal');
  });

  it('pulls links out of messy pastes', () => {
    expect(extractUrl('look at this: https://youtu.be/abc?t=4, so good!')).toBe('https://youtu.be/abc?t=4');
    expect(extractUrl('  vimeo.com/123  ')).toBe('vimeo.com/123');
    expect(extractUrl('hello world')).toBeNull();
    expect(looksLikeUrl('https://x.com/a')).toBe(true);
    expect(looksLikeUrl('two words')).toBe(false);
  });

  it('basename works with both separators', () => {
    expect(basename('/Users/you/Downloads/Balader')).toBe('Balader');
    expect(basename('C:\\Users\\you\\Downloads\\Balader\\')).toBe('Balader');
  });
});
