// The number on the toolbar icon. The user picks what it counts in
// Settings: the YouTube video tabs a click would fold, the videos in the
// library, or nothing.
//
// This file is pure: the service worker reads tabs and storage and sets the
// badge.

import { countFoldableTabs } from './youtube.js';
import { isActive } from './archive.js';

export const BADGE_MODES = ['tabs', 'library', 'off'];
export const DEFAULT_BADGE_MODE = 'tabs';

/** The badge mode in these settings, or the default. */
export function badgeMode(settings) {
  return BADGE_MODES.includes(settings?.badge) ? settings.badge : DEFAULT_BADGE_MODE;
}

/**
 * What the badge counts.
 * @param {'tabs' | 'library' | 'off'} mode
 * @param {{ tabs?: { url?: string }[], videos?: object[] }} from open tabs, or every stored record
 */
export function badgeCount(mode, { tabs = [], videos = [] } = {}) {
  if (mode === 'tabs') return countFoldableTabs(tabs);
  if (mode === 'library') return videos.filter(isActive).length;
  return 0;
}

/** The badge text: nothing for 0, "999+" past 999. */
export function badgeText(count) {
  if (!Number.isFinite(count) || count < 1) return '';
  return count > 999 ? '999+' : String(Math.floor(count));
}
