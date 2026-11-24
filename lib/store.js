// One owner for savedVideos.
//
// Every change to the saved list is an operation applied to the *current*
// stored array, one at a time, by the service worker. Nobody writes back an
// array they read earlier, so a slow writer (enrichment waiting on the
// network) can't resurrect deleted videos or erase a concurrent fold.
//
// This file is pure: no browser APIs, so the operations are unit-tested.

import { mergeVideos, hasNewPosition } from './youtube.js';
import { isActive, stateStamp, restoreFromArchive, importRecords } from './archive.js';

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
 * Operations the dashboard may send. Each is plain data so it can cross
 * chrome.runtime.sendMessage.
 *
 *   { type: 'add', videos }              new videos first, skipping saved IDs
 *   { type: 'remove', videoIds }         result: [{ video, index }] removed
 *   { type: 'restore', entries }         undo of 'remove': re-insert at prior
 *                                        positions, skipping IDs saved since
 *
 * @param {object[]} videos current stored array (not modified)
 * @param {object} op
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

    case 'import':
      return importRecords(videos, Array.isArray(op.videos) ? op.videos : [], ctx);

    case 'remove': {
      const ids = new Set(Array.isArray(op.videoIds) ? op.videoIds : []);
      const removed = [];
      const kept = [];
      videos.forEach((video, index) => {
        if (ids.has(video.videoId)) removed.push({ video, index });
        else kept.push(video);
      });
      return { videos: removed.length ? kept : videos, result: { removed } };
    }

    case 'restore': {
      const entries = (Array.isArray(op.entries) ? op.entries : [])
        .filter(e => e && e.video && typeof e.video.videoId === 'string')
        .sort((a, b) => a.index - b.index);
      const present = new Set(videos.map(v => v.videoId));
      const next = [...videos];
      let restored = 0;
      for (const { video, index } of entries) {
        if (present.has(video.videoId)) continue; // saved again since: keep the newer copy
        const at = Number.isInteger(index) && index >= 0 ? Math.min(index, next.length) : 0;
        next.splice(at, 0, video);
        present.add(video.videoId);
        restored++;
      }
      return { videos: restored ? next : videos, result: { restored } };
    }

    default:
      throw new Error(`Unknown savedVideos operation: ${op?.type}`);
  }
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
 * Startup check after a window-close save. Videos saved on close whose tab
 * the browser restored are duplicates and are removed. Every other pending
 * video is marked checked, so a later startup with that video open in a tab
 * never deletes it. The marker is independent of metadataSource, so
 * enrichment relabelling a video does not hide it from this check.
 * @param {object[]} videos
 * @param {Set<string>} openVideoIds video IDs of the tabs open at startup
 * @returns {{ videos: object[], result: { removed: { video: object, index: number }[] } }}
 */
export function reconcileRestoredTabs(videos, openVideoIds) {
  const removed = [];
  const next = [];
  let changed = false;
  videos.forEach((video, index) => {
    if (!isPendingRestoreCheck(video)) {
      next.push(video);
      return;
    }
    changed = true;
    if (openVideoIds.has(video.videoId)) removed.push({ video, index });
    else next.push({ ...video, pendingRestoreCheck: false });
  });
  return { videos: changed ? next : videos, result: { removed } };
}
