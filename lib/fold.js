// The fold sequence, kept free of browser APIs so it can be unit-tested.
// Rule: never close a tab without having saved it.
//
//   1. Read every tab (scrape, or fall back to its URL and title).
//   2. Save everything that has a video ID, in one write.
//   3. Close only the tabs whose video was saved.
//
// If the worker dies between 2 and 3, tabs stay open *and* saved; the next
// fold dedupes them. That is the safe direction to fail in.

import { urlToVideoData } from './youtube.js';

/**
 * @typedef {object} FoldDeps
 * @property {(tab: object) => Promise<object | null>} readTab
 *   Scrape a loaded tab. May throw or return null; the fold then falls back
 *   to the tab's URL and title. Not called for discarded tabs.
 * @property {(videos: object[]) => Promise<void>} save
 *   Persist the videos (newest first). If it throws, no tab is closed.
 * @property {(tabId: number) => Promise<void>} closeTab
 */

/**
 * @param {object[]} tabs chrome.tabs.Tab-like objects ({ id, url, title, discarded, status })
 * @param {FoldDeps} deps
 * @returns {Promise<{ closed: number, leftOpen: number, saved: number, saveFailed: boolean }>}
 */
export async function foldTabs(tabs, { readTab, save, closeTab }) {
  const videos = [];
  const tabIdsToClose = [];

  for (const tab of tabs) {
    const video = await readVideo(tab, readTab);
    if (!video) continue; // no video ID: leave the tab open, save nothing
    videos.push(video);
    tabIdsToClose.push(tab.id);
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

  const results = await Promise.allSettled(tabIdsToClose.map(id => closeTab(id)));
  const closed = results.filter(r => r.status === 'fulfilled').length;
  return { closed, leftOpen: tabs.length - closed, saved: videos.length, saveFailed: false };
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
