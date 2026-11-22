/* global ytInitialPlayerResponse -- YouTube page global, read by the MAIN-world duration probe */
import { scrapeYouTubeTab } from '../content/scraper.js';
import { parseVideoUrl, parseIsoDuration, formatDuration } from '../lib/youtube.js';
import { foldTabs, autoCollapseVideo } from '../lib/fold.js';
import { createVideoStore, applyVideoOp, patchVideos, reconcileRestoredTabs } from '../lib/store.js';

// ---- Saved videos: single owner ----

// Every change to savedVideos goes through mutateSavedVideos, one at a time,
// applied to the array as stored *now* (see lib/store.js). This is the only
// place that writes it.
const mutateSavedVideos = createVideoStore({
  read: async () => (await chrome.storage.local.get("savedVideos")).savedVideos || [],
  write: (videos) => chrome.storage.local.set({ savedVideos: videos }),
});

// ---- Shared helpers ----

// Tab URL patterns for YouTube videos, Shorts and live streams.
const YOUTUBE_TAB_PATTERNS = [
  "*://*.youtube.com/watch?v=*",
  "*://*.youtube.com/shorts/*",
  "*://*.youtube.com/live/*",
];

function notify(id, message) {
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "FoldTube",
      message,
    });
  } catch (_) { /* notifications are non-critical */ }
}

// ---- State & Storage Setup ----

async function updateActiveTabsCache() {
  const tabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS });
  const map = {};
  for(const t of tabs) map[t.id] = { url: t.url, title: t.title };
  
  if (chrome.storage && chrome.storage.session) {
    await chrome.storage.session.set({ activeYoutubeTabs: map });
  }
}

// Initial hydration
updateActiveTabsCache();

// Keep tracker updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    if (tab.url && tab.url.includes('youtube.com/')) {
      updateActiveTabsCache();
    }
  }
});

// ---- Auto-collapse when a window closes ----

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) {
    const { settings = {} } = await chrome.storage.local.get("settings");
    if (!settings.autoCollapse) return;

    if (chrome.storage && chrome.storage.session) {
      const { activeYoutubeTabs = {} } = await chrome.storage.session.get("activeYoutubeTabs");
      const video = autoCollapseVideo(removeInfo, settings, activeYoutubeTabs[tabId]);
      if (video) {
        await mutateSavedVideos(videos => applyVideoOp(videos, { type: 'add', videos: [video] }));
      }
    }
  } else {
    // Standard tab close, just update cache
    updateActiveTabsCache();
  }
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
  try {
    const durResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const player = document.querySelector('#movie_player');
          if (player && typeof player.getDuration === 'function') {
            const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
            const lengthSec = data?.video_quality_features?.length_seconds
              || (typeof player.getDuration === 'function' ? player.getDuration() : 0);
            if (typeof ytInitialPlayerResponse !== 'undefined') {
              const ls = parseInt(ytInitialPlayerResponse?.videoDetails?.lengthSeconds, 10);
              if (ls > 0) return ls;
            }
            return lengthSec || 0;
          }
          if (typeof ytInitialPlayerResponse !== 'undefined') {
            return parseInt(ytInitialPlayerResponse?.videoDetails?.lengthSeconds, 10) || 0;
          }
          return 0;
        } catch (_) { return 0; }
      },
    });
    const realDuration = Math.round(durResults[0]?.result || 0);
    if (realDuration > 0) {
      metadata.durationSeconds = realDuration;
      metadata.durationFormatted = formatDuration(realDuration);
    }
  } catch (_) { /* duration enrichment is best-effort */ }
  return metadata;
}

// Save folded videos newest first, after any other change in progress.
function saveFoldedVideos(videos) {
  return mutateSavedVideos(current => applyVideoOp(current, { type: 'add', videos }));
}

// Save first, then close only the tabs that were saved (see lib/fold.js).
async function processAndSaveTabs(tabs) {
  if (!tabs || tabs.length === 0) return { closed: 0, leftOpen: 0, saved: 0, saveFailed: false };

  const result = await foldTabs(tabs, {
    readTab: scrapeTab,
    save: saveFoldedVideos,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
  });

  // Fill in channel and duration for URL-only entries, if an API key is set.
  if (result.saved > 0) runEnrichment();
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

async function handleOpenDashboard() {
  try {
    const dashboardUrl = chrome.runtime.getURL("dashboard/dashboard.html");
    const dashboardTabs = await chrome.tabs.query({ url: dashboardUrl });
    if (dashboardTabs.length > 0) {
      const existingTab = dashboardTabs[0];
      await chrome.tabs.update(existingTab.id, { active: true });
      try { await chrome.windows.update(existingTab.windowId, { focused: true }); } catch (_) {}
    } else {
      await chrome.tabs.create({ url: dashboardUrl });
    }
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

  if (tabs.length > 0) {
    const { closed } = await processAndSaveTabs(tabs);
    notify("foldtube-collapse-single",
      closed > 0 ? "Folded current YouTube tab!" : "Couldn't fold this tab; it was left open.");
    await handleOpenDashboard();
  }
}

// ---- Startup Reconciliation & Enrichment ----

chrome.runtime.onStartup.addListener(async () => {
  await reconcileTabs();
  await runEnrichment();
  await updateActiveTabsCache();
});

async function reconcileTabs() {
  const physicalTabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERNS });

  // Extract video IDs from restored tabs for robust matching regardless of
  // extra query params (timestamps, playlist refs, etc.) that may differ.
  const physicalVideoIds = new Set(
    physicalTabs.map(t => parseVideoUrl(t.url)?.videoId).filter(Boolean)
  );

  // A video saved on window close whose tab the browser restored is a
  // duplicate; the rest are kept and marked checked (see lib/store.js).
  const { removed } = await mutateSavedVideos(videos => reconcileRestoredTabs(videos, physicalVideoIds));
  if (removed.length) console.log(`Reconciled ${removed.length} restored tab(s) already open.`);
}

async function runEnrichment() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!settings.apiKey) return;

  // Read once to choose what to look up; the results are applied to the list
  // as it is when each batch returns, so changes made meanwhile survive.
  const { savedVideos = [] } = await chrome.storage.local.get("savedVideos");

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

const DASHBOARD_OPS = new Set(['add', 'remove', 'restore']);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own pages may change the library.
  if (sender.id !== chrome.runtime.id) return;

  if (request.action === "runEnrichment") {
    runEnrichment();
    return;
  }

  if (request.action === "mutateVideos" && DASHBOARD_OPS.has(request.op?.type)) {
    mutateSavedVideos(videos => applyVideoOp(videos, request.op))
      .then(result => sendResponse({ ok: true, result }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // respond asynchronously
  }
});
