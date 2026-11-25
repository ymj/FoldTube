// Everything the user clicks or types: the header, search and filters, the
// cards, Settings and Help, History, import and export, toasts and keyboard
// shortcuts.

import { validateImport, buildHtmlExport, buildJsonExport, isYouTubeUrl, openUrlFor } from '../lib/youtube.js';
import { isActive } from '../lib/archive.js';
import { historyItems } from '../lib/history.js';
import { describeShortcuts } from '../lib/shortcuts.js';
import { state } from './state.js';
import { CHANNEL_SORTS } from './filters.js';
import { changeVideos, archiveVideos, unarchiveVideos, saveSettings, clearApiError, saveLibraryView } from './store.js';
import {
  selectableVideos, setGroupCollapsed, renderLibrary, renderHistory, renderSettingsHistory, renderBackupButtons,
  renderImportResult, refreshEmptyState, updateSelectionBar, setCardSelected,
} from './render.js';

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/** Wire up every control. Called once, after settings are loaded. */
export function bindControls() {
  bindHeader();
  bindSettings();
  bindKeyboard();
  bindToasts();
  bindLibraryControls();
  bindCards();
  bindBulkActions();
  bindEmptyState();
  bindHistory();
  bindImportResult();
  bindStickyOffsets();
}

// Collapsing a group whose header is stuck at the top shrinks the group to
// above the screen: scroll back so its header stays where it was.
function keepHeaderInView(group) {
  const header = group.querySelector('.group-header');
  const stuckAt = parseFloat(getComputedStyle(header).top) || 0;
  const top = header.getBoundingClientRect().top;
  if (top < stuckAt) window.scrollBy(0, top - stuckAt);
}

// The controls bar sticks below the page header and the selection bar, and
// channel headers below all three; their heights change with the window
// width, with what's selected, and when the controls hide (empty library).
function bindStickyOffsets() {
  const root = document.documentElement;
  const header = document.querySelector('.header');
  const bar = document.getElementById('selection-bar');
  const controls = document.getElementById('controls-bar');
  // Exact heights, not rounded: a rounded-down height leaves a strip of the
  // cards behind showing above a stuck header.
  const update = () => {
    root.style.setProperty('--header-height', `${header.getBoundingClientRect().height}px`);
    root.style.setProperty('--selection-bar-height', `${bar.getBoundingClientRect().height}px`);
    root.style.setProperty('--controls-height', `${controls.getBoundingClientRect().height}px`);
  };
  new ResizeObserver(update).observe(header);
  new ResizeObserver(update).observe(bar);
  new ResizeObserver(update).observe(controls);
  update();
}

// ---- Theme ----

/**
 * Applies the given theme preference to the document root.
 * - 'system': removes data-theme, letting the CSS @media query decide.
 * - 'light' / 'dark': sets data-theme so the explicit token block wins.
 */
export function applyTheme(preference) {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}

// ---- Settings ----

/** Put the loaded settings into the Settings controls and apply the theme. */
export function showSettings() {
  const { settings } = state;
  document.getElementById('auto-collapse-toggle').checked = settings.autoCollapse;
  document.getElementById('api-key-input').value = settings.apiKey;
  document.getElementById('btn-clear-api').classList.toggle('hidden', !settings.apiKey);
  applyTheme(settings.theme);
  document.getElementById('theme-select').value = settings.theme;
  document.getElementById('badge-select').value = settings.badge;
}

/** Put the remembered Group by choice into its menu. */
export function showLibraryView() {
  document.getElementById('group-select').value = state.library.groupBy;
  syncSortChoices();
}

// Grouped by channel, every video in a group has the same channel: the
// Channel Name sorts would do nothing, so they're hidden, and a picked one
// falls back to newest first.
function syncSortChoices() {
  const grouped = state.library.groupBy !== 'none';
  const select = document.getElementById('sort-select');
  for (const option of select.options) {
    if (CHANNEL_SORTS.includes(option.value)) option.hidden = option.disabled = grouped;
  }
  if (grouped && CHANNEL_SORTS.includes(state.library.sort)) {
    state.library.sort = 'date-desc';
    select.value = 'date-desc';
  }
}

async function saveAndShowSettings() {
  await saveSettings();
  document.getElementById('btn-clear-api').classList.toggle('hidden', !state.settings.apiKey);
}

function bindHeader() {
  const settingsModal = document.getElementById('settings-modal');
  const helpModal = document.getElementById('help-modal');
  // Bindings are re-read each time: they may have changed since last time.
  document.getElementById('btn-settings').addEventListener('click', () => {
    selectSettingsTab('general');
    renderSettingsHistory();
    renderBackupButtons();
    renderShortcuts(document.getElementById('shortcut-list'));
    settingsModal.showModal();
  });
  document.getElementById('btn-help').addEventListener('click', () => {
    renderShortcuts(document.getElementById('help-shortcut-list'));
    helpModal.showModal();
  });
  document.getElementById('btn-close-help').addEventListener('click', () => helpModal.close());
  document.getElementById('btn-help-change-shortcuts')
    .addEventListener('click', () => openShortcutSettings(document.getElementById('help-shortcut-hint')));
  document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.close());
  fillAboutInfo();

  // API error banner
  document.getElementById('btn-dismiss-banner').addEventListener('click', async () => {
    document.getElementById('api-error-banner').classList.add('hidden');
    await clearApiError();
  });
}

/** Show or hide the "API key isn't working" banner. */
export function showApiError(on) {
  document.getElementById('api-error-banner').classList.toggle('hidden', !on);
}

function bindSettings() {
  const settingsModal = document.getElementById('settings-modal');
  const { settings } = state;
  bindSettingsTabs();
  document.getElementById('btn-change-shortcuts')
    .addEventListener('click', () => openShortcutSettings(document.getElementById('shortcut-hint')));

  document.getElementById('auto-collapse-toggle').addEventListener('change', async (e) => {
    settings.autoCollapse = e.target.checked;
    await saveAndShowSettings();
  });

  // The service worker updates the icon when the setting changes.
  document.getElementById('badge-select').addEventListener('change', async (e) => {
    settings.badge = e.target.value;
    await saveAndShowSettings();
  });

  document.getElementById('theme-select').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    applyTheme(settings.theme);
    await saveAndShowSettings();
  });

  document.getElementById('btn-save-api').addEventListener('click', async () => {
    settings.apiKey = document.getElementById('api-key-input').value.trim();
    await saveAndShowSettings();
    const btn = document.getElementById('btn-save-api');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save Key'; }, 2000);
    await clearApiError();
    chrome.runtime.sendMessage({ action: 'runEnrichment' });
  });

  document.getElementById('btn-clear-api').addEventListener('click', async () => {
    settings.apiKey = '';
    document.getElementById('api-key-input').value = '';
    await saveAndShowSettings();
    await clearApiError();
  });

  // Export JSON
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildJsonExport(state.records), null, 2)], { type: 'application/json' });
    triggerDownload(blob, `foldtube_backup_${today()}.json`);
  });

  // Export HTML
  document.getElementById('btn-export-html').addEventListener('click', () => {
    const html = buildHtmlExport(state.videos, { date: today(), exportedAt: new Date().toLocaleString() });
    triggerDownload(new Blob([html], { type: 'text/html' }), `foldtube_bookmarks_${today()}.html`);
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
      let validItems;
      try {
        validItems = validateImport(JSON.parse(evt.target.result));
      } catch {
        alert("Failed to parse the JSON file. Please check it's a valid FoldTube backup.");
        e.target.value = '';
        return;
      }
      try {
        const result = await changeVideos({ type: 'import', videos: validItems });
        settingsModal.close();
        showImportResult(result, validItems);
      } catch (err) {
        console.error('FoldTube: import failed', err);
        alert('The backup could not be imported. Please try again.');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
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

// ---- Keyboard shortcuts (Settings and Help) ----

// Fill a list with the shortcuts as currently bound (Settings and Help).
// Short labels, so the three fit side by side.
const SHORT_LABELS = { '_execute_action': 'Fold all tabs', 'fold-current-tab': 'Fold this tab', 'open-dashboard': 'Dashboard' };

export async function readShortcutRows() {
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
export function fillShortcutRefs(rows) {
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

// ---- Keyboard ----
function bindKeyboard() {
  const settingsModal = document.getElementById('settings-modal');
  const helpModal = document.getElementById('help-modal');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsModal.open) { settingsModal.close(); return; }
      if (helpModal.open) { helpModal.close(); return; }
      // From History, Esc goes back unless it is clearing a search.
      const active = document.activeElement;
      const typing = active.tagName === 'INPUT' && !(active.id === 'history-search' && !active.value);
      if (state.history.open && !typing) { showHistory(false); return; }
    }
    if (state.history.open) return;
    if (e.key === 'Delete' && state.selected.size > 0 && document.activeElement.tagName !== 'INPUT') {
      document.getElementById('btn-delete-selected').click();
    }
  });
}

// ---- Toasts ----
let undoAction = null;
let toastTimer = null;

function bindToasts() {
  document.getElementById('btn-undo').addEventListener('click', async () => {
    if (undoAction) {
      await undoAction();
      undoAction = null;
      clearTimeout(toastTimer);
      document.getElementById('undo-toast').classList.remove('visible');
    }
  });
}

function showUndoToast(message, undo) {
  clearTimeout(toastTimer);
  undoAction = undo;
  document.getElementById('btn-undo').hidden = false;

  const toast = document.getElementById('undo-toast');
  document.getElementById('undo-toast-msg').textContent = message;
  toast.classList.add('visible');

  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    undoAction = null;
  }, 5000);
}

// A short message in the toast, without Undo.
function showMessageToast(message) {
  clearTimeout(toastTimer);
  undoAction = null;
  const toast = document.getElementById('undo-toast');
  document.getElementById('undo-toast-msg').textContent = message;
  document.getElementById('btn-undo').hidden = true;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    document.getElementById('btn-undo').hidden = false;
  }, 4000);
}

// ---- Search, sort and length filter ----
function bindLibraryControls() {
  const view = state.library;
  document.getElementById('search-input').addEventListener('input', debounce((e) => {
    view.query = e.target.value.toLowerCase();
    renderLibrary();
  }, 150));

  document.getElementById('sort-select').addEventListener('change', (e) => {
    view.sort = e.target.value;
    renderLibrary();
  });

  document.getElementById('group-select').addEventListener('change', (e) => {
    view.groupBy = e.target.value;
    syncSortChoices();
    renderLibrary();
    saveLibraryView().catch(err => console.error('FoldTube: could not save the view', err));
  });

  document.getElementById('duration-filters').addEventListener('click', (e) => {
    if (!e.target.classList.contains('filter-pill')) return;
    const isAllPill = e.target.dataset.all === 'true';
    const isOn = e.target.classList.contains('active');
    document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.remove('active'));
    if (isAllPill || isOn) {
      document.querySelector('.filter-pill[data-all="true"]').classList.add('active');
      view.duration = null;
    } else {
      e.target.classList.add('active');
      view.duration = { min: parseInt(e.target.dataset.min, 10), max: parseInt(e.target.dataset.max, 10) };
    }
    renderLibrary();
  });
}

// ---- Cards ----

// One listener per grid, not one per card: a click finds its card and video.
function bindCards() {
  for (const grid of [document.getElementById('video-grid'), document.getElementById('shorts-grid')]) {
    grid.addEventListener('change', (e) => {
      if (!e.target.classList.contains('card-checkbox')) return;
      setCardSelected(e.target.closest('.video-card'), e.target.checked);
    });

    grid.addEventListener('click', (e) => {
      const toggle = e.target.closest('.group-toggle');
      if (toggle) {
        const group = toggle.closest('.video-group');
        setGroupCollapsed(group, !group.classList.contains('collapsed'));
        keepHeaderInView(group);
        saveLibraryView().catch(err => console.error('FoldTube: could not save the view', err));
        return;
      }
      const card = e.target.closest('.video-card');
      // Already opening or removing (a double-click): don't do it twice.
      if (!card || card.classList.contains('card-exit')) return;
      const video = state.videos.find(v => v.videoId === card.dataset.id);
      if (!video) return;
      if (e.target.classList.contains('channel') || e.target.classList.contains('card-checkbox')) return;
      if (e.target.classList.contains('delete-btn')) {
        deleteSingleVideo(video, card);
      } else if (state.selected.size > 0) {
        setCardSelected(card, !state.selected.has(video.videoId));
      } else {
        openSingleVideo(video, card);
      }
    });
  }
}

async function deleteSingleVideo(video, card) {
  card.classList.add('card-exit');
  // Remove after the exit animation; undo waits for the removal to finish.
  const removal = new Promise(resolve => setTimeout(resolve, 300))
    .then(() => archiveVideos([video.videoId], 'deleted'));
  const title = typeof video.title === 'string' ? video.title.trim() : '';
  const toastMsg = title
    ? `"${title.length > 40 ? title.slice(0, 40) + '…' : title}" removed`
    : 'Video removed';
  showUndoToast(toastMsg, async () => unarchiveVideos(await removal));
}

function openSingleVideo(video, card) {
  if (!isYouTubeUrl(video.url)) return; // not a YouTube link: keep it saved, open nothing
  chrome.tabs.create({ url: openUrlFor(video) });
  card.classList.add('card-exit');
  setTimeout(() => archiveVideos([video.videoId], 'watched'), 300);
}

// ---- Bulk actions ----
function bindBulkActions() {
  const { selected } = state;
  document.getElementById('btn-select-all').addEventListener('click', () => {
    selectableVideos().forEach(v => selected.add(v.videoId));
    updateSelectionBar();
    document.querySelectorAll('.video-card').forEach(card => {
      const on = selected.has(card.dataset.id);
      card.classList.toggle('selected', on);
      card.querySelector('.card-checkbox').checked = on;
    });
  });

  document.getElementById('btn-deselect-all').addEventListener('click', () => {
    selected.clear();
    updateSelectionBar();
    document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = false);
    document.querySelectorAll('.video-card').forEach(c => c.classList.remove('selected'));
  });

  document.getElementById('btn-open-selected').addEventListener('click', async () => {
    if (!selected.size) return;
    if (selected.size > 10 && !confirm(`This will open ${selected.size} tabs. Continue?`)) return;
    // Only entries with a YouTube link are opened and removed; others stay saved.
    const removed = state.videos.filter(v => selected.has(v.videoId) && isYouTubeUrl(v.url));
    const ids = new Set(removed.map(v => v.videoId));
    const count = removed.length;
    if (count === 0) return;
    removed.forEach(v => chrome.tabs.create({ url: openUrlFor(v), active: false }));
    selected.clear();
    updateSelectionBar();
    const result = await archiveVideos([...ids], 'watched');
    showUndoToast(`${count} video${count > 1 ? 's' : ''} opened & removed`, () => unarchiveVideos(result));
  });

  document.getElementById('btn-delete-selected').addEventListener('click', async () => {
    if (!selected.size) return;
    const ids = new Set(selected);
    const count = ids.size;
    if (count > 1 && !confirm(`Delete ${count} selected videos?`)) return;
    selected.clear();
    updateSelectionBar();
    const result = await archiveVideos([...ids], 'deleted');
    showUndoToast(`${count} video${count > 1 ? 's' : ''} removed`, () => unarchiveVideos(result));
  });
}

// ---- Empty state ----
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

// ---- History ----
function showHistory(open) {
  state.history.open = open;
  const button = document.getElementById('btn-history');
  button.setAttribute('aria-pressed', String(open));
  document.getElementById('history-view').classList.toggle('hidden', !open);
  // The library's own screen, with its search bar and selection.
  document.querySelector('.main-content:not(.history-view)').classList.toggle('hidden', open);
  if (open) {
    document.getElementById('controls-bar').classList.add('hidden');
    document.getElementById('selection-bar').classList.add('hidden');
    renderHistory();
    document.getElementById('history-search').focus();
  } else {
    renderLibrary();
    button.focus();
  }
  window.scrollTo(0, 0);
}

function bindHistory() {
  const history = state.history;
  document.getElementById('btn-history').addEventListener('click', () => showHistory(!history.open));
  document.getElementById('btn-history-back').addEventListener('click', () => showHistory(false));
  document.getElementById('history-search').addEventListener('input', debounce((e) => {
    history.query = e.target.value.trim().toLowerCase();
    renderHistory();
  }, 150));

  document.getElementById('history-filters').addEventListener('click', (e) => {
    const pill = e.target.closest('.history-pill');
    if (!pill) return;
    history.filter = pill.dataset.filter;
    renderHistory();
  });

  document.getElementById('btn-clear-history').addEventListener('click', clearHistory);
  document.getElementById('btn-settings-clear-history').addEventListener('click', clearHistory);

  // One listener for every row.
  document.getElementById('history-list').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    const row = button?.closest('.history-row');
    if (!row) return;
    button.disabled = true;
    // Restored videos stay listed, now marked as back in the library.
    const restoring = button.dataset.action === 'restore';
    if (!restoring || history.filter !== 'all') row.classList.add('row-exit');
    const op = restoring
      ? { type: 'unarchive', videoIds: [row.dataset.id], fromHistory: true }
      : { type: 'forget', videoIds: [row.dataset.id] };
    setTimeout(() => {
      changeVideos(op).catch(err => {
        console.error('FoldTube: history change failed', err);
        row.classList.remove('row-exit');
        button.disabled = false;
      });
    }, restoring ? 0 : 200);
  });
}

// From the History screen and from Settings → Advanced.
async function clearHistory() {
  const items = historyItems(state.records);
  if (!items.length) return;
  const gone = items.filter(v => !isActive(v)).length;
  const back = items.length - gone;
  const message = gone
    ? `Clear History? ${gone} video${gone === 1 ? '' : 's'} you opened or removed will be deleted forever.`
      + `${back ? ' Videos back in your library stay there.' : ''} This can't be undone.`
    : 'Clear History? Videos back in your library stay there.';
  if (!confirm(message)) return;
  await changeVideos({ type: 'clearHistory' });
}

// ---- Import result ----
function showImportResult(result, backup) {
  renderImportResult(result, backup);
  const byId = new Map(backup.map(v => [v.videoId, v]));
  state.pendingSkipped = (result.skipped ?? []).map(id => byId.get(id)).filter(Boolean);
  document.getElementById('import-modal').showModal();
  document.getElementById('btn-import-done').focus();
}

function bindImportResult() {
  const modal = document.getElementById('import-modal');
  const close = () => { state.pendingSkipped = []; modal.close(); };
  document.getElementById('btn-import-done').addEventListener('click', close);
  document.getElementById('btn-import-add').addEventListener('click', async () => {
    const videos = state.pendingSkipped;
    close();
    if (!videos.length) return;
    // The same as saving them again: back in the library, still listed in
    // History as back in library.
    const { added } = await changeVideos({ type: 'add', videos });
    showMessageToast(`Restored ${added} video${added === 1 ? '' : 's'} to your library.`);
  });
}

// ---- Downloads ----
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  // Firefox may start the download after click() returns: free it later.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function today() {
  return new Date().toISOString().split('T')[0];
}
