// One owner for savedVideos.
//
// Every change to the saved list is an operation applied to the *current*
// stored array, one at a time, by the service worker. Nobody writes back an
// array they read earlier, so a slow writer (enrichment waiting on the
// network) can't resurrect deleted videos or erase a concurrent fold.
//
// This file is pure: no browser APIs, so the operations are unit-tested.

import { mergeVideos, hasNewPosition } from './youtube.js';
import {
  isActive, isArchived, stateStamp, restoreFromArchive, importRecords, tombstone, purgeExpired,
} from './archive.js';

/**
 * Run async tasks strictly one after another. A failing task rejects its own
 * promise but does not block the tasks queued after it.
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>}
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * The savedVideos mutator. Each change runs against a fresh read and is
 * written before the next change starts.
 * @param {{ read: () => Promise<object[]>, write: (videos: object[]) => Promise<void> }} storage
 * @returns {(change: (videos: object[]) => { videos: object[], result?: unknown }) => Promise<unknown>}
 *   change must not modify its input; returning the same array skips the write
 */
export function createVideoStore({ read, write }) {
  const enqueue = createSerialQueue();
  return (change) => enqueue(async () => {
    const current = await read();
    const { videos, result } = change(current);
    if (videos !== current) await write(videos);
    return result;
  });
}

/**
 * Operations on the list. Each is plain data so it can cross
 * chrome.runtime.sendMessage.
 *
 *   { type: 'add', videos }            new videos first, skipping saved IDs;
 *                                      a watched or deleted video comes back
 *   { type: 'import', videos }         records from a backup
 *   { type: 'archive', videoIds, state }
 *                                      library → 'watched' (opened) or
 *                                      'deleted' (removed). result: { changed }
 *   { type: 'unarchive', videoIds }    watched or deleted → back in the
 *                                      library (undo, and Restore in History)
 *   { type: 'forget', videoIds }       watched or deleted → deleted forever
 *   { type: 'clearHistory' }           every watched or deleted video → deleted forever
 *   { type: 'purge' }                  drop history older than ARCHIVE_DAYS
 *
 * Records are never removed from the list, except by 'purge'. Every change
 * of state is stamped with ctx (when, and on which install).
 *
 * @param {object[]} videos current stored array (not modified)
 * @param {object} op
 * @param {{ deviceId?: string, now?: Date }} [ctx]
 * @returns {{ videos: object[], result: unknown }} videos is the same array
 *   when nothing changed, so the caller can skip the write
 */
export function applyVideoOp(videos, op, ctx = {}) {
  switch (op?.type) {
    case 'add': {
      const incoming = Array.isArray(op.videos) ? op.videos : [];
      // A video saved again after it was watched or deleted comes back to
      // the library as a new save.
      const archived = new Map(videos.filter(v => !isActive(v)).map(v => [v.videoId, v]));
      const restored = new Map();
      const fresh = [];
      for (const video of incoming) {
        const old = archived.get(video?.videoId);
        if (!old) { fresh.push(video); continue; }
        if (!restored.has(video.videoId)) restored.set(video.videoId, restoreFromArchive(old, video, ctx, hasNewPosition));
      }
      const { merged, added, updated } = mergeVideos(fresh, videos);
      if (!added.length && !updated && !restored.size) return { videos, result: { added: 0 } };

      const stamp = stateStamp(ctx);
      const addedIds = new Set(added.map(v => v.videoId));
      const next = [
        ...restored.values(),
        ...merged
          .filter(v => !restored.has(v.videoId))
          .map(v => (addedIds.has(v.videoId) && !v.state ? { ...v, state: 'active', ...stamp } : v)),
      ];
      return { videos: next, result: { added: added.length + restored.size } };
    }

    case 'import': {
      const { videos: next, result } = importRecords(videos, Array.isArray(op.videos) ? op.videos : [], ctx);
      // Old history in a backup is not brought back only to expire.
      return { videos: purgeExpired(next, ctx.now).videos, result };
    }

    case 'archive': {
      if (op.state !== 'watched' && op.state !== 'deleted') throw new Error(`Cannot archive as ${op.state}`);
      return changeState(videos, op.videoIds, isActive, () => ({ state: op.state, ...stateStamp(ctx) }));
    }

    case 'unarchive':
      return changeState(videos, op.videoIds, isArchived, () => ({ state: 'active', ...stateStamp(ctx) }));

    case 'forget':
      return changeState(videos, op.videoIds, isArchived, null, ctx);

    case 'clearHistory':
      return changeState(videos, videos.filter(isArchived).map(v => v.videoId), isArchived, null, ctx);

    case 'purge':
      return purgeExpired(videos, ctx.now);

    default:
      throw new Error(`Unknown savedVideos operation: ${op?.type}`);
  }
}

// Change the records with these IDs that pass `eligible`. `fields` gives the
// fields to set; without it the record becomes a tombstone.
function changeState(videos, videoIds, eligible, fields, ctx) {
  const ids = new Set(Array.isArray(videoIds) ? videoIds : []);
  const changed = [];
  const next = videos.map(video => {
    if (!ids.has(video.videoId) || !eligible(video)) return video;
    changed.push(video.videoId);
    return fields ? { ...video, ...fields() } : tombstone(video, ctx);
  });
  return { videos: changed.length ? next : videos, result: { changed } };
}

/**
 * Apply field updates to matching videos (all copies with that ID), leaving
 * every other video, including ones added or removed meanwhile, untouched.
 * @param {object[]} videos
 * @param {Map<string, object>} patches videoId → fields to set
 * @returns {{ videos: object[], result: { patched: number } }}
 */
export function patchVideos(videos, patches) {
  let patched = 0;
  const next = videos.map(video => {
    const patch = patches.get(video.videoId);
    if (!patch) return video;
    patched++;
    return { ...video, ...patch };
  });
  return { videos: patched ? next : videos, result: { patched } };
}

/**
 * True for a video saved when its window closed and not yet checked against
 * the tabs the browser restores. Older libraries have no marker: an
 * "auto-collapsed" entry without one is treated as pending once.
 * @param {object} video
 */
export function isPendingRestoreCheck(video) {
  return video.pendingRestoreCheck === true
    || (video.metadataSource === 'auto-collapsed' && video.pendingRestoreCheck === undefined);
}

/**
 * Startup check after a window-close save. A video saved on close whose tab
 * the browser restored is open again, so it moves out of the library to
 * History as watched. Every other pending video is marked checked, so a
 * later startup with that video open in a tab never moves it. The marker is
 * independent of metadataSource, so enrichment relabelling a video does not
 * hide it from this check.
 * @param {object[]} videos
 * @param {Set<string>} openVideoIds video IDs of the tabs open at startup
 * @param {{ deviceId?: string, now?: Date }} [ctx]
 * @returns {{ videos: object[], result: { reopened: string[] } }}
 */
export function reconcileRestoredTabs(videos, openVideoIds, ctx = {}) {
  const reopened = [];
  let changed = false;
  const next = videos.map(video => {
    if (!isActive(video) || !isPendingRestoreCheck(video)) return video;
    changed = true;
    if (!openVideoIds.has(video.videoId)) return { ...video, pendingRestoreCheck: false };
    reopened.push(video.videoId);
    return { ...video, pendingRestoreCheck: false, state: 'watched', ...stateStamp(ctx) };
  });
  return { videos: changed ? next : videos, result: { reopened } };
}
