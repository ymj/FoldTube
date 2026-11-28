import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTabs, stillShowsVideo } from '../lib/fold.js';
import { mergeVideos } from '../lib/youtube.js';

const tab = (id, videoId, extra = {}) => ({
  id,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  title: `Video ${videoId} - YouTube`,
  status: 'complete',
  discarded: false,
  ...extra,
});

const scraped = (videoId) => ({ videoId, videoType: 'video', title: `Scraped ${videoId}`, metadataSource: 'scrape' });

// A fake browser: storage is an array, open tabs are a Set of IDs, and every
// call is logged so tests can check what happened in which order.
function fakeBrowser({ savedVideos = [], readTab, save, closeTab } = {}) {
  const state = { savedVideos: [...savedVideos], open: new Set(), log: [] };
  const deps = {
    readTab: readTab ?? (async (t) => scraped(new URL(t.url).searchParams.get('v'))),
    save: async (videos) => {
      state.log.push('save');
      if (save) await save(videos);
      state.savedVideos = mergeVideos(videos, state.savedVideos).merged;
    },
    closeTab: async (id, videoId) => {
      state.log.push(`close:${id}`);
      if (closeTab) await closeTab(id, videoId);
      state.open.delete(id);
    },
  };
  return { state, deps, openAll: (tabs) => tabs.forEach(t => state.open.add(t.id)) };
}

describe('foldTabs', () => {
  test('each tab is closed with the video saved from it, so the closer can check', async () => {
    const tabs = [tab(1, 'aaa'), tab(2, 'bbb')];
    const asked = [];
    const b = fakeBrowser({ closeTab: async (id, videoId) => { asked.push([id, videoId]); } });
    await foldTabs(tabs, b.deps);
    assert.deepEqual(asked, [[1, 'aaa'], [2, 'bbb']]);
  });

  test('a tab that moved on during the fold stays open, still saved', async () => {
    const tabs = [tab(1, 'aaa'), tab(2, 'bbb')];
    // Tab 2 now shows another site: the closer refuses, as the worker's does.
    const now = { 1: { url: 'https://www.youtube.com/watch?v=aaa' }, 2: { url: 'https://example.com/' } };
    const b = fakeBrowser({
      closeTab: async (id, videoId) => { if (!stillShowsVideo(now[id], videoId)) throw new Error('moved on'); },
    });
    b.openAll(tabs);
    const result = await foldTabs(tabs, b.deps);
    assert.deepEqual(result, { closed: 1, leftOpen: 1, saved: 2, saveFailed: false });
    assert.deepEqual([...b.state.open], [2]);
  });

  test('fold 5 tabs: all 5 saved, all 5 closed', async () => {
    const tabs = [1, 2, 3, 4, 5].map(n => tab(n, `v${n}`));
    const b = fakeBrowser();
    b.openAll(tabs);
    const result = await foldTabs(tabs, b.deps);
    assert.deepEqual(result, { closed: 5, leftOpen: 0, saved: 5, saveFailed: false });
    assert.deepEqual(b.state.savedVideos.map(v => v.videoId), ['v1', 'v2', 'v3', 'v4', 'v5']);
    assert.equal(b.state.open.size, 0);
  });

  test('saves once, before closing any tab', async () => {
    const tabs = [tab(1, 'a'), tab(2, 'b')];
    const b = fakeBrowser();
    await foldTabs(tabs, b.deps);
    assert.deepEqual(b.state.log, ['save', 'close:1', 'close:2']);
  });

  test('scrape returns nothing → saved from URL and title, then closed', async () => {
    const b = fakeBrowser({ readTab: async () => null });
    const result = await foldTabs([tab(1, 'abc')], b.deps);
    assert.equal(result.closed, 1);
    assert.equal(b.state.savedVideos[0].videoId, 'abc');
    assert.equal(b.state.savedVideos[0].title, 'Video abc');
    assert.equal(b.state.savedVideos[0].metadataSource, 'url-only');
  });

  test('executeScript throws (crashed or navigating tab) → same URL fallback', async () => {
    const b = fakeBrowser({ readTab: async () => { throw new Error('Cannot access contents of the page'); } });
    const result = await foldTabs([tab(1, 'abc')], b.deps);
    assert.equal(result.closed, 1);
    assert.equal(b.state.savedVideos[0].metadataSource, 'url-only');
  });

  test('discarded tabs are not scraped and are marked discarded', async () => {
    let scrapes = 0;
    const b = fakeBrowser({ readTab: async () => { scrapes++; return null; } });
    await foldTabs([tab(1, 'a', { discarded: true }), tab(2, 'b', { status: 'unloaded' })], b.deps);
    assert.equal(scrapes, 0);
    assert.deepEqual(b.state.savedVideos.map(v => v.metadataSource), ['discarded', 'discarded']);
  });

  test('no video ID in the URL → tab left open, nothing saved', async () => {
    const noId = { id: 9, url: 'https://www.youtube.com/watch', title: 'YouTube', status: 'complete' };
    const b = fakeBrowser({ readTab: async () => null });
    b.openAll([noId, tab(1, 'a')]);
    const result = await foldTabs([noId, tab(1, 'a')], b.deps);
    assert.deepEqual(result, { closed: 1, leftOpen: 1, saved: 1, saveFailed: false });
    assert.ok(b.state.open.has(9));
    assert.deepEqual(b.state.savedVideos.map(v => v.videoId), ['a']);
  });

  test('only unsaveable tabs → nothing saved or closed', async () => {
    const noId = { id: 9, url: 'https://www.youtube.com/watch', title: 'YouTube' };
    const b = fakeBrowser({ readTab: async () => null });
    const result = await foldTabs([noId], b.deps);
    assert.deepEqual(result, { closed: 0, leftOpen: 1, saved: 0, saveFailed: false });
    assert.deepEqual(b.state.log, []);
  });

  test('save throws mid-fold → every tab stays open', async () => {
    const tabs = [tab(1, 'a'), tab(2, 'b'), tab(3, 'c')];
    const b = fakeBrowser({ save: async () => { throw new Error('storage quota exceeded'); } });
    b.openAll(tabs);
    const result = await foldTabs(tabs, b.deps);
    assert.deepEqual(result, { closed: 0, leftOpen: 3, saved: 0, saveFailed: true });
    assert.equal(b.state.open.size, 3);
    assert.ok(!b.state.log.some(l => l.startsWith('close')));
  });

  test('reading throws partway through → no tab is closed before the save', async () => {
    let n = 0;
    const b = fakeBrowser({
      readTab: async (t) => {
        n++;
        if (n === 2) throw new Error('boom');
        return scraped(new URL(t.url).searchParams.get('v'));
      },
    });
    const tabs = [tab(1, 'a'), tab(2, 'b'), tab(3, 'c')];
    await foldTabs(tabs, b.deps);
    assert.equal(b.state.log[0], 'save');
    assert.deepEqual(b.state.savedVideos.map(v => v.videoId), ['a', 'b', 'c']);
  });

  test('a tab that fails to close is counted as left open, but stays saved', async () => {
    const b = fakeBrowser({ closeTab: async (id) => { if (id === 2) throw new Error('No tab with id: 2'); } });
    const result = await foldTabs([tab(1, 'a'), tab(2, 'b'), tab(3, 'c')], b.deps);
    assert.deepEqual(result, { closed: 2, leftOpen: 1, saved: 3, saveFailed: false });
    assert.equal(b.state.savedVideos.length, 3);
  });

  test('dedupe and newest-first ordering are preserved', async () => {
    const b = fakeBrowser({ savedVideos: [{ videoId: 'old1' }, { videoId: 'b', title: 'kept' }] });
    const result = await foldTabs([tab(1, 'a'), tab(2, 'b'), tab(3, 'a')], b.deps);
    assert.equal(result.closed, 3, 'a duplicate tab is still closed: its video is saved');
    assert.deepEqual(b.state.savedVideos.map(v => v.videoId), ['a', 'old1', 'b']);
    assert.equal(b.state.savedVideos.find(v => v.videoId === 'b').title, 'kept');
  });
});

describe('stillShowsVideo', () => {
  test('the same video, in any YouTube form', () => {
    assert.equal(stillShowsVideo({ url: 'https://www.youtube.com/watch?v=abc&t=10' }, 'abc'), true);
    assert.equal(stillShowsVideo({ url: 'https://www.youtube.com/watch?list=L&v=abc' }, 'abc'), true);
    assert.equal(stillShowsVideo({ url: 'https://m.youtube.com/shorts/abc/' }, 'abc'), true);
  });

  test('moved on: another video, another site, unknown, or on its way elsewhere', () => {
    assert.equal(stillShowsVideo({ url: 'https://www.youtube.com/watch?v=xyz' }, 'abc'), false);
    assert.equal(stillShowsVideo({ url: 'https://example.com/watch?v=abc' }, 'abc'), false);
    assert.equal(stillShowsVideo({}, 'abc'), false, 'no URL: not a page FoldTube can see any more');
    assert.equal(stillShowsVideo(null, 'abc'), false);
    assert.equal(stillShowsVideo({ url: 'https://www.youtube.com/watch?v=abc', pendingUrl: 'https://example.com/' }, 'abc'), false);
    assert.equal(stillShowsVideo({ url: 'https://www.youtube.com/watch?v=abc', pendingUrl: 'https://www.youtube.com/watch?v=abc&t=5' }, 'abc'), true);
  });
});
