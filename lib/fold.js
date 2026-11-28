// The fold sequence, kept free of browser APIs so it can be unit-tested.
// Rule: never close a tab without having saved it.
//
//   1. Read every tab (scrape, or fall back to its URL and title).
//   2. Save everything that has a video ID, in one write.
//   3. Close only the tabs whose video was saved, and only if they still
//      show it: a tab that moved on during the fold is left open.
//
// If the worker dies between 2 and 3, tabs stay open *and* saved; the next
// fold dedupes them. That is the safe direction to fail in.

import { urlToVideoData, isYouTubeUrl, parseVideoUrl } from './youtube.js';

/**
 * @typedef {object} FoldDeps
 * @property {(tab: object) => Promise<object | null>} readTab
 *   Scrape a loaded tab. May throw or return null; the fold then falls back
 *   to the tab's URL and title. Not called for discarded tabs.
 * @property {(videos: object[]) => Promise<void>} save
 *   Persist the videos (newest first). If it throws, no tab is closed.
 * @property {(tabId: number, videoId: string) => Promise<void>} closeTab
 *   Close the tab if it still shows `videoId` (see stillShowsVideo); throw to
 *   leave it open.
 */

/**
 * @param {object[]} tabs chrome.tabs.Tab-like objects ({ id, url, title, discarded, status })
 * @param {FoldDeps} deps
 * @returns {Promise<{ closed: number, leftOpen: number, saved: number, saveFailed: boolean }>}
 */
export async function foldTabs(tabs, { readTab, save, closeTab }) {
  const videos = [];
  const toClose = [];

  for (const tab of tabs) {
    const video = await readVideo(tab, readTab);
    if (!video) continue; // no video ID: leave the tab open, save nothing
    videos.push(video);
    toClose.push({ id: tab.id, videoId: video.videoId });
  }

  if (videos.length === 0) {
    return { closed: 0, leftOpen: tabs.length, saved: 0, saveFailed: false };
  }

  try {
    await save(videos);
  } catch (e) {
    console.error('FoldTube: saving folded videos failed; no tabs closed.', e);
    return { closed: 0, leftOpen: tabs.length, saved: 0, saveFailed: true };
  }

  const results = await Promise.allSettled(toClose.map(({ id, videoId }) => closeTab(id, videoId)));
  const closed = results.filter(r => r.status === 'fulfilled').length;
  return { closed, leftOpen: tabs.length - closed, saved: videos.length, saveFailed: false };
}

/**
 * Whether a tab, as it is now, still shows the video that was saved from it.
 * A tab that moved to another page or video during a fold isn't closed.
 * @param {{ url?: string, pendingUrl?: string }} tab
 * @param {string} videoId
 */
export function stillShowsVideo(tab, videoId) {
  if (!tab || !isYouTubeUrl(tab.url) || parseVideoUrl(tab.url)?.videoId !== videoId) return false;
  // On its way somewhere else: it has moved on too.
  if (tab.pendingUrl && parseVideoUrl(tab.pendingUrl)?.videoId !== videoId) return false;
  return true;
}

async function readVideo(tab, readTab) {
  const discarded = tab.discarded || tab.status === 'unloaded';
  if (!discarded) {
    try {
      const scraped = await readTab(tab);
      if (scraped && scraped.videoId) return scraped;
    } catch {
      // Crashed, navigating or still-loading tab: use the URL instead.
    }
  }
  const fallback = urlToVideoData(tab.url, tab.title);
  if (fallback) fallback.metadataSource = discarded ? 'discarded' : 'url-only';
  return fallback;
}

/**
 * Decide what, if anything, to save when a tab is removed.
 * Only tabs closed together with their window are saved, and only when
 * auto-collapse is on. A normal single-tab close never saves anything.
 * @param {{ isWindowClosing?: boolean }} removeInfo from chrome.tabs.onRemoved
 * @param {{ autoCollapse?: boolean }} settings
 * @param {{ url: string, title?: string } | undefined} tabData cached tab info
 * @returns {object | null} the video to save
 */
export function autoCollapseVideo(removeInfo, settings, tabData) {
  if (!removeInfo?.isWindowClosing || !settings?.autoCollapse || !tabData) return null;
  const video = urlToVideoData(tabData.url, tabData.title);
  if (!video) return null;
  video.pendingRestoreCheck = true; // checked against restored tabs at next startup
  return video;
}

// ---- Write-ahead list of open YouTube tabs ----
//
// The browser may stop the extension before a quit finishes, so a window-close
// save can't be relied on. Instead the extension keeps a lasting list of the
// YouTube video tabs that are open, updated as tabs load and navigate. At the
// next start, any listed video whose tab didn't come back is saved.
//
// The list is a plain object: tab ID → { url, title }.

/**
 * The list entry for a tab, or null if it isn't a YouTube video tab.
 * @param {{ url?: string, title?: string }} tab
 */
export function tabSnapshotEntry(tab) {
  if (!tab?.url || !isYouTubeUrl(tab.url) || !parseVideoUrl(tab.url)) return null;
  return { url: tab.url, title: tab.title || '' };
}

/**
 * @param {object[]} tabs chrome.tabs.Tab-like objects
 * @returns {Record<string, { url: string, title: string }>}
 */
export function buildTabSnapshot(tabs) {
  const snapshot = {};
  for (const tab of tabs) {
    const entry = tabSnapshotEntry(tab);
    if (entry) snapshot[tab.id] = entry;
  }
  return snapshot;
}

/**
 * Record a tab's new URL or title. A tab that left YouTube is dropped.
 * @returns {object} a new object, or the same one when nothing changed
 */
export function updateTabSnapshot(snapshot, tabId, tab) {
  const entry = tabSnapshotEntry(tab);
  const current = snapshot[tabId];
  if (!entry) {
    if (!current) return snapshot;
    const { [tabId]: _removed, ...rest } = snapshot;
    return rest;
  }
  if (current && current.url === entry.url && current.title === entry.title) return snapshot;
  return { ...snapshot, [tabId]: entry };
}

/**
 * At the start of a browser session: the videos that were open when the last
 * session ended and whose tab didn't come back. Saved only with auto-collapse
 * on. Tabs the browser restored are open again, so they are skipped.
 * @param {Record<string, { url: string, title?: string }>} snapshot from the last session
 * @param {Set<string>} openVideoIds video IDs of the tabs open now
 * @param {{ autoCollapse?: boolean }} settings
 * @returns {object[]} videos to save
 */
export function recoverClosedTabs(snapshot, openVideoIds, settings) {
  if (!settings?.autoCollapse || !snapshot) return [];
  const videos = [];
  for (const entry of Object.values(snapshot)) {
    const video = urlToVideoData(entry?.url, entry?.title);
    if (video && !openVideoIds.has(video.videoId)) videos.push(video);
  }
  return videos;
}
