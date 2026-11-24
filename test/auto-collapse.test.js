// Auto-collapse on window close: the "always" rules.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCollapseVideo, tabSnapshotEntry, buildTabSnapshot, updateTabSnapshot, recoverClosedTabs } from '../lib/fold.js';
import { reconcileRestoredTabs, isPendingRestoreCheck, applyVideoOp, patchVideos } from '../lib/store.js';

const tabData = { url: 'https://www.youtube.com/watch?v=abc', title: 'A video - YouTube' };
const on = { autoCollapse: true };
const off = { autoCollapse: false };

describe('autoCollapseVideo', () => {
  test('window closing + auto-collapse on → saves the tab, marked for the restore check', () => {
    const video = autoCollapseVideo({ isWindowClosing: true }, on, tabData);
    assert.equal(video.videoId, 'abc');
    assert.equal(video.title, 'A video');
    assert.equal(video.metadataSource, 'auto-collapsed');
    assert.equal(video.pendingRestoreCheck, true);
  });

  test('closing a single tab normally never saves it', () => {
    assert.equal(autoCollapseVideo({ isWindowClosing: false }, on, tabData), null);
    assert.equal(autoCollapseVideo({}, on, tabData), null);
  });

  test('auto-collapse off → nothing is saved on any close', () => {
    assert.equal(autoCollapseVideo({ isWindowClosing: true }, off, tabData), null);
    assert.equal(autoCollapseVideo({ isWindowClosing: false }, off, tabData), null);
    assert.equal(autoCollapseVideo({ isWindowClosing: true }, {}, tabData), null);
  });

  test('a tab we have no record of, or without a video ID, is not saved', () => {
    assert.equal(autoCollapseVideo({ isWindowClosing: true }, on, undefined), null);
    assert.equal(autoCollapseVideo({ isWindowClosing: true }, on, { url: 'https://www.youtube.com/', title: 'YouTube' }), null);
  });
});

describe('reconcileRestoredTabs', () => {
  const saved = (videoId, extra) => ({ videoId, metadataSource: 'scrape', ...extra });

  test('a restored tab moves to History as watched, even after enrichment relabelled it', () => {
    // Saved on close, then enriched before the browser restarted.
    let videos = [autoCollapseVideo({ isWindowClosing: true }, on, tabData), saved('keep')];
    videos = patchVideos(videos, new Map([['abc', { metadataSource: 'api-enriched', channelName: 'Chan' }]])).videos;
    assert.equal(videos[0].metadataSource, 'api-enriched');

    const { videos: after, result } = reconcileRestoredTabs(videos, new Set(['abc']), { deviceId: 'dev', now: new Date('2026-11-24T10:00:00Z') });
    assert.deepEqual(after.map(v => v.videoId), ['abc', 'keep'], 'nothing removed');
    assert.equal(after[0].state, 'watched');
    assert.equal(after[0].stateChangedAt, '2026-11-24T10:00:00.000Z');
    assert.equal(after[0].stateChangedBy, 'dev');
    assert.equal(after[0].pendingRestoreCheck, false);
    assert.deepEqual(result.reopened, ['abc']);
  });

  test('a video saved on close whose tab was not restored is kept and marked checked', () => {
    const videos = [autoCollapseVideo({ isWindowClosing: true }, on, tabData)];
    const { videos: after } = reconcileRestoredTabs(videos, new Set());
    assert.equal(after.length, 1);
    assert.equal(after[0].pendingRestoreCheck, false);
    assert.equal(isPendingRestoreCheck(after[0]), false);
  });

  test('once checked, a later startup with that video open does not delete it', () => {
    let videos = [autoCollapseVideo({ isWindowClosing: true }, on, tabData)];
    videos = reconcileRestoredTabs(videos, new Set()).videos;      // first startup: not restored
    videos = reconcileRestoredTabs(videos, new Set(['abc'])).videos; // weeks later: user opened it again
    assert.deepEqual(videos.map(v => v.videoId), ['abc']);
    assert.notEqual(videos[0].state, 'watched');
  });

  test('videos saved by a fold or import are never removed, even if open', () => {
    const videos = [saved('abc'), saved('def', { metadataSource: 'url-only' })];
    const { videos: after, result } = reconcileRestoredTabs(videos, new Set(['abc', 'def']));
    assert.equal(after, videos, 'nothing to check: same array, no write');
    assert.deepEqual(result.reopened, []);
  });

  test('older libraries: an unmarked auto-collapsed entry is checked once', () => {
    const legacy = { videoId: 'abc', metadataSource: 'auto-collapsed' };
    assert.equal(isPendingRestoreCheck(legacy), true);
    assert.equal(reconcileRestoredTabs([legacy], new Set(['abc'])).videos[0].state, 'watched');
    const kept = reconcileRestoredTabs([legacy], new Set()).videos;
    assert.equal(isPendingRestoreCheck(kept[0]), false);
  });

  test('a video already in the library is not re-marked by a window-close save', () => {
    const existing = [saved('abc')];
    const { videos } = applyVideoOp(existing, { type: 'add', videos: [autoCollapseVideo({ isWindowClosing: true }, on, tabData)] });
    assert.equal(videos, existing);
    assert.equal(reconcileRestoredTabs(videos, new Set(['abc'])).videos, videos);
  });
});

describe('open-tabs list (write-ahead)', () => {
  const yt = (id, videoId, title = `Video ${videoId} - YouTube`) =>
    ({ id, url: `https://www.youtube.com/watch?v=${videoId}`, title });

  test('lists YouTube video tabs only', () => {
    assert.deepEqual(tabSnapshotEntry(yt(1, 'abc')), { url: 'https://www.youtube.com/watch?v=abc', title: 'Video abc - YouTube' });
    assert.equal(tabSnapshotEntry({ url: 'https://www.youtube.com/' }), null);
    assert.equal(tabSnapshotEntry({ url: 'https://example.com/watch?v=abc' }), null);
    assert.equal(tabSnapshotEntry({ url: 'chrome://newtab/' }), null);
    assert.equal(tabSnapshotEntry({}), null);
  });

  test('buildTabSnapshot keys entries by tab ID', () => {
    const snap = buildTabSnapshot([yt(1, 'a'), { id: 2, url: 'https://example.com/' }, yt(3, 'c')]);
    assert.deepEqual(Object.keys(snap), ['1', '3']);
  });

  test('updateTabSnapshot adds, updates, drops, and skips no-ops', () => {
    let snap = {};
    snap = updateTabSnapshot(snap, 1, yt(1, 'a', 'YouTube'));
    snap = updateTabSnapshot(snap, 1, yt(1, 'a'));
    assert.equal(snap[1].title, 'Video a - YouTube', 'title updated once the page loads');

    const same = updateTabSnapshot(snap, 1, yt(1, 'a'));
    assert.equal(same, snap, 'unchanged: same object, no write');

    snap = updateTabSnapshot(snap, 1, { id: 1, url: 'https://www.google.com/' });
    assert.deepEqual(snap, {}, 'navigated away from YouTube: dropped');
    assert.equal(updateTabSnapshot(snap, 2, { url: 'https://example.com/' }), snap);
  });

  test('quit with 30 tabs, none restored: all 30 recovered', () => {
    const tabs = Array.from({ length: 30 }, (_, i) => yt(i + 1, `v${i}`));
    const videos = recoverClosedTabs(buildTabSnapshot(tabs), new Set(), on);
    assert.equal(videos.length, 30);
    assert.equal(videos[0].title, 'Video v0');
    assert.equal(videos[0].metadataSource, 'auto-collapsed');
  });

  test('restored tabs are not recovered, so no duplicates', () => {
    const snap = buildTabSnapshot([yt(1, 'a'), yt(2, 'b'), yt(3, 'c')]);
    const videos = recoverClosedTabs(snap, new Set(['a', 'c']), on);
    assert.deepEqual(videos.map(v => v.videoId), ['b']);
  });

  test('auto-collapse off: nothing recovered', () => {
    const snap = buildTabSnapshot([yt(1, 'a')]);
    assert.deepEqual(recoverClosedTabs(snap, new Set(), off), []);
    assert.deepEqual(recoverClosedTabs(snap, new Set(), {}), []);
  });

  test('a tab closed on purpose is dropped from the list, so it is never recovered', () => {
    const snap = buildTabSnapshot([yt(1, 'a'), yt(2, 'b')]);
    const { 1: _closed, ...rest } = snap;
    assert.deepEqual(recoverClosedTabs(rest, new Set(), on).map(v => v.videoId), ['b']);
  });

  test('a tab saved on close and also recovered is stored once', () => {
    const liveSave = autoCollapseVideo({ isWindowClosing: true }, on, tabData);
    let { videos } = applyVideoOp([], { type: 'add', videos: [liveSave] });
    const recovered = recoverClosedTabs(buildTabSnapshot([{ id: 1, ...tabData }]), new Set(), on);
    ({ videos } = applyVideoOp(videos, { type: 'add', videos: recovered }));
    assert.deepEqual(videos.map(v => v.videoId), ['abc']);
  });

  test('a malformed stored list is ignored', () => {
    assert.deepEqual(recoverClosedTabs(undefined, new Set(), on), []);
    assert.deepEqual(recoverClosedTabs({ 1: null, 2: { url: 42 } }, new Set(), on), []);
  });
});
