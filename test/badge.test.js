import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { badgeMode, badgeCount, badgeText, BADGE_MODES, DEFAULT_BADGE_MODE } from '../lib/badge.js';

describe('toolbar badge', () => {
  test('the mode comes from settings; anything else means the default', () => {
    assert.equal(DEFAULT_BADGE_MODE, 'tabs');
    for (const mode of BADGE_MODES) assert.equal(badgeMode({ badge: mode }), mode);
    for (const settings of [undefined, {}, { badge: 'nope' }, { badge: 1 }]) {
      assert.equal(badgeMode(settings), 'tabs', JSON.stringify(settings));
    }
  });

  test('open tabs: only the ones a click would fold', () => {
    const tabs = [
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { url: 'https://www.youtube.com/shorts/abc123' },
      { url: 'https://www.youtube.com/live/xyz789' },
      { url: 'https://www.youtube.com/' },
      { url: 'https://www.youtube.com/@channel' },
      {},
    ];
    assert.equal(badgeCount('tabs', { tabs }), 3);
  });

  test('library: videos in the library only, never History', () => {
    const videos = [
      { videoId: 'a', state: 'active' },
      { videoId: 'b' }, // saved before states existed
      { videoId: 'c', state: 'watched' },
      { videoId: 'd', state: 'deleted' },
      { videoId: 'e', state: 'purged' },
      { videoId: 'f', state: 'active', archivedAt: '2026-11-20T00:00:00.000Z', archivedAs: 'watched' },
    ];
    assert.equal(badgeCount('library', { videos }), 3);
  });

  test('off counts nothing', () => {
    assert.equal(badgeCount('off', { tabs: [{ url: 'https://www.youtube.com/watch?v=x' }], videos: [{ videoId: 'a' }] }), 0);
  });

  test('text: hidden at 0, the number up to 999, then 999+', () => {
    assert.equal(badgeText(0), '');
    assert.equal(badgeText(-1), '');
    assert.equal(badgeText(NaN), '');
    assert.equal(badgeText(1), '1');
    assert.equal(badgeText(999), '999');
    assert.equal(badgeText(1000), '999+');
    assert.equal(badgeText(12345), '999+');
  });

  test('Settings offers the three choices, matching the modes', async () => {
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const select = html.match(/<select id="badge-select"[\s\S]*?<\/select>/)?.[0] ?? '';
    assert.deepEqual([...select.matchAll(/value="(\w+)"/g)].map(m => m[1]), BADGE_MODES);
  });
});
