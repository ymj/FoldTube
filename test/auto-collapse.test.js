// Auto-collapse on window close: the "always" rules.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCollapseVideo } from '../lib/fold.js';
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

  test('a restored tab leaves no duplicate, even after enrichment relabelled it', () => {
    // Saved on close, then enriched before the browser restarted.
    let videos = [autoCollapseVideo({ isWindowClosing: true }, on, tabData), saved('keep')];
    videos = patchVideos(videos, new Map([['abc', { metadataSource: 'api-enriched', channelName: 'Chan' }]])).videos;
    assert.equal(videos[0].metadataSource, 'api-enriched');

    const { videos: after, result } = reconcileRestoredTabs(videos, new Set(['abc']));
    assert.deepEqual(after.map(v => v.videoId), ['keep']);
    assert.equal(result.removed[0].video.videoId, 'abc');
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
  });

  test('videos saved by a fold or import are never removed, even if open', () => {
    const videos = [saved('abc'), saved('def', { metadataSource: 'url-only' })];
    const { videos: after, result } = reconcileRestoredTabs(videos, new Set(['abc', 'def']));
    assert.equal(after, videos, 'nothing to check: same array, no write');
    assert.deepEqual(result.removed, []);
  });

  test('older libraries: an unmarked auto-collapsed entry is checked once', () => {
    const legacy = { videoId: 'abc', metadataSource: 'auto-collapsed' };
    assert.equal(isPendingRestoreCheck(legacy), true);
    assert.deepEqual(reconcileRestoredTabs([legacy], new Set(['abc'])).videos, []);
    const kept = reconcileRestoredTabs([legacy], new Set()).videos;
    assert.equal(isPendingRestoreCheck(kept[0]), false);
  });

  test('a video already in the library is not re-marked by a window-close save', () => {
    const existing = [saved('abc')];
    const { videos } = applyVideoOp(existing, { type: 'add', videos: [autoCollapseVideo({ isWindowClosing: true }, on, tabData)] });
    assert.equal(videos, existing);
    assert.equal(reconcileRestoredTabs(videos, new Set(['abc'])).videos.length, 1);
  });
});
