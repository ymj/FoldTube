// Drawing the dashboard from `state`: the library grid and its cards, the
// empty states, History, the import dialog and the Settings counts.
//
// Nothing here listens for clicks; controls.js does, so a re-render never
// leaves stale handlers behind.

import { thumbnailUrlFor, isYouTubeUrl, resumeSeconds, formatDuration, YOUTUBE_TAB_PATTERNS, countFoldableTabs } from '../lib/youtube.js';
import { isBackInLibrary, daysLeft } from '../lib/archive.js';
import { matchesSearch, historyItems, groupByDay, expiryLabel, HISTORY_FILTERS } from '../lib/history.js';
import { libraryView, splitByType } from './filters.js';
import { state } from './state.js';

/** The library as the grid shows it right now. */
export function visibleVideos() {
  return libraryView(state.videos, state.library);
}

// ---- Skeleton loader ----
export function showSkeletons(count = 8) {
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

// Storage could not be read: show the empty state rather than nothing.
export function showLoadFailed() {
  document.getElementById('videos-section').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
}

// ---- Selection bar ----
export function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const count = document.getElementById('selection-count');
  bar.classList.toggle('hidden', state.selected.size === 0);
  count.textContent = `${state.selected.size} selected`;
}

// ---- Library ----
export function renderLibrary() {
  try {
    const videos = visibleVideos();
    const total = state.videos.length;
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
      const libraryEmpty = total === 0;
      emptyState.classList.toggle('hidden', !libraryEmpty);
      // Nothing to search, sort or filter in an empty library.
      document.getElementById('controls-bar').classList.toggle('hidden', libraryEmpty);
      videoCount.classList.toggle('hidden', libraryEmpty);
      noResults.classList.toggle('hidden', libraryEmpty);
      if (libraryEmpty) {
        videoCount.textContent = '0 items';
        refreshEmptyState();
      } else {
        videoCount.textContent = `Showing 0 of ${total} items`;
      }
      return;
    }
    emptyState.classList.add('hidden');
    noResults.classList.add('hidden');
    document.getElementById('controls-bar').classList.remove('hidden');
    videoCount.classList.remove('hidden');
    videoCount.textContent = total !== videos.length
      ? `Showing ${videos.length} of ${total} items`
      : `${videos.length} item${videos.length === 1 ? '' : 's'}`;

    const { standard, shorts } = splitByType(videos);
    videosSection.classList.toggle('hidden', standard.length === 0);
    shortsSection.classList.toggle('hidden', shorts.length === 0);
    videoGrid.replaceChildren(...standard.map(createCard));
    shortsGrid.replaceChildren(...shorts.map(createCard));
  } catch (err) {
    console.error('Render error:', err);
  }
}

/** Tick or untick a card, keeping the selection and the bar in step. */
export function setCardSelected(card, selected) {
  const id = card.dataset.id;
  card.querySelector('.card-checkbox').checked = selected;
  card.classList.toggle('selected', selected);
  if (selected) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionBar();
}

function createCard(video, index) {
  const selected = state.selected.has(video.videoId);
  const card = document.createElement('div');
  card.className = 'video-card';
  if (selected) card.classList.add('selected');
  card.dataset.id = video.videoId;
  card.style.animationDelay = `${Math.min(index * 0.04, 0.4)}s`;

  const date = new Date(video.dateSaved).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  // Checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'card-checkbox';
  checkbox.value = video.videoId;
  checkbox.checked = selected;
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
  deleteBtn.textContent = '×';
  cardContent.appendChild(deleteBtn);

  card.appendChild(cardContent);
  return card;
}

// ---- Empty state ----

// Two empty views: first run (nothing ever saved) and "all caught up"
// (everything saved has been watched or removed). When YouTube tabs are
// open, the main button folds them; otherwise it opens YouTube. The count
// follows tabs opened or closed elsewhere while the library is empty.
export async function refreshEmptyState() {
  if (state.videos.length) return;
  document.getElementById('empty-first-run').classList.toggle('hidden', state.hasSavedBefore);
  document.getElementById('empty-caught-up').classList.toggle('hidden', !state.hasSavedBefore);

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

// ---- Settings → Advanced ----

// Backups hold the library only: nothing to export while it's empty.
// Import stays available, since that is how an empty library gets filled.
export function renderBackupButtons() {
  const empty = state.videos.length === 0;
  for (const id of ['btn-export', 'btn-export-html']) {
    const button = document.getElementById(id);
    button.disabled = empty;
    button.title = empty ? 'Nothing to export yet' : '';
  }
}

// The History line.
export function renderSettingsHistory() {
  const count = historyItems(state.records).length;
  document.getElementById('settings-history-count').textContent = count
    ? `${count} video${count === 1 ? '' : 's'} in History`
    : 'No videos in History';
  document.getElementById('btn-settings-clear-history').disabled = count === 0;
}

// ---- History ----
export function renderHistory() {
  const { query, filter } = state.history;
  const all = historyItems(state.records);
  const searched = query ? all.filter(v => matchesSearch(v, query)) : all;
  const items = searched.filter(HISTORY_FILTERS[filter]);
  const list = document.getElementById('history-list');

  document.querySelectorAll('.history-pill').forEach(pill => {
    const pillFilter = pill.dataset.filter;
    pill.setAttribute('aria-pressed', String(pillFilter === filter));
    const count = searched.filter(HISTORY_FILTERS[pillFilter]).length;
    pill.querySelector('.pill-count').textContent = ` ${count}`;
  });
  document.getElementById('history-filters').classList.toggle('hidden', all.length === 0);

  document.querySelector('.video-count').classList.remove('hidden');
  document.querySelector('.video-count').textContent = `${all.length} in History`;
  document.getElementById('btn-clear-history').disabled = all.length === 0;
  document.getElementById('btn-clear-history').classList.toggle('hidden', all.length === 0);
  document.querySelector('.history-controls').classList.toggle('hidden', all.length === 0);
  document.querySelector('.history-note').classList.toggle('hidden', all.length === 0);
  document.getElementById('history-empty').classList.toggle('hidden', all.length > 0);
  document.getElementById('history-no-results').classList.toggle('hidden', !(all.length > 0 && items.length === 0));

  const now = new Date();
  const fragment = document.createDocumentFragment();
  for (const group of groupByDay(items, now)) {
    const heading = document.createElement('h3');
    heading.className = 'history-day';
    heading.textContent = group.label;
    fragment.appendChild(heading);
    for (const video of group.items) fragment.appendChild(createHistoryRow(video, now));
  }
  list.replaceChildren(fragment);
}

function createHistoryRow(video, now) {
  const back = isBackInLibrary(video);
  const row = document.createElement('div');
  row.className = back ? 'history-row back-in-library' : 'history-row';
  row.dataset.id = video.videoId;

  const img = document.createElement('img');
  img.className = video.videoType === 'short' ? 'history-thumb short' : 'history-thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = thumbnailUrlFor(video.videoId, 'mqdefault');
  img.onerror = function() { this.onerror = null; this.src = thumbnailUrlFor(video.videoId, 'hqdefault'); };

  const info = document.createElement('div');
  info.className = 'history-info';
  const title = document.createElement('p');
  title.className = 'title';
  title.title = video.title || '';
  title.textContent = video.title || '';
  const channel = document.createElement('span');
  channel.className = 'channel';
  channel.textContent = video.channelName || '';

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  // What happened (watched or deleted), then where the video is now.
  const how = back ? video.archivedAs : video.state;
  const badge = document.createElement('span');
  badge.className = `history-badge ${how}`;
  badge.textContent = how === 'watched' ? 'Watched' : 'Deleted';
  meta.appendChild(badge);
  if (back) {
    const where = document.createElement('span');
    where.className = 'history-badge library';
    where.textContent = 'Back in library';
    meta.appendChild(where);
  } else {
    const expiry = document.createElement('span');
    expiry.textContent = expiryLabel(daysLeft(video, now));
    meta.appendChild(expiry);
  }
  info.append(title, channel, meta);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  if (back) {
    row.append(img, info, actions);
    return row;
  }
  const restore = document.createElement('button');
  restore.className = 'history-restore';
  restore.dataset.action = 'restore';
  restore.textContent = 'Restore';
  restore.title = 'Put back in your library';
  const forget = document.createElement('button');
  forget.className = 'history-forget';
  forget.dataset.action = 'forget';
  forget.textContent = 'Delete forever';
  actions.append(restore, forget);

  row.append(img, info, actions);
  return row;
}

// ---- Import result ----

// Says what an import did: how many videos were added, how many were
// already in the library, and which were skipped because they are in
// History (opened or removed here after the backup was made). Those can be
// restored.
export function renderImportResult({ added, inLibrary = 0, skipped = [] }, backup) {
  const byId = new Map(backup.map(v => [v.videoId, v]));
  const videos = (n) => `${n} video${n === 1 ? '' : 's'}`;
  const title = document.getElementById('import-title');
  const detail = document.getElementById('import-detail');

  if (skipped.length) {
    title.textContent = added ? `${videos(added)} imported` : 'No new videos added';
    const parts = [];
    if (inLibrary) parts.push(document.createTextNode(`${inLibrary} already in library`));
    const inHistory = document.createElement('span');
    inHistory.className = 'count';
    const n = document.createElement('strong');
    n.textContent = skipped.length;
    inHistory.append(n, ' in history');
    parts.push(inHistory);
    detail.replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
    detail.classList.remove('lead');
  } else if (added && !inLibrary) {
    title.textContent = `${videos(added)} imported`;
    detail.textContent = added === 1
      ? 'The video from this backup was added to your library.'
      : `All ${added} videos from this backup were added to your library.`;
    detail.classList.add('lead');
  } else if (added) {
    title.textContent = `${videos(added)} imported`;
    detail.textContent = `${inLibrary} already in library`;
    detail.classList.remove('lead');
  } else {
    title.textContent = 'Library is already up to date';
    detail.textContent = inLibrary === 1
      ? 'The video in this backup is already in your library.'
      : `All ${inLibrary} videos in this backup are already in your library.`;
    detail.classList.add('lead');
  }

  document.getElementById('import-skipped-why').textContent = skipped.length === 1
    ? 'This one was watched or removed after the backup was made:'
    : `These ${skipped.length} were watched or removed after the backup was made:`;

  // Thumbnails rather than titles: easy to tell apart, any length, any
  // language. The title shows on hover or keyboard focus.
  const SHOWN = 5;
  const titleOf = (id) => byId.get(id)?.title || 'Untitled video';
  const thumbs = skipped.slice(0, SHOWN).map(id => {
    const wrap = document.createElement('span');
    wrap.className = 'import-thumb';
    wrap.tabIndex = 0;
    wrap.dataset.title = titleOf(id);
    const img = document.createElement('img');
    img.src = thumbnailUrlFor(id, 'mqdefault');
    img.alt = titleOf(id);
    wrap.appendChild(img);
    return wrap;
  });
  if (skipped.length > SHOWN) {
    const rest = skipped.slice(SHOWN);
    const more = document.createElement('span');
    more.className = 'import-thumb more';
    more.tabIndex = 0;
    more.textContent = `+${rest.length}`;
    // A list, not the plain one-line tip: one title per row, divided.
    const listed = rest.slice(0, 5).map(titleOf);
    if (rest.length > 5) listed.push(`and ${rest.length - 5} more`);
    const tip = document.createElement('ul');
    tip.className = 'import-more-list';
    tip.setAttribute('aria-hidden', 'true');
    tip.replaceChildren(...listed.map((text, i) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (rest.length > 5 && i === listed.length - 1) li.className = 'rest';
      return li;
    }));
    more.appendChild(tip);
    more.setAttribute('aria-label', `${rest.length} more: ${listed.join(', ')}`);
    thumbs.push(more);
  }
  document.getElementById('import-thumbs').replaceChildren(...thumbs);

  const asking = skipped.length > 0;
  document.getElementById('import-skipped').classList.toggle('hidden', !asking);
  const restore = document.getElementById('btn-import-add');
  restore.classList.toggle('hidden', !asking);
  restore.textContent = `Restore ${skipped.length}`;
}
