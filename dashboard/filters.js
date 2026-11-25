// What the library grid shows: search, length filter and sort.
//
// This file is pure: no browser APIs, so the tests import it directly.

import { matchesSearch } from '../lib/history.js';

const byText = (key) => (a, b) => (a[key] || '').localeCompare(b[key] || '');
const byNumber = (key) => (a, b) => (a[key] || 0) - (b[key] || 0);
const byDate = (a, b) => new Date(a.dateSaved) - new Date(b.dateSaved);
const reversed = (compare) => (a, b) => compare(b, a);

/** The Sort menu's choices. */
export const SORTS = {
  'date-desc': reversed(byDate),
  'date-asc': byDate,
  'dur-asc': byNumber('durationSeconds'),
  'dur-desc': reversed(byNumber('durationSeconds')),
  'chan-asc': byText('channelName'),
  'chan-desc': reversed(byText('channelName')),
  'title-asc': byText('title'),
  'title-desc': reversed(byText('title')),
};

/**
 * True when a video's length is in the range. An unknown length counts as 0.
 * @param {object} video
 * @param {{ min: number, max: number } | null} range min included, max not; null matches all
 */
export function matchesDuration(video, range) {
  if (!range) return true;
  const seconds = video.durationSeconds || 0;
  return seconds >= range.min && seconds < range.max;
}

/**
 * The library as the grid shows it: searched, filtered, then sorted.
 * The list passed in is never changed.
 * @param {object[]} videos the library (active records)
 * @param {{ query?: string, duration?: { min: number, max: number } | null, sort?: string }} [view]
 */
export function libraryView(videos, { query = '', duration = null, sort = 'date-desc' } = {}) {
  const list = videos.filter(v => matchesSearch(v, query) && matchesDuration(v, duration));
  const compare = SORTS[sort];
  return compare ? list.sort(compare) : list;
}

/** The Group by menu's choices: no grouping, or by channel in an order. */
export const GROUP_BY = ['none', 'channel-az', 'channel-za', 'channel-recent', 'channel-count'];

/** Sort choices that mean nothing inside a channel group. */
export const CHANNEL_SORTS = ['chan-asc', 'chan-desc'];

/** The group a video belongs to: its channel name, or '' when unknown. */
export function channelKey(video) {
  return typeof video.channelName === 'string' ? video.channelName.trim() : '';
}

// Channel names A to Z: case and accents ignored, "Top 10" before "Top 100".
const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
// In the name orders, names starting with a letter come first, then numbers
// and symbols.
const startsWithLetter = (key) => /^\p{L}/u.test(key);
const byLettersFirst = (a, b) => startsWithLetter(b.key) - startsWithLetter(a.key);

const GROUP_ORDERS = {
  'channel-az': (a, b) => byLettersFirst(a, b) || byName(a.key, b.key),
  'channel-za': (a, b) => byLettersFirst(a, b) || byName(b.key, a.key),
  'channel-recent': (a, b) => b.newest - a.newest || byName(a.key, b.key),
  'channel-count': (a, b) => b.videos.length - a.videos.length || byName(a.key, b.key),
};

/**
 * Split videos (already sorted) into one group per channel. Videos keep their
 * order inside a group. Groups come in the order asked for (A to Z by
 * default); the unknown channel ('') always comes last.
 * @param {object[]} videos
 * @param {string} [order] one of GROUP_BY, other than 'none'
 * @returns {{ key: string, videos: object[] }[]}
 */
export function groupByChannel(videos, order = 'channel-az') {
  const groups = new Map();
  for (const video of videos) {
    const key = channelKey(video);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, videos: [], newest: -Infinity });
    group.videos.push(video);
    const saved = Date.parse(video.dateSaved);
    if (saved > group.newest) group.newest = saved;
  }
  const compare = GROUP_ORDERS[order] || GROUP_ORDERS['channel-az'];
  return [...groups.values()]
    .sort((a, b) => (a.key === '') - (b.key === '') || compare(a, b))
    .map(({ key, videos: list }) => ({ key, videos: list }));
}

/** Shorts get their own section; everything else is a video. */
export function splitByType(videos) {
  const standard = [];
  const shorts = [];
  for (const v of videos) (v.videoType === 'short' ? shorts : standard).push(v);
  return { standard, shorts };
}
