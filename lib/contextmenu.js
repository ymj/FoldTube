// Right-click menus: "Fold this tab" on a YouTube video page, and
// "Save to FoldTube" on a link to a YouTube video.
//
// This file is pure: the service worker creates the menus and handles clicks.

import { YOUTUBE_TAB_PATTERNS, parseVideoUrl, urlToVideoData } from './youtube.js';

export const MENU_FOLD_TAB = 'fold-this-tab';
export const MENU_SAVE_LINK = 'save-link';

/** Links the "Save to FoldTube" menu appears on. */
export const VIDEO_LINK_PATTERNS = [
  '*://*.youtube.com/watch?*',
  '*://*.youtube.com/shorts/*',
  '*://*.youtube.com/live/*',
  '*://youtu.be/*',
];

/** The menu items, as passed to chrome.contextMenus.create. */
export function menuItems() {
  return [
    {
      id: MENU_FOLD_TAB,
      title: 'Fold this tab',
      contexts: ['page'],
      documentUrlPatterns: YOUTUBE_TAB_PATTERNS,
    },
    {
      id: MENU_SAVE_LINK,
      title: 'Save to FoldTube',
      contexts: ['link'],
      targetUrlPatterns: VIDEO_LINK_PATTERNS,
    },
  ];
}

/**
 * Set up the menus: clear them, then create each item. Calls never overlap:
 * one made while another runs waits for it. (Install and startup events can
 * fire together when the browser applies an update as it starts; two
 * overlapping setups would each clear, then each create, and the second
 * create fails with "duplicate id".) Create errors are read and logged.
 * @param {{ removeAll: () => Promise<void>, create: (item: object, done: () => void) => unknown }} menus
 * @param {() => { message?: string } | undefined} lastError chrome.runtime.lastError, read inside create's callback
 * @param {(...args: unknown[]) => void} [log]
 * @returns {() => Promise<void>}
 */
export function createMenuInstaller(menus, lastError, log = console.error) {
  let queue = Promise.resolve();
  const install = async () => {
    await menus.removeAll();
    for (const item of menuItems()) {
      await new Promise(resolve => {
        menus.create(item, () => {
          const error = lastError();
          if (error) log(`FoldTube: could not create the "${item.id}" menu`, error.message ?? error);
          resolve();
        });
      });
    }
  };
  return () => {
    queue = queue.then(install).catch(e => log('FoldTube: failed to create menus', e));
    return queue;
  };
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The clean watch or Shorts URL for a link to a YouTube video, without
 * tracking or playlist parameters. Not a video link → null.
 * @param {string} linkUrl
 * @returns {string | null}
 */
export function videoUrlFromLink(linkUrl) {
  let url;
  try {
    url = new URL(linkUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  let videoId;
  let isShort = false;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0];
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const parsed = parseVideoUrl(url.href);
    videoId = parsed?.videoId;
    isShort = parsed?.videoType === 'short';
  }
  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;

  return isShort
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * A saved-video record for a link, before its title and channel are known.
 * They are filled in afterwards, like any other URL-only save.
 * @param {string} linkUrl
 * @param {Date} [now]
 * @returns {object | null}
 */
export function linkToVideo(linkUrl, now = new Date()) {
  const url = videoUrlFromLink(linkUrl);
  if (!url) return null;
  const video = urlToVideoData(url, '', now);
  video.metadataSource = 'url-only';
  return video;
}
