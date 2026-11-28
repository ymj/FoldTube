import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoUrl,
  parseIsoDuration,
  formatDuration,
  cleanTitle,
  urlToVideoData,
  mergeVideos,
  validateImport,
  UNKNOWN_TITLE,
  UNKNOWN_CHANNEL,
} from '../lib/youtube.js';

describe('parseVideoUrl', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { videoId: 'dQw4w9WgXcQ', videoType: 'video' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1', { videoId: 'dQw4w9WgXcQ', videoType: 'video' }],
    ['https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ', { videoId: 'dQw4w9WgXcQ', videoType: 'video' }],
    ['https://m.youtube.com/watch?v=abc123', { videoId: 'abc123', videoType: 'video' }],
    ['https://www.youtube.com/shorts/abc123', { videoId: 'abc123', videoType: 'short' }],
    ['https://www.youtube.com/shorts/abc123/', { videoId: 'abc123', videoType: 'short' }],
    ['https://www.youtube.com/shorts/abc123?feature=share', { videoId: 'abc123', videoType: 'short' }],
    ['https://www.youtube.com/live/xyz789', { videoId: 'xyz789', videoType: 'video' }],
    ['https://www.youtube.com/live/xyz789/', { videoId: 'xyz789', videoType: 'video' }],
  ];
  for (const [url, expected] of cases) {
    test(url, () => assert.deepEqual(parseVideoUrl(url), expected));
  }

  const invalid = [
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch?list=PL1',
    'https://www.youtube.com/shorts/',
    'https://www.youtube.com/live/',
    'https://www.youtube.com/',
    'not a url',
    '',
    undefined,
    null,
  ];
  for (const url of invalid) {
    test(`rejects ${JSON.stringify(url)}`, () => assert.equal(parseVideoUrl(url), null));
  }
});

describe('parseIsoDuration', () => {
  const cases = [
    ['PT1H', 3600],
    ['PT59S', 59],
    ['PT0S', 0],
    ['PT4M13S', 253],
    ['PT1H2M3S', 3723],
    ['PT10H', 36000],
    ['P1DT2H', 93600],
    ['P1D', 86400],
  ];
  for (const [iso, seconds] of cases) {
    test(`${iso} → ${seconds}`, () => assert.equal(parseIsoDuration(iso), seconds));
  }

  for (const bad of ['', 'P', 'PT', '1H2M', 'PT1H2M3', 'PTXS', 'PT-5S', 'garbage', 'xPT5S', 'PT5Sx', null, undefined, 42]) {
    test(`malformed ${JSON.stringify(bad)} → null`, () => assert.equal(parseIsoDuration(bad), null));
  }

  test('P0D (YouTube live streams) is zero', () => assert.equal(parseIsoDuration('P0D'), 0));
});

describe('formatDuration', () => {
  const cases = [
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [253, '4:13'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36000, '10:00:00'],
    [93600, '26:00:00'],
  ];
  for (const [seconds, text] of cases) {
    test(`${seconds} → ${text}`, () => assert.equal(formatDuration(seconds), text));
  }

  test('byte-equal to the previous inline implementation for 0..10000 seconds', () => {
    // The formatter that was copied into the service worker before extraction.
    const previous = (total) => {
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const hStr = h > 0 ? `${h}:` : '';
      const mStr = h > 0 ? m.toString().padStart(2, '0') : m.toString();
      const sStr = s.toString().padStart(2, '0');
      return `${hStr}${mStr}:${sStr}`;
    };
    for (let n = 0; n <= 10000; n++) assert.equal(formatDuration(n), previous(n), `at ${n}`);
  });

  test('bad input formats as 0:00', () => {
    assert.equal(formatDuration(undefined), '0:00');
    assert.equal(formatDuration(-5), '0:00');
    assert.equal(formatDuration(NaN), '0:00');
  });
});

describe('cleanTitle', () => {
  test('strips the YouTube suffix', () => assert.equal(cleanTitle('My Video - YouTube'), 'My Video'));
  test('keeps other titles', () => assert.equal(cleanTitle('My Video'), 'My Video'));
  test('falls back when empty', () => {
    assert.equal(cleanTitle(''), UNKNOWN_TITLE);
    assert.equal(cleanTitle(undefined), UNKNOWN_TITLE);
    assert.equal(cleanTitle(' - YouTube'), UNKNOWN_TITLE);
  });
});

describe('urlToVideoData', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');

  test('builds a URL-only record', () => {
    const url = 'https://www.youtube.com/shorts/abc123';
    assert.deepEqual(urlToVideoData(url, 'Clip - YouTube', now), {
      videoId: 'abc123',
      videoType: 'short',
      url,
      title: 'Clip',
      channelName: UNKNOWN_CHANNEL,
      channelUrl: null,
      thumbnailUrl: 'https://img.youtube.com/vi/abc123/maxresdefault.jpg',
      durationSeconds: 0,
      durationFormatted: '',
      description: '',
      dateSaved: '2026-01-02T03:04:05.000Z',
      metadataSource: 'auto-collapsed',
      timestampSeconds: 0,
    });
  });

  test('returns null without a video ID', () => {
    assert.equal(urlToVideoData('https://www.youtube.com/feed/subscriptions', 'Subs', now), null);
  });
});

describe('mergeVideos', () => {
  const v = (videoId) => ({ videoId });

  test('puts new videos first, newest first', () => {
    const { merged, added } = mergeVideos([v('c'), v('d')], [v('a'), v('b')]);
    assert.deepEqual(merged.map(x => x.videoId), ['c', 'd', 'a', 'b']);
    assert.deepEqual(added.map(x => x.videoId), ['c', 'd']);
  });

  test('skips videos already saved and keeps the saved copy', () => {
    const saved = [{ videoId: 'a', title: 'saved' }];
    const { merged, added } = mergeVideos([{ videoId: 'a', title: 'new' }, v('b')], saved);
    assert.deepEqual(merged, [v('b'), { videoId: 'a', title: 'saved' }]);
    assert.deepEqual(added, [v('b')]);
  });

  test('keeps only the first of repeats within the new batch', () => {
    const { merged } = mergeVideos([{ videoId: 'x', n: 1 }, { videoId: 'x', n: 2 }], []);
    assert.deepEqual(merged, [{ videoId: 'x', n: 1 }]);
  });

  test('does not modify its inputs', () => {
    const incoming = [v('b')];
    const saved = [v('a')];
    mergeVideos(incoming, saved);
    assert.deepEqual(incoming, [v('b')]);
    assert.deepEqual(saved, [v('a')]);
  });

  test('handles empty lists', () => {
    assert.deepEqual(mergeVideos([], []).merged, []);
    assert.deepEqual(mergeVideos([], [v('a')]).merged, [v('a')]);
  });
});

describe('validateImport', () => {
  const good = { videoId: 'a', url: 'https://www.youtube.com/watch?v=a', title: 'A', videoType: 'video' };

  test('accepts valid entries', () => {
    assert.deepEqual(validateImport([good, { ...good, videoId: 'b', videoType: 'short' }]).length, 2);
  });

  test('drops invalid entries and keeps valid ones', () => {
    const data = [
      good,
      null,
      'string',
      { ...good, videoId: '' },
      { ...good, videoId: 7 },
      { ...good, url: '' },
      { ...good, title: undefined },
      { ...good, videoType: 'playlist' },
    ];
    assert.deepEqual(validateImport(data).map(v => v.videoId), ['a']);
  });

  test('an empty backup is valid and empty', () => assert.deepEqual(validateImport([]), []));

  test('rejects a non-array', () => {
    for (const data of [{}, null, 'x', 3]) {
      assert.throws(() => validateImport(data), /Invalid format/);
    }
  });

  test('rejects a backup with entries but none valid', () => {
    assert.throws(() => validateImport([{}, { videoId: 'a' }]), /No valid entries/);
  });
});

describe('countFoldableTabs', async () => {
  const { countFoldableTabs, YOUTUBE_TAB_PATTERNS } = await import('../lib/youtube.js');

  test('counts the tabs a fold would close: those with a video ID', () => {
    const tabs = [
      { url: 'https://www.youtube.com/watch?v=abc' },
      { url: 'https://www.youtube.com/shorts/def' },
      { url: 'https://www.youtube.com/live/ghi' },
      { url: 'https://www.youtube.com/watch' }, // matched by the pattern, but no video ID
      {}, // URL hidden from the extension
    ];
    assert.equal(countFoldableTabs(tabs), 3);
  });

  test('nothing open, or nothing readable → 0', () => {
    assert.equal(countFoldableTabs([]), 0);
    assert.equal(countFoldableTabs(undefined), 0);
  });

  test('tab patterns cover videos, Shorts and live streams', () => {
    // watch?* rather than watch?v=*: v isn't always the first parameter.
    assert.deepEqual(YOUTUBE_TAB_PATTERNS.map(p => p.split('youtube.com/')[1]), ['watch?*', 'shorts/*', 'live/*']);
  });

  test('a watch page counts only with a video ID, wherever v is', () => {
    const tabs = ['https://www.youtube.com/watch?list=L&v=abc', 'https://www.youtube.com/watch?app=desktop&v=def', 'https://www.youtube.com/watch?list=L']
      .map(url => ({ url }));
    assert.equal(countFoldableTabs(tabs), 2);
  });
});
