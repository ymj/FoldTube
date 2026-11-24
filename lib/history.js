// The History screen: videos opened or removed from the library, newest
// change first, grouped by day.
//
// This file is pure: no browser APIs.

import { isArchived, isBackInLibrary, historyTime } from './archive.js';

/**
 * True when a video matches the search box. Same matching everywhere:
 * title, channel or description contains the text, ignoring case.
 * @param {object} video
 * @param {string} query already lower-cased; empty matches everything
 */
export function matchesSearch(video, query) {
  if (!query) return true;
  return (video.title || '').toLowerCase().includes(query)
    || (video.channelName || '').toLowerCase().includes(query)
    || (video.description || '').toLowerCase().includes(query);
}

function changedTime(video) {
  const t = Date.parse(historyTime(video));
  return Number.isNaN(t) ? -Infinity : t;
}

/** The History filters, and what each shows. */
export const HISTORY_FILTERS = {
  all: () => true,
  watched: v => v.state === 'watched',
  deleted: v => v.state === 'deleted',
  library: isBackInLibrary,
};

/** True for a video History shows: watched, deleted, or back in the library. */
export function inHistory(video) {
  return isArchived(video) || isBackInLibrary(video);
}

/**
 * The videos History shows, newest first by when they left the library.
 * @param {object[]} records every stored record
 * @param {string} [query] lower-cased search text
 * @param {keyof HISTORY_FILTERS} [filter]
 */
export function historyItems(records, query = '', filter = 'all') {
  const keep = HISTORY_FILTERS[filter] ?? HISTORY_FILTERS.all;
  return records
    .filter(v => inHistory(v) && keep(v) && matchesSearch(v, query))
    .sort((a, b) => changedTime(b) - changedTime(a));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "Today", "Yesterday", or the date ("12 Nov", with the year when it isn't
 * this year). Local time.
 * @param {Date} date
 * @param {Date} [now]
 * @param {string} [locale]
 */
export function dayLabel(date, now = new Date(), locale = undefined) {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const options = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(locale, options);
}

/**
 * Split items (already newest first) into days.
 * @param {object[]} items
 * @param {Date} [now]
 * @param {string} [locale]
 * @returns {{ label: string, items: object[] }[]}
 */
export function groupByDay(items, now = new Date(), locale = undefined) {
  const groups = [];
  let current = null;
  let currentDay = null;
  for (const item of items) {
    const date = new Date(historyTime(item));
    const day = Number.isNaN(date.getTime()) ? 'unknown' : startOfDay(date);
    if (day !== currentDay) {
      currentDay = day;
      current = { label: day === 'unknown' ? 'Earlier' : dayLabel(date, now, locale), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

/** "Removed in 12 days", "Removed tomorrow", "Removed today". */
export function expiryLabel(days) {
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'Removed today';
  if (days === 1) return 'Removed tomorrow';
  return `Removed in ${days} days`;
}
