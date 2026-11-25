import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { libraryView, matchesDuration, splitByType, SORTS } from '../dashboard/filters.js';
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

describe('dashboard modules', () => {
  test('the page loads one module; the rest are imported', async () => {
    const html = await readFile(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.deepEqual(scripts.map(m => m[1].trim()), ['src="theme-init.js"', 'type="module" src="dashboard.js"']);
    for (const [, , body] of scripts) assert.equal(body.trim(), '', 'no inline script');
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
