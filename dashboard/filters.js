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

/** Shorts get their own section; everything else is a video. */
export function splitByType(videos) {
  const standard = [];
  const shorts = [];
  for (const v of videos) (v.videoType === 'short' ? shorts : standard).push(v);
  return { standard, shorts };
}
