import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeStored, encodeStored, migrateV1, needsMigration, isActive, truncateDescription,
  importRecords, DESCRIPTION_MAX, SCHEMA_VERSION,
} from '../lib/archive.js';
import { applyVideoOp, createVideoStore } from '../lib/store.js';
import { validateImport, buildJsonExport, buildHtmlExport, urlToVideoData } from '../lib/youtube.js';

const ctx = { deviceId: 'device-a', now: new Date('2026-11-24T12:00:00.000Z') };
const later = { deviceId: 'device-a', now: new Date('2026-11-25T12:00:00.000Z') };
const v1 = (videoId, dateSaved, extra = {}) => ({
  videoId, videoType: 'video', url: `https://www.youtube.com/watch?v=${videoId}`,
  title: `Video ${videoId}`, channelName: 'C', dateSaved, ...extra,
});

// A fake storage.local holding the raw savedVideos value, with the same
// read/write as the service worker.
function fakeStorage(raw) {
  const storage = { savedVideos: raw, writes: 0 };
  const mutate = createVideoStore({
    read: async () => decodeStored(storage.savedVideos, ctx),
    write: async (videos) => {
      storage.writes++;
      storage.savedVideos = encodeStored(videos);
      storage.schemaVersion = SCHEMA_VERSION;
    },
  });
  const migrate = async () => {
    if (!needsMigration(storage)) return;
    await mutate(videos => ({ videos: [...videos] }));
  };
  return { storage, mutate, migrate };
}

describe('migration from the v1 array', () => {
  test('empty or missing list', async () => {
    const empty = fakeStorage([]);
    await empty.migrate();
    assert.deepEqual(empty.storage.savedVideos, {});
    assert.equal(empty.storage.schemaVersion, 2);

    const fresh = fakeStorage(undefined);
    await fresh.migrate();
    assert.equal(fresh.storage.writes, 0, 'a new install has nothing to convert');
  });

  test('every video kept, active, stamped, keyed by ID, in the same order', async () => {
    const list = [v1('c', '2026-11-03T00:00:00Z'), v1('b', '2026-11-02T00:00:00Z'), v1('a', '2026-11-01T00:00:00Z', { timestampSeconds: 90 })];
    const { storage, migrate } = fakeStorage(list);
    await migrate();
    assert.deepEqual(Object.keys(storage.savedVideos).sort(), ['a', 'b', 'c']);
    const after = decodeStored(storage.savedVideos);
    assert.deepEqual(after.map(v => v.videoId), ['c', 'b', 'a']);
    for (const video of after) {
      assert.equal(video.state, 'active');
      assert.equal(video.stateChangedAt, '2026-11-24T12:00:00.000Z');
      assert.equal(video.stateChangedBy, 'device-a');
    }
    assert.equal(storage.savedVideos.a.timestampSeconds, 90, 'other fields kept');
  });

  test('two records for one video: the newest save is kept', () => {
    const [kept] = migrateV1([v1('a', '2026-11-01T00:00:00Z', { title: 'old' }), v1('a', '2026-11-05T00:00:00Z', { title: 'new' })], ctx);
    assert.equal(kept.title, 'new');
    assert.equal(migrateV1([v1('a', '2026-11-01T00:00:00Z'), v1('a', '2026-11-01T00:00:00Z')], ctx).length, 1);
  });

  test('videos saved at the same moment keep their v1 order', () => {
    const same = '2026-11-01T00:00:00Z';
    assert.deepEqual(migrateV1([v1('x', same), v1('y', same), v1('z', same)], ctx).map(v => v.videoId), ['x', 'y', 'z']);
  });

  test('running it twice changes nothing the second time', async () => {
    const { storage, migrate } = fakeStorage([v1('a', '2026-11-01T00:00:00Z')]);
    await migrate();
    const once = structuredClone(storage.savedVideos);
    await migrate();
    assert.equal(storage.writes, 1);
    assert.deepEqual(storage.savedVideos, once);
  });

  test('interrupted before the write: the v1 list is untouched and the next run converts it', async () => {
    const list = [v1('a', '2026-11-01T00:00:00Z')];
    const failing = createVideoStore({
      read: async () => decodeStored(list, ctx),
      write: async () => { throw new Error('browser closed'); },
    });
    await assert.rejects(failing(videos => ({ videos: [...videos] })));
    assert.ok(Array.isArray(list) && list.length === 1 && !list[0].state);

    const { storage, migrate } = fakeStorage(list);
    await migrate();
    assert.equal(storage.savedVideos.a.state, 'active');
  });

  test('long descriptions are trimmed', () => {
    const [video] = migrateV1([v1('a', '2026-11-01T00:00:00Z', { description: 'word '.repeat(400) })], ctx);
    assert.ok(video.description.length <= DESCRIPTION_MAX);
  });

  test('needsMigration', () => {
    assert.equal(needsMigration({ savedVideos: [] }), true);
    assert.equal(needsMigration({ savedVideos: {}, schemaVersion: 2 }), false);
    assert.equal(needsMigration({}), false);
  });
});

describe('the stored map', () => {
  test('decoded newest saved first; tombstones last; bad entries skipped', () => {
    const stored = {
      a: { videoId: 'a', dateSaved: '2026-11-01T00:00:00Z' },
      b: { videoId: 'b', dateSaved: '2026-11-09T00:00:00Z' },
      p: { videoId: 'p', state: 'purged', stateChangedAt: '2026-11-10T00:00:00Z' },
      wrong: { videoId: 'not-wrong' },
      junk: null,
    };
    assert.deepEqual(decodeStored(stored).map(v => v.videoId), ['b', 'a', 'p']);
    assert.deepEqual(decodeStored(undefined), []);
    assert.deepEqual(decodeStored('nonsense'), []);
  });

  test('encoding keeps the first copy of a video', () => {
    const map = encodeStored([{ videoId: 'a', n: 1 }, { videoId: 'a', n: 2 }, { videoId: 'b' }]);
    assert.deepEqual(map, { a: { videoId: 'a', n: 1 }, b: { videoId: 'b' } });
  });

  test('records without a state count as active', () => {
    assert.equal(isActive({ videoId: 'a' }), true);
    assert.equal(isActive({ videoId: 'a', state: 'watched' }), false);
  });
});

describe('folding', () => {
  const archived = (state) => ({
    ...v1('a', '2026-10-01T00:00:00Z', { channelName: 'Known', durationSeconds: 300, timestampSeconds: 120 }),
    state, stateChangedAt: '2026-10-02T00:00:00Z', stateChangedBy: 'device-b',
  });

  test('new videos are saved active and stamped', () => {
    const { videos } = applyVideoOp([], { type: 'add', videos: [v1('n', '2026-11-24T12:00:00Z')] }, ctx);
    assert.equal(videos[0].state, 'active');
    assert.equal(videos[0].stateChangedBy, 'device-a');
  });

  for (const state of ['watched', 'deleted']) {
    test(`a ${state} video comes back: active, saved now, new title and position, known details kept`, () => {
      const saved = [v1('x', '2026-11-20T00:00:00Z', { state: 'active' }), archived(state)];
      const folded = { ...v1('a', '2026-11-24T12:00:00Z', { title: 'New title', channelName: 'Unknown Channel' }), timestampSeconds: 300, metadataSource: 'url-only' };
      const { videos, result } = applyVideoOp(saved, { type: 'add', videos: [folded] }, ctx);
      assert.equal(result.added, 1);
      const back = videos.find(v => v.videoId === 'a');
      assert.equal(back.state, 'active');
      assert.equal(back.stateChangedAt, '2026-11-24T12:00:00.000Z');
      assert.equal(back.stateChangedBy, 'device-a');
      assert.equal(back.dateSaved, '2026-11-24T12:00:00Z');
      assert.equal(back.title, 'New title');
      assert.equal(back.timestampSeconds, 300);
      assert.equal(back.channelName, 'Known', 'a URL-only save does not erase the channel');
      assert.equal(videos.filter(v => v.videoId === 'a').length, 1);
      assert.equal(videos[0].videoId, 'a', 'first, as the newest save');
    });
  }

  test('a video deleted forever comes back from the new save alone', () => {
    const tomb = { videoId: 'a', state: 'purged', stateChangedAt: '2026-10-02T00:00:00Z', stateChangedBy: 'device-b' };
    const folded = urlToVideoData('https://www.youtube.com/watch?v=a', 'Fresh', ctx.now);
    const { videos } = applyVideoOp([tomb], { type: 'add', videos: [folded] }, ctx);
    assert.equal(videos[0].state, 'active');
    assert.equal(videos[0].title, 'Fresh');
  });

  test('an active video folded again is unchanged (dedupe)', () => {
    const saved = [{ ...v1('a', '2026-11-01T00:00:00Z'), state: 'active' }];
    assert.equal(applyVideoOp(saved, { type: 'add', videos: [v1('a', '2026-11-24T00:00:00Z')] }, ctx).videos, saved);
  });
});

describe('descriptions', () => {
  test('short ones are kept as they are', () => {
    assert.equal(truncateDescription('hello world'), 'hello world');
    assert.equal(truncateDescription(undefined), '');
  });

  test('long ones are cut at a word boundary, within the limit', () => {
    const cut = truncateDescription('lorem ipsum '.repeat(200));
    assert.ok(cut.length <= DESCRIPTION_MAX, String(cut.length));
    assert.ok(cut.endsWith('…'));
    assert.match(cut, /(ipsum|lorem)…$/);
  });

  test('one huge word is cut at the limit', () => {
    assert.equal(truncateDescription('x'.repeat(5000)).length, DESCRIPTION_MAX);
  });

  test('imports are trimmed too', () => {
    const [video] = validateImport([v1('dQw4w9WgXcQ', '2026-11-01T00:00:00Z', { description: 'y '.repeat(2000) })]);
    assert.ok(video.description.length <= DESCRIPTION_MAX);
  });
});

describe('backups', () => {
  const records = [
    { ...v1('dQw4w9WgXcQ', '2026-11-03T00:00:00Z'), state: 'active', stateChangedAt: '2026-11-03T00:00:00.000Z', stateChangedBy: 'device-a' },
    { ...v1('9bZkp7q5F2w', '2026-11-02T00:00:00Z'), state: 'watched', stateChangedAt: '2026-11-04T00:00:00.000Z', stateChangedBy: 'device-a' },
  ];

  test('JSON export: the library only, with the schema version, no device ID, History notes or settings', () => {
    const back = { ...v1('kJQP7kiw5Fk', '2026-11-01T00:00:00Z'), state: 'active', stateChangedAt: '2026-11-05T00:00:00.000Z', stateChangedBy: 'device-a', archivedAt: '2026-11-04T00:00:00.000Z', archivedAs: 'watched' };
    const backup = buildJsonExport([...records, back, { videoId: 'gone', state: 'purged', stateChangedAt: '2026-11-04T00:00:00.000Z' }]);
    assert.equal(backup.schemaVersion, 2);
    assert.deepEqual(Object.keys(backup.savedVideos), ['dQw4w9WgXcQ', 'kJQP7kiw5Fk']);
    const saved = backup.savedVideos.kJQP7kiw5Fk;
    assert.equal(saved.stateChangedAt, '2026-11-05T00:00:00.000Z', 'kept, so a newer change wins on import');
    for (const key of ['stateChangedBy', 'archivedAt', 'archivedAs']) assert.equal(saved[key], undefined, key);
    assert.doesNotMatch(JSON.stringify(backup), /device-a/);
    assert.equal(backup.settings, undefined);
  });

  test('a backup holds nothing but the library: no settings, no API key', async () => {
    const backup = buildJsonExport(records);
    assert.deepEqual(Object.keys(backup), ['schemaVersion', 'savedVideos']);
    // The dashboard exports exactly this, from the saved list alone.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    assert.match(src, /JSON\.stringify\(buildJsonExport\(allRecords\)/);
    assert.doesNotMatch(src, /buildJsonExport\([^)]*(appSettings|apiKey|settings)/);
  });

  test('HTML export: the library only', () => {
    const html = buildHtmlExport(records, { date: 'd', exportedAt: 'e' });
    assert.match(html, /dQw4w9WgXcQ/);
    assert.doesNotMatch(html, /9bZkp7q5F2w/);
  });

  test('everything in a backup imports into the library; only the change date is kept', () => {
    const fromV2 = validateImport({ schemaVersion: 2, savedVideos: {
      dQw4w9WgXcQ: { ...records[0], stateChangedBy: 'someone', archivedAt: '2026-11-01T00:00:00Z', archivedAs: 'watched' },
      '9bZkp7q5F2w': records[1],
    } });
    assert.deepEqual(fromV2.map(v => v.state), [undefined, undefined]);
    assert.equal(fromV2[0].stateChangedAt, '2026-11-03T00:00:00.000Z');
    assert.equal(fromV2[0].stateChangedBy, undefined);
    assert.equal(fromV2[0].archivedAt, undefined);

    const { videos, result } = importRecords([], fromV2, ctx);
    assert.ok(videos.every(isActive));
    assert.equal(videos[0].stateChangedBy, 'device-a');
    assert.deepEqual(result, { added: 2, inLibrary: 0, skipped: [] });

    const fromV1 = validateImport([v1('dQw4w9WgXcQ', '2026-11-01T00:00:00Z')]);
    assert.equal(importRecords([], fromV1, ctx).videos[0].state, 'active');
  });

  test('tombstones in a backup are skipped; a backup of only tombstones is not an error', () => {
    const backup = { schemaVersion: 2, savedVideos: { p: { videoId: 'p', state: 'purged', stateChangedAt: '2026-11-01T00:00:00Z' } } };
    assert.deepEqual(validateImport(backup), []);
  });

  test('not a backup → error', () => {
    for (const bad of [null, 42, 'x', { savedVideos: [] }, {}]) assert.throws(() => validateImport(bad), /Invalid format/);
  });

  test('a video opened or removed here after the backup was made is skipped', () => {
    const backedUp = { ...records[0], stateChangedAt: '2026-11-03T00:00:00.000Z' };
    const watchedLater = { ...records[0], title: 'ours', state: 'watched', stateChangedAt: '2026-11-10T00:00:00.000Z' };
    const { videos, result } = importRecords([watchedLater], [backedUp], later);
    assert.deepEqual(videos, [watchedLater]);
    assert.deepEqual(result, { added: 0, inLibrary: 0, skipped: [records[0].videoId] });
  });

  test('a video deleted forever here, even after the backup, comes back', () => {
    const gone = { videoId: records[0].videoId, state: 'purged', stateChangedAt: '2026-11-10T00:00:00.000Z' };
    const { videos, result } = importRecords([gone], [{ ...records[0], stateChangedAt: '2026-11-03T00:00:00.000Z' }], later);
    assert.deepEqual(result, { added: 1, inLibrary: 0, skipped: [] });
    assert.equal(videos.length, 1);
    assert.equal(videos[0].state, 'active');
    assert.equal(videos[0].title, records[0].title);
    assert.equal(videos[0].archivedAt, undefined, 'not listed in History');
  });

  test('everything removed, history cleared, backup imported: all of it comes back', () => {
    const backup = [records[0], { ...records[1], state: 'active' }];
    let list = importRecords([], backup, ctx).videos;
    list = applyVideoOp(list, { type: 'archive', videoIds: list.map(v => v.videoId), state: 'deleted' }, later).videos;
    list = applyVideoOp(list, { type: 'clearHistory' }, later).videos;
    assert.ok(list.every(v => v.state === 'purged'));
    const { videos, result } = importRecords(list, backup, later);
    assert.deepEqual(result, { added: 2, inLibrary: 0, skipped: [] });
    assert.ok(videos.every(isActive));
  });

  test('a video removed here before the backup was made comes back, still listed in History', () => {
    const removedEarlier = { ...records[0], state: 'deleted', stateChangedAt: '2026-11-01T00:00:00.000Z' };
    const { videos, result } = importRecords([removedEarlier], [{ ...records[0], stateChangedAt: '2026-11-03T00:00:00.000Z' }], later);
    assert.deepEqual(result, { added: 1, inLibrary: 0, skipped: [] });
    assert.equal(videos[0].state, 'active');
    assert.equal(videos[0].archivedAs, 'deleted');
  });

  test('a video already in the library is left alone', () => {
    const ours = { ...records[0], title: 'ours' };
    const { videos, result } = importRecords([ours], [{ ...records[0], stateChangedAt: '2026-11-30T00:00:00.000Z' }], later);
    assert.deepEqual(videos, [ours]);
    assert.deepEqual(result, { added: 0, inLibrary: 1, skipped: [] });
  });

  test('skipped videos can be added anyway, like saving them again', () => {
    const watched = { ...records[0], state: 'watched', stateChangedAt: '2026-11-10T00:00:00.000Z' };
    const { result } = importRecords([watched], [records[0]], later);
    const { videos, result: addResult } = applyVideoOp([watched], { type: 'add', videos: [records[0]] }, later);
    assert.deepEqual(result.skipped, [records[0].videoId]);
    assert.equal(addResult.added, 1);
    assert.equal(videos[0].state, 'active');
    assert.equal(videos[0].archivedAs, 'watched', 'still listed in History, as back in library');
  });

  test('the import op goes through applyVideoOp and keeps the list sorted', () => {
    const { videos, result } = applyVideoOp([records[1]], { type: 'import', videos: [records[0]] }, ctx);
    assert.deepEqual(videos.map(v => v.videoId), ['dQw4w9WgXcQ', '9bZkp7q5F2w']);
    assert.equal(result.added, 1);
  });
});
