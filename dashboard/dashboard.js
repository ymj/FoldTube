import { validateImport, buildHtmlExport, isYouTubeUrl, thumbnailUrlFor } from '../lib/youtube.js';

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
      if (changes.savedVideos) {
        allVideos = changes.savedVideos.newValue || [];
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

// ---- Controls ----
function bindControls() {
  // Settings Modal
  const settingsModal = document.getElementById('settings-modal');
  document.getElementById('btn-settings').addEventListener('click', () => settingsModal.showModal());
  document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.close());

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsModal.open) { settingsModal.close(); return; }
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
    const blob = new Blob([JSON.stringify(allVideos, null, 2)], { type: "application/json" });
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
        const { added } = await changeVideos({ type: 'add', videos: validItems });
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
    removed.forEach(v => chrome.tabs.create({ url: v.url, active: false }));
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
async function loadVideos() {
  try {
    const { savedVideos = [] } = await chrome.storage.local.get("savedVideos");
    allVideos = savedVideos;
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
    const videoCount = document.querySelector('.video-count');

    if (videos.length === 0) {
      videoGrid.innerHTML = '';
      shortsGrid.innerHTML = '';
      videosSection.classList.add('hidden');
      shortsSection.classList.add('hidden');
      emptyState.classList.remove('hidden');

      if (allVideos.length > 0) {
        emptyState.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <h2>No results</h2>
          <p>Try adjusting your search or filters</p>`;
        videoCount.textContent = `Showing 0 of ${allVideos.length} items`;
      } else {
        emptyState.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/></svg>
          <h2>Your library is empty</h2>
          <p>Press the FoldTube icon (or Ctrl+Shift+Y) to fold your open YouTube tabs</p>`;
        videoCount.textContent = '0 items';
      }
      return;
    }

    emptyState.classList.add('hidden');
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
  chrome.tabs.create({ url: video.url });
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
