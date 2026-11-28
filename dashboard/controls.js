// Everything the user clicks or types: the header, search and filters, the
// cards, Settings and Help, History, import and export, toasts and keyboard
// shortcuts.

import { validateImport, buildHtmlExport, buildJsonExport, isYouTubeUrl, openUrlFor } from '../lib/youtube.js';
import { isActive } from '../lib/archive.js';
import { bindRail } from './rail.js';
import { historyItems } from '../lib/history.js';
import { describeShortcuts } from '../lib/shortcuts.js';
import { state } from './state.js';
import { SORT_FIELDS, parseSort } from './filters.js';
import { changeVideos, archiveVideos, unarchiveVideos, saveSettings, clearApiError, saveLibraryView } from './store.js';
import {
  selectableVideos, groupVideos, setGroupCollapsed, updateCollapseAll, renderLibrary, renderHistory, renderSettingsHistory, renderBackupButtons,
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
  bindRail();
  bindCollapseAll();
}

// ---- Sort and Group menus ----
// A button and a menu: arrows move between choices, Enter or a click picks
// one, Esc or a click elsewhere closes it.
function bindMenu(name, onPick) {
  const picker = document.getElementById(`${name}-picker`);
  const button = document.getElementById(`${name}-button`);
  const menu = document.getElementById(`${name}-menu`);
  const items = [...menu.querySelectorAll('[role="menuitemradio"]')];

  const open = () => {
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    (items.find(i => i.getAttribute('aria-checked') === 'true') || items[0]).focus();
  };
  const close = ({ focusButton = true } = {}) => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };

  button.addEventListener('click', () => (menu.classList.contains('hidden') ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (!item) return;
    close();
    if (item.getAttribute('aria-checked') !== 'true') onPick(item.dataset.value);
  });

  menu.addEventListener('keydown', (e) => {
    const index = items.indexOf(document.activeElement);
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move) {
      e.preventDefault();
      items[(index + move + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close({ focusButton: false });
    }
  });

  // A click elsewhere only closes the menu, as a native dropdown does: it
  // doesn't also open the video under it. A click on the other menu's
  // button still opens that menu.
  let swallowClick = false;
  document.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    if (menu.classList.contains('hidden') || picker.contains(e.target)) return;
    close({ focusButton: false });
    swallowClick = !e.target.closest('.menu-picker');
  });
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  // A press that never became a click (a drag) mustn't swallow a later one.
  document.addEventListener('keydown', () => { swallowClick = false; }, true);
}

function bindViewMenus() {
  const view = state.library;
  const changed = () => { showLibraryView(); renderLibrary(); };

  bindMenu('group', (groupBy) => {
    view.groupBy = groupBy;
    changed();
    saveLibraryView().catch(err => console.error('FoldTube: could not save the view', err));
  });

  // A new field starts in its natural direction (newest, shortest, A to Z);
  // the arrow beside it reverses that.
  bindMenu('sort', (field) => {
    view.sort = `${field}-${SORT_FIELDS[field].start}`;
    changed();
  });
  document.getElementById('sort-direction').addEventListener('click', () => {
    const { field, direction } = parseSort(view.sort);
    view.sort = `${field}-${direction === 'asc' ? 'desc' : 'asc'}`;
    changed();
  });
}

// Collapsing a group whose header is stuck at the top shrinks the group to
// above the screen: scroll back so its header stays where it was.
function keepHeaderInView(group) {
  const header = group.querySelector('.group-header');
  const stuckAt = parseFloat(getComputedStyle(header).top) || 0;
  const top = header.getBoundingClientRect().top;
  if (top < stuckAt) window.scrollBy(0, top - stuckAt);
}

// Collapse all / Expand all. The channel you're in stays at the top.
function bindCollapseAll() {
  document.getElementById('btn-collapse-all').addEventListener('click', () => {
    const groups = [...document.querySelectorAll('#video-grid > .video-group')];
    const collapse = groups.some(g => !g.classList.contains('collapsed'));
    const stuckAt = groups.length ? parseFloat(getComputedStyle(groups[0].querySelector('.group-header')).top) || 0 : 0;
    // The group you're in: the one passing under the stuck header line.
    const current = groups.find(g => g.getBoundingClientRect().bottom > stuckAt);
    // Its header is stuck, or right at the line (just jumped to).
    const scrolledInto = current && current.getBoundingClientRect().top - 8 <= stuckAt + 1;
    for (const group of groups) setGroupCollapsed(group, collapse, { updateButton: false });
    updateCollapseAll();
    if (scrolledInto) {
      // Its header sits 8px above the group: put that at the line.
      window.scrollBy(0, current.getBoundingClientRect().top - 8 - stuckAt);
    }
    saveLibraryView().catch(err => console.error('FoldTube: could not save the view', err));
  });
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

/** Show the Group by and Sort choices on their buttons and in their menus. */
export function showLibraryView() {
  showPicked('group', state.library.groupBy);
  const { field, direction } = parseSort(state.library.sort);
  showPicked('sort', field);
  const flip = document.getElementById('sort-direction');
  const label = SORT_FIELDS[field].label[direction];
  flip.classList.toggle('ascending', direction === 'asc');
  flip.setAttribute('aria-label', `Order: ${label}. Click to reverse`);
  flip.title = label;
}

// Check the current choice in a menu and show its label on the button.
function showPicked(name, value) {
  for (const item of document.querySelectorAll(`#${name}-menu [role="menuitemradio"]`)) {
    item.setAttribute('aria-checked', String(item.dataset.value === value));
  }
  for (const label of document.getElementById(`${name}-button-labels`).children) {
    label.classList.toggle('current', label.dataset.value === value);
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
    // Fire and forget: the lookups report through the library and the banner.
    chrome.runtime.sendMessage({ action: 'runEnrichment' }).catch(() => {});
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
        askToConfirm({ title: "Couldn't read that file", detail: "Please check it's a FoldTube backup (a .json file).", ok: 'OK', cancel: false });
        e.target.value = '';
        return;
      }
      try {
        const result = await changeVideos({ type: 'import', videos: validItems });
        settingsModal.close();
        showImportResult(result, validItems);
      } catch (err) {
        console.error('FoldTube: import failed', err);
        askToConfirm({ title: "Couldn't import the backup", detail: 'Nothing was changed. Please try again.', ok: 'OK', cancel: false });
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // An open dialog closes itself on Esc, the top one only. Closing them
      // here too would also close Settings, or leave History, under a
      // dialog opened on top (Clear History, import errors).
      if (document.querySelector('dialog[open]')) return;
      // From History, Esc goes back unless it is clearing a search.
      const active = document.activeElement;
      const typing = active.tagName === 'INPUT' && !(active.id === 'history-search' && !active.value);
      if (state.history.open && !typing) { showHistory(false); return; }
    }
    if (state.history.open || document.querySelector('dialog[open]')) return;
    if (e.key === 'Delete' && state.selected.size > 0 && document.activeElement.tagName !== 'INPUT') {
      document.getElementById('btn-delete-selected').click();
    }
  });
}

// ---- Toasts ----
let undoAction = null;
let toastTimer = null;

function bindToasts() {
  // Undo runs once, however many clicks; if it fails, the toast says so.
  const undoButton = document.getElementById('btn-undo');
  undoButton.addEventListener('click', async () => {
    const undo = undoAction;
    if (!undo) return;
    undoAction = null;
    clearTimeout(toastTimer);
    undoButton.disabled = true;
    try {
      await undo();
      document.getElementById('undo-toast').classList.remove('visible');
    } catch (err) {
      console.error('FoldTube: undo failed', err);
      showMessageToast("Couldn't undo. You can restore it from History.");
    } finally {
      undoButton.disabled = false;
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
  // The Undo button stays hidden while the toast fades; showUndoToast shows
  // it again when there's something to undo.
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

// ---- Search, sort and length filter ----
function bindLibraryControls() {
  const view = state.library;
  document.getElementById('search-input').addEventListener('input', debounce((e) => {
    view.query = e.target.value.toLowerCase();
    renderLibrary();
  }, 150));

  bindViewMenus();

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

    // A focused card: Enter or Space does what a click does (open it, or tick
    // it while some are selected). Keys on its own controls stay theirs.
    grid.addEventListener('keydown', (e) => {
      if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList.contains('video-card')) return;
      e.preventDefault();
      e.target.click();
    });

    grid.addEventListener('click', (e) => {
      const action = e.target.closest('.group-action');
      if (action) {
        const videos = groupVideos(action.closest('.video-group').dataset.group);
        if (action.dataset.action === 'open') openVideos(videos);
        else confirmClear(action, videos);
        return;
      }
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
      if (e.target.closest('a.channel') || e.target.classList.contains('card-checkbox')) return;
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

// The card fades out first; if the change then fails, it comes back.
function changeFailed(card, message) {
  return (err) => {
    console.error('FoldTube: could not update the library', err);
    card.classList.remove('card-exit');
    showMessageToast(message);
    throw err;
  };
}

async function deleteSingleVideo(video, card) {
  card.classList.add('card-exit');
  // Remove after the exit animation; undo waits for the removal to finish.
  const removal = new Promise(resolve => setTimeout(resolve, 300))
    .then(() => archiveVideos([video.videoId], 'deleted'))
    .catch(changeFailed(card, "Couldn't remove the video. Please try again."));
  removal.catch(() => {}); // reported above; Undo sees the failure too
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
  setTimeout(() => {
    archiveVideos([video.videoId], 'watched')
      .catch(changeFailed(card, "Opened, but couldn't move it to History."))
      .catch(() => {});
  }, 300);
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

  document.getElementById('btn-open-selected').addEventListener('click', () => {
    openVideos(state.videos.filter(v => selected.has(v.videoId)));
  });

  document.getElementById('btn-delete-selected').addEventListener('click', () => {
    removeVideos(state.videos.filter(v => selected.has(v.videoId)));
  });
}

// Opening this many tabs at once asks first: lots of new tabs can bog the
// browser down.
const OPEN_ASK_OVER = 5;

// Open videos in new tabs and move them to History as watched, with Undo.
// Used by Open Selected and a group's Open all.
async function openVideos(videos) {
  // Only entries with a YouTube link are opened and removed; others stay saved.
  const opened = videos.filter(v => isYouTubeUrl(v.url));
  const count = opened.length;
  if (count === 0) return;
  if (count > OPEN_ASK_OVER && !await askToConfirm({
    title: `Open ${count} videos in new tabs?`,
    detail: 'Opening many tabs at once can slow your browser down. They move to History as watched, and you can Undo.',
    ok: `Open ${count} tabs`,
  })) return;
  opened.forEach(v => chrome.tabs.create({ url: openUrlFor(v), active: false }));
  const ids = opened.map(v => v.videoId);
  let result;
  try {
    result = await archiveVideos(ids, 'watched');
  } catch (err) {
    console.error('FoldTube: could not move opened videos to History', err);
    showMessageToast(`Opened, but couldn't move ${count === 1 ? 'it' : 'them'} to History.`);
    return;
  }
  deselect(ids);
  showUndoToast(`${count} video${count > 1 ? 's' : ''} opened & removed`, () => unarchiveVideos(result));
}

// Remove videos (to History as deleted), with Undo. Used by Delete Selected,
// which asks first, and Clear group, which asks on the button itself.
async function removeVideos(videos, { ask = true } = {}) {
  const count = videos.length;
  if (count === 0) return;
  if (ask && count > 1 && !await askToConfirm({
    title: `Delete ${count} videos?`,
    detail: 'They move to History for 90 days, and you can Undo right away.',
    ok: `Delete ${count} videos`,
  })) return;
  const ids = videos.map(v => v.videoId);
  let result;
  try {
    result = await archiveVideos(ids, 'deleted');
  } catch (err) {
    console.error('FoldTube: could not remove videos', err);
    showMessageToast(`Couldn't remove ${count === 1 ? 'the video' : 'the videos'}. Please try again.`);
    return;
  }
  deselect(ids);
  showUndoToast(`${count} video${count > 1 ? 's' : ''} removed`, () => unarchiveVideos(result));
}

/**
 * Ask a yes/no question in a dialog. Resolves true for the OK button.
 * With `cancel: false` it's a notice: one button, which has focus.
 */
function askToConfirm({ title, detail, ok, cancel = true }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-detail').textContent = detail;
  const okButton = document.getElementById('btn-confirm-ok');
  okButton.textContent = ok;
  document.getElementById('btn-confirm-cancel').hidden = !cancel;
  return new Promise((resolve) => {
    const answer = (yes) => () => { modal.close(); resolve(yes); };
    const onOk = answer(true);
    const onCancel = answer(false);
    okButton.addEventListener('click', onOk);
    document.getElementById('btn-confirm-cancel').addEventListener('click', onCancel);
    // Esc closes it too: that's a no.
    modal.addEventListener('close', () => {
      okButton.removeEventListener('click', onOk);
      document.getElementById('btn-confirm-cancel').removeEventListener('click', onCancel);
      resolve(false);
    }, { once: true });
    // Cancel has focus first, so Enter alone doesn't go ahead.
    modal.showModal();
    (cancel ? document.getElementById('btn-confirm-cancel') : okButton).focus();
  });
}

// Clear group asks on the button: the first click turns it into "Clear N?",
// a second click within a few seconds clears. Leaving it, or waiting, resets.
const CLEAR_CONFIRM_MS = 4000;
function confirmClear(button, videos) {
  if (videos.length <= 1 || button.classList.contains('confirming')) {
    removeVideos(videos, { ask: false });
    return;
  }
  const text = button.querySelector('span');
  const original = { text: text.textContent, label: button.getAttribute('aria-label') };
  // Same width while it asks, so Open all beside it doesn't move.
  button.style.minWidth = `${button.getBoundingClientRect().width}px`;
  button.classList.add('confirming');
  text.textContent = `Clear ${videos.length}?`;
  button.setAttribute('aria-label', `Click again to remove all ${videos.length}`);
  const reset = () => {
    clearTimeout(timer);
    button.classList.remove('confirming');
    button.style.minWidth = '';
    text.textContent = original.text;
    button.setAttribute('aria-label', original.label);
    button.closest('.group-header')?.removeEventListener('mouseleave', reset);
    button.removeEventListener('blur', reset);
  };
  const timer = setTimeout(reset, CLEAR_CONFIRM_MS);
  button.closest('.group-header').addEventListener('mouseleave', reset);
  button.addEventListener('blur', reset);
}

function deselect(ids) {
  ids.forEach(id => state.selected.delete(id));
  updateSelectionBar();
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
      showMessageToast("Couldn't fold your tabs. Try the FoldTube icon in the toolbar.");
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
    // Both of the row's buttons: Restore and Delete forever can't both run.
    const rowButtons = [...row.querySelectorAll('button[data-action]')];
    rowButtons.forEach(b => { b.disabled = true; });
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
        rowButtons.forEach(b => { b.disabled = false; });
        showMessageToast(restoring ? "Couldn't restore the video. Please try again." : "Couldn't delete the video. Please try again.");
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
  const detail = gone
    ? `${gone} video${gone === 1 ? '' : 's'} you opened or removed will be deleted forever.`
      + `${back ? ' Videos back in your library stay there.' : ''} This can't be undone.`
    : 'Videos back in your library stay there.';
  if (!await askToConfirm({ title: 'Clear History?', detail, ok: 'Clear History' })) return;
  try {
    await changeVideos({ type: 'clearHistory' });
  } catch (err) {
    console.error('FoldTube: could not clear History', err);
    // A dialog, not a toast: this may be asked from Settings, over the page.
    askToConfirm({ title: "Couldn't clear History", detail: 'Nothing was deleted. Please try again.', ok: 'OK', cancel: false });
  }
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
    try {
      const { added } = await changeVideos({ type: 'add', videos });
      showMessageToast(`Restored ${added} video${added === 1 ? '' : 's'} to your library.`);
    } catch (err) {
      console.error('FoldTube: could not restore skipped videos', err);
      showMessageToast("Couldn't add those videos. Please try again.");
    }
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
