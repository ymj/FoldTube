/* global ytInitialPlayerResponse -- YouTube page global, read by readYouTubePlayer in the page's world */
// scrapeYouTubeTab is passed to chrome.scripting.executeScript, which
// serialises the function body and runs it inside the YouTube page. It must
// stay self-contained: no imports, no references to outer variables. Its video
// ID and ISO 8601 duration logic therefore duplicates lib/youtube.js; keep the
// two in step when changing either.
export function scrapeYouTubeTab() {
  // Empty segments dropped, so /shorts/<id>/ works like /shorts/<id>.
  const segments = window.location.pathname.split('/').filter(Boolean);
  const isShort = segments[0] === 'shorts';
  const isLive = segments[0] === 'live';
  let videoId;
  let videoType = 'video';

  if (isShort || isLive) {
    videoId = segments[1] || null;
    if (isShort) videoType = 'short';
  } else {
    const videoIdMatch = window.location.search.match(/[?&]v=([^&]+)/);
    videoId = videoIdMatch ? videoIdMatch[1] : null;
  }

  if (!videoId) return null;

  // Title: the watch page's heading (current layout, then the older one); on
  // Shorts, the active Short's, not a neighbour's in the feed.
  let title = '';
  const titleVideoEl = document.querySelector('ytd-watch-metadata h1')
    || document.querySelector('h1.ytd-video-primary-info-renderer');
  const titleShortEl = document.querySelector('ytd-reel-video-renderer[is-active] h2.title')
    || document.querySelector('ytd-reel-player-header-renderer[is-active] h2.title');

  if (titleVideoEl && titleVideoEl.textContent.trim()) {
    title = titleVideoEl.textContent.trim();
  } else if (titleShortEl && titleShortEl.textContent.trim()) {
    title = titleShortEl.textContent.trim();
  } else if (document.title) {
    // The tab title, minus YouTube's unread count: "(3) Title - YouTube".
    title = document.title.replace(/^\(\d+\+?\)\s+/, '');
  }

  if (title.endsWith(' - YouTube')) {
    title = title.substring(0, title.length - 10);
  }
  if (!title) title = 'Unknown Title';

  // Channel extraction with fallbacks
  let channelName = '';
  let channelUrl = null;

  // ytd-video-owner-renderer is used on /watch, ytd-reel-player-header-renderer on /shorts
  const channelVideoEl = document.querySelector('ytd-video-owner-renderer ytd-channel-name a') || document.querySelector('#channel-name a');
  // Only the active Short's: the feed keeps its neighbours in the page.
  const channelShortEl = document.querySelector('ytd-reel-player-header-renderer[is-active] ytd-channel-name a');
  
  const finalChannelEl = isShort ? (channelShortEl || channelVideoEl) : (channelVideoEl || channelShortEl);

  if (finalChannelEl) {
    channelName = finalChannelEl.textContent.trim();
    channelUrl = finalChannelEl.href;
  } else {
    // The page's structured data: the channel is the author block. A bare
    // itemprop="url" is the video's own URL.
    const author = document.querySelector('[itemprop="author"]');
    const authorLink = author?.querySelector('link[itemprop="name"]');
    if (authorLink) channelName = authorLink.getAttribute('content');

    const urlLink = author?.querySelector('link[itemprop="url"]');
    if (urlLink) channelUrl = urlLink.getAttribute('href');
  }

  if (!channelName) channelName = 'Unknown Channel';

  let durationSeconds = 0;
  let durationFormatted = '';

  if (!isShort) {
    // The meta tag shows the real duration even during an ad (the player UI
    // shows the ad's), but YouTube doesn't update it when you move to another
    // video in the same tab: trust it only when it names this video.
    const metaDuration = document.querySelector('meta[itemprop="duration"]');
    const metaVideoId = document.querySelector('meta[itemprop="identifier"], meta[itemprop="videoId"]')?.getAttribute('content');
    if (metaDuration && metaVideoId === videoId) {
      const pt = metaDuration.getAttribute('content') || '';
      const match = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const h = parseInt(match[1] || 0, 10);
        const m = parseInt(match[2] || 0, 10);
        const s = parseInt(match[3] || 0, 10);
        durationSeconds = (h * 3600) + (m * 60) + s;

        const hStr = h > 0 ? `${h}:` : '';
        const mStr = h > 0 ? m.toString().padStart(2, '0') : m.toString();
        const sStr = s.toString().padStart(2, '0');
        durationFormatted = `${hStr}${mStr}:${sStr}`;
      }
    }

    // Fallback: read the player UI (may be wrong during ads, but better than nothing)
    if (!durationSeconds) {
      const durationEl = document.querySelector('span.ytp-time-duration');
      durationFormatted = durationEl ? durationEl.textContent.trim() : '';

      if (durationFormatted) {
        const parts = durationFormatted.split(':').map(Number);
        if (parts.length === 3) {
          durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
          durationSeconds = parts[0] * 60 + parts[1];
        }
      }
    }
  }

  const descEl = document.querySelector('#description-inline-expander') || document.querySelector('ytd-text-inline-expander');
  const description = descEl ? descEl.textContent.trim() : '';

  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  return {
    videoId,
    videoType,
    url: window.location.href,
    title,
    channelName,
    channelUrl,
    thumbnailUrl,
    durationSeconds,
    durationFormatted,
    description,
    dateSaved: new Date().toISOString(),
    metadataSource: 'scrape'
  };
}

// readYouTubePlayer runs in the page's own world (MAIN), where the player
// object and YouTube's page data are visible. Like scrapeYouTubeTab it must
// stay self-contained.
//
// Duration, best source first:
//   1. the player's response for the video it has loaded now;
//   2. ytInitialPlayerResponse, but only if it is this video: YouTube sets it
//      for the first video a tab loads and leaves it there when you move on;
//   3. the player's own length, unless an ad is playing (that's the ad's).
export function readYouTubePlayer() {
  try {
    const p = document.querySelector('#movie_player');
    const data = p && typeof p.getVideoData === 'function' ? p.getVideoData() : null;
    const adShowing = Boolean(p?.classList?.contains('ad-showing'));
    const currentId = data?.video_id
      || new URLSearchParams(window.location.search).get('v')
      || window.location.pathname.split('/').filter(Boolean)[1]
      || null;
    const seconds = (response) => {
      const details = response?.videoDetails;
      if (!details || (currentId && details.videoId !== currentId)) return 0;
      return parseInt(details.lengthSeconds, 10) || 0;
    };

    let duration = 0;
    if (p && typeof p.getPlayerResponse === 'function') duration = seconds(p.getPlayerResponse());
    if (!duration && typeof ytInitialPlayerResponse !== 'undefined') {
      duration = seconds(ytInitialPlayerResponse);
    }
    if (!duration && p && typeof p.getDuration === 'function' && !adShowing) {
      duration = data?.video_quality_features?.length_seconds || p.getDuration() || 0;
    }
    const position = p && typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : null;
    return { duration, position, isLive: Boolean(data?.isLive), adShowing };
  } catch (_) {
    return null;
  }
}
