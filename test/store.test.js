import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSerialQueue, createVideoStore, applyVideoOp, patchVideos } from '../lib/store.js';

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

  test('remove returns the removed videos with their positions', () => {
    const { videos, result } = applyVideoOp(saved, { type: 'remove', videoIds: ['c', 'a', 'zzz'] });
    assert.deepEqual(ids(videos), ['b']);
    assert.deepEqual(result.removed, [{ video: v('a'), index: 0 }, { video: v('c'), index: 2 }]);
  });

  test('remove of nothing returns the same array', () => {
    assert.equal(applyVideoOp(saved, { type: 'remove', videoIds: ['zzz'] }).videos, saved);
  });

  test('restore puts videos back at their prior positions', () => {
    const { videos: afterRemove, result } = applyVideoOp(saved, { type: 'remove', videoIds: ['a', 'c'] });
    const { videos } = applyVideoOp(afterRemove, { type: 'restore', entries: result.removed });
    assert.deepEqual(ids(videos), ['a', 'b', 'c']);
  });

  test('restore clamps positions past the end and skips IDs saved since', () => {
    const { videos, result } = applyVideoOp([v('b', { title: 'newer' })], {
      type: 'restore',
      entries: [{ video: v('b', { title: 'older' }), index: 0 }, { video: v('z'), index: 99 }],
    });
    assert.deepEqual(videos, [v('b', { title: 'newer' }), v('z')]);
    assert.deepEqual(result, { restored: 1 });
  });

  test('ops never modify their input', () => {
    const input = [v('a'), v('b')];
    const copy = structuredClone(input);
    applyVideoOp(input, { type: 'add', videos: [v('x')] });
    applyVideoOp(input, { type: 'remove', videoIds: ['a'] });
    applyVideoOp(input, { type: 'restore', entries: [{ video: v('q'), index: 0 }] });
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
    await mutate(videos => applyVideoOp(videos, { type: 'remove', videoIds: ['a'] }));

    respond(new Map([['a', { title: 'A enriched' }], ['b', { title: 'B enriched' }]]));
    await enrichment;

    assert.deepEqual(storage.state.videos, [v('b', { title: 'B enriched' })]);
  });

  test('delete → auto-collapse save → undo: both videos are present', async () => {
    const storage = fakeStorage([v('a'), v('b')]);
    const mutate = createVideoStore(storage);

    const { removed } = await mutate(videos => applyVideoOp(videos, { type: 'remove', videoIds: ['a'] }));
    await mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('auto')] }));
    await mutate(videos => applyVideoOp(videos, { type: 'restore', entries: removed }));

    assert.deepEqual(ids(storage.state.videos), ['a', 'auto', 'b']);
  });

  test('concurrent folds and deletes all land', async () => {
    const storage = fakeStorage([v('a'), v('b')]);
    const mutate = createVideoStore(storage);
    await Promise.all([
      mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('f1')] })),
      mutate(videos => applyVideoOp(videos, { type: 'remove', videoIds: ['a'] })),
      mutate(videos => applyVideoOp(videos, { type: 'add', videos: [v('f2'), v('f3')] })),
    ]);
    assert.deepEqual(ids(storage.state.videos), ['f2', 'f3', 'f1', 'b']);
  });

  test('a change that does nothing skips the write', async () => {
    const storage = fakeStorage([v('a')]);
    const mutate = createVideoStore(storage);
    await mutate(videos => applyVideoOp(videos, { type: 'remove', videoIds: ['zzz'] }));
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
  const files = ['background/service-worker.js', 'dashboard/dashboard.js', 'content/scraper.js', 'lib/youtube.js', 'lib/fold.js', 'lib/store.js'];
  let count = 0;
  for (const f of files) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    count += (src.match(/storage\.local\.set\(\{\s*savedVideos/g) || []).length;
  }
  assert.equal(count, 1);
});
