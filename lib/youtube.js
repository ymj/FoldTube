// Pure helpers shared by the service worker and the dashboard.
// No browser APIs here, so everything can be unit-tested in Node.
//
// content/scraper.js keeps its own copies of the ID and duration logic:
// scrapeYouTubeTab is serialised by chrome.scripting.executeScript and runs
// inside the YouTube page, so it cannot import anything.

export const UNKNOWN_TITLE = 'Unknown Title';
export const UNKNOWN_CHANNEL = 'Unknown Channel';

/** Tab URL patterns for YouTube videos, Shorts and live streams (tabs.query). */
export const YOUTUBE_TAB_PATTERNS = [
  '*://*.youtube.com/watch?v=*',
  '*://*.youtube.com/shorts/*',
  '*://*.youtube.com/live/*',
];

/**
 * How many of these tabs a fold would save and close: those with a video ID.
 * @param {{ url?: string }[]} tabs
 */
export function countFoldableTabs(tabs) {
  return (Array.isArray(tabs) ? tabs : []).filter(t => parseVideoUrl(t?.url)).length;
}

/**
 * Extract the video ID and type from a YouTube watch, Shorts or live URL.
 * @param {string} urlStr
 * @returns {{ videoId: string, videoType: 'video' | 'short' } | null}
 */
export function parseVideoUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  let videoId;
  let videoType = 'video';

  if (segments[0] === 'shorts' || segments[0] === 'live') {
    videoId = segments[1] || null;
    if (segments[0] === 'shorts') videoType = 'short';
  } else {
    videoId = url.searchParams.get('v');
  }

  return videoId ? { videoId, videoType } : null;
}

/**
 * Parse an ISO 8601 duration as used by YouTube (e.g. "PT1H2M3S", "P1DT2H").
 * @param {string} iso
 * @returns {number | null} total seconds, or null if the string is not a duration
 */
export function parseIsoDuration(iso) {
  if (typeof iso !== 'string') return null;
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  // "P" or "PT" alone carry no value and are not valid durations.
  if (!match || !match.slice(1).some(part => part !== undefined)) return null;
  const [d, h, m, s] = match.slice(1).map(part => parseInt(part || '0', 10));
  return d * 86400 + h * 3600 + m * 60 + s;
}

// ---- Resume position ----

/** Positions under this many seconds open from the start. */
export const RESUME_MIN_SECONDS = 60;

/**
 * Seconds from a YouTube `t` value: "90", "90s", "1m30s", "1h2m3s".
 * Anything else → 0.
 * @param {unknown} value
 * @returns {number}
 */
export function parseTimeParam(value) {
  if (typeof value !== 'string') return 0;
  const v = value.trim();
  if (/^\d+s?$/.test(v)) return parseInt(v, 10);
  const match = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match.slice(1).some(Boolean)) return 0;
  const [h, m, s] = match.slice(1).map(part => parseInt(part || '0', 10));
  return h * 3600 + m * 60 + s;
}

/**
 * The position in a video URL's `t` parameter, in whole seconds. Shorts and
 * /live/ URLs always give 0.
 * @param {string} urlStr
 * @returns {number}
 */
export function timestampFromUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return 0;
  }
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (first === 'shorts' || first === 'live') return 0;
  return parseTimeParam(url.searchParams.get('t') ?? undefined);
}

/**
 * The position to save for a folded tab, from what the player reported.
 * Shorts and live streams → 0. While an ad plays, or if the player couldn't
 * be read, the player's time isn't the video's: the URL's `t` is used instead,
 * and the position counts as coming from the URL (see mergeVideos).
 * @param {{ url: string, videoType?: string }} video the scraped record
 * @param {{ position?: number, isLive?: boolean, adShowing?: boolean } | null} player
 * @returns {{ seconds: number, source: 'player' | 'url' }}
 */
export function positionFromPlayer(video, player) {
  if (video.videoType === 'short' || player?.isLive) return { seconds: 0, source: 'player' };
  if (player && !player.adShowing && Number.isFinite(player.position) && player.position >= 0) {
    return { seconds: Math.floor(player.position), source: 'player' };
  }
  return { seconds: timestampFromUrl(video.url), source: 'url' };
}

/**
 * Where a saved video should start: its position, or 0 for Shorts and for
 * positions under a minute.
 * @param {{ videoType?: string, timestampSeconds?: number }} video
 * @returns {number}
 */
export function resumeSeconds(video) {
  if (video?.videoType === 'short') return 0;
  const t = Number.isFinite(video?.timestampSeconds) ? Math.floor(video.timestampSeconds) : 0;
  return t >= RESUME_MIN_SECONDS ? t : 0;
}

/**
 * The URL to open a saved video at: any `t` in the saved URL is replaced by
 * the resume position, or removed when it starts from the beginning. Only
 * watch URLs carry a position; other URLs are returned as they are.
 * @param {{ url: string, videoType?: string, timestampSeconds?: number }} video
 * @returns {string}
 */
export function openUrlFor(video) {
  let url;
  try {
    url = new URL(video.url);
  } catch {
    return video.url;
  }
  if (url.pathname !== '/watch') return video.url;
  url.searchParams.delete('t');
  const t = resumeSeconds(video);
  if (t > 0) url.searchParams.set('t', `${t}s`);
  return url.href;
}

/**
 * Format seconds as "M:SS" or "H:MM:SS".
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hStr = h > 0 ? `${h}:` : '';
  const mStr = h > 0 ? m.toString().padStart(2, '0') : m.toString();
  const sStr = s.toString().padStart(2, '0');
  return `${hStr}${mStr}:${sStr}`;
}

/**
 * Strip YouTube's " - YouTube" suffix from a tab title.
 * @param {string} [rawTitle]
 * @returns {string}
 */
export function cleanTitle(rawTitle) {
  let title = typeof rawTitle === 'string' ? rawTitle.trimEnd() : '';
  if (title.endsWith(' - YouTube')) title = title.slice(0, -' - YouTube'.length);
  return title.trim() || UNKNOWN_TITLE;
}

/**
 * Build a saved-video record from a tab URL and title alone (no page access).
 * @param {string} urlStr
 * @param {string} [rawTitle]
 * @param {Date} [now]
 * @returns {object | null}
 */
export function urlToVideoData(urlStr, rawTitle, now = new Date()) {
  const parsed = parseVideoUrl(urlStr);
  if (!parsed) return null;
  const { videoId, videoType } = parsed;
  return {
    videoId,
    videoType,
    url: urlStr,
    title: cleanTitle(rawTitle),
    channelName: UNKNOWN_CHANNEL,
    channelUrl: null,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    durationSeconds: 0,
    durationFormatted: '',
    description: '',
    dateSaved: now.toISOString(),
    metadataSource: 'auto-collapsed', // overwritten for discarded tabs
    timestampSeconds: timestampFromUrl(urlStr),
  };
}

/**
 * Put new videos in front of the saved list, skipping any video already saved
 * and any repeat within the new batch (the first occurrence wins).
 * @param {object[]} incoming newest first
 * @param {object[]} saved
 * @returns {{ merged: object[], added: object[] }}
 */
export function mergeVideos(incoming, saved) {
  const seen = new Set(saved.map(v => v.videoId));
  const added = [];
  const positions = new Map();
  for (const video of incoming) {
    if (seen.has(video.videoId)) {
      if (hasNewPosition(video) && !positions.has(video.videoId)) positions.set(video.videoId, video.timestampSeconds);
      continue;
    }
    seen.add(video.videoId);
    added.push(video);
  }
  let updated = 0;
  const kept = positions.size
    ? saved.map(v => {
      if (!positions.has(v.videoId) || v.timestampSeconds === positions.get(v.videoId)) return v;
      updated++;
      return { ...v, timestampSeconds: positions.get(v.videoId) };
    })
    : saved;
  return { merged: [...added, ...kept], added, updated };
}

// A video saved again carries a position worth keeping when it was read from
// the player (forward or back, even 0: the user rewound or started over) or
// found in the URL. A URL without a position says nothing, and neither does
// the player while an ad plays, so the saved position is kept.
function hasNewPosition(video) {
  if (!Number.isFinite(video.timestampSeconds)) return false;
  return video.positionSource === 'player' || video.timestampSeconds > 0;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const METADATA_SOURCES = new Set(['scrape', 'auto-collapsed', 'discarded', 'url-only', 'api-enriched', 'imported']);

/**
 * Thumbnail URL for a video ID, always on YouTube's image host.
 * @param {string} videoId
 * @param {string} [size]
 */
export function thumbnailUrlFor(videoId, size = 'maxresdefault') {
  return `https://img.youtube.com/vi/${encodeURIComponent(videoId)}/${size}.jpg`;
}

/**
 * True for https links on youtube.com (any subdomain) or youtu.be.
 * @param {unknown} value
 */
export function isYouTubeUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

/**
 * Rebuild one entry from an imported backup, keeping only known fields with
 * safe values. Fields we can derive (thumbnail, formatted duration) are
 * regenerated instead of trusted.
 * @param {unknown} v
 * @param {Date} [now] used when the saved date is missing or invalid
 * @returns {object | null} the repaired record, or null if it can't be used
 */
export function sanitizeImportedVideo(v, now = new Date()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.videoId !== 'string' || !VIDEO_ID_RE.test(v.videoId)) return null;
  if (!isYouTubeUrl(v.url)) return null;
  if (typeof v.title !== 'string') return null;
  if (!['video', 'short'].includes(v.videoType)) return null;

  const seconds = Number.isFinite(v.durationSeconds) && v.durationSeconds > 0
    ? Math.floor(v.durationSeconds)
    : 0;
  const savedAt = typeof v.dateSaved === 'string' ? new Date(v.dateSaved) : null;

  return {
    videoId: v.videoId,
    videoType: v.videoType,
    url: v.url,
    title: v.title.trim() || UNKNOWN_TITLE,
    channelName: typeof v.channelName === 'string' && v.channelName.trim() ? v.channelName.trim() : UNKNOWN_CHANNEL,
    channelUrl: isYouTubeUrl(v.channelUrl) ? v.channelUrl : null,
    thumbnailUrl: thumbnailUrlFor(v.videoId),
    durationSeconds: seconds,
    durationFormatted: seconds > 0 ? formatDuration(seconds) : '',
    description: typeof v.description === 'string' ? v.description : '',
    dateSaved: savedAt && !Number.isNaN(savedAt.getTime()) ? savedAt.toISOString() : now.toISOString(),
    metadataSource: METADATA_SOURCES.has(v.metadataSource) ? v.metadataSource : 'imported',
    // Older backups have no position: they open from the start.
    timestampSeconds: v.videoType !== 'short' && Number.isFinite(v.timestampSeconds) && v.timestampSeconds > 0
      ? Math.floor(v.timestampSeconds)
      : 0,
  };
}

/**
 * Validate a parsed FoldTube backup and return its usable entries, repaired.
 * @param {unknown} data result of JSON.parse on the backup file
 * @param {Date} [now]
 * @returns {object[]}
 * @throws {Error} if the backup is not an array, or has entries but none are valid
 */
export function validateImport(data, now = new Date()) {
  if (!Array.isArray(data)) throw new Error('Invalid format');
  const valid = data.map(v => sanitizeImportedVideo(v, now)).filter(Boolean);
  if (valid.length === 0 && data.length > 0) throw new Error('No valid entries');
  return valid;
}

/**
 * Escape text for use in HTML element content or a quoted attribute.
 * @param {unknown} value
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Build the standalone HTML bookmarks file. Every value from storage is
 * escaped, and links that aren't YouTube https URLs are left out.
 * @param {object[]} videos
 * @param {{ date: string, exportedAt: string }} labels
 * @returns {string}
 */
export function buildHtmlExport(videos, { date, exportedAt }) {
  const items = videos.map(v => {
    const href = isYouTubeUrl(v.url) ? openUrlFor(v) : '';
    const title = escapeHtml(v.title);
    const link = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      : `<span class="title">${title}</span>`;
    const thumb = typeof v.videoId === 'string' && VIDEO_ID_RE.test(v.videoId)
      ? `<img src="${escapeHtml(thumbnailUrlFor(v.videoId, 'mqdefault'))}" alt="">`
      : '';
    const duration = v.durationFormatted ? ` · ${escapeHtml(v.durationFormatted)}` : '';
    return `<li>
        ${thumb}
        <div class="info">
          ${link}
          <div class="meta">${escapeHtml(v.channelName)}${duration}</div>
        </div>
      </li>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FoldTube Backup — ${escapeHtml(date)}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #f1f1f1; padding: 2rem; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  p.sub { color: #aaa; font-size: 0.9rem; margin-top: 0; margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
  img { width: 120px; border-radius: 4px; flex-shrink: 0; }
  .info a, .info .title { color: #3ea6ff; text-decoration: none; font-weight: 600; }
  .info a:hover { text-decoration: underline; }
  .meta { color: #aaa; font-size: 0.85rem; margin-top: 4px; }
</style></head><body>
<h1>FoldTube Backup</h1>
<p class="sub">${videos.length} saved tabs · Exported ${escapeHtml(exportedAt)}</p>
<ul>${items.join('')}</ul></body></html>`;
}
