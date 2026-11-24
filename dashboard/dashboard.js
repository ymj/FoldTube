import {
  validateImport, buildHtmlExport, isYouTubeUrl, thumbnailUrlFor, YOUTUBE_TAB_PATTERNS, countFoldableTabs,
  resumeSeconds, openUrlFor, formatDuration, buildJsonExport,
} from '../lib/youtube.js';
import { decodeStored, isActive } from '../lib/archive.js';
import { describeShortcuts } from '../lib/shortcuts.js';

let allVideos = [];
let selectedVideoIds = new Set();
let searchQuery = "";
let currentSort = "date-desc";
let currentDurationFilter = null;

let appSettings = {
  autoCollapse: false,
  apiKey: '',
  theme: 'system' // 'system' | 'light' | 'dark'
};

// Undo state
let undoStack = null;
let undoTimer = null;

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

// ---- Debounce utility ----
function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// ---- Theme ----

/**
 * Applies the given theme preference to the document root.
 * - 'system': removes data-theme, letting the CSS @media query decide.
 * - 'light' / 'dark': sets data-theme so the explicit token block wins.
 */
function applyTheme(preference) {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}

// ---- Settings ----
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) appSettings = { ...appSettings, ...settings };
  document.getElementById('auto-collapse-toggle').checked = appSettings.autoCollapse;
  document.getElementById('api-key-input').value = appSettings.apiKey;
  document.getElementById('btn-clear-api').classList.toggle('hidden', !appSettings.apiKey);

  // Apply persisted theme and sync the selector
  applyTheme(appSettings.theme);
  document.getElementById('theme-select').value = appSettings.theme;
}

async function saveSettings() {
  await chrome.storage.local.set({ settings: appSettings });
  document.getElementById('btn-clear-api').classList.toggle('hidden', !appSettings.apiKey);
}

// ---- Init ----
async function init() {
  await loadSettings();
  bindControls();
  bindEmptyState();
  readShortcutRows().then(fillShortcutRefs);
  showSkeletons();
  await loadVideos();

  // Re-apply theme if OS preference changes while user is in 'system' mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appSettings.theme === 'system') applyTheme('system');
  });

  chrome.storage.local.get("apiError").then(({ apiError }) => {
    if (apiError) document.getElementById('api-error-banner').classList.remove('hidden');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.hasSavedBefore) hasSavedBefore = Boolean(changes.hasSavedBefore.newValue);
      if (changes.savedVideos) {
        setRecords(changes.savedVideos.newValue);
        const currentIds = new Set(allVideos.map(v => v.videoId));
        for (const id of selectedVideoIds) {
          if (!currentIds.has(id)) selectedVideoIds.delete(id);
        }
        processAndRender();
      }
      if (changes.apiError) {
        const banner = document.getElementById('api-error-banner');
        if (changes.apiError.newValue) banner.classList.remove('hidden');
        else banner.classList.add('hidden');
      }
    }
  });
}

// ---- Skeleton Loader ----
function showSkeletons(count = 8) {
  const grid = document.getElementById('video-grid');
  const section = document.getElementById('videos-section');
  section.classList.remove('hidden');
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const sk = document.createElement('div');
    sk.className = 'skeleton-card';
    sk.innerHTML = `<div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div>`;
    grid.appendChild(sk);
  }
}

// ---- Changing the library ----
// The service worker owns savedVideos; the dashboard asks it for changes and
// re-renders from storage.onChanged, so there is one write and one render.
async function changeVideos(op) {
  const response = await chrome.runtime.sendMessage({ action: 'mutateVideos', op });
  if (!response?.ok) throw new Error(response?.error || 'FoldTube background did not respond');
  return response.result;
}

function removeVideos(videoIds) {
  return changeVideos({ type: 'remove', videoIds });
}

function restoreVideos(removed) {
  return changeVideos({ type: 'restore', entries: removed });
}

// ---- Undo Toast ----
function showUndoToast(message, restoreFn) {
  clearTimeout(undoTimer);
  undoStack = restoreFn;

  const toast = document.getElementById('undo-toast');
  document.getElementById('undo-toast-msg').textContent = message;
  toast.classList.add('visible');

  undoTimer = setTimeout(() => {
    toast.classList.remove('visible');
    undoStack = null;
  }, 5000);
}

// ---- Empty state ----

// Two empty views: first run (nothing ever saved) and "all caught up"
// (everything saved has been watched or removed). When YouTube tabs are
// open, the main button folds them; otherwise it opens YouTube. The count
// follows tabs opened or closed elsewhere while the library is empty.
let hasSavedBefore = false;

async function refreshEmptyState() {
  if (allVideos.length) return;
  document.getElementById('empty-first-run').classList.toggle('hidden', hasSavedBefore);
  document.getElementById('empty-caught-up').classList.toggle('hidden', !hasSavedBefore);

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS });
  } catch (_) { /* no access to YouTube tabs: offer to open YouTube instead */ }
  const count = countFoldableTabs(tabs);
  const plural = count === 1 ? '' : 's';

  document.querySelectorAll('.empty-when-no-tabs').forEach(el => el.classList.toggle('hidden', count > 0));
  document.getElementById('empty-has-tabs').classList.toggle('hidden', count === 0);
  document.getElementById('empty-tab-count').textContent = `${count} YouTube tab${plural}`;

  const fold = document.getElementById('btn-fold-open-tabs');
  fold.classList.toggle('hidden', count === 0);
  if (!fold.disabled) fold.textContent = `Fold ${count} open tab${plural}`;
  document.getElementById('btn-open-youtube').classList.toggle('hidden', count > 0);
}

function bindEmptyState() {
  const fold = document.getElementById('btn-fold-open-tabs');
  fold.addEventListener('click', async () => {
    fold.disabled = true;
    fold.textContent = 'Folding…';
    try {
      const response = await chrome.runtime.sendMessage({ action: 'foldAllTabs' });
      if (!response?.ok) throw new Error(response?.error || 'FoldTube background did not respond');
    } catch (e) {
      console.error('FoldTube: fold from the empty state failed', e);
    } finally {
      fold.disabled = false;
      refreshEmptyState(); // the list itself re-renders from storage
    }
  });

  document.getElementById('btn-open-youtube').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.youtube.com/' });
  });

  document.getElementById('btn-empty-help').addEventListener('click', () => {
    document.getElementById('btn-help').click();
  });

  const recount = debounce(refreshEmptyState, 250);
  chrome.tabs.onCreated.addListener(recount);
  chrome.tabs.onRemoved.addListener(recount);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') recount();
  });
}

// ---- Keyboard Shortcuts (Settings) ----

// Fill a list with the shortcuts as currently bound (Settings and Help).
// Short labels, so the three fit side by side.
const SHORT_LABELS = { '_execute_action': 'Fold all tabs', 'fold-current-tab': 'Fold this tab', 'open-dashboard': 'Dashboard' };

async function readShortcutRows() {
  try {
    const [commands, { os }] = await Promise.all([chrome.commands.getAll(), chrome.runtime.getPlatformInfo()]);
    return describeShortcuts(commands, os);
  } catch (e) {
    console.error('FoldTube: could not read shortcuts', e);
    return describeShortcuts([], '');
  }
}

// Keys mentioned in running text (Help's first answer, the empty state).
// A [data-shortcut-wrap] phrase is hidden when its shortcut isn't set.
function fillShortcutRefs(rows) {
  const byCommand = new Map(rows.map(r => [r.name, r]));
  document.querySelectorAll('[data-shortcut]').forEach(el => {
    const row = byCommand.get(el.dataset.shortcut);
    el.textContent = row?.isSet ? row.keys : 'no shortcut set';
  });
  document.querySelectorAll('[data-shortcut-wrap]').forEach(el => {
    el.hidden = !byCommand.get(el.dataset.shortcutWrap)?.isSet;
  });
}

async function renderShortcuts(list) {
  const rows = await readShortcutRows();

  const items = rows.map(({ name: command, label, keys, isSet }) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'shortcut-label';
    name.textContent = SHORT_LABELS[command] || label;
    const value = document.createElement('span');
    value.className = 'shortcut-keys';
    if (isSet) {
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      value.appendChild(kbd);
    } else {
      value.classList.add('shortcut-unset');
      value.textContent = keys;
    }
    li.append(name, value);
    return li;
  });
  list.replaceChildren(...items);
  fitShortcutsCard(list.closest('.shortcuts-card'));
  fillShortcutRefs(rows);
}

// Version in the Settings and Help footers; Firefox-only help where it applies.
function fillAboutInfo() {
  const { version, description } = chrome.runtime.getManifest();
  document.querySelectorAll('.app-version').forEach(el => { el.textContent = version; });
  document.querySelectorAll('.app-description').forEach(el => { el.textContent = description; });
  // getBrowserInfo exists only in Firefox.
  if (typeof chrome.runtime.getBrowserInfo === 'function') {
    document.getElementById('faq-firefox').hidden = false;
  }
}

// Settings tabs: General (everyday) and Advanced (API key, backup).
const SETTINGS_TABS = ['general', 'advanced'];

function selectSettingsTab(name) {
  for (const tab of SETTINGS_TABS) {
    const selected = tab === name;
    const button = document.getElementById(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    document.getElementById(`panel-${tab}`).hidden = !selected;
  }
}

function bindSettingsTabs() {
  SETTINGS_TABS.forEach((tab, i) => {
    const button = document.getElementById(`tab-${tab}`);
    button.addEventListener('click', () => selectSettingsTab(tab));
    button.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = SETTINGS_TABS[(i + (e.key === 'ArrowRight' ? 1 : SETTINGS_TABS.length - 1)) % SETTINGS_TABS.length];
      selectSettingsTab(next);
      document.getElementById(`tab-${next}`).focus();
    });
  });
}

// Side by side when the shortcuts fit, stacked when they don't. Every key
// gets the width of the widest one, so they line up either way.
function fitShortcutsCard(card) {
  if (!card || !card.isConnected) return;
  const list = card.querySelector('.shortcut-keys-list');
  const keys = [...list.querySelectorAll('kbd')];
  keys.forEach(k => { k.style.minWidth = ''; });
  const widest = Math.ceil(Math.max(0, ...keys.map(k => k.getBoundingClientRect().width)));
  if (widest > 0) keys.forEach(k => { k.style.minWidth = `${widest}px`; });

  card.classList.remove('stacked');
  if (list.scrollWidth > list.clientWidth) card.classList.add('stacked');
}

// Re-check when the card's width changes (window resized, dialog opened).
// The re-check changes the card's own layout, so it runs on the next frame,
// outside the observer callback; otherwise the browser reports a
// "ResizeObserver loop" error. Height changes from stacking are ignored.
const shortcutsCardObserver = new ResizeObserver(entries => {
  for (const { target, contentRect } of entries) {
    const width = String(Math.round(contentRect.width));
    if (target.dataset.width === width) continue;
    target.dataset.width = width;
    requestAnimationFrame(() => fitShortcutsCard(target));
  }
});
document.querySelectorAll('.shortcuts-card').forEach(card => shortcutsCardObserver.observe(card));

// Chrome, Brave and Edge have a shortcuts page; Firefox opens its own.
// If neither works, show the written steps in `hint`.
async function openShortcutSettings(hint) {
  if (typeof chrome.commands.openShortcutSettings === 'function') {
    try {
      await chrome.commands.openShortcutSettings();
      return;
    } catch (_) {
      hint.classList.remove('hidden');
      return;
    }
  }
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  } catch (_) {
    hint.classList.remove('hidden');
  }
}

// ---- Controls ----
function bindControls() {
  // Settings Modal
  const settingsModal = document.getElementById('settings-modal');
  const helpModal = document.getElementById('help-modal');
  // Bindings are re-read each time: they may have changed since last time.
  const openSettings = () => {
    selectSettingsTab('general');
    renderShortcuts(document.getElementById('shortcut-list'));
    settingsModal.showModal();
  };
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-help').addEventListener('click', () => {
    renderShortcuts(document.getElementById('help-shortcut-list'));
    helpModal.showModal();
  });
  document.getElementById('btn-close-help').addEventListener('click', () => helpModal.close());
  document.getElementById('btn-help-change-shortcuts')
    .addEventListener('click', () => openShortcutSettings(document.getElementById('help-shortcut-hint')));
  bindSettingsTabs();
  fillAboutInfo();
  document.getElementById('btn-change-shortcuts')
    .addEventListener('click', () => openShortcutSettings(document.getElementById('shortcut-hint')));
  document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.close());

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsModal.open) { settingsModal.close(); return; }
      if (helpModal.open) { helpModal.close(); return; }
    }
    if (e.key === 'Delete' && selectedVideoIds.size > 0 && document.activeElement.tagName !== 'INPUT') {
      document.getElementById('btn-delete-selected').click();
    }
  });

  // Undo button
  document.getElementById('btn-undo').addEventListener('click', async () => {
    if (undoStack) {
      await undoStack();
      undoStack = null;
      clearTimeout(undoTimer);
      document.getElementById('undo-toast').classList.remove('visible');
    }
  });

  // API Error Banner dismiss
  document.getElementById('btn-dismiss-banner').addEventListener('click', async () => {
    document.getElementById('api-error-banner').classList.add('hidden');
    await chrome.storage.local.set({ apiError: false });
  });

  // Settings
  document.getElementById('auto-collapse-toggle').addEventListener('change', async (e) => {
    appSettings.autoCollapse = e.target.checked;
    await saveSettings();
  });

  document.getElementById('theme-select').addEventListener('change', async (e) => {
    appSettings.theme = e.target.value;
    applyTheme(appSettings.theme);
    await saveSettings();
  });

  document.getElementById('btn-save-api').addEventListener('click', async () => {
    appSettings.apiKey = document.getElementById('api-key-input').value.trim();
    await saveSettings();
    const btn = document.getElementById('btn-save-api');
    btn.textContent = "Saved!";
    setTimeout(() => { btn.textContent = "Save Key"; }, 2000);
    await chrome.storage.local.set({ apiError: false });
    chrome.runtime.sendMessage({ action: "runEnrichment" });
  });

  document.getElementById('btn-clear-api').addEventListener('click', async () => {
    appSettings.apiKey = '';
    document.getElementById('api-key-input').value = '';
    await saveSettings();
    await chrome.storage.local.set({ apiError: false });
  });

  // Export JSON
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildJsonExport(allRecords), null, 2)], { type: "application/json" });
    triggerDownload(blob, `foldtube_backup_${today()}.json`);
  });

  // Export HTML
  document.getElementById('btn-export-html').addEventListener('click', () => {
    const html = buildHtmlExport(allVideos, { date: today(), exportedAt: new Date().toLocaleString() });
    triggerDownload(new Blob([html], { type: "text/html" }), `foldtube_bookmarks_${today()}.html`);
  });

  // Import JSON
  document.getElementById('btn-import-trigger').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const validItems = validateImport(JSON.parse(evt.target.result));
        const { added } = await changeVideos({ type: 'import', videos: validItems });
        settingsModal.close();
        alert(`Imported ${added} new video${added === 1 ? '' : 's'}!`);
      } catch {
        alert("Failed to parse the JSON file. Please check it's a valid FoldTube backup.");
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  // Search (debounced)
  document.getElementById('search-input').addEventListener('input', debounce((e) => {
    searchQuery = e.target.value.toLowerCase();
    processAndRender();
  }, 150));

  // Sort
  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    processAndRender();
  });

  // Duration filter pills
  document.getElementById('duration-filters').addEventListener('click', (e) => {
    if (!e.target.classList.contains('filter-pill')) return;
    const isAllPill = e.target.dataset.all === "true";
    const isActive = e.target.classList.contains('active');
    document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.remove('active'));
    if (isAllPill || isActive) {
      document.querySelector('.filter-pill[data-all="true"]').classList.add('active');
      currentDurationFilter = null;
    } else {
      e.target.classList.add('active');
      currentDurationFilter = { min: parseInt(e.target.dataset.min, 10), max: parseInt(e.target.dataset.max, 10) };
    }
    processAndRender();
  });

  // Bulk actions
  document.getElementById('btn-select-all').addEventListener('click', () => {
    getProcessedVideos().forEach(v => selectedVideoIds.add(v.videoId));
    updateSelectionBar();
    document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = true);
    document.querySelectorAll('.video-card').forEach(c => c.classList.add('selected'));
  });

  document.getElementById('btn-deselect-all').addEventListener('click', () => {
    selectedVideoIds.clear();
    updateSelectionBar();
    document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = false);
    document.querySelectorAll('.video-card').forEach(c => c.classList.remove('selected'));
  });

  document.getElementById('btn-open-selected').addEventListener('click', async () => {
    if (!selectedVideoIds.size) return;
    if (selectedVideoIds.size > 10 && !confirm(`This will open ${selectedVideoIds.size} tabs. Continue?`)) return;
    // Only entries with a YouTube link are opened and removed; others stay saved.
    const removed = allVideos.filter(v => selectedVideoIds.has(v.videoId) && isYouTubeUrl(v.url));
    const ids = new Set(removed.map(v => v.videoId));
    const count = removed.length;
    if (count === 0) return;
    removed.forEach(v => chrome.tabs.create({ url: openUrlFor(v), active: false }));
    selectedVideoIds.clear();
    updateSelectionBar();
    const result = await removeVideos([...ids]);
    showUndoToast(`${count} video${count > 1 ? 's' : ''} opened & removed`, () => restoreVideos(result.removed));
  });

  document.getElementById('btn-delete-selected').addEventListener('click', async () => {
    if (!selectedVideoIds.size) return;
    const ids = new Set(selectedVideoIds);
    const count = ids.size;
    if (count > 1 && !confirm(`Delete ${count} selected videos?`)) return;
    selectedVideoIds.clear();
    updateSelectionBar();
    const result = await removeVideos([...ids]);
    showUndoToast(`${count} video${count > 1 ? 's' : ''} removed`, () => restoreVideos(result.removed));
  });
}

// ---- Selection bar ----
function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const count = document.getElementById('selection-count');
  bar.classList.toggle('hidden', selectedVideoIds.size === 0);
  count.textContent = `${selectedVideoIds.size} selected`;
}

// ---- Load & Render ----

// Every record, archived ones included (for the backup), and the library:
// the active ones, which is what the grid, search and filters show.
let allRecords = [];
function setRecords(stored) {
  allRecords = decodeStored(stored);
  allVideos = allRecords.filter(isActive);
}

async function loadVideos() {
  try {
    const { savedVideos, hasSavedBefore: savedBefore } = await chrome.storage.local.get(["savedVideos", "hasSavedBefore"]);
    setRecords(savedVideos);
    hasSavedBefore = Boolean(savedBefore);
    // Libraries from before this flag existed: having videos now counts.
    if (allVideos.length && !hasSavedBefore) {
      hasSavedBefore = true;
      chrome.storage.local.set({ hasSavedBefore: true });
    }
    processAndRender();
  } catch (err) {
    console.error("Failed to load videos:", err);
    document.getElementById('videos-section').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
  }
}

function getProcessedVideos() {
  let list = [...allVideos];
  if (searchQuery) {
    list = list.filter(v =>
      (v.title || '').toLowerCase().includes(searchQuery) ||
      (v.channelName || '').toLowerCase().includes(searchQuery) ||
      (v.description || '').toLowerCase().includes(searchQuery)
    );
  }
  if (currentDurationFilter) {
    list = list.filter(v => {
      const ds = v.durationSeconds || 0;
      return ds >= currentDurationFilter.min && ds < currentDurationFilter.max;
    });
  }
  list.sort((a, b) => {
    switch (currentSort) {
      case 'date-desc': return new Date(b.dateSaved) - new Date(a.dateSaved);
      case 'date-asc':  return new Date(a.dateSaved) - new Date(b.dateSaved);
      case 'dur-asc':   return (a.durationSeconds || 0) - (b.durationSeconds || 0);
      case 'dur-desc':  return (b.durationSeconds || 0) - (a.durationSeconds || 0);
      case 'chan-asc':  return (a.channelName || '').localeCompare(b.channelName || '');
      case 'chan-desc': return (b.channelName || '').localeCompare(a.channelName || '');
      case 'title-asc':  return (a.title || '').localeCompare(b.title || '');
      case 'title-desc': return (b.title || '').localeCompare(a.title || '');
      default: return 0;
    }
  });
  return list;
}

function processAndRender() {
  try {
    const videos = getProcessedVideos();
    updateSelectionBar();

    const videoGrid = document.getElementById('video-grid');
    const shortsGrid = document.getElementById('shorts-grid');
    const videosSection = document.getElementById('videos-section');
    const shortsSection = document.getElementById('shorts-section');
    const emptyState = document.getElementById('empty-state');
    const noResults = document.getElementById('no-results');
    const videoCount = document.querySelector('.video-count');

    if (videos.length === 0) {
      videoGrid.replaceChildren();
      shortsGrid.replaceChildren();
      videosSection.classList.add('hidden');
      shortsSection.classList.add('hidden');

      // An empty library gets the welcome; a search or filter with no hits
      // gets a plain "No matches".
      const libraryEmpty = allVideos.length === 0;
      emptyState.classList.toggle('hidden', !libraryEmpty);
      // Nothing to search, sort or filter in an empty library.
      document.getElementById('controls-bar').classList.toggle('hidden', libraryEmpty);
      videoCount.classList.toggle('hidden', libraryEmpty);
      noResults.classList.toggle('hidden', libraryEmpty);
      if (libraryEmpty) {
        videoCount.textContent = '0 items';
        refreshEmptyState();
      } else {
        videoCount.textContent = `Showing 0 of ${allVideos.length} items`;
      }
      return;
    }
    emptyState.classList.add('hidden');
    noResults.classList.add('hidden');
    document.getElementById('controls-bar').classList.remove('hidden');
    videoCount.classList.remove('hidden');
    videoCount.textContent = allVideos.length !== videos.length
      ? `Showing ${videos.length} of ${allVideos.length} items`
      : `${videos.length} item${videos.length === 1 ? '' : 's'}`;

    videoGrid.innerHTML = '';
    shortsGrid.innerHTML = '';

    const standard = videos.filter(v => v.videoType !== 'short');
    const shorts = videos.filter(v => v.videoType === 'short');

    videosSection.classList.toggle('hidden', standard.length === 0);
    shortsSection.classList.toggle('hidden', shorts.length === 0);

    standard.forEach((v, i) => videoGrid.appendChild(createCard(v, i)));
    shorts.forEach((v, i) => shortsGrid.appendChild(createCard(v, i)));

  } catch (err) {
    console.error("Render error:", err);
  }
}

// ---- Card factory ----
function createCard(video, index) {
  const card = document.createElement('div');
  card.className = 'video-card';
  if (selectedVideoIds.has(video.videoId)) card.classList.add('selected');
  card.dataset.id = video.videoId;
  card.style.animationDelay = `${Math.min(index * 0.04, 0.4)}s`;

  const date = new Date(video.dateSaved).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  // Checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'card-checkbox';
  checkbox.value = video.videoId;
  checkbox.checked = selectedVideoIds.has(video.videoId);
  card.appendChild(checkbox);

  // Thumbnail container
  const thumbContainer = document.createElement('div');
  thumbContainer.className = 'thumbnail-container';

  const img = document.createElement('img');
  img.className = 'thumbnail';
  img.loading = 'lazy';
  // Always derived from the video ID, never taken from stored data.
  img.src = thumbnailUrlFor(video.videoId);
  img.alt = video.title || '';
  img.onerror = function() { this.onerror = null; this.src = thumbnailUrlFor(video.videoId, 'hqdefault'); };
  thumbContainer.appendChild(img);

  if (video.durationFormatted) {
    const durBadge = document.createElement('span');
    durBadge.className = 'duration-badge';
    durBadge.textContent = video.durationFormatted;
    thumbContainer.appendChild(durBadge);
  }

  // Where it was left off: a progress bar when the length is known.
  const resumeAt = resumeSeconds(video);
  if (resumeAt > 0 && video.durationSeconds > 0) {
    const track = document.createElement('div');
    track.className = 'resume-track';
    const bar = document.createElement('div');
    bar.className = 'resume-bar';
    bar.style.width = `${Math.min(100, (resumeAt / video.durationSeconds) * 100)}%`;
    track.appendChild(bar);
    thumbContainer.appendChild(track);
  }
  card.appendChild(thumbContainer);

  // Card content
  const cardContent = document.createElement('div');
  cardContent.className = 'card-content';

  const title = document.createElement('h3');
  title.className = 'title';
  title.title = video.title || '';
  title.textContent = video.title || '';
  cardContent.appendChild(title);

  const channel = document.createElement('a');
  channel.href = isYouTubeUrl(video.channelUrl) ? video.channelUrl : '#';
  channel.className = 'channel';
  channel.target = '_blank';
  channel.rel = 'noopener noreferrer';
  channel.textContent = video.channelName || '';
  cardContent.appendChild(channel);

  const dateSaved = document.createElement('div');
  dateSaved.className = 'date-saved';
  dateSaved.textContent = `Saved: ${date}`;
  if (resumeAt > 0) {
    const resume = document.createElement('span');
    resume.className = 'resume-label';
    resume.textContent = `Resume at ${formatDuration(resumeAt)}`;
    dateSaved.append(' · ', resume);
  }
  cardContent.appendChild(dateSaved);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.title = 'Remove';
  deleteBtn.setAttribute('aria-label', 'Remove');
  deleteBtn.textContent = '\u00d7';
  cardContent.appendChild(deleteBtn);

  card.appendChild(cardContent);

  checkbox.addEventListener('change', (e) => {
    if (e.target.checked) { selectedVideoIds.add(video.videoId); card.classList.add('selected'); }
    else { selectedVideoIds.delete(video.videoId); card.classList.remove('selected'); }
    updateSelectionBar();
  });

  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('channel') || e.target.classList.contains('card-checkbox')) return;
    if (e.target.classList.contains('delete-btn')) {
      deleteSingleVideo(video, card);
    } else if (selectedVideoIds.size > 0) {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    } else {
      openSingleVideo(video, card);
    }
  });

  return card;
}

async function deleteSingleVideo(video, cardElement) {
  cardElement.classList.add('card-exit');
  // Remove after the exit animation; undo waits for the removal to finish.
  const removal = new Promise(resolve => setTimeout(resolve, 300))
    .then(() => removeVideos([video.videoId]));
  const title = typeof video.title === 'string' ? video.title.trim() : '';
  const toastMsg = title
    ? `"${title.length > 40 ? title.slice(0, 40) + '…' : title}" removed`
    : 'Video removed';
  showUndoToast(toastMsg, async () => restoreVideos((await removal).removed));
}

async function openSingleVideo(video, cardElement) {
  if (!isYouTubeUrl(video.url)) return; // not a YouTube link: keep it saved, open nothing
  chrome.tabs.create({ url: openUrlFor(video) });
  cardElement.classList.add('card-exit');
  setTimeout(() => removeVideos([video.videoId]), 300);
}

// ---- Utilities ----
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function today() {
  return new Date().toISOString().split('T')[0];
}
