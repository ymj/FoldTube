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
  'title-asc': byText('title'),
  'title-desc': reversed(byText('title')),
};

/**
 * The Sort control: a field, and a direction it flips between. Each field
 * starts in its natural direction; `label` says what each direction means.
 */
export const SORT_FIELDS = {
  date: { start: 'desc', label: { desc: 'Newest first', asc: 'Oldest first' } },
  dur: { start: 'asc', label: { asc: 'Shortest first', desc: 'Longest first' } },
  title: { start: 'asc', label: { asc: 'A to Z', desc: 'Z to A' } },
};

/** Split a sort ('date-desc') into its field and direction. */
export function parseSort(sort) {
  const [field, direction] = String(sort).split('-');
  return SORT_FIELDS[field] && SORT_FIELDS[field].label[direction] ? { field, direction } : { field: 'date', direction: 'desc' };
}

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

/**
 * The Group by menu's choices: by media type ('none': Videos and Shorts in
 * their own sections, the default; the value predates the name), or by
 * channel in an order.
 */
export const GROUP_BY = ['none', 'channel-az', 'channel-za', 'channel-recent', 'channel-count'];

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

/** A channel group's id, as kept in the collapsed set: Videos and Shorts collapse together. */
export function groupId(key) {
  return `channel:${key}`;
}

/** The videos of one group, in the order given. */
export function videosInGroup(videos, id) {
  return videos.filter(v => groupId(channelKey(v)) === id);
}

/** What Select all picks: everything, or when grouped, what isn't in a collapsed group. */
export function selectableIn(videos, groupBy, collapsed) {
  if (groupBy === 'none') return videos;
  return videos.filter(v => !collapsed.has(groupId(channelKey(v))));
}

/**
 * The collapsed groups worth keeping: current-format ids of channels still in
 * the library. Older ids and channels since emptied are dropped.
 */
export function liveCollapsed(collapsed, library) {
  const channels = new Set(library.map(v => groupId(channelKey(v))));
  return [...collapsed].filter(id => channels.has(id));
}

/** Shorts apart from everything else: their own section, or row in a channel group. */
export function splitByType(videos) {
  const standard = [];
  const shorts = [];
  for (const v of videos) (v.videoType === 'short' ? shorts : standard).push(v);
  return { standard, shorts };
}

// ---- Channel rail ----

/** Most ticks the channel rail shows; with more channels, one stands for several. */
export const RAIL_MAX_TICKS = 18;
/** Channels before the rail's list gets a filter box. */
export const RAIL_FILTER_OVER = 10;
/** Channels before the list gets letter dividers (in the name orders). */
export const RAIL_LETTERS_FROM = 100;
/** Channels shown in the compact hover peek before expanding to the full list. */
export const RAIL_PEEK_SIZE = 5;
/** Channels before hover starts in the compact peek instead of the full list. */
export const RAIL_PEEK_OVER = 7;

/** The tick that lights for the channel at `index` of `total`. */
export function railTick(index, total, max = RAIL_MAX_TICKS) {
  if (total <= max) return index;
  return Math.round((index / (total - 1)) * (max - 1));
}

/** The channel index at normalized pointer position `ratio` (0..1) along the rail. */
export function railChannelAt(ratio, total) {
  if (total <= 0) return -1;
  if (total === 1) return 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * (total - 1));
}

/** Smooth raised-cosine wave weight (0..1) for each tick given pointer `ratio` (0..1). */
export function railWaveWeights(tickCount, ratio, radius = 2.5) {
  if (tickCount <= 0) return [];
  if (tickCount === 1) return [1];
  const clamped = Math.max(0, Math.min(1, ratio));
  const pos = clamped * (tickCount - 1);
  return Array.from({ length: tickCount }, (_, i) => {
    const d = Math.abs(i - pos);
    if (d >= radius) return 0;
    return 0.5 * (1 + Math.cos((Math.PI * d) / radius));
  });
}

/**
 * True when pointer motion from `prev` to `curr` is heading leftward toward
 * the popover beside the rail, so diagonal movement doesn't shift the previewed
 * channel right before reaching the list.
 */
export function isAimingAtPopover(prev, curr, targetRect, margin = 16) {
  if (!prev || !curr || !targetRect) return false;
  const dx = curr.x - prev.x;
  if (dx > -2 || prev.x <= targetRect.right) return false;
  const dy = curr.y - prev.y;
  if (Math.abs(dy) > -dx * 5) return false;
  const distToEdge = prev.x - targetRect.right;
  const projectedY = prev.y + (dy / -dx) * distToEdge;
  return projectedY >= targetRect.top - margin && projectedY <= targetRect.bottom + margin;
}

/**
 * Inclusive start, exclusive end of the compact peek slice centered on `centerIndex`.
 */
export function railPeekRange(centerIndex, total, size = RAIL_PEEK_SIZE) {
  if (total <= 0) return { start: 0, end: 0 };
  if (total <= size) return { start: 0, end: total };
  const clamped = Math.max(0, Math.min(total - 1, centerIndex));
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(total - size, clamped - half));
  return { start, end: start + size };
}

/** The letter a channel is listed under: accents folded (É → E), '#' for numbers and symbols. */
export function channelInitial(key) {
  const first = String(key).normalize('NFD')[0] || '';
  return /\p{L}/u.test(first) ? first.toUpperCase() : '#';
}
