// The channel rail: while grouped by channel, slim ticks on the right edge
// show where you are in the library, and open a list to jump to a channel.
//
// render.js calls renderRail after drawing the groups; controls.js calls
// bindRail once. Rows are found by index: the list and the grid's groups are
// in the same order.

import { state } from './state.js';
import { railTick, channelInitial, RAIL_MAX_TICKS, RAIL_FILTER_OVER, RAIL_LETTERS_FROM } from './filters.js';

const OPEN_DELAY = 150; // passing the mouse by on the way to the scrollbar doesn't open it
const CLOSE_DELAY = 250;
// Shorter than this (all of it on screen), there's nowhere to jump.
const FITS_SLACK = 80;

const $ = (id) => document.getElementById(id);

let groups = [];
let items = [];
let activeIndex = -1;
let typing = false; // a filter is being typed: the list stays where it is
let refocusing = false; // focus back on the ticks after a jump: don't reopen

const groupElements = () => document.querySelectorAll('#video-grid > .video-group');

/** Redraw the rail for these groups (none when not grouped). */
export function renderRail(next) {
  groups = state.library.groupBy === 'none' ? [] : next;
  const ticks = $('rail-ticks');
  const list = $('rail-list');
  const filter = $('rail-filter');
  activeIndex = -1;
  typing = false;
  if (groups.length < 2) {
    items = [];
    ticks.replaceChildren();
    list.replaceChildren();
    updateRailVisibility();
    return;
  }

  $('rail-heading').textContent = `Jump to channel · ${groups.length}`;
  filter.hidden = groups.length <= RAIL_FILTER_OVER;
  filter.value = '';
  list.classList.toggle('long', groups.length >= RAIL_LETTERS_FROM);
  list.classList.remove('no-match');

  // A long list in a name order gets letters to keep your place.
  const letters = groups.length >= RAIL_LETTERS_FROM && ['channel-az', 'channel-za'].includes(state.library.groupBy);
  const rows = [];
  let letter = null;
  items = groups.map(({ key, videos }, index) => {
    if (letters && key && channelInitial(key) !== letter) {
      letter = channelInitial(key);
      const divider = document.createElement('div');
      divider.className = 'rail-letter';
      divider.textContent = letter;
      divider.setAttribute('aria-hidden', 'true');
      rows.push(divider);
    }
    const label = key || 'Unknown channel';
    const item = document.createElement('button');
    item.className = 'rail-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.dataset.index = index;
    item.dataset.name = label.toLowerCase();
    item.setAttribute('aria-label', `${label}, ${videos.length} video${videos.length === 1 ? '' : 's'}`);
    const name = document.createElement('span');
    name.className = key ? 'rail-item-name' : 'rail-item-name unknown';
    name.textContent = label;
    name.title = label;
    const count = document.createElement('span');
    count.className = 'rail-item-count';
    count.textContent = videos.length;
    item.append(name, count);
    rows.push(item);
    return item;
  });
  list.replaceChildren(...rows);

  const tickCount = Math.min(groups.length, RAIL_MAX_TICKS);
  ticks.replaceChildren(...Array.from({ length: tickCount }, () => {
    const tick = document.createElement('span');
    tick.className = 'tick';
    return tick;
  }));
  updateRailVisibility();
  followScroll(true);
}

// Hidden when there's nothing to jump between: one channel, a library that
// fits on screen, or History showing. The room it needs on the right stays
// while grouped, so the page doesn't shift as it comes and goes.
function updateRailVisibility() {
  const rail = $('channel-rail');
  const grouped = groups.length > 1 && !state.history.open;
  const fits = document.documentElement.scrollHeight <= innerHeight + FITS_SLACK;
  document.body.classList.toggle('has-rail', grouped);
  rail.classList.toggle('hidden', !grouped || fits);
  if (!grouped || fits) closeRail();
}

// ---- Open and close ----

const isOpen = () => $('channel-rail').classList.contains('open');
let timer = 0;

function openRail({ focus = false } = {}) {
  clearTimeout(timer);
  const rail = $('channel-rail');
  if (rail.classList.contains('hidden')) return;
  if (!isOpen()) {
    rail.classList.add('open');
    $('rail-ticks').setAttribute('aria-expanded', 'true');
    // Open on where you are, not at the top of the list.
    const list = $('rail-list');
    const item = items[activeIndex];
    if (item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
  }
  if (!focus) return;
  // After the list shows: a hidden element can't take focus.
  const filter = $('rail-filter');
  requestAnimationFrame(() => (filter.hidden ? items[activeIndex] : filter)?.focus());
}

function closeRail({ refocus = false } = {}) {
  clearTimeout(timer);
  if (!isOpen()) return;
  $('channel-rail').classList.remove('open');
  $('rail-ticks').setAttribute('aria-expanded', 'false');
  const filter = $('rail-filter');
  if (filter.value) {
    filter.value = '';
    applyFilter();
  }
  typing = false;
  if (refocus) {
    refocusing = true;
    $('rail-ticks').focus();
    refocusing = false;
  }
}

// ---- Filter ----

const shownItems = () => items.filter(item => !item.hidden);

function applyFilter() {
  const query = $('rail-filter').value.trim().toLowerCase();
  for (const item of items) item.hidden = query !== '' && !item.dataset.name.includes(query);
  // A letter with nothing left under it goes too.
  for (const divider of $('rail-list').querySelectorAll('.rail-letter')) {
    let next = divider.nextElementSibling;
    let any = false;
    while (next && !next.classList.contains('rail-letter')) {
      if (!next.hidden) any = true;
      next = next.nextElementSibling;
    }
    divider.hidden = !any;
  }
  $('rail-list').classList.toggle('no-match', query !== '' && shownItems().length === 0);
  if (query === '') typing = false;
}

// ---- Jump, and follow the scroll ----

const cssPx = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
// Where a stuck channel header sits: below the page header, selection bar and controls.
const stickyTop = () => cssPx('--header-height') + cssPx('--selection-bar-height') + cssPx('--controls-height') - 2;
// A group header sticks 8px above its group (its negative margin).
const HEADER_OVERHANG = 8;

let followPausedUntil = 0;

function jumpTo(index) {
  const group = groupElements()[index];
  if (!group) return;
  // Opens it, and remembers that, as clicking its header would.
  if (group.classList.contains('collapsed')) group.querySelector('.group-toggle').click();
  closeRail({ refocus: $('channel-rail').contains(document.activeElement) });
  setActive(index);
  // Don't let the smooth scroll light up every channel it passes.
  followPausedUntil = performance.now() + 1000;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = group.getBoundingClientRect().top + scrollY - HEADER_OVERHANG - stickyTop();
  scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

function setActive(index) {
  if (index === activeIndex || !items[index]) return;
  items[activeIndex]?.classList.remove('active');
  items[activeIndex]?.removeAttribute('aria-current');
  activeIndex = index;
  const item = items[index];
  item.classList.add('active');
  item.setAttribute('aria-current', 'true');

  const ticks = $('rail-ticks');
  ticks.setAttribute('aria-label', `Jump to channel. Now at ${groups[index].key || 'Unknown channel'}`);
  ticks.querySelector('.tick.active')?.classList.remove('active');
  ticks.children[railTick(index, groups.length)]?.classList.add('active');

  // While open, keep it in sight in the list, unless a filter is being typed.
  const list = $('rail-list');
  if (isOpen() && !typing) {
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
}

// The channel whose header is stuck at the top. At the very bottom, the last
// one: a short last group never reaches the top.
function followScroll(force = false) {
  if (items.length === 0 || (!force && performance.now() < followPausedUntil)) return;
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 24) {
    setActive(items.length - 1);
    return;
  }
  const line = stickyTop() + 10;
  let current = 0;
  for (const [index, group] of [...groupElements()].entries()) {
    if (group.getBoundingClientRect().top - HEADER_OVERHANG > line) break;
    current = index;
  }
  setActive(current);
}

// ---- Events ----

const isTyping = (target) => Boolean(target.closest?.('input, textarea, select, [contenteditable="true"]'));

export function bindRail() {
  const rail = $('channel-rail');
  const ticks = $('rail-ticks');
  const filter = $('rail-filter');
  const list = $('rail-list');

  // Hover opens it after a moment; leaving closes it, unless focus is inside.
  const canHover = matchMedia('(hover: hover)');
  rail.addEventListener('mouseenter', () => {
    if (!canHover.matches) return;
    clearTimeout(timer);
    timer = setTimeout(openRail, OPEN_DELAY);
  });
  rail.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    if (!rail.contains(document.activeElement)) timer = setTimeout(closeRail, CLOSE_DELAY);
  });
  ticks.addEventListener('click', () => openRail({ focus: true }));
  ticks.addEventListener('focus', () => { if (!refocusing) openRail(); });
  ticks.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openRail({ focus: true });
    }
  });
  rail.addEventListener('focusout', (e) => {
    if (!rail.contains(e.relatedTarget) && !rail.matches(':hover')) closeRail();
  });
  document.addEventListener('click', (e) => { if (isOpen() && !rail.contains(e.target)) closeRail(); });

  // Before the page's own keys: Esc closes the list first, G opens it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      closeRail({ refocus: rail.contains(document.activeElement) });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
    if (e.key === 'g' || e.key === 'G') {
      if (rail.classList.contains('hidden')) return;
      e.preventDefault();
      openRail({ focus: true });
    } else if (isOpen() && !filter.hidden && e.key.length === 1) {
      // Opened by hovering: the first letter typed goes to the filter, which
      // doesn't take focus on hover (it would steal typing from the search).
      filter.focus();
    }
  }, true);

  filter.addEventListener('input', () => {
    typing = true;
    applyFilter();
    list.scrollTop = 0;
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = shownItems()[0];
      if (first) jumpTo(Number(first.dataset.index));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      shownItems()[0]?.focus();
    }
  });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.rail-item');
    if (item) jumpTo(Number(item.dataset.index));
  });
  list.addEventListener('keydown', (e) => {
    const shown = shownItems();
    const at = shown.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: shown.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    if (to < 0 && !filter.hidden) filter.focus();
    else shown[Math.max(0, Math.min(shown.length - 1, to))]?.focus();
  });

  let frame = 0;
  addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => followScroll());
  }, { passive: true });
  addEventListener('scrollend', () => {
    followPausedUntil = 0;
    followScroll();
  });
  // Collapsing groups, History opening, the window resizing: the page may
  // now fit on screen, or no longer.
  new ResizeObserver(updateRailVisibility).observe(document.querySelector('main.main-content'));
  addEventListener('resize', updateRailVisibility);
}
