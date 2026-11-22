// Pure helpers shared by the service worker and the dashboard.
// No browser APIs here, so everything can be unit-tested in Node.
//
// content/scraper.js keeps its own copies of the ID and duration logic:
// scrapeYouTubeTab is serialised by chrome.scripting.executeScript and runs
// inside the YouTube page, so it cannot import anything.

export const UNKNOWN_TITLE = 'Unknown Title';
export const UNKNOWN_CHANNEL = 'Unknown Channel';

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
  for (const video of incoming) {
    if (seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    added.push(video);
  }
  return { merged: [...added, ...saved], added };
}

/**
 * Validate a parsed FoldTube backup and return its usable entries.
 * @param {unknown} data result of JSON.parse on the backup file
 * @returns {object[]}
 * @throws {Error} if the backup is not an array, or has entries but none are valid
 */
export function validateImport(data) {
  if (!Array.isArray(data)) throw new Error('Invalid format');
  const valid = data.filter(isValidVideo);
  if (valid.length === 0 && data.length > 0) throw new Error('No valid entries');
  return valid;
}

function isValidVideo(v) {
  return Boolean(
    v && typeof v === 'object' &&
    typeof v.videoId === 'string' && v.videoId &&
    typeof v.url === 'string' && v.url &&
    typeof v.title === 'string' &&
    ['video', 'short'].includes(v.videoType)
  );
}
