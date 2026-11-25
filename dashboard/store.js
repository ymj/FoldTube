// Reading and changing what the dashboard keeps in storage.
//
// The service worker owns savedVideos and migrates it to the current format;
// the dashboard asks it for changes and re-renders from storage.onChanged, so
// there is one write and one render.

import { decodeStored, isActive } from '../lib/archive.js';
import { badgeMode } from '../lib/badge.js';
import { state } from './state.js';

/** Take a new savedVideos value: every record, and the library. */
export function setRecords(stored) {
  state.records = decodeStored(stored);
  state.videos = state.records.filter(isActive);
}

/** Read the saved videos. Throws when storage can't be read. */
export async function loadLibrary() {
  const { savedVideos, hasSavedBefore } = await chrome.storage.local.get(['savedVideos', 'hasSavedBefore']);
  setRecords(savedVideos);
  state.hasSavedBefore = Boolean(hasSavedBefore);
  // Libraries from before this flag existed: having videos now counts.
  if (state.videos.length && !state.hasSavedBefore) {
    state.hasSavedBefore = true;
    chrome.storage.local.set({ hasSavedBefore: true });
  }
}

/** Ask the service worker for a change to the library. */
export async function changeVideos(op) {
  const response = await chrome.runtime.sendMessage({ action: 'mutateVideos', op });
  if (!response?.ok) throw new Error(response?.error || 'FoldTube background did not respond');
  return response.result;
}

// Opening a video moves it to History as watched; removing it, as deleted.
// Undo brings back the ones that changed.
export function archiveVideos(videoIds, archivedState) {
  return changeVideos({ type: 'archive', videoIds, state: archivedState });
}

// Undo: `archived` is what the archive change returned, so a video that was
// in History before gets its earlier entry back too.
export function unarchiveVideos(archived) {
  return changeVideos({ type: 'unarchive', videoIds: archived.changed, notes: archived.notes });
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  // In place: controls keep a reference to this object.
  if (settings) Object.assign(state.settings, settings);
  state.settings.badge = badgeMode(state.settings);
}

export function saveSettings() {
  return chrome.storage.local.set({ settings: state.settings });
}

export async function readApiError() {
  const { apiError } = await chrome.storage.local.get('apiError');
  return Boolean(apiError);
}

export function clearApiError() {
  return chrome.storage.local.set({ apiError: false });
}
