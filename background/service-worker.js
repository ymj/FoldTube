/* global ytInitialPlayerResponse -- YouTube page global, read by the MAIN-world duration probe */
import { scrapeYouTubeTab } from '../content/scraper.js';
import { showSavedMark } from '../content/saved-mark.js';
import { parseVideoUrl, parseIsoDuration, formatDuration, positionFromPlayer, YOUTUBE_TAB_PATTERNS } from '../lib/youtube.js';
import { foldTabs, autoCollapseVideo, buildTabSnapshot, updateTabSnapshot, recoverClosedTabs } from '../lib/fold.js';
import { createSerialQueue, createVideoStore, applyVideoOp, patchVideos, reconcileRestoredTabs } from '../lib/store.js';
import { videoIdsForLookup, oembedUrl, classifyOembedStatus, applyOembedResults } from '../lib/oembed.js';
import { menuItems, linkToVideo, MENU_FOLD_TAB, MENU_SAVE_LINK } from '../lib/contextmenu.js';
import { decodeStored, encodeStored, needsMigration, isActive, truncateDescription, SCHEMA_VERSION } from '../lib/archive.js';

// ---- Saved videos: single owner ----

// A random ID for this install, made once. It marks which install changed a
// video's state, so lists from two devices can be merged later. It encodes
// nothing about the browser or the user.
let deviceIdPromise = null;
function getDeviceId() {
  deviceIdPromise ??= (async () => {
    const { deviceId } = await chrome.storage.local.get("deviceId");
    if (typeof deviceId === "string" && deviceId) return deviceId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: id });
    return id;
  })();
  return deviceIdPromise;
}

async function changeContext() {
  return { deviceId: await getDeviceId(), now: new Date() };
}

// Every change to savedVideos goes through mutateSavedVideos, one at a time,
// applied to the list as stored *now* (see lib/store.js). This is the only
// place that writes it. Stored as a map keyed by video ID (lib/archive.js);
// handled here as an array, newest saved first.
const mutateSavedVideos = createVideoStore({
  read: async () => decodeStored((await chrome.storage.local.get("savedVideos")).savedVideos, await changeContext()),
  // hasSavedBefore tells the dashboard's empty view apart: first run vs
  // everything watched or removed.
  write: (videos) => chrome.storage.local.set({
    savedVideos: encodeStored(videos),
    schemaVersion: SCHEMA_VERSION,
    ...(videos.length ? { hasSavedBefore: true } : {}),
  }),
});

// Apply one operation from lib/store.js, stamped with this install and time.
async function applyOp(op) {
  const ctx = await changeContext();
  return mutateSavedVideos(videos => applyVideoOp(videos, op, ctx));
}

// The saved list, read without changing it.
async function readSavedVideos() {
  return decodeStored((await chrome.storage.local.get("savedVideos")).savedVideos);
}

// Lists saved by 1.0.8 and earlier are an array. Convert once, in one write:
// reading converts, and writing stores the new shape. Safe to run again.
async function migrateStorage() {
  const stored = await chrome.storage.local.get(["savedVideos", "schemaVersion"]);
  if (!needsMigration(stored)) return;
  await mutateSavedVideos(videos => ({ videos: [...videos] }));
  console.log("FoldTube: saved list converted to the new format.");
}

const migrated = migrateStorage().catch(e => console.error("FoldTube: converting the saved list failed", e));
chrome.runtime.onInstalled.addListener(() => migrated.then(migrateStorage));
chrome.runtime.onStartup.addListener(() => migrated.then(migrateStorage));

// ---- Shared helpers ----

// A notification still in the notification centre with the same ID would be
// updated silently (no banner), so clear it first.
async function notify(id, message) {
  try {
    await chrome.notifications.clear(id).catch(() => {});
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "FoldTube",
      message,
    });
  } catch (_) { /* notifications are non-critical */ }
}

// A short badge on the toolbar icon: confirmation that shows even when the
// OS hides notifications.
let badgeTimer = null;
function flashBadge(text, color) {
  try {
    clearTimeout(badgeTimer);
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
  } catch (_) { /* the badge is non-critical */ }
}

// ---- Open YouTube tabs (write-ahead) ----

// The YouTube video tabs that are open, kept in storage.local so the list
// survives a quit or crash (see lib/fold.js). Changes are applied one at a
// time. During a session it is updated tab by tab and never rebuilt, so a tab
// whose close event wakes the worker is still listed when the event is handled.
const TAB_SNAPSHOT_KEY = "openYoutubeTabs";
const enqueueSnapshot = createSerialQueue();

async function readTabSnapshot() {
  return (await chrome.storage.local.get(TAB_SNAPSHOT_KEY))[TAB_SNAPSHOT_KEY] || {};
}

function writeTabSnapshot(snapshot) {
  return chrome.storage.local.set({ [TAB_SNAPSHOT_KEY]: snapshot });
}

function videoIdsOfTabs(tabs) {
  return new Set(tabs.map(t => parseVideoUrl(t.url)?.videoId).filter(Boolean));
}

// storage.session is cleared when the browser starts and when the extension
// is installed, updated or reloaded: that marks a new session.
const SESSION_FLAG = "foldtubeSessionStarted";

// A new session: save what the last one left open and didn't get back, move
// restored tabs to History, drop expired history, then list the tabs open now.
const sessionReady = enqueueSnapshot(async () => {
  await migrated;
  if ((await chrome.storage.session.get(SESSION_FLAG))[SESSION_FLAG]) return;

  const tabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS });
  const openIds = videoIdsOfTabs(tabs);
  const { settings = {} } = await chrome.storage.local.get("settings");

  const recovered = recoverClosedTabs(await readTabSnapshot(), openIds, settings);
  if (recovered.length) {
    const { added } = await applyOp({ type: 'add', videos: recovered });
    console.log(`FoldTube: saved ${added} tab(s) left open when the browser last closed.`);
    fillInMetadata();
  }

  // A video saved on window close whose tab the browser restored is open
  // again: it moves to History as watched. The rest are kept and marked
  // checked (see lib/store.js).
  const ctx = await changeContext();
  const { reopened } = await mutateSavedVideos(videos => reconcileRestoredTabs(videos, openIds, ctx));
  if (reopened.length) console.log(`FoldTube: ${reopened.length} restored tab(s) already open moved to History.`);

  // History older than 90 days is dropped once per browser session (and
  // each time the dashboard opens).
  const { purged } = await applyOp({ type: 'purge' });
  if (purged) console.log(`FoldTube: dropped ${purged} history entr${purged === 1 ? 'y' : 'ies'} older than 90 days.`);

  await writeTabSnapshot(buildTabSnapshot(tabs));
  await chrome.storage.session.set({ [SESSION_FLAG]: true });
}).catch(e => console.error("FoldTube: session start failed", e));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") return;
  enqueueSnapshot(async () => {
    const snapshot = await readTabSnapshot();
    const next = updateTabSnapshot(snapshot, tabId, tab);
    if (next !== snapshot) await writeTabSnapshot(next);
  });
});

// ---- Auto-collapse when a window closes ----

// While the browser keeps running (closing one window), save the window's
// tabs right away. If the browser quits first, the list above still has them.
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  enqueueSnapshot(async () => {
    const snapshot = await readTabSnapshot();
    const entry = snapshot[tabId];
    if (!entry) return;

    if (removeInfo.isWindowClosing) {
      const { settings = {} } = await chrome.storage.local.get("settings");
      const video = autoCollapseVideo(removeInfo, settings, entry);
      if (video) {
        await applyOp({ type: 'add', videos: [video] });
        fillInMetadata();
      }
    }

    // Saved, or closed on purpose: no longer a candidate.
    const { [tabId]: _closed, ...rest } = snapshot;
    await writeTabSnapshot(rest);
  });
});

// ---- Manual Collapse (Clicking Extension Icon) ----

// Scrape one loaded tab: page metadata, then the real duration from the
// player (MAIN world) so an ad playing doesn't skew it.
async function scrapeTab(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeYouTubeTab,
  });
  const metadata = results[0]?.result;
  if (!metadata) return null;
  metadata.description = truncateDescription(metadata.description);
  let player = null;
  try {
    const playerResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          let duration = 0;
          const p = document.querySelector('#movie_player');
          const data = p && typeof p.getVideoData === 'function' ? p.getVideoData() : null;
          if (typeof ytInitialPlayerResponse !== 'undefined') {
            duration = parseInt(ytInitialPlayerResponse?.videoDetails?.lengthSeconds, 10) || 0;
          }
          if (!duration && p && typeof p.getDuration === 'function') {
            duration = data?.video_quality_features?.length_seconds || p.getDuration() || 0;
          }
          const position = p && typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : null;
          return {
            duration,
            position,
            isLive: Boolean(data?.isLive),
            adShowing: Boolean(p?.classList?.contains('ad-showing')),
          };
        } catch (_) { return null; }
      },
    });
    player = playerResults[0]?.result || null;
    const realDuration = Math.round(player?.duration || 0);
    if (realDuration > 0) {
      metadata.durationSeconds = realDuration;
      metadata.durationFormatted = formatDuration(realDuration);
    }
  } catch (_) { /* the player read is best-effort */ }
  const { seconds, source } = positionFromPlayer(metadata, player);
  metadata.timestampSeconds = seconds;
  metadata.positionSource = source;
  return metadata;
}

// Save folded videos newest first, after any other change in progress.
function saveFoldedVideos(videos) {
  return applyOp({ type: 'add', videos });
}

// Save first, then close only the tabs that were saved (see lib/fold.js).
async function processAndSaveTabs(tabs) {
  if (!tabs || tabs.length === 0) return { closed: 0, leftOpen: 0, saved: 0, saveFailed: false };

  const result = await foldTabs(tabs, {
    readTab: scrapeTab,
    save: saveFoldedVideos,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
  });

  // Fill in channel (and, with an API key, duration) for URL-only entries.
  if (result.saved > 0) fillInMetadata();
  return result;
}

async function handleCollapse() {
  const tabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS });
  
  if (tabs.length > 0) {
    const { closed, leftOpen } = await processAndSaveTabs(tabs);
    notify("foldtube-collapse", `Folded ${closed} YouTube tab${closed === 1 ? '' : 's'}`
      + (leftOpen > 0 ? ` · ${leftOpen} left open` : ''));
  } else {
    notify("foldtube-empty", "No YouTube tabs found.");
  }

  // Always open / focus the dashboard
  await handleOpenDashboard();
}

chrome.action.onClicked.addListener(handleCollapse);

// ---- Open Dashboard (no collapse) ----

// Without the "tabs" permission the worker can't find the dashboard tab by
// its URL, so it asks: an open dashboard brings itself to the front and
// answers. With no answer, a new one is opened.
async function handleOpenDashboard() {
  try {
    const focused = await chrome.runtime.sendMessage({ action: "focusDashboard" }).catch(() => false);
    if (focused) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  } catch (e) {
    console.error("FoldTube: failed to open dashboard", e);
  }
}

// Handle named keyboard commands
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-dashboard") {
    handleOpenDashboard();
  } else if (command === "fold-current-tab") {
    handleFoldCurrentTab();
  }
});

async function handleFoldCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: YOUTUBE_TAB_PATTERNS });
  if (tabs.length > 0) await foldOneTab(tabs[0]);
}

// The keyboard shortcut and the "Fold this tab" menu.
async function foldOneTab(tab) {
  const { closed } = await processAndSaveTabs([tab]);
  notify("foldtube-collapse-single",
    closed > 0 ? "Folded current YouTube tab!" : "Couldn't fold this tab; it was left open.");
  await handleOpenDashboard();
}

// ---- Right-click menus ----

// Chrome keeps menus across restarts; Firefox may not. Clearing first means
// creating them again never duplicates them.
async function createMenus() {
  try {
    await chrome.contextMenus.removeAll();
    for (const item of menuItems()) chrome.contextMenus.create(item);
  } catch (e) {
    console.error("FoldTube: failed to create menus", e);
  }
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_FOLD_TAB && tab?.id !== undefined && parseVideoUrl(tab.url)) {
    foldOneTab(tab);
  } else if (info.menuItemId === MENU_SAVE_LINK) {
    saveLink(info, tab);
  }
});

// Save a linked video without opening it. Its title and channel are filled
// in afterwards.
async function saveLink(info, tab) {
  const video = linkToVideo(info.linkUrl);
  if (!video) return;
  const { added } = await applyOp({ type: 'add', videos: [video] });
  if (added) fillInMetadata();

  // Confirm on the page itself, where the user is looking. Pages the
  // extension can't draw on (browser pages, the extension stores) get the
  // toolbar badge and a notification instead.
  if (await showMarkOnPage(info, tab, Boolean(added))) return;
  flashBadge(added ? "+1" : "✓", added ? "#1e8e3e" : "#5f6368");
  notify("foldtube-save-link", added ? "Saved to FoldTube" : "Already in FoldTube");
}

let iconDataUrl = null;
async function markIcon() {
  if (iconDataUrl) return iconDataUrl;
  try {
    const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL("icons/icon48.png"))).arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    iconDataUrl = `data:image/png;base64,${btoa(binary)}`;
  } catch (_) { /* the pill works without the icon */ }
  return iconDataUrl;
}

// Uses activeTab, which the menu click grants for this tab only.
async function showMarkOnPage(info, tab, added) {
  if (tab?.id === undefined || tab.id < 0) return false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: showSavedMark,
      args: [info.linkUrl, { added, iconUrl: await markIcon() }],
    });
    return result?.result === true;
  } catch (_) {
    return false;
  }
}

// ---- Filling in metadata ----

chrome.runtime.onStartup.addListener(async () => {
  await sessionReady;
  await fillInMetadata();
});

// API enrichment first (it also fills duration), then oEmbed for any channel
// still unknown. One run at a time; a request made while a run is waiting to
// start is covered by that run.
const enqueueMetadata = createSerialQueue();
let metadataRunWaiting = null;

function fillInMetadata() {
  if (metadataRunWaiting) return metadataRunWaiting;
  metadataRunWaiting = enqueueMetadata(async () => {
    metadataRunWaiting = null;
    await runEnrichment();
    await runChannelLookup();
  }).catch(e => console.error("FoldTube: filling in metadata failed", e));
  return metadataRunWaiting;
}

// Channel names without an API key (see lib/oembed.js). Requests go one at a
// time and carry no cookies. Offline, rate-limited or a server error: stop
// and try again on a later run.
async function runChannelLookup() {
  const ids = videoIdsForLookup((await readSavedVideos()).filter(isActive));
  let results = new Map();
  const flush = async () => {
    if (!results.size) return;
    const batch = results;
    results = new Map();
    await mutateSavedVideos(videos => applyOembedResults(videos, batch));
  };

  try {
    for (const id of ids) {
      let resp;
      try {
        resp = await fetch(oembedUrl(id), { credentials: "omit" });
      } catch (_) {
        return; // offline
      }
      const outcome = classifyOembedStatus(resp.status);
      if (outcome === "retry") return;
      let data = null;
      if (outcome === "ok") {
        try { data = await resp.json(); } catch (_) { return; } // garbled: retry later
      }
      results.set(id, data);
      if (results.size >= 10) await flush();
    }
  } finally {
    await flush();
  }
}

async function runEnrichment() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!settings.apiKey) return;

  // Read once to choose what to look up; the results are applied to the list
  // as it is when each batch returns, so changes made meanwhile survive.
  const savedVideos = (await readSavedVideos()).filter(isActive);

  const needsEnrichment = savedVideos.filter(v => 
    v.durationSeconds === 0 || 
    v.channelName === "Unknown Channel" || 
    v.metadataSource === "auto-collapsed" || 
    v.metadataSource === "discarded" ||
    v.metadataSource === "url-only"
  );
  
  if (needsEnrichment.length === 0) return;

  const apiKey = settings.apiKey;
  const idsToProcess = [...new Set(needsEnrichment.map(v => v.videoId))];

  for (let i = 0; i < idsToProcess.length; i += 50) {
    const batch = idsToProcess.slice(i, i + 50);
    try {
      const resp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${batch.join(',')}&key=${apiKey}`);
      const data = await resp.json();
      
      if (data.error) {
        console.error("YouTube API Errored:", data.error.message);
        await chrome.storage.local.set({ apiError: true });
        return; // Abort enrichment loop to avoid spamming bad keys
      } else {
        await chrome.storage.local.set({ apiError: false }); // Clear if success
      }
      
      if (data.items?.length) {
        const patches = new Map();
        for (const item of data.items) {
          const patch = {
            title: item.snippet.title,
            channelName: item.snippet.channelTitle,
            metadataSource: 'api-enriched',
          };
          const seconds = parseIsoDuration(item.contentDetails?.duration);
          if (seconds !== null) {
            patch.durationSeconds = seconds;
            patch.durationFormatted = formatDuration(seconds);
          }
          patches.set(item.id, patch);
        }
        await mutateSavedVideos(videos => patchVideos(videos, patches));
      }
    } catch(e) {
      console.error("API Enrichment fetch failed.", e);
    }
  }
}

// ---- Messages from the dashboard ----

const DASHBOARD_OPS = new Set(['import', 'archive', 'unarchive', 'forget', 'clearHistory', 'purge']);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own pages may change the library.
  if (sender.id !== chrome.runtime.id) return;

  // The dashboard's "Fold N open tabs" button: same fold as the toolbar icon,
  // without re-opening the dashboard it was clicked in.
  if (request.action === "foldAllTabs") {
    chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS })
      .then(processAndSaveTabs)
      .then(result => sendResponse({ ok: true, result }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // respond asynchronously
  }

  if (request.action === "runEnrichment") {
    fillInMetadata();
    return;
  }

  if (request.action === "mutateVideos" && DASHBOARD_OPS.has(request.op?.type)) {
    applyOp(request.op)
      .then(result => sendResponse({ ok: true, result }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // respond asynchronously
  }
});
