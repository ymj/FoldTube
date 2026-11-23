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
