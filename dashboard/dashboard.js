// The dashboard's entry point: loads settings and the library, wires up the
// controls, and re-renders when storage changes.
//
//   state.js    what the dashboard is showing right now
//   store.js    reading and changing storage
//   filters.js  search, media-type and length filters, and sort (pure)
//   render.js   drawing the page from state
//   controls.js everything the user clicks or types

import { state } from './state.js';
import { setRecords, loadLibrary, loadSettings, loadLibraryView, changeVideos, readApiError } from './store.js';
import { showSkeletons, showLoadFailed, renderLibrary, renderHistory, renderSettingsHistory, renderBackupButtons } from './render.js';
import { bindControls, showSettings, showLibraryView, applyTheme, showApiError, readShortcutRows, fillShortcutRefs } from './controls.js';

document.addEventListener('DOMContentLoaded', () => {
  init();
});

// The service worker asks before opening a dashboard, so there is only ever
// one: this tab brings itself to the front and says so.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || request?.action !== 'focusDashboard') return;
  focusThisTab().then(sendResponse, () => sendResponse(false));
  return true; // respond asynchronously
});

async function focusThisTab() {
  const tab = await chrome.tabs.getCurrent();
  if (!tab) return false; // not shown in a tab
  await chrome.tabs.update(tab.id, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  return true;
}

async function init() {
  await Promise.all([loadSettings(), loadLibraryView()]);
  showSettings();
  showLibraryView();
  bindControls();
  readShortcutRows().then(fillShortcutRefs);
  showSkeletons();
  try {
    await loadLibrary();
    renderLibrary();
  } catch (err) {
    console.error('Failed to load videos:', err);
    showLoadFailed();
  }
  // History older than 90 days goes each time the dashboard opens.
  changeVideos({ type: 'purge' }).catch(e => console.error('FoldTube: purge failed', e));

  // Re-apply theme if OS preference changes while user is in 'system' mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme('system');
  });

  readApiError().then(on => { if (on) showApiError(true); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hasSavedBefore) state.hasSavedBefore = Boolean(changes.hasSavedBefore.newValue);
    if (changes.savedVideos) {
      setRecords(changes.savedVideos.newValue);
      const currentIds = new Set(state.videos.map(v => v.videoId));
      for (const id of state.selected) {
        if (!currentIds.has(id)) state.selected.delete(id);
      }
      if (state.history.open) renderHistory();
      else renderLibrary();
      renderSettingsHistory();
      renderBackupButtons();
    }
    if (changes.apiError) showApiError(Boolean(changes.apiError.newValue));
  });
}
