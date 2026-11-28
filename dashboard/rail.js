// The channel rail: while grouped by channel, slim ticks on the right edge
// show where you are in the library, peek nearby channels on hover, expand to
// the full list as you keep scrubbing, or click to jump straight to that area.
//
// render.js calls renderRail after drawing the groups; controls.js calls
// bindRail once. Rows are found by index: the list and the grid's groups are
// in the same order.

import { state } from './state.js';
import {
  railTick,
  railChannelAt,
  railWaveWeights,
  railPeekRange,
  isAimingAtPopover,
  channelInitial,
  RAIL_MAX_TICKS,
  RAIL_FILTER_OVER,
  RAIL_LETTERS_FROM,
  RAIL_PEEK_OVER,
} from './filters.js';

const OPEN_DELAY = 120; // passing the mouse by on the way to the scrollbar doesn't open it
const CLOSE_DELAY = 250;
const HANDOFF_FREEZE_MS = 220; // brief freeze while sliding diagonally from ladder into panel
const TRAIL_WINDOW_MS = 80;
const EXPAND_CHANNELS = 4; // scrubbing through 4 channels (up or down) unfolds peek into the full list
const EXPAND_FALLBACK_MS = 750;
// Shorter than this (all of it on screen), there's nowhere to jump.
const FITS_SLACK = 80;

const $ = (id) => document.getElementById(id);

let groups = [];
let items = [];
let activeIndex = -1;
let previewIndex = -1;
let hoverTarget = -1;
let typing = false; // a filter is being typed: the list stays where it is
let refocusing = false; // focus back on the ticks after a jump: don't reopen
let expandingGroup = false; // synthetic click on a collapsed group header shouldn't close the rail
let openPending = false;
let scrubFrozen = false;
let freezeTimer = 0;
let expandTimer = 0;
let expandFrame = 0;
let lastClientY = null;
let peekSteps = 0;
let pointerTrail = [];
let jumping = false; // a jump's smooth scroll is under way

const groupElements = () => document.querySelectorAll('#video-grid > .video-group');

/** Redraw the rail for these groups (none when not grouped). */
export function renderRail(next) {
  const ticks = $('rail-ticks');
  const list = $('rail-list');
  const filter = $('rail-filter');
  // The library can redraw while the list is open (a video saved in another
  // tab): keep what's typed in the filter, and the channel that had focus.
  const open = isOpen();
  const wasPeek = isPeek();
  const query = open ? filter.value : '';
  const focused = document.activeElement;
  const focusedKey = open && focused?.classList.contains('rail-item') ? groups[Number(focused.dataset.index)]?.key : undefined;
  const filterFocused = open && focused === filter;

  groups = state.library.groupBy === 'none' ? [] : next;
  activeIndex = -1;
  previewIndex = -1;
  hoverTarget = -1;
  typing = false;
  clearHandoff();
  finishExpandAnimation();
  if (groups.length < 2) {
    items = [];
    ticks.replaceChildren();
    list.replaceChildren();
    updateRailVisibility();
    return;
  }

  $('rail-heading').textContent = `Jump to channel · ${groups.length}`;
  $('rail-expand').textContent = `All ${groups.length} channels`;
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

  if (open && isOpen()) {
    if (wasPeek && groups.length > RAIL_PEEK_OVER) {
      applyPeekSlice(activeIndex >= 0 ? activeIndex : 0);
    } else if (wasPeek) {
      $('channel-rail').classList.remove('peek');
      clearPeekSlice();
    }
    filter.value = filter.hidden ? '' : query;
    applyFilter();
    typing = filter.value !== '';
    const again = focusedKey === undefined ? -1 : groups.findIndex(g => g.key === focusedKey);
    if (again >= 0 && !items[again].hidden) items[again].focus();
    else if (filterFocused && !filter.hidden) filter.focus();
  }
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

// ---- Ladder wave, peek slice & preview sync ----

function pointerRatioOnTicks(clientY) {
  const ticks = $('rail-ticks');
  const first = ticks.firstElementChild;
  const last = ticks.lastElementChild;
  if (!first || !last) return 0;
  const start = first.getBoundingClientRect().top + first.offsetHeight / 2;
  const end = last.getBoundingClientRect().top + last.offsetHeight / 2;
  if (end <= start) return 0;
  return Math.max(0, Math.min(1, (clientY - start) / (end - start)));
}

function applyWave(ratio) {
  const ticks = $('rail-ticks');
  const els = ticks.children;
  if (els.length === 0) return;
  ticks.classList.add('scrubbing');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    const nearest = Math.round(ratio * (els.length - 1));
    for (let i = 0; i < els.length; i++) {
      if (i === nearest) els[i].style.setProperty('--wave', '1');
      else els[i].style.removeProperty('--wave');
    }
    return;
  }
  const weights = railWaveWeights(els.length, ratio);
  for (let i = 0; i < els.length; i++) {
    if (weights[i] > 0.005) els[i].style.setProperty('--wave', weights[i].toFixed(3));
    else els[i].style.removeProperty('--wave');
  }
}

function clearWave() {
  const ticks = $('rail-ticks');
  ticks.classList.remove('scrubbing');
  for (const el of ticks.children) el.style.removeProperty('--wave');
}

function clearHandoff() {
  clearTimeout(freezeTimer);
  scrubFrozen = false;
  pointerTrail = [];
}

function applyPeekSlice(centerIndex) {
  const { start, end } = railPeekRange(centerIndex, items.length);
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('peek-hidden', i < start || i >= end);
  }
}

function clearPeekSlice() {
  for (const item of items) item.classList.remove('peek-hidden');
}

function setPreview(index) {
  if (index === previewIndex) return;
  items[previewIndex]?.classList.remove('preview');
  previewIndex = index >= 0 && items[index] ? index : -1;
  if (previewIndex >= 0) items[previewIndex].classList.add('preview');
}

function scrollListTo(index) {
  const list = $('rail-list');
  const item = items[index];
  if (!item) return;
  const target = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
  const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
  list.scrollTop = Math.max(0, Math.min(maxScroll, target));
}

function scrubAt(clientY) {
  if (groups.length === 0) return;
  const ratio = pointerRatioOnTicks(clientY);
  applyWave(ratio);
  const prevTarget = hoverTarget;
  hoverTarget = railChannelAt(ratio, groups.length);
  if (isOpen() && !typing) {
    if (isPeek() && prevTarget >= 0 && hoverTarget !== prevTarget) {
      peekSteps += Math.abs(hoverTarget - prevTarget);
      if (peekSteps >= EXPAND_CHANNELS) {
        setPreview(hoverTarget);
        expandRail();
        return;
      }
    }
    setPreview(hoverTarget);
    if (isPeek()) applyPeekSlice(hoverTarget);
    else scrollListTo(hoverTarget);
  }
}

// ---- Open, expand and close ----

const isOpen = () => $('channel-rail').classList.contains('open');
const isPeek = () => $('channel-rail').classList.contains('peek');
let timer = 0;

function scheduleHoverOpen() {
  if (isOpen() || openPending) return;
  clearTimeout(timer);
  openPending = true;
  timer = setTimeout(() => {
    openPending = false;
    if ($('rail-ticks').matches(':hover')) openRail({ preview: true, peek: true });
  }, OPEN_DELAY);
}

function openRail({ focus = false, preview = false, peek = false } = {}) {
  clearTimeout(timer);
  openPending = false;
  const rail = $('channel-rail');
  if (rail.classList.contains('hidden')) return;
  if (!isOpen()) {
    const usePeek = peek && !focus && groups.length > RAIL_PEEK_OVER;
    rail.classList.toggle('peek', usePeek);
    rail.classList.add('open');
    $('rail-ticks').setAttribute('aria-expanded', 'true');
    peekSteps = 0;
    const target = preview && hoverTarget >= 0 ? hoverTarget : activeIndex;
    if (usePeek) {
      applyPeekSlice(target >= 0 ? target : 0);
      if (preview && hoverTarget >= 0) setPreview(hoverTarget);
    } else {
      clearPeekSlice();
      // Ensure popover dimensions are ready before centering the list.
      void $('rail-popover').offsetHeight;
      if (preview && hoverTarget >= 0 && !typing) {
        setPreview(hoverTarget);
        scrollListTo(hoverTarget);
      } else {
        scrollListTo(activeIndex);
      }
    }
  } else if (!peek && isPeek()) {
    expandRail({ focus });
    return;
  }
  if (!focus) return;
  const filter = $('rail-filter');
  (filter.hidden ? items[activeIndex] : filter)?.focus();
}

function expandRail({ focus = false } = {}) {
  if (!isOpen()) return;
  const anchor = previewIndex >= 0 ? previewIndex : (hoverTarget >= 0 ? hoverTarget : activeIndex);
  if (isPeek()) {
    const popover = $('rail-popover');
    finishExpandAnimation();
    const startHeight = popover.getBoundingClientRect().height;
    $('channel-rail').classList.remove('peek');
    clearPeekSlice();
    peekSteps = 0;
    const endHeight = popover.getBoundingClientRect().height;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced && startHeight > 0 && endHeight > startHeight + 2) {
      popover.classList.add('expanding-start');
      popover.style.height = `${startHeight}px`;
      if (!typing && anchor >= 0) scrollListTo(anchor);
      void popover.offsetHeight;
      popover.classList.remove('expanding-start');
      popover.classList.add('expanding');
      popover.style.height = `${endHeight}px`;
      const keepCentered = () => {
        if (!popover.classList.contains('expanding')) return;
        const target = previewIndex >= 0 ? previewIndex : anchor;
        if (!typing && target >= 0) scrollListTo(target);
        expandFrame = requestAnimationFrame(keepCentered);
      };
      expandFrame = requestAnimationFrame(keepCentered);
      const onEnd = (e) => {
        if (e.target === popover && e.propertyName === 'height') {
          popover.removeEventListener('transitionend', onEnd);
          finishExpandAnimation();
        }
      };
      popover.addEventListener('transitionend', onEnd);
      expandTimer = setTimeout(() => {
        popover.removeEventListener('transitionend', onEnd);
        finishExpandAnimation();
      }, EXPAND_FALLBACK_MS);
    } else if (!typing && anchor >= 0) {
      scrollListTo(anchor);
    }
  }
  if (!focus) return;
  const filter = $('rail-filter');
  (filter.hidden ? items[anchor >= 0 ? anchor : activeIndex] : filter)?.focus();
}

function finishExpandAnimation() {
  clearTimeout(expandTimer);
  cancelAnimationFrame(expandFrame);
  expandTimer = 0;
  expandFrame = 0;
  const popover = $('rail-popover');
  popover.classList.remove('expanding', 'expanding-start');
  popover.style.height = '';
}

function closeRail({ refocus = false } = {}) {
  clearTimeout(timer);
  openPending = false;
  finishExpandAnimation();
  clearWave();
  clearHandoff();
  hoverTarget = -1;
  lastClientY = null;
  peekSteps = 0;
  setPreview(-1);
  if (!isOpen()) return;
  const rail = $('channel-rail');
  rail.classList.remove('open', 'peek');
  clearPeekSlice();
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

function jumpTo(index, { byKeyboard = false, keepOpen = false } = {}) {
  const group = groupElements()[index];
  if (!group) return;
  // Opens it, and remembers that, as clicking its header would.
  if (group.classList.contains('collapsed')) {
    expandingGroup = true;
    try {
      group.querySelector('.group-toggle').click();
    } finally {
      expandingGroup = false;
    }
  }
  const rail = $('channel-rail');
  const focusInside = rail.contains(document.activeElement);
  if (!keepOpen) {
    // From the keyboard, focus goes back to the rail. From a click, it leaves
    // the rail, or hovering would no longer close the list on the way out.
    closeRail({ refocus: byKeyboard && focusInside });
  }
  if (!byKeyboard && focusInside) document.activeElement.blur();
  setActive(index);
  // Don't let the smooth scroll light up every channel it passes. The pause
  // lasts while the scroll does (see the scroll listener), or 1s if the page
  // doesn't move at all.
  jumping = true;
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

  // While open in full mode, keep it in sight unless filtering or previewing another spot.
  const list = $('rail-list');
  if (isOpen() && !isPeek() && !typing && previewIndex === -1) {
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
  const popover = $('rail-popover');
  const filter = $('rail-filter');
  const list = $('rail-list');
  const expand = $('rail-expand');

  // Hover on the ladder reacts immediately with a wave and opens the compact peek
  // after a short delay; leaving the whole rail closes it, unless focus is inside.
  const canHover = matchMedia('(hover: hover)');
  rail.addEventListener('mouseenter', () => {
    if (!canHover.matches) return;
    if (!openPending) clearTimeout(timer);
  });
  rail.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    openPending = false;
    clearWave();
    clearHandoff();
    hoverTarget = -1;
    lastClientY = null;
    // The ladder no longer points anywhere: show where you are again.
    setPreview(-1);
    // Stays open while the keyboard is in it (the filter, or a channel
    // reached with the arrows), not for focus a click left behind.
    const active = document.activeElement;
    if (rail.contains(active) && active.matches(':focus-visible')) return;
    timer = setTimeout(closeRail, CLOSE_DELAY);
  });

  // Scrolling the mouse wheel over the ladder or peek panel expands to the full list.
  rail.addEventListener('wheel', (e) => {
    if (!isPeek()) return;
    e.preventDefault();
    expandRail();
  }, { passive: false });

  ticks.addEventListener('pointerenter', (e) => {
    if (!canHover.matches || e.pointerType === 'touch') return;
    if (!openPending) clearTimeout(timer);
    clearHandoff();
    lastClientY = e.clientY;
    pointerTrail = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    scrubAt(e.clientY);
    scheduleHoverOpen();
  });
  ticks.addEventListener('pointermove', (e) => {
    if (!canHover.matches || e.pointerType === 'touch') return;
    const now = performance.now();
    lastClientY = e.clientY;
    const curr = { x: e.clientX, y: e.clientY, t: now };
    pointerTrail = pointerTrail.filter(p => now - p.t <= TRAIL_WINDOW_MS);
    const anchor = pointerTrail[0];
    pointerTrail.push(curr);

    if (!isOpen()) {
      scrubAt(e.clientY);
      scheduleHoverOpen();
      return;
    }

    if (anchor) {
      if (isAimingAtPopover(anchor, curr, popover.getBoundingClientRect())) {
        scrubFrozen = true;
        clearTimeout(freezeTimer);
        freezeTimer = setTimeout(() => {
          scrubFrozen = false;
          if (ticks.matches(':hover') && lastClientY !== null) scrubAt(lastClientY);
        }, HANDOFF_FREEZE_MS);
        return;
      }
      if (scrubFrozen) {
        // Still frozen until user moves back right or clearly scrubs vertically.
        const movedBack = curr.x - anchor.x >= 2;
        const movedVertically = Math.abs(curr.y - anchor.y) >= 4;
        if (!movedBack && !movedVertically) return;
        clearTimeout(freezeTimer);
        scrubFrozen = false;
      }
    }

    scrubAt(e.clientY);
  });
  ticks.addEventListener('pointerleave', () => {
    clearWave();
    clearHandoff();
    lastClientY = null;
  });

  // Pointer moving over items in the list takes over the highlight from ladder preview.
  popover.addEventListener('mouseenter', () => {
    if (!openPending) clearTimeout(timer);
    clearHandoff();
  });
  list.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    if (previewIndex !== -1 && e.target.closest('.rail-item')) setPreview(-1);
  });
  expand.addEventListener('click', () => expandRail());

  ticks.addEventListener('click', (e) => {
    // Keyboard activation (detail === 0): open and focus the full list.
    if (e.detail === 0) {
      openRail({ focus: true });
      return;
    }
    clearHandoff();
    const idx = railChannelAt(pointerRatioOnTicks(e.clientY), groups.length);
    if (idx < 0) return;
    if (filter.value) {
      filter.value = '';
      applyFilter();
    }
    hoverTarget = idx;
    jumpTo(idx, { byKeyboard: false, keepOpen: true });
    if (!isOpen()) openRail({ preview: true, peek: true });
    else {
      setPreview(idx);
      if (isPeek()) applyPeekSlice(idx);
      else scrollListTo(idx);
    }
  });
  ticks.addEventListener('focus', () => { if (!refocusing && ticks.matches(':focus-visible')) openRail(); });
  ticks.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openRail({ focus: true });
    }
  });
  rail.addEventListener('focusout', (e) => {
    if (!rail.contains(e.relatedTarget) && !rail.matches(':hover')) closeRail();
  });
  document.addEventListener('click', (e) => {
    if (!expandingGroup && isOpen() && !rail.contains(e.target)) closeRail();
  });

  // Before the page's own keys: Esc closes the list first, G opens/expands it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      const inside = rail.contains(document.activeElement);
      // Esc meant for the rail stops here; from elsewhere (the search box),
      // it closes the list and still does what it does there.
      if (inside || document.activeElement === document.body) e.stopPropagation();
      closeRail({ refocus: inside });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
    // A Sort or Group menu is open: its keys are its own.
    if (document.querySelector('.picker-menu:not(.hidden)')) return;
    if (e.key === 'g' || e.key === 'G') {
      if (rail.classList.contains('hidden')) return;
      if (!isOpen()) {
        e.preventDefault();
        openRail({ focus: true });
      } else if (isPeek()) {
        e.preventDefault();
        expandRail({ focus: true });
      }
    } else if (isOpen() && !filter.hidden && e.key.length === 1 && e.key !== ' ') {
      // Opened by hovering: the first letter typed expands (if peeking) and goes
      // to the filter, which doesn't take focus on hover.
      e.preventDefault();
      if (isPeek()) expandRail();
      filter.focus();
      filter.value += e.key;
      filter.dispatchEvent(new Event('input'));
    }
  }, true);

  filter.addEventListener('input', () => {
    typing = filter.value.trim() !== '';
    setPreview(-1);
    applyFilter();
    list.scrollTop = 0;
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = shownItems()[0];
      if (first) jumpTo(Number(first.dataset.index), { byKeyboard: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      shownItems()[0]?.focus();
    }
  });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.rail-item');
    if (!item) return;
    // detail 0: Enter or Space, not a click. Mouse clicks keep the panel open so
    // you can immediately pick another channel if you missed; moving away closes it.
    const byKeyboard = e.detail === 0;
    jumpTo(Number(item.dataset.index), { byKeyboard, keepOpen: !byKeyboard });
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
    // A jump's scroll keeps the pause going; one that never moved the page
    // has already timed out, and this scroll is the user's own.
    if (jumping && performance.now() > followPausedUntil) jumping = false;
    if (jumping) followPausedUntil = performance.now() + 250;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => followScroll());
  }, { passive: true });
  addEventListener('scrollend', () => {
    jumping = false;
    followPausedUntil = 0;
    followScroll();
  });
  // Collapsing groups, History opening, the window resizing: the page may
  // now fit on screen, or no longer.
  new ResizeObserver(updateRailVisibility).observe(document.querySelector('main.main-content'));
  addEventListener('resize', updateRailVisibility);
}
