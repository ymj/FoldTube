// The archive data model: every saved video has a state, and the list is
// stored as a map keyed by video ID.
//
//   active   in the library
//   watched  opened from the library            (kept for 90 days)
//   deleted  removed from the library           (kept for 90 days)
//   purged   deleted forever: a tombstone with no title or URL, so a later
//            sync never brings the video back
//
// Each change of state records when (stateChangedAt) and on which install
// (stateChangedBy, a random per-install ID). That is what lets two devices
// merge their lists later: for the same video, the newer change wins.
//
// Storage history:
//   v1  savedVideos: [record, ...] newest first, no state
//   v2  savedVideos: { [videoId]: record }, schemaVersion: 2
//
// Inside the extension the list is still handled as an array, newest saved
// first; decodeStored and encodeStored convert at the storage boundary.
//
// This file is pure: no browser APIs.

export const SCHEMA_VERSION = 2;
export const STATES = ['active', 'watched', 'deleted', 'purged'];
export const DESCRIPTION_MAX = 1000;

/** True for a video in the library (records from before states count as active). */
export function isActive(video) {
  return (video?.state ?? 'active') === 'active';
}

/**
 * The stamp for a change of state.
 * @param {{ deviceId?: string, now?: Date }} [ctx]
 */
export function stateStamp(ctx = {}) {
  return {
    stateChangedAt: (ctx.now ?? new Date()).toISOString(),
    stateChangedBy: ctx.deviceId ?? null,
  };
}

/**
 * Cap a description at DESCRIPTION_MAX characters, cut at a word boundary,
 * with an ellipsis when something was cut.
 * @param {unknown} text
 * @returns {string}
 */
export function truncateDescription(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= DESCRIPTION_MAX) return text;
  const room = text.slice(0, DESCRIPTION_MAX - 1);
  const space = room.search(/\s\S*$/);
  const cut = space > DESCRIPTION_MAX / 2 ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}

function savedTime(video) {
  const t = Date.parse(video?.dateSaved);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Newest saved first. Tombstones (no date) go last. Doesn't modify its input. */
export function sortBySaved(videos) {
  return [...videos].sort((a, b) => savedTime(b) - savedTime(a));
}

/**
 * Bring a v1 list up to v2: one record per video (the newest save wins),
 * every record active, stamped with this change, descriptions capped.
 * @param {object[]} list v1 array, newest first
 * @param {{ deviceId?: string, now?: Date }} ctx
 * @returns {object[]} newest saved first
 */
export function migrateV1(list, ctx) {
  const stamp = stateStamp(ctx);
  const byId = new Map();
  for (const video of list) {
    if (!video || typeof video.videoId !== 'string') continue;
    const kept = byId.get(video.videoId);
    if (kept && savedTime(kept) >= savedTime(video)) continue;
    byId.set(video.videoId, video);
  }
  // Keep the v1 order (newest first) for videos saved at the same moment.
  const order = new Map(list.map((v, i) => [v, i]));
  return [...byId.values()]
    .sort((a, b) => (savedTime(b) - savedTime(a)) || (order.get(a) - order.get(b)))
    .map(video => ({
      ...video,
      description: truncateDescription(video.description),
      state: 'active',
      ...stamp,
    }));
}

/**
 * The stored savedVideos value (v1 array, v2 map, or nothing) as an array,
 * newest saved first.
 * @param {unknown} raw
 * @param {{ deviceId?: string, now?: Date }} [ctx] used to stamp v1 records
 * @returns {object[]}
 */
export function decodeStored(raw, ctx = {}) {
  if (Array.isArray(raw)) return migrateV1(raw, ctx);
  if (!raw || typeof raw !== 'object') return [];
  const records = Object.entries(raw)
    .filter(([id, video]) => video && typeof video === 'object' && video.videoId === id)
    .map(([, video]) => video);
  return sortBySaved(records);
}

/**
 * The array as stored: { [videoId]: record }. If a video appears twice the
 * first copy (the newer one) is kept.
 * @param {object[]} videos
 * @returns {Record<string, object>}
 */
export function encodeStored(videos) {
  const map = {};
  for (const video of videos) {
    if (video && typeof video.videoId === 'string' && !Object.hasOwn(map, video.videoId)) {
      map[video.videoId] = video;
    }
  }
  return map;
}

/** True when storage still holds the v1 list. */
export function needsMigration(stored) {
  return Array.isArray(stored?.savedVideos) || (stored?.savedVideos !== undefined && stored?.schemaVersion !== SCHEMA_VERSION);
}

/**
 * Bring an incoming record back into the library when it was watched,
 * deleted or deleted forever. It counts as newly saved: its save date, title
 * and position come from the new save. Details the new save didn't read
 * (channel, duration) are kept from the old record.
 * @param {object} existing the archived record
 * @param {object} video the record being saved
 * @param {{ deviceId?: string, now?: Date }} ctx
 * @param {(video: object) => boolean} hasNewPosition
 */
export function restoreFromArchive(existing, video, ctx, hasNewPosition = () => false) {
  const stamp = stateStamp(ctx);
  if (existing.state === 'purged') return { ...video, state: 'active', ...stamp };
  const readFromPage = video.metadataSource === 'scrape';
  return {
    ...existing,
    ...(readFromPage ? video : {}),
    url: video.url ?? existing.url,
    title: video.title && video.title !== 'Unknown Title' ? video.title : existing.title,
    dateSaved: video.dateSaved ?? stamp.stateChangedAt,
    timestampSeconds: hasNewPosition(video) ? video.timestampSeconds : (existing.timestampSeconds ?? 0),
    pendingRestoreCheck: video.pendingRestoreCheck,
    state: 'active',
    ...stamp,
  };
}

/**
 * Merge records from a backup into the list. A video not in the list is
 * added as it was in the backup. For a video in both, the newer change of
 * state wins; a backup record with no change date (a v1 backup) never
 * replaces one in the list.
 * @param {object[]} videos current list (not modified)
 * @param {object[]} incoming sanitized backup records
 * @param {{ deviceId?: string, now?: Date }} ctx
 * @returns {{ videos: object[], result: { added: number, updated: number } }}
 */
export function importRecords(videos, incoming, ctx) {
  const stamp = stateStamp(ctx);
  const current = new Map(videos.map(v => [v.videoId, v]));
  const replaced = new Map();
  const added = [];
  const seen = new Set();
  for (const record of incoming) {
    if (!record?.videoId || seen.has(record.videoId)) continue;
    seen.add(record.videoId);
    const existing = current.get(record.videoId);
    if (!existing) {
      added.push({
        ...record,
        state: record.state ?? 'active',
        stateChangedAt: record.stateChangedAt ?? stamp.stateChangedAt,
        stateChangedBy: record.stateChangedBy ?? stamp.stateChangedBy,
      });
      continue;
    }
    const theirs = Date.parse(record.stateChangedAt);
    const ours = Date.parse(existing.stateChangedAt);
    if (!Number.isNaN(theirs) && (Number.isNaN(ours) || theirs > ours)) replaced.set(record.videoId, record);
  }
  if (!added.length && !replaced.size) return { videos, result: { added: 0, updated: 0 } };
  const next = sortBySaved([...added, ...videos.map(v => replaced.get(v.videoId) ?? v)]);
  return { videos: next, result: { added: added.length, updated: replaced.size } };
}
