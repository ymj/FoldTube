// What the dashboard is showing right now. The other modules read and change
// this one object; nothing here touches the page or storage.

import { DEFAULT_BADGE_MODE } from '../lib/badge.js';

export const state = {
  // Every stored record, History included (for History and backups), and the
  // library: the active ones, which is what the grid, search and filters show.
  records: [],
  videos: [],
  selected: new Set(),
  // Nothing ever saved (first run) vs everything watched or removed.
  hasSavedBefore: false,

  library: {
    query: '', // lower-cased
    sort: 'date-desc',
    duration: null, // { min, max } in seconds, or null for any length
    // Remembered between visits:
    groupBy: 'none', // 'none' (by media type: Videos and Shorts sections), or by channel in an order: see GROUP_BY
    collapsed: new Set(), // collapsed groups, as "<section>:<channel>"
  },

  history: {
    open: false,
    query: '', // lower-cased
    filter: 'all',
  },

  settings: {
    autoCollapse: false,
    apiKey: '',
    theme: 'system', // 'system' | 'light' | 'dark'
    badge: DEFAULT_BADGE_MODE, // what the toolbar icon counts: 'tabs' | 'library' | 'off'
  },

  // Videos an import skipped, offered in the import dialog.
  pendingSkipped: [],
};
