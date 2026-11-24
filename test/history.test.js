import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyVideoOp } from '../lib/store.js';
import { purgeExpired, daysLeft, tombstone, isActive, isArchived, ARCHIVE_DAYS } from '../lib/archive.js';
import { historyItems, groupByDay, dayLabel, expiryLabel, matchesSearch } from '../lib/history.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const ctx = { deviceId: 'device-1', now: NOW };
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const video = (videoId, extra = {}) => ({
  videoId, title: `Title ${videoId}`, channelName: 'Chan', url: `https://www.youtube.com/watch?v=${videoId}`,
  dateSaved: '2026-11-01T00:00:00.000Z', state: 'active', timestampSeconds: 300, ...extra,
});
const op = (videos, o, c = ctx) => applyVideoOp(videos, o, c);

describe('opening and removing change state', () => {
  const library = [video('a'), video('b'), video('c')];

  test('opening marks watched, removing marks deleted, both stamped', () => {
    const opened = op(library, { type: 'archive', videoIds: ['a'], state: 'watched' }).videos;
    assert.equal(opened[0].state, 'watched');
    assert.equal(opened[0].stateChangedAt, NOW.toISOString());
    assert.equal(opened[0].stateChangedBy, 'device-1');
    assert.equal(opened[0].timestampSeconds, 300, 'position kept for a restore');
    const removed = op(library, { type: 'archive', videoIds: ['b', 'c'], state: 'deleted' }).videos;
    assert.deepEqual(removed.map(v => v.state), ['active', 'deleted', 'deleted']);
    assert.equal(removed.length, 3, 'nothing removed from storage');
  });

  test('only library videos change; other states are refused', () => {
    const watched = op(library, { type: 'archive', videoIds: ['a'], state: 'watched' }).videos;
    const again = op(watched, { type: 'archive', videoIds: ['a'], state: 'deleted' }, { ...ctx, now: new Date() });
    assert.equal(again.videos, watched);
    assert.throws(() => op(library, { type: 'archive', videoIds: ['a'], state: 'purged' }), /Cannot archive/);
    assert.throws(() => op(library, { type: 'remove', videoIds: ['a'] }), /Unknown/);
  });

  test('undo puts them back with their save date, stamped as a new change', () => {
    const later = { ...ctx, now: new Date(NOW.getTime() + 3000) };
    const { videos, result } = op(library, { type: 'archive', videoIds: ['a', 'b'], state: 'deleted' });
    const undone = op(videos, { type: 'unarchive', videoIds: result.changed }, later).videos;
    assert.ok(undone.every(isActive));
    assert.equal(undone[0].dateSaved, library[0].dateSaved);
    assert.equal(undone[0].stateChangedAt, later.now.toISOString());
  });

  test('undo after the video was folded again meanwhile changes nothing', () => {
    const { videos, result } = op(library, { type: 'archive', videoIds: ['a'], state: 'watched' });
    const refolded = op(videos, { type: 'add', videos: [video('a', { dateSaved: NOW.toISOString(), metadataSource: 'scrape' })] }).videos;
    assert.equal(refolded[0].videoId, 'a');
    assert.equal(refolded[0].dateSaved, NOW.toISOString());
    assert.equal(op(refolded, { type: 'unarchive', videoIds: result.changed }).videos, refolded);
  });

  test('no part of the extension asks to remove records', async () => {
    for (const f of ['dashboard/dashboard.js', 'background/service-worker.js']) {
      const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /type: ['"](remove|restore)['"]/, f);
    }
  });
});

describe('the 90-day rule', () => {
  test(`${ARCHIVE_DAYS} days after the last change, history goes`, () => {
    const videos = [
      video('w89', { state: 'watched', stateChangedAt: daysAgo(89) }),
      video('w90', { state: 'watched', stateChangedAt: daysAgo(90) }),
      video('d91', { state: 'deleted', stateChangedAt: daysAgo(91) }),
      { videoId: 'p91', state: 'purged', stateChangedAt: daysAgo(91) },
      { videoId: 'p10', state: 'purged', stateChangedAt: daysAgo(10) },
      video('old', { state: 'active', stateChangedAt: daysAgo(400) }),
      video('legacy', { state: undefined }),
    ];
    const { videos: after, result } = purgeExpired(videos, NOW);
    assert.deepEqual(after.map(v => v.videoId), ['w89', 'p10', 'old', 'legacy']);
    assert.equal(result.purged, 3);
  });

  test('nothing due: same array, so no write; running twice changes nothing', () => {
    const videos = [video('a'), video('w', { state: 'watched', stateChangedAt: daysAgo(100) })];
    const once = op(videos, { type: 'purge' }).videos;
    assert.equal(once.length, 1);
    assert.equal(op(once, { type: 'purge' }).videos, once);
  });

  test('a record with no readable date is kept', () => {
    const videos = [video('w', { state: 'watched', stateChangedAt: 'garbage' })];
    assert.equal(purgeExpired(videos, NOW).videos, videos);
    assert.ok(Number.isNaN(daysLeft(videos[0], NOW)));
  });

  test('days left, for "Removed in N days"', () => {
    assert.equal(daysLeft({ stateChangedAt: NOW.toISOString() }, NOW), 90);
    assert.equal(daysLeft({ stateChangedAt: daysAgo(89.5) }, NOW), 1);
    assert.equal(daysLeft({ stateChangedAt: daysAgo(95) }, NOW), 0);
    assert.equal(expiryLabel(12), 'Removed in 12 days');
    assert.equal(expiryLabel(1), 'Removed tomorrow');
    assert.equal(expiryLabel(0), 'Removed today');
    assert.equal(expiryLabel(NaN), '');
  });

  test('importing a backup does not bring back expired history', () => {
    const incoming = [
      video('fresh', { state: 'watched', stateChangedAt: daysAgo(5) }),
      video('stale', { state: 'deleted', stateChangedAt: daysAgo(120) }),
    ];
    const { videos } = op([], { type: 'import', videos: incoming });
    assert.deepEqual(videos.map(v => v.videoId), ['fresh']);
  });
});

describe('deleting forever', () => {
  const history = [
    video('a', { state: 'watched', stateChangedAt: daysAgo(1) }),
    video('b', { state: 'deleted', stateChangedAt: daysAgo(2) }),
    video('c'),
  ];

  test('leaves a tombstone with nothing about the video', () => {
    const { videos, result } = op(history, { type: 'forget', videoIds: ['a', 'c'] });
    assert.deepEqual(result.changed, ['a'], 'library videos are not deleted forever');
    assert.deepEqual(videos[0], { videoId: 'a', state: 'purged', stateChangedAt: NOW.toISOString(), stateChangedBy: 'device-1' });
    assert.deepEqual(tombstone(history[1], ctx), { videoId: 'b', state: 'purged', stateChangedAt: NOW.toISOString(), stateChangedBy: 'device-1' });
  });

  test('Clear history deletes every watched and deleted video, nothing in the library', () => {
    const { videos, result } = op(history, { type: 'clearHistory' });
    assert.deepEqual(result.changed, ['a', 'b']);
    assert.deepEqual(videos.map(v => v.state), ['purged', 'purged', 'active']);
    assert.equal(op(videos, { type: 'clearHistory' }).videos, videos, 'nothing left: no write');
  });

  test('a tombstone is not restorable, but folding the video again saves it anew', () => {
    const gone = op(history, { type: 'forget', videoIds: ['a'] }).videos;
    assert.equal(op(gone, { type: 'unarchive', videoIds: ['a'] }).videos, gone);
    const folded = op(gone, { type: 'add', videos: [video('a', { title: 'Again', state: undefined, dateSaved: NOW.toISOString() })] });
    assert.equal(folded.result.added, 1);
    assert.equal(folded.videos[0].title, 'Again');
    assert.equal(folded.videos[0].state, 'active');
  });
});

describe('the History list', () => {
  const records = [
    video('lib'),
    video('old', { state: 'deleted', stateChangedAt: '2026-11-20T09:00:00.000Z', title: 'Cooking pasta' }),
    video('new', { state: 'watched', stateChangedAt: '2026-11-24T08:00:00.000Z', channelName: 'Bon Appetit' }),
    video('yday', { state: 'watched', stateChangedAt: '2026-11-23T08:00:00.000Z' }),
    { videoId: 'gone', state: 'purged', stateChangedAt: '2026-11-24T09:00:00.000Z' },
  ];

  test('watched and deleted only, newest change first', () => {
    assert.deepEqual(historyItems(records).map(v => v.videoId), ['new', 'yday', 'old']);
    assert.ok(historyItems(records).every(isArchived));
  });

  test('search matches title and channel like the library search', () => {
    assert.deepEqual(historyItems(records, 'pasta').map(v => v.videoId), ['old']);
    assert.deepEqual(historyItems(records, 'bon app').map(v => v.videoId), ['new']);
    assert.equal(matchesSearch({ description: 'about knives' }, 'knives'), true);
    assert.equal(matchesSearch({}, ''), true);
  });

  test('grouped by day: Today, Yesterday, then the date', () => {
    const now = new Date(2026, 10, 24, 15, 0);
    const at = (d, h) => new Date(2026, 10, d, h).toISOString();
    const items = [
      { videoId: '1', stateChangedAt: at(24, 9) },
      { videoId: '2', stateChangedAt: at(24, 1) },
      { videoId: '3', stateChangedAt: at(23, 22) },
      { videoId: '4', stateChangedAt: at(12, 10) },
    ];
    const groups = groupByDay(items, now, 'en-GB');
    assert.deepEqual(groups.map(g => g.label), ['Today', 'Yesterday', '12 Nov']);
    assert.deepEqual(groups.map(g => g.items.length), [2, 1, 1]);
    assert.equal(dayLabel(new Date(2025, 10, 12), now, 'en-GB'), '12 Nov 2025');
  });

  test('a thousand entries sort, filter and group quickly', () => {
    const many = Array.from({ length: 1000 }, (_, i) => video(`v${i}`, {
      state: i % 2 ? 'watched' : 'deleted', stateChangedAt: daysAgo(i % 90), title: `Video number ${i}`,
    }));
    const start = performance.now();
    groupByDay(historyItems(many), NOW);
    groupByDay(historyItems(many, 'number 9'), NOW);
    assert.ok(performance.now() - start < 100);
  });
});
