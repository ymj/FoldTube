import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { libraryView, matchesDuration, splitByType, groupByChannel, GROUP_BY, SORTS } from '../dashboard/filters.js';
import { dashboardFiles } from './helpers.js';

const v = (videoId, extra = {}) => ({
  videoId, title: `Title ${videoId}`, channelName: 'Chan', dateSaved: '2026-11-01T00:00:00.000Z', ...extra,
});
const ids = (videos) => videos.map(x => x.videoId);

describe('library view', () => {
  const library = [
    v('a', { title: 'Cooking pasta', channelName: 'Zed', durationSeconds: 120, dateSaved: '2026-11-03T00:00:00.000Z' }),
    v('b', { title: 'Learning Rust', channelName: 'Amy', durationSeconds: 3600, dateSaved: '2026-11-01T00:00:00.000Z' }),
    v('c', { title: 'Rust traits', channelName: 'Bob', dateSaved: '2026-11-02T00:00:00.000Z', description: 'pasta-free' }),
  ];

  test('newest saved first by default; the input is left alone', () => {
    const before = ids(library);
    assert.deepEqual(ids(libraryView(library)), ['a', 'c', 'b']);
    assert.deepEqual(ids(library), before);
  });

  test('every Sort choice', () => {
    const expected = {
      'date-desc': ['a', 'c', 'b'], 'date-asc': ['b', 'c', 'a'],
      'dur-asc': ['c', 'a', 'b'], 'dur-desc': ['b', 'a', 'c'],
      'chan-asc': ['b', 'c', 'a'], 'chan-desc': ['a', 'c', 'b'],
      'title-asc': ['a', 'b', 'c'], 'title-desc': ['c', 'b', 'a'],
    };
    assert.deepEqual(Object.keys(SORTS), Object.keys(expected));
    for (const [sort, order] of Object.entries(expected)) {
      assert.deepEqual(ids(libraryView(library, { sort })), order, sort);
    }
  });

  test('an unknown sort keeps the saved order', () => {
    assert.deepEqual(ids(libraryView(library, { sort: 'nope' })), ['a', 'b', 'c']);
  });

  test('search matches title, channel or description, then sorts', () => {
    assert.deepEqual(ids(libraryView(library, { query: 'rust' })), ['c', 'b']);
    assert.deepEqual(ids(libraryView(library, { query: 'amy' })), ['b']);
    assert.deepEqual(ids(libraryView(library, { query: 'pasta' })), ['a', 'c']);
    assert.deepEqual(libraryView(library, { query: 'nothing like it' }), []);
  });

  test('length filter: min included, max not, unknown counts as 0', () => {
    assert.equal(matchesDuration(v('x', { durationSeconds: 240 }), { min: 0, max: 240 }), false);
    assert.equal(matchesDuration(v('x', { durationSeconds: 240 }), { min: 240, max: 1200 }), true);
    assert.equal(matchesDuration(v('x'), { min: 0, max: 240 }), true);
    assert.equal(matchesDuration(v('x'), null), true);
    assert.deepEqual(ids(libraryView(library, { duration: { min: 0, max: 240 } })), ['a', 'c']);
    assert.deepEqual(ids(libraryView(library, { query: 'rust', duration: { min: 1200, max: Infinity } })), ['b']);
  });

  test('Shorts get their own section, in the same order', () => {
    const { standard, shorts } = splitByType([v('a'), v('s1', { videoType: 'short' }), v('b', { videoType: 'video' }), v('s2', { videoType: 'short' })]);
    assert.deepEqual(ids(standard), ['a', 'b']);
    assert.deepEqual(ids(shorts), ['s1', 's2']);
  });
});

describe('group by channel', () => {
  const at = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const library = [
    v('a1', { channelName: 'Amy', dateSaved: at(1), durationSeconds: 50 }),
    v('b1', { channelName: 'Bob', dateSaved: at(5), durationSeconds: 10 }),
    v('a2', { channelName: 'Amy', dateSaved: at(9), durationSeconds: 30 }),
    v('u1', { channelName: '', dateSaved: at(20) }),
    v('u2', { channelName: undefined, dateSaved: at(2) }),
    v('c1', { channelName: '  Cat ', dateSaved: at(3) }),
    v('c2', { channelName: 'Cat', dateSaved: at(4) }),
  ];
  const shape = (groups) => groups.map(g => [g.key, ids(g.videos)]);

  test('one group per channel, A to Z; unknown last', () => {
    assert.deepEqual(shape(groupByChannel(libraryView(library))), [
      ['Amy', ['a2', 'a1']],
      ['Bob', ['b1']],
      ['Cat', ['c2', 'c1']],
      ['', ['u1', 'u2']],
    ]);
  });

  test('Sort orders the videos inside each group, not the groups', () => {
    assert.deepEqual(shape(groupByChannel(libraryView(library, { sort: 'dur-asc' }))), [
      ['Amy', ['a2', 'a1']],
      ['Bob', ['b1']],
      ['Cat', ['c1', 'c2']],
      ['', ['u1', 'u2']],
    ]);
  });

  test('search and filters apply first: groups come from what is left', () => {
    assert.deepEqual(shape(groupByChannel(libraryView(library, { query: 'bob' }))), [['Bob', ['b1']]]);
    assert.deepEqual(shape(groupByChannel(libraryView(library, { duration: { min: 20, max: 60 } }))), [['Amy', ['a2', 'a1']]]);
    assert.deepEqual(groupByChannel([]), []);
  });

  test('A to Z ignores case and accents, and reads numbers as numbers', () => {
    const names = ['zed', 'Émile', 'Top 100', 'amy', 'Top 9', 'Bob', 'Eve', '日本'];
    const groups = groupByChannel(names.map((channelName, i) => v(`x${i}`, { channelName })));
    assert.deepEqual(groups.map(g => g.key), ['amy', 'Bob', 'Émile', 'Eve', 'Top 9', 'Top 100', 'zed', '日本']);
  });

  test('names starting with a number or symbol come after the letters, before unknown', () => {
    const names = ['', '@home', 'Bob', '3Blue1Brown', '_under', 'amy', '10 Minute', '2 Minute'];
    const groups = groupByChannel(names.map((channelName, i) => v(`x${i}`, { channelName })));
    assert.deepEqual(groups.map(g => g.key), ['amy', 'Bob', '_under', '@home', '2 Minute', '3Blue1Brown', '10 Minute', '']);
  });

  test('the Group by menu offers exactly these choices', async () => {
    assert.deepEqual(GROUP_BY, ['none', 'channel']);
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const select = html.match(/<select id="group-select"[\s\S]*?<\/select>/)?.[0] ?? '';
    assert.deepEqual([...select.matchAll(/value="(\w+)"/g)].map(m => m[1]), GROUP_BY);
  });

  test('500 videos from 150 channels group quickly', () => {
    const many = Array.from({ length: 500 }, (_, i) => v(`v${i}`, { channelName: `Channel ${i % 150}`, dateSaved: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString() }));
    const start = performance.now();
    const groups = groupByChannel(libraryView(many, { query: 'title' }));
    assert.equal(groups.length, 150);
    assert.equal(groups.reduce((n, g) => n + g.videos.length, 0), 500);
    assert.ok(performance.now() - start < 50, 'under 50 ms');
  });
});

describe('dashboard modules', () => {
  test('the page loads one module; the rest are imported', async () => {
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attrs, body]) => ({
      src: attrs.match(/\bsrc="([^"]+)"/)?.[1],
      module: /\btype="module"/.test(attrs),
      body: body.trim(),
    }));
    assert.deepEqual(scripts.map(s => s.src), ['theme-init.js', 'dashboard.js']);
    assert.deepEqual(scripts.filter(s => s.module).map(s => s.src), ['dashboard.js']);
    for (const s of scripts) assert.equal(s.body, '', 'no inline script');
  });

  test('every module is imported by another, and none uses eval', async () => {
    const files = await dashboardFiles();
    const sources = await Promise.all(files.map(f => readFile(new URL(`../${f}`, import.meta.url), 'utf8')));
    const imported = new Set(sources.flatMap(src => [...src.matchAll(/from '\.\/([\w-]+\.js)'/g)].map(m => `dashboard/${m[1]}`)));
    for (const f of files) {
      if (f === 'dashboard/dashboard.js' || f === 'dashboard/theme-init.js') continue;
      assert.ok(imported.has(f), `${f} is not imported`);
    }
    for (const [i, src] of sources.entries()) assert.doesNotMatch(src, /\beval\(|new Function\(/, files[i]);
  });

  test('filters.js uses no browser APIs', async () => {
    const src = await readFile(new URL('../dashboard/filters.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\b(chrome|document|window)\./);
  });
});
