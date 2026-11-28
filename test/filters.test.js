import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { libraryView, matchesDuration, splitByType, groupByChannel, parseSort, railTick, railChannelAt, railWaveWeights, railPeekRange, isAimingAtPopover, channelInitial, groupId, videosInGroup, selectableIn, liveCollapsed, GROUP_BY, SORT_FIELDS, SORTS, RAIL_MAX_TICKS, RAIL_PEEK_OVER } from '../dashboard/filters.js';
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

  test('Group by orders: Z to A, recently saved, most videos; unknown always last', () => {
    const mixed = [...library, v('n1', { channelName: '9 Lives', dateSaved: at(30) })];
    const order = (o) => groupByChannel(libraryView(mixed), o).map(g => g.key);
    assert.deepEqual(order('channel-az'), ['Amy', 'Bob', 'Cat', '9 Lives', '']);
    assert.deepEqual(order('channel-za'), ['Cat', 'Bob', 'Amy', '9 Lives', '']);
    assert.deepEqual(order('channel-recent'), ['9 Lives', 'Amy', 'Bob', 'Cat', '']);
    assert.deepEqual(order('channel-count'), ['Amy', 'Cat', '9 Lives', 'Bob', '']);
    assert.deepEqual(order('nope'), order('channel-az'));
  });

  test('recently saved: ties by name; unknown dates after known ones', () => {
    const tie = [v('z', { channelName: 'Zed', dateSaved: at(1) }), v('y', { channelName: 'Yan', dateSaved: at(1) }), v('n', { channelName: 'Nod', dateSaved: 'nope' })];
    assert.deepEqual(groupByChannel(tie, 'channel-recent').map(g => g.key), ['Yan', 'Zed', 'Nod']);
  });

  test('the Group by menu offers exactly these choices', async () => {
    assert.deepEqual(GROUP_BY, ['none', 'channel-az', 'channel-za', 'channel-recent', 'channel-count']);
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const menu = html.match(/<div class="picker-menu hidden" id="group-menu[\s\S]*?\n {4}<\/div>/)?.[0] ?? '';
    assert.deepEqual([...menu.matchAll(/data-value="([\w-]+)"/g)].map(m => m[1]), GROUP_BY);
    const labels = html.match(/<span class="picker-labels" id="group-button-labels"[\s\S]*?<\/span>\s*<\/span>/)?.[0] ?? '';
    assert.deepEqual([...labels.matchAll(/data-value="([\w-]+)"/g)].map(m => m[1]), GROUP_BY, 'a button label for every choice');
  });

  test('the Sort menu: every field, both directions, is a sort; nothing else is', async () => {
    const pairs = Object.entries(SORT_FIELDS).flatMap(([field, f]) => Object.keys(f.label).map(d => `${field}-${d}`));
    assert.deepEqual(pairs.sort(), Object.keys(SORTS).sort());
    for (const [field, f] of Object.entries(SORT_FIELDS)) assert.ok(f.label[f.start], field);
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const menu = html.match(/<div class="picker-menu hidden" id="sort-menu[\s\S]*?\n {8}<\/div>/)?.[0] ?? '';
    assert.deepEqual([...menu.matchAll(/data-value="(\w+)"/g)].map(m => m[1]), Object.keys(SORT_FIELDS));
    const labels = html.match(/<span class="picker-labels" id="sort-button-labels"[\s\S]*?<\/span>\s*<\/span>/)?.[0] ?? '';
    assert.deepEqual([...labels.matchAll(/data-value="(\w+)"/g)].map(m => m[1]), Object.keys(SORT_FIELDS));
  });

  test('parseSort: field and direction, or newest first when unknown', () => {
    assert.deepEqual(parseSort('dur-desc'), { field: 'dur', direction: 'desc' });
    assert.deepEqual(parseSort('title-asc'), { field: 'title', direction: 'asc' });
    assert.deepEqual(parseSort('chan-asc'), { field: 'date', direction: 'desc' });
    assert.deepEqual(parseSort(undefined), { field: 'date', direction: 'desc' });
  });

  test("a channel's Shorts are in its group, after its videos once split", () => {
    const mixed = [
      v('a1', { channelName: 'Amy', dateSaved: at(3) }),
      v('as', { channelName: 'Amy', videoType: 'short', dateSaved: at(5) }),
      v('bs', { channelName: 'Bob', videoType: 'short', dateSaved: at(4) }),
    ];
    const groups = groupByChannel(libraryView(mixed));
    assert.deepEqual(shape(groups), [['Amy', ['as', 'a1']], ['Bob', ['bs']]]);
    const { standard, shorts } = splitByType(groups[0].videos);
    assert.deepEqual([ids(standard), ids(shorts)], [['a1'], ['as']]);
  });

  test('a group is the whole channel: its Shorts share its id', () => {
    const mixed = [v('a1', { channelName: 'Amy' }), v('as', { channelName: ' Amy ', videoType: 'short' }), v('b1', { channelName: 'Bob' }), v('u1', { channelName: '' })];
    assert.equal(groupId('Amy'), 'channel:Amy');
    assert.deepEqual(ids(videosInGroup(mixed, groupId('Amy'))), ['a1', 'as']);
    assert.deepEqual(ids(videosInGroup(mixed, groupId(''))), ['u1']);
    assert.deepEqual(videosInGroup(mixed, 'videos:Amy'), [], 'old per-section ids match nothing');
  });

  test('Select all skips collapsed groups, Shorts included; ungrouped, it takes everything', () => {
    const mixed = [v('a1', { channelName: 'Amy' }), v('as', { channelName: 'Amy', videoType: 'short' }), v('b1', { channelName: 'Bob' })];
    const collapsed = new Set([groupId('Amy')]);
    assert.deepEqual(ids(selectableIn(mixed, 'channel-az', collapsed)), ['b1']);
    assert.deepEqual(ids(selectableIn(mixed, 'none', collapsed)), ['a1', 'as', 'b1']);
  });

  test('collapsed groups kept: current ids of channels still in the library', () => {
    const library = [v('a1', { channelName: 'Amy' }), v('u1', { channelName: '' })];
    const saved = new Set(['channel:Amy', 'channel:Gone', 'videos:Amy', 'shorts:Amy', 'channel:']);
    assert.deepEqual(liveCollapsed(saved, library), ['channel:Amy', 'channel:']);
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

describe('channel rail', () => {
  test('one tick per channel up to 18', () => {
    assert.equal(RAIL_MAX_TICKS, 18);
    for (let i = 0; i < 18; i++) assert.equal(railTick(i, 18), i);
    assert.equal(railTick(3, 5), 3);
  });

  test('more channels: ticks stand for several, first and last at the ends, in order', () => {
    for (const total of [19, 40, 150]) {
      const ticks = Array.from({ length: total }, (_, i) => railTick(i, total));
      assert.equal(ticks[0], 0);
      assert.equal(ticks.at(-1), 17);
      assert.ok(ticks.every((t, i) => i === 0 || t >= ticks[i - 1]), `in order for ${total}`);
      assert.equal(new Set(ticks).size, 18, `every tick used for ${total}`);
    }
  });

  test('letters: accents folded, numbers and symbols under #', () => {
    assert.deepEqual(['amy', 'Émile', 'Øyvind', '3Blue1Brown', '@home', '_x', '日本', ''].map(channelInitial),
      ['A', 'E', 'Ø', '#', '#', '#', '日', '#']);
  });

  test('railChannelAt maps pointer ratio continuously across all channels', () => {
    assert.equal(railChannelAt(0.5, 0), -1);
    assert.equal(railChannelAt(0.5, 1), 0);
    assert.equal(railChannelAt(-0.5, 50), 0);
    assert.equal(railChannelAt(0, 50), 0);
    assert.equal(railChannelAt(0.5, 51), 25);
    assert.equal(railChannelAt(1, 50), 49);
    assert.equal(railChannelAt(1.5, 50), 49);
    // Every channel is reachable across a sweep, even with >18 channels.
    const seen = new Set(Array.from({ length: 201 }, (_, i) => railChannelAt(i / 200, 60)));
    assert.equal(seen.size, 60);
  });

  test('railWaveWeights peaks at the pointer and tapers smoothly to zero', () => {
    assert.deepEqual(railWaveWeights(0, 0.5), []);
    assert.deepEqual(railWaveWeights(1, 0.5), [1]);
    const w = railWaveWeights(11, 0.5); // pointer at tick 5
    assert.equal(w.length, 11);
    assert.equal(w[5], 1);
    assert.ok(w[4] > 0.5 && w[4] < 1);
    assert.equal(w[4], w[6]);
    assert.ok(w[3] > 0 && w[3] < w[4]);
    assert.equal(w[2], 0);
    assert.equal(w[0], 0);
    assert.equal(w[10], 0);
  });

  test('isAimingAtPopover detects leftward moves aimed at the side panel, not vertical scrubbing', () => {
    const rect = { right: 1200, top: 200, bottom: 600 };
    assert.equal(isAimingAtPopover({ x: 1230, y: 400 }, { x: 1222, y: 400 }, rect), true);
    assert.equal(isAimingAtPopover({ x: 1230, y: 400 }, { x: 1220, y: 425 }, rect), true);
    // Moving right (away) or mostly vertical on the ladder should not freeze.
    assert.equal(isAimingAtPopover({ x: 1230, y: 400 }, { x: 1238, y: 400 }, rect), false);
    assert.equal(isAimingAtPopover({ x: 1230, y: 400 }, { x: 1229, y: 420 }, rect), false);
    assert.equal(isAimingAtPopover({ x: 1230, y: 400 }, { x: 1228, y: 440 }, rect), false);
    // Heading leftward but aimed well above/below the popover.
    assert.equal(isAimingAtPopover({ x: 1260, y: 200 }, { x: 1250, y: 155 }, rect), false);
    // Already inside the popover.
    assert.equal(isAimingAtPopover({ x: 1180, y: 400 }, { x: 1170, y: 400 }, rect), false);
  });

  test('railPeekRange centers a fixed-size window and clamps cleanly at both ends', () => {
    assert.equal(RAIL_PEEK_OVER, 11, 'under 12 channels opens straight to the full list');
    assert.deepEqual(railPeekRange(0, 0), { start: 0, end: 0 });
    assert.deepEqual(railPeekRange(2, 4), { start: 0, end: 4 });
    assert.deepEqual(railPeekRange(0, 20), { start: 0, end: 5 });
    assert.deepEqual(railPeekRange(1, 20), { start: 0, end: 5 });
    assert.deepEqual(railPeekRange(10, 20), { start: 8, end: 13 });
    assert.deepEqual(railPeekRange(18, 20), { start: 15, end: 20 });
    assert.deepEqual(railPeekRange(19, 20), { start: 15, end: 20 });
  });

  test('the page has the rail and Collapse all', async () => {
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    for (const id of ['channel-rail', 'rail-ticks', 'rail-popover', 'rail-heading', 'rail-filter', 'rail-list', 'rail-expand', 'btn-collapse-all']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
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
