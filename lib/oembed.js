// Channel names without an API key, from YouTube's public oEmbed endpoint.
//
// Videos saved without reading the page (window close, quit recovery, folds
// that fell back to the URL) have no channel. oEmbed returns the channel name
// and the real title for any public, embeddable video. It has no duration.
//
// This file is pure: the service worker does the fetching.

import { UNKNOWN_CHANNEL, UNKNOWN_TITLE, isYouTubeUrl } from './youtube.js';
import { patchVideos } from './store.js';

/** Marker for videos oEmbed can never describe (private, deleted, not embeddable). */
export const CHANNEL_UNAVAILABLE = 'unavailable';

// 400 invalid or unknown ID, 401/403 private or not embeddable, 404 deleted.
const PERMANENT_FAILURES = new Set([400, 401, 403, 404]);

/** Most lookups one run makes; the rest wait for the next run. */
export const MAX_LOOKUPS_PER_RUN = 100;

/**
 * @param {object} video
 * @returns {boolean} true if the channel is unknown and worth asking about
 */
export function needsChannelLookup(video) {
  return (!video.channelName || video.channelName === UNKNOWN_CHANNEL)
    && video.channelLookup !== CHANNEL_UNAVAILABLE;
}

/**
 * Video IDs to look up. Newest saves are at the front of the list, so they
 * are looked up first.
 * @param {object[]} videos
 * @param {number} [limit]
 * @returns {string[]}
 */
export function videoIdsForLookup(videos, limit = MAX_LOOKUPS_PER_RUN) {
  const ids = [];
  const seen = new Set();
  for (const video of videos) {
    if (ids.length >= limit) break;
    if (!needsChannelLookup(video) || seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    ids.push(video.videoId);
  }
  return ids;
}

/** The oEmbed request URL for a video ID. Shorts resolve from the watch URL too. */
export function oembedUrl(videoId) {
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`;
}

/**
 * What to do with an oEmbed HTTP status.
 * @param {number} status
 * @returns {'ok' | 'unavailable' | 'retry'}
 */
export function classifyOembedStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (PERMANENT_FAILURES.has(status)) return 'unavailable';
  return 'retry'; // 429, 5xx: try again on a later run
}

// A stored title that came from the tab rather than the page: the fallback,
// YouTube's placeholder before the page loads, or a title with YouTube's
// unread-notifications counter in front ("(3) Video title").
function isFallbackTitle(title) {
  return !title || title === UNKNOWN_TITLE || title === 'YouTube' || /^\(\d+\)\s/.test(title);
}

/**
 * Fields to set from an oEmbed response, or null if it has no usable channel.
 * The title is replaced only when the stored one is a fallback.
 * @param {object} video the stored video
 * @param {unknown} data parsed oEmbed JSON
 * @returns {object | null}
 */
export function oembedPatch(video, data) {
  const name = typeof data?.author_name === 'string' ? data.author_name.trim() : '';
  if (!name) return null;
  const patch = { channelName: name };
  if (typeof data.author_url === 'string' && isYouTubeUrl(data.author_url)) patch.channelUrl = data.author_url;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title && isFallbackTitle(video.title)) patch.title = title;
  return patch;
}

/**
 * Apply lookup results to the list as stored now. A video deleted, or filled
 * in by API enrichment, since the lookup started is left alone. A response
 * with no channel marks the video unavailable, so it isn't asked about again.
 * @param {object[]} videos current stored array (not modified)
 * @param {Map<string, unknown>} results videoId → parsed oEmbed JSON, or null for a permanent failure
 * @returns {{ videos: object[], result: { patched: number } }}
 */
export function applyOembedResults(videos, results) {
  const current = new Map(videos.map(v => [v.videoId, v]));
  const patches = new Map();
  for (const [id, data] of results) {
    const video = current.get(id);
    if (!video || !needsChannelLookup(video)) continue;
    patches.set(id, (data && oembedPatch(video, data)) || { channelLookup: CHANNEL_UNAVAILABLE });
  }
  return patchVideos(videos, patches);
}
