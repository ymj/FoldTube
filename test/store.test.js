import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardFiles } from './helpers.js';
import { createSerialQueue, createVideoStore, applyVideoOp, patchVideos } from '../lib/store.js';
import { isActive } from '../lib/archive.js';

const v = (videoId, extra = {}) => ({ videoId, ...extra });
const ids = (videos) => videos.map(x => x.videoId);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// A fake chrome.storage.local: async read/write with a call log.
function fakeStorage(initial = []) {
  const state = { videos: initial, writes: 0 };
  return {
    state,
    read: async () => { await tick(); return state.videos; },
    write: async (videos) => { await tick(); state.writes++; state.videos = videos; },
  };
}

describe('createSerialQueue', () => {
  test('runs tasks one at a time, in order', async () => {
    const enqueue = createSerialQueue();
    const log = [];
    const task = (name, ms) => () => new Promise(resolve => {
      log.push(`start ${name}`);
      setTimeout(() => { log.push(`end ${name}`); resolve(name); }, ms);
    });
    const results = await Promise.all([enqueue(task('a', 20)), enqueue(task('b', 0)), enqueue(task('c', 5))]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  test('a failing task does not block the next', async () => {
    const enqueue = createSerialQueue();
    const failed = enqueue(() => { throw new Error('boom'); });
    const next = enqueue(() => 'ok');
    await assert.rejects(failed, /boom/);
    assert.equal(await next, 'ok');
  });
});

describe('applyVideoOp', () => {
  const saved = [v('a'), v('b'), v('c')];

  test('add puts new videos first and skips saved IDs', () => {
    const { videos, result } = applyVideoOp(saved, { type: 'add', videos: [v('x'), v('b')] });
    assert.deepEqual(ids(videos), ['x', 'a', 'b', 'c']);
    assert.deepEqual(result, { added: 1 });
  });

  test('add of only saved videos returns the same array (no write)', () => {
    assert.equal(applyVideoOp(saved, { type: 'add', videos: [v('a')] }).videos, saved);
  });

  test('archive moves videos out of the library without removing them', () => {
    const { videos, result } = applyVideoOp(saved, { type: 'archive', videoIds: ['c', 'a', 'zzz'], state: 'deleted' });
    assert.deepEqual(ids(videos), ['a', 'b', 'c']);
    assert.deepEqual(result.changed, ['a', 'c']);
    assert.deepEqual(videos.map(x => x.state), ['deleted', undefined, 'deleted']);
  });

  test('archive of nothing returns the same array', () => {
    assert.equal(applyVideoOp(saved, { type: 'archive', videoIds: ['zzz'], state: 'watched' }).videos, saved);
  });

  test('unarchive brings them back where they were', () => {
    const { videos: after, result } = applyVideoOp(saved, { type: 'archive', videoIds: ['a', 'c'], state: 'watched' });
    const { videos } = applyVideoOp(after, { type: 'unarchive', videoIds: result.changed });
    assert.deepEqual(ids(videos), ['a', 'b', 'c']);
    assert.ok(videos.every(x => x.state === 'active' || x.state === undefined));
  });

  test('ops never modify their input', () => {
    const input = [v('a'), v('b')];
    const copy = structuredClone(input);
    applyVideoOp(input, { type: 'add', videos: [v('x')] });
    applyVideoOp(input, { type: 'archive', videoIds: ['a'], state: 'deleted' });
    applyVideoOp(input, { type: 'unarchive', videoIds: ['a'] });
    applyVideoOp(input, { type: 'forget', videoIds: ['a'] });
    applyVideoOp(input, { type: 'clearHistory' });
    applyVideoOp(input, { type: 'purge' });
    assert.deepEqual(input, copy);
  });

  test('unknown operations throw', () => {
    assert.throws(() => applyVideoOp(saved, { type: 'replaceAll', videos: [] }), /Unknown/);
    assert.throws(() => applyVideoOp(saved, null), /Unknown/);
  });
});

describe('patchVideos', () => {
  test('updates every copy with the ID and leaves others alone', () => {
    const input = [v('a', { title: 'old' }), v('b'), v('a', { title: 'old2' })];
    const { videos, result } = patchVideos(input, new Map([['a', { title: 'new' }]]));
    assert.deepEqual(videos, [v('a', { title: 'new' }), v('b'), v('a', { title: 'new' })]);
    assert.deepEqual(result, { patched: 2 });
    assert.equal(input[0].title, 'old');
  });

  test('a patch for a video no longer saved does nothing', () => {
    const input = [v('b')];
    assert.equal(patchVideos(input, new Map([['a', { title: 'x' }]])).videos, input);
  });
});

describe('createVideoStore (races)', () => {
  test('delete while enrichment runs → the video stays deleted', async () => {
    const storage = fakeStorage([v('a', { title: 'A' }), v('b', { title: 'B' })]);
    const mutate = createVideoStore(storage);

    // Enrichment reads first, then waits on the network...
    const snapshot = await storage.read();
    let respond;
    const network = new Promise(resolve => { respond = resolve; });
    const enrichment = (async () => {
      const patches = await network;
      assert.ok(snapshot.length === 2);
      await mutate(videos => patchVideos(videos, patches));
    })();

    // ...meanwhile the user deletes "a".
    await mutate(videos => applyVideoOp(videos, { type: 'archive', videoIds: ['a'], state: 'deleted' }));

    respond(new Map([['a', { title: 'A enriched' }], ['b', { title: 'B enriched' }]]));
    await enrichment;

    const [a, b] = storage.state.videos;
    assert.equal(a.state, 'deleted');
    assert.equal(b.title, 'B enriched');
  });

  test('delete → auto-collapse save → undo: both videos are present', async () => {
    const storage = fakeStorage([v('a'), v('b')]);
    const mutate = createVideoStore(storage);

    const { changed } = await mutate(videos => applyVideoOp(videos, { type: 'archive', videoIds: ['a'], state: 'deleted' }));
    await mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('auto')] }));
    await mutate(videos => applyVideoOp(videos, { type: 'unarchive', videoIds: changed }));

    assert.deepEqual(ids(storage.state.videos), ['auto', 'a', 'b']);
    assert.ok(storage.state.videos.every(isActive));
  });

  test('concurrent folds and deletes all land', async () => {
    const storage = fakeStorage([v('a'), v('b')]);
    const mutate = createVideoStore(storage);
    await Promise.all([
      mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('f1')] })),
      mutate(videos => applyVideoOp(videos, { type: 'archive', videoIds: ['a'], state: 'deleted' })),
      mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('f2'), v('f3')] })),
    ]);
    assert.deepEqual(ids(storage.state.videos.filter(isActive)), ['f2', 'f3', 'f1', 'b']);
  });

  test('a change that does nothing skips the write', async () => {
    const storage = fakeStorage([v('a')]);
    const mutate = createVideoStore(storage);
    await mutate(videos => applyVideoOp(videos, { type: 'archive', videoIds: ['zzz'], state: 'deleted' }));
    assert.equal(storage.state.writes, 0);
  });

  test('a failing change writes nothing and the next change still runs', async () => {
    const storage = fakeStorage([v('a')]);
    const mutate = createVideoStore(storage);
    await assert.rejects(mutate(() => { throw new Error('bad op'); }), /bad op/);
    await mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('b')] }));
    assert.deepEqual(ids(storage.state.videos), ['b', 'a']);
    assert.equal(storage.state.writes, 1);
  });
});

test('savedVideos is written in exactly one place in the extension', async () => {
  const files = ['background/service-worker.js', ...await dashboardFiles(), 'content/scraper.js', 'lib/youtube.js', 'lib/fold.js', 'lib/store.js'];
  let count = 0;
  for (const f of files) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    count += (src.match(/storage\.local\.set\(\{\s*savedVideos/g) || []).length;
  }
  assert.equal(count, 1);
});
