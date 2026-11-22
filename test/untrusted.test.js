// Imported backups and stored records are untrusted: a crafted backup must not
// inject markup into the HTML export or point the dashboard at other hosts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isYouTubeUrl,
  sanitizeImportedVideo,
  validateImport,
  buildHtmlExport,
  escapeHtml,
  UNKNOWN_CHANNEL,
} from '../lib/youtube.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');
const PAYLOAD = '"><script>alert(1)</script>';

const malicious = {
  videoId: 'dQw4w9WgXcQ',
  videoType: 'video',
  url: `https://www.youtube.com/watch?v=dQw4w9WgXcQ${PAYLOAD}`,
  title: `<img src=x onerror=alert(1)>`,
  channelName: `<b>${PAYLOAD}</b>`,
  channelUrl: 'javascript:alert(1)',
  thumbnailUrl: 'https://evil.example/pixel.gif?u=123',
  durationSeconds: 61,
  durationFormatted: `1:01${PAYLOAD}`,
  description: 'ok',
  dateSaved: '2025-05-05T05:05:05.000Z',
  metadataSource: 'scrape',
  extraField: 'should be dropped',
};

describe('isYouTubeUrl', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=a',
    'https://youtube.com/watch?v=a',
    'https://m.youtube.com/watch?v=a',
    'https://music.youtube.com/watch?v=a',
    'https://youtu.be/a',
    'https://www.youtube.com/@channel',
  ]) {
    test(`accepts ${url}`, () => assert.equal(isYouTubeUrl(url), true));
  }
  for (const url of [
    'http://www.youtube.com/watch?v=a',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example/watch?v=a',
    'https://youtube.com.evil.example/watch?v=a',
    'https://evilyoutube.com/watch?v=a',
    'https://user:pass@www.youtube.com/watch?v=a',
    'https://youtu.be.evil.example/a',
    '',
    null,
    42,
  ]) {
    test(`rejects ${JSON.stringify(url)}`, () => assert.equal(isYouTubeUrl(url), false));
  }
});

describe('sanitizeImportedVideo', () => {
  const clean = sanitizeImportedVideo(malicious, NOW);

  test('keeps the entry, as its URL is on youtube.com', () => assert.ok(clean));

  test('regenerates the thumbnail from the video ID', () => {
    assert.equal(clean.thumbnailUrl, 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
  });

  test('drops a non-YouTube channel link', () => assert.equal(clean.channelUrl, null));

  test('rebuilds the formatted duration from the seconds', () => {
    assert.equal(clean.durationSeconds, 61);
    assert.equal(clean.durationFormatted, '1:01');
  });

  test('keeps only known fields', () => {
    assert.deepEqual(Object.keys(clean).sort(), [
      'channelName', 'channelUrl', 'dateSaved', 'description', 'durationFormatted',
      'durationSeconds', 'metadataSource', 'thumbnailUrl', 'title', 'url', 'videoId', 'videoType',
    ]);
  });

  test('keeps a valid date and known source', () => {
    assert.equal(clean.dateSaved, '2025-05-05T05:05:05.000Z');
    assert.equal(clean.metadataSource, 'scrape');
  });

  test('drops entries whose link is not a YouTube https URL', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.example/watch?v=a', 'http://www.youtube.com/watch?v=a']) {
      assert.equal(sanitizeImportedVideo({ ...malicious, url }, NOW), null, url);
    }
  });

  test('drops entries whose video ID could break out of a URL', () => {
    for (const videoId of ['a/../../x', 'a"b', 'a b', '<x>', 'x'.repeat(65)]) {
      assert.equal(sanitizeImportedVideo({ ...malicious, videoId }, NOW), null, videoId);
    }
  });

  test('repairs bad optional fields', () => {
    const v = sanitizeImportedVideo({
      ...malicious,
      channelName: 7,
      durationSeconds: 'lots',
      description: { a: 1 },
      dateSaved: 'not a date',
      metadataSource: 'something-else',
    }, NOW);
    assert.equal(v.channelName, UNKNOWN_CHANNEL);
    assert.equal(v.durationSeconds, 0);
    assert.equal(v.durationFormatted, '');
    assert.equal(v.description, '');
    assert.equal(v.dateSaved, NOW.toISOString());
    assert.equal(v.metadataSource, 'imported');
  });

  test('negative or fractional durations are repaired', () => {
    assert.equal(sanitizeImportedVideo({ ...malicious, durationSeconds: -5 }, NOW).durationSeconds, 0);
    assert.equal(sanitizeImportedVideo({ ...malicious, durationSeconds: 61.9 }, NOW).durationSeconds, 61);
  });

  test('validateImport applies the same repairs', () => {
    const [v] = validateImport([malicious], NOW);
    assert.deepEqual(v, clean);
  });
});

describe('buildHtmlExport', () => {
  const labels = { date: '2026-01-02', exportedAt: '<i>now</i>' };

  // The export must contain no tag or attribute we did not write ourselves.
  const assertNoPayload = (html) => {
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img src=x/i);
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /<i>/);
    assert.doesNotMatch(html, /evil\.example/);
    assert.doesNotMatch(html, /javascript:/i);
  };

  test('escapes every stored value, even if it never went through import', () => {
    const html = buildHtmlExport([malicious], labels);
    assertNoPayload(html);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /1:01&quot;&gt;&lt;script&gt;/);
  });

  test('a YouTube link is kept, escaped, as the href', () => {
    const html = buildHtmlExport([malicious], labels);
    assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&quot;&gt;&lt;script&gt;/);
  });

  test('a non-YouTube link is left out', () => {
    const html = buildHtmlExport([{ ...malicious, url: 'javascript:alert(1)' }], labels);
    assertNoPayload(html);
    assert.doesNotMatch(html, /<a /);
  });

  test('the thumbnail comes from the video ID, never the stored URL', () => {
    const html = buildHtmlExport([malicious], labels);
    assert.match(html, /<img src="https:\/\/img\.youtube\.com\/vi\/dQw4w9WgXcQ\/mqdefault\.jpg" alt="">/);
    const bad = buildHtmlExport([{ ...malicious, videoId: '"><script>' }], labels);
    assertNoPayload(bad);
    assert.doesNotMatch(bad, /<img/);
  });

  test('an import→export round trip has no payload', () => {
    assertNoPayload(buildHtmlExport(validateImport([malicious], NOW), labels));
  });

  test('a clean library exports as before', () => {
    const html = buildHtmlExport([{
      videoId: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'Rock & Roll',
      channelName: 'Chan', durationFormatted: '4:13',
    }], { date: '2026-01-02', exportedAt: '1/2/2026' });
    assert.match(html, /<title>FoldTube Backup — 2026-01-02<\/title>/);
    assert.match(html, /1 saved tabs · Exported 1\/2\/2026/);
    assert.match(html, /<a href="https:\/\/www\.youtube\.com\/watch\?v=abc" target="_blank" rel="noopener noreferrer">Rock &amp; Roll<\/a>/);
    assert.match(html, /<div class="meta">Chan · 4:13<\/div>/);
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-special characters', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;');
  });
  test('handles non-strings', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });
});
