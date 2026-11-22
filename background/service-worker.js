/* global ytInitialPlayerResponse -- YouTube page global, read by the MAIN-world duration probe */
import { scrapeYouTubeTab } from '../content/scraper.js';
import { urlToVideoData, parseVideoUrl, parseIsoDuration, formatDuration, mergeVideos } from '../lib/youtube.js';
import { foldTabs } from '../lib/fold.js';

// ---- State & Storage Setup ----

async function updateActiveTabsCache() {
  const tabs = await chrome.tabs.query({ url: [
    "*://*.youtube.com/watch?v=*",
    "*://*.youtube.com/shorts/*",
    "*://*.youtube.com/live/*"
  ] });
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

// Auto-Collapse tracking logic with Queue to prevent races at termination
let savingPromise = Promise.resolve();

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) {
    const { settings = {} } = await chrome.storage.local.get("settings");
    if (!settings.autoCollapse) return;

    if (chrome.storage && chrome.storage.session) {
      const { activeYoutubeTabs = {} } = await chrome.storage.session.get("activeYoutubeTabs");
      const tabData = activeYoutubeTabs[tabId];
      
      if (tabData) {
        // Enforce linear asynchronous saving sequence
        savingPromise = savingPromise.then(async () => {
          const videoObj = urlToVideoData(tabData.url, tabData.title);
          if (!videoObj) return;

          const { savedVideos = [] } = await chrome.storage.local.get("savedVideos");
          const alreadyExists = savedVideos.some(v => v.videoId === videoObj.videoId);
          if (!alreadyExists) {
            savedVideos.unshift(videoObj);
            await chrome.storage.local.set({ savedVideos });
          }
        });
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

// Save folded videos newest first, queued behind any other save in progress.
function saveFoldedVideos(videos) {
  const run = savingPromise.then(async () => {
    const { savedVideos = [] } = await chrome.storage.local.get("savedVideos");
    const { merged } = mergeVideos(videos, savedVideos);
    await chrome.storage.local.set({ savedVideos: merged });
  });
  savingPromise = run.catch(() => {});
  return run;
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
  const tabs = await chrome.tabs.query({ url: [
    "*://*.youtube.com/watch?v=*",
    "*://*.youtube.com/shorts/*",
    "*://*.youtube.com/live/*"
  ] });
  
  if (tabs.length > 0) {
    const { closed, leftOpen } = await processAndSaveTabs(tabs);
    const message = `Folded ${closed} YouTube tab${closed === 1 ? '' : 's'}`
      + (leftOpen > 0 ? ` · ${leftOpen} left open` : '');

    try {
      chrome.notifications.create("foldtube-collapse", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "FoldTube",
        message
      });
    } catch (_) { /* notification is non-critical */ }
  } else {
    try {
      chrome.notifications.create("foldtube-empty", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "FoldTube",
        message: "No YouTube tabs found."
      });
    } catch (_) { /* notification is non-critical */ }
  }

  // Always open / focus the dashboard
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
  const tabs = await chrome.tabs.query({ 
    active: true, 
    currentWindow: true,
    url: [
      "*://*.youtube.com/watch?v=*",
      "*://*.youtube.com/shorts/*",
      "*://*.youtube.com/live/*"
    ]
  });

  if (tabs.length > 0) {
    const { closed } = await processAndSaveTabs(tabs);

    try {
      chrome.notifications.create("foldtube-collapse-single", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "FoldTube",
        message: closed > 0 ? "Folded current YouTube tab!" : "Couldn't fold this tab; it was left open."
      });
    } catch (_) { /* notification is non-critical */ }
    
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
  const { savedVideos = [] } = await chrome.storage.local.get("savedVideos");
  if (savedVideos.length === 0) return;

  const physicalTabs = await chrome.tabs.query({ url: ["*://*.youtube.com/watch?v=*", "*://*.youtube.com/shorts/*", "*://*.youtube.com/live/*"] });
  if (physicalTabs.length === 0) return;

  // Extract video IDs from restored tabs for robust matching regardless of
  // extra query params (timestamps, playlist refs, etc.) that may differ.
  const physicalVideoIds = new Set(
    physicalTabs.map(t => parseVideoUrl(t.url)?.videoId).filter(Boolean)
  );

  const cleansedVideos = savedVideos.filter(video => {
    // If it was auto-collapsed, and the browser cleanly restored it, delete it.
    if (video.metadataSource === "auto-collapsed" && physicalVideoIds.has(video.videoId)) {
      return false; // Remove!
    }
    return true; // Keep!
  });

  if (cleansedVideos.length !== savedVideos.length) {
    await chrome.storage.local.set({ savedVideos: cleansedVideos });
    console.log(`Reconciled and destroyed ${savedVideos.length - cleansedVideos.length} duplicated restored tabs.`);
  }
}

async function runEnrichment() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!settings.apiKey) return;

  let { savedVideos = [] } = await chrome.storage.local.get("savedVideos");
  
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
  let isModified = false;

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
      
      if (data.items) {
        data.items.forEach(item => {
          // Update all references in savedVideos (in case of dupes)
          savedVideos.forEach(video => {
            if (video.videoId === item.id) {
              video.title = item.snippet.title;
              video.channelName = item.snippet.channelTitle;
              
              // Map Duration ISO 8601
              const seconds = parseIsoDuration(item.contentDetails?.duration);
              if (seconds !== null) {
                video.durationSeconds = seconds;
                video.durationFormatted = formatDuration(seconds);
              }
              video.metadataSource = 'api-enriched';
              isModified = true;
            }
          });
        });
      }
    } catch(e) {
      console.error("API Enrichment fetch failed.", e);
    }
  }

  if (isModified) {
    await chrome.storage.local.set({ savedVideos });
  }
}

// Receive message from Dashboard
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "runEnrichment") {
    runEnrichment();
  }
});
