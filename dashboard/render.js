// Drawing the dashboard from `state`: the library grid and its cards, the
// empty states, History, the import dialog and the Settings counts.
//
// Nothing here listens for clicks; controls.js does, so a re-render never
// leaves stale handlers behind.

import { thumbnailUrlFor, isYouTubeUrl, resumeSeconds, formatDuration, YOUTUBE_TAB_PATTERNS, countFoldableTabs } from '../lib/youtube.js';
import { isBackInLibrary, daysLeft } from '../lib/archive.js';
import { matchesSearch, historyItems, groupByDay, expiryLabel, HISTORY_FILTERS } from '../lib/history.js';
import { libraryView, splitByType, groupByChannel, groupId, videosInGroup, selectableIn } from './filters.js';
import { renderRail } from './rail.js';
import { state } from './state.js';

/** The library as the grid shows it right now. */
export function visibleVideos() {
  return libraryView(state.videos, state.library);
}

/** A group's videos and Shorts as the grid shows them (searched and filtered), collapsed or not. */
export function groupVideos(id) {
  return videosInGroup(visibleVideos(), id);
}

/** The videos Select all picks: what's on screen, not in collapsed groups. */
export function selectableVideos() {
  return selectableIn(visibleVideos(), state.library.groupBy, state.library.collapsed);
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
  document.getElementById('shorts-section').classList.add('hidden');
  document.getElementById('controls-bar').classList.add('hidden');
  const empty = document.getElementById('empty-state');
  for (const copy of empty.querySelectorAll('.empty-copy, #empty-has-tabs')) copy.classList.add('hidden');
  document.getElementById('empty-load-failed').classList.remove('hidden');
  empty.classList.remove('hidden');
}

// ---- Selection bar ----
export function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const count = document.getElementById('selection-count');
  bar.classList.toggle('hidden', state.selected.size === 0);
  count.textContent = `${state.selected.size} selected`;
}

// ---- Library ----

// A redraw replaces every card. Keep keyboard focus where it was: on the same
// card, or when that one is gone (opened, removed), the next one.
function focusedCardIds() {
  const focused = document.activeElement?.closest?.('.video-card');
  if (!focused) return null;
  const cards = [...document.querySelectorAll('#videos-section .video-card, #shorts-section .video-card')];
  const at = cards.indexOf(focused);
  return cards.slice(at).concat(cards.slice(0, at).reverse()).map(c => c.dataset.id);
}

function restoreCardFocus(ids) {
  if (!ids) return;
  for (const id of ids) {
    const card = document.querySelector(`.video-card[data-id="${CSS.escape(id)}"]`);
    if (card && !card.closest('.collapsed')) {
      card.focus({ preventScroll: true });
      return;
    }
  }
}

export function renderLibrary() {
  const keepFocus = focusedCardIds();
  try {
    const videos = visibleVideos();
    const total = state.videos.length;
    updateSelectionBar();

    const videoGrid = document.getElementById('video-grid');
    const shortsGrid = document.getElementById('shorts-grid');
    const videosSection = document.getElementById('videos-section');
    const shortsSection = document.getElementById('shorts-section');
    const videosTitle = videosSection.querySelector('.section-title');
    const emptyState = document.getElementById('empty-state');
    const noResults = document.getElementById('no-results');
    const videoCount = document.querySelector('.video-count');

    if (videos.length === 0) {
      videoGrid.replaceChildren();
      shortsGrid.replaceChildren();
      videosSection.classList.add('hidden');
      shortsSection.classList.add('hidden');
      renderRail([]);

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

    // Grouped: one group per channel, its Shorts with it. Otherwise videos
    // and Shorts each get a section.
    const byChannel = state.library.groupBy !== 'none';
    videoGrid.classList.toggle('by-channel', byChannel);
    if (byChannel) {
      const groups = groupByChannel(videos, state.library.groupBy);
      videosSection.classList.remove('hidden');
      shortsSection.classList.add('hidden');
      // One section holds both now: say what's in it.
      const { standard, shorts } = splitByType(videos);
      videosTitle.textContent = !standard.length ? 'Shorts' : shorts.length ? 'Videos and Shorts' : 'Videos';
      videoGrid.replaceChildren(...channelGroups(groups));
      shortsGrid.replaceChildren();
      updateCollapseAll();
      renderRail(groups);
      restoreCardFocus(keepFocus);
      return;
    }
    const { standard, shorts } = splitByType(videos);
    videosTitle.textContent = 'Videos';
    videosSection.classList.toggle('hidden', standard.length === 0);
    shortsSection.classList.toggle('hidden', shorts.length === 0);
    videoGrid.replaceChildren(...standard.map((video, i) => createCard(video, i)));
    shortsGrid.replaceChildren(...shorts.map((video, i) => createCard(video, i)));
    updateCollapseAll();
    renderRail([]);
    restoreCardFocus(keepFocus);
  } catch (err) {
    console.error('Render error:', err);
    // Still on the loading placeholders: say so rather than load forever.
    if (document.querySelector('#video-grid .skeleton-card')) showLoadFailed();
  }
}

// Group by channel: a group per channel, each a header, its videos, then a
// row of its Shorts.
function channelGroups(groups) {
  let index = 0;
  return groups.map(({ key, videos: list }) => {
    const id = groupId(key);
    const collapsed = state.library.collapsed.has(id);
    const group = document.createElement('div');
    group.className = collapsed ? 'video-group collapsed' : 'video-group';
    group.dataset.group = id;

    const header = document.createElement('h3');
    header.className = 'group-header';
    const toggle = document.createElement('button');
    toggle.className = 'group-toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const name = document.createElement('span');
    name.className = key ? 'group-name' : 'group-name unknown';
    name.textContent = key || 'Unknown channel';
    name.title = name.textContent;
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = `· ${list.length}`;
    toggle.append(name, count);

    // Shown on hover or focus: act on the whole group at once. A single
    // video opens from its card, so it gets no Open all.
    const actions = document.createElement('span');
    actions.className = 'group-actions';
    const label = key || 'Unknown channel';
    if (list.length > 1) {
      actions.appendChild(groupAction('open', `Open all (${list.length})`, `Open all ${list.length} from ${label}`,
        ['M14 3h7v7', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5']));
    }
    actions.appendChild(groupAction('clear', 'Clear group', `Remove all ${list.length} from ${label}`,
      ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6']));

    header.append(toggle, actions);

    const { standard, shorts } = splitByType(list);
    group.append(header, ...standard.map(video => createCard(video, index++)));
    if (shorts.length) {
      const row = document.createElement('div');
      row.className = 'group-shorts shorts-grid';
      const label = document.createElement('div');
      label.className = 'group-shorts-label';
      label.textContent = `Shorts · ${shorts.length}`;
      row.append(label, ...shorts.map(video => createCard(video, index++)));
      group.appendChild(row);
    }
    return group;
  });
}

// A header button: a small icon and a label.
function groupAction(action, text, ariaLabel, paths) {
  const button = document.createElement('button');
  button.className = `group-action ${action}`;
  button.dataset.action = action;
  button.setAttribute('aria-label', ariaLabel);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  const span = document.createElement('span');
  span.textContent = text;
  button.append(svg, span);
  return button;
}

/** Collapse or expand a group in place, without redrawing its cards. */
export function setGroupCollapsed(group, collapsed, { updateButton = true } = {}) {
  group.classList.toggle('collapsed', collapsed);
  group.querySelector('.group-toggle').setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) state.library.collapsed.add(group.dataset.group);
  else state.library.collapsed.delete(group.dataset.group);
  if (updateButton) updateCollapseAll();
}

/** Collapse all, or Expand all once every group is collapsed; only with 2+ groups. */
export function updateCollapseAll() {
  const button = document.getElementById('btn-collapse-all');
  const groups = document.querySelectorAll('#video-grid > .video-group');
  button.classList.toggle('hidden', groups.length < 2);
  const allCollapsed = [...groups].every(g => g.classList.contains('collapsed'));
  button.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
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
  // Reachable with Tab; Enter or Space acts as a click (see controls.js).
  card.tabIndex = 0;
  card.setAttribute('role', 'article');
  card.setAttribute('aria-label', video.title || 'Untitled video');
  card.setAttribute('aria-description', 'Press Enter to open');
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

  // A link only with a channel page to go to. Without one (saved from a
  // link, or a closed window), plain text: a "#" link opened a second
  // dashboard.
  const hasChannelPage = isYouTubeUrl(video.channelUrl);
  const channel = document.createElement(hasChannelPage ? 'a' : 'span');
  channel.className = 'channel';
  if (hasChannelPage) {
    channel.href = video.channelUrl;
    channel.target = '_blank';
    channel.rel = 'noopener noreferrer';
  }
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
  document.getElementById('empty-load-failed').classList.add('hidden');
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
