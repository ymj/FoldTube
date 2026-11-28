import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeYouTubeTab, readYouTubePlayer } from '../content/scraper.js';

// Both functions run inside a YouTube page; here the page is a stand-in:
// a location, a title, and elements found by exact selector.
function page({ url, title = '', elements = {}, initial } = {}) {
  const u = new URL(url);
  globalThis.window = { location: { pathname: u.pathname, search: u.search, href: url } };
  globalThis.document = {
    title,
    querySelector: (sel) => elements[sel] ?? null,
  };
  if (initial) globalThis.ytInitialPlayerResponse = initial;
}
const text = (t) => ({ textContent: t });
const meta = (content) => ({ getAttribute: () => content });

describe('scrapeYouTubeTab', () => {
  afterEach(() => { delete globalThis.window; delete globalThis.document; });

  test('a Short with a trailing slash still has its ID', () => {
    page({ url: 'https://www.youtube.com/shorts/abc123/', title: 'A Short - YouTube' });
    const v = scrapeYouTubeTab();
    assert.equal(v.videoId, 'abc123');
    assert.equal(v.videoType, 'short');
  });

  test("the current watch page heading is the title", () => {
    page({ url: 'https://www.youtube.com/watch?v=abc', title: '(3) Old - YouTube', elements: { 'ytd-watch-metadata h1': text(' Real title ') } });
    assert.equal(scrapeYouTubeTab().title, 'Real title');
  });

  test("from the tab title, YouTube's unread count is dropped", () => {
    page({ url: 'https://www.youtube.com/watch?v=abc', title: '(3) Cooking pasta - YouTube' });
    assert.equal(scrapeYouTubeTab().title, 'Cooking pasta');
    page({ url: 'https://www.youtube.com/watch?v=abc', title: '(99+) Cooking pasta - YouTube' });
    assert.equal(scrapeYouTubeTab().title, 'Cooking pasta');
  });

  test("a Short's title comes from the active Short only", () => {
    page({
      url: 'https://www.youtube.com/shorts/abc',
      title: 'Fallback - YouTube',
      elements: { 'ytd-reel-video-renderer[is-active] h2.title': text('Active one') },
    });
    assert.equal(scrapeYouTubeTab().title, 'Active one');
  });

  test('the duration meta tag counts only when it names this video', () => {
    const elements = { 'meta[itemprop="duration"]': meta('PT4M5S'), 'meta[itemprop="identifier"], meta[itemprop="videoId"]': meta('old') };
    page({ url: 'https://www.youtube.com/watch?v=new', elements });
    assert.equal(scrapeYouTubeTab().durationSeconds, 0, 'left over from the video before');
    elements['meta[itemprop="identifier"], meta[itemprop="videoId"]'] = meta('new');
    page({ url: 'https://www.youtube.com/watch?v=new', elements });
    assert.equal(scrapeYouTubeTab().durationSeconds, 245);
  });

  test("the fallback channel link is the author's, not the video's", () => {
    const author = { querySelector: (sel) => ({ 'link[itemprop="name"]': meta('Amy'), 'link[itemprop="url"]': meta('https://www.youtube.com/@amy') })[sel] };
    page({ url: 'https://www.youtube.com/watch?v=abc', elements: { '[itemprop="author"]': author, 'link[itemprop="url"]': meta('https://www.youtube.com/watch?v=abc') } });
    const v = scrapeYouTubeTab();
    assert.equal(v.channelName, 'Amy');
    assert.equal(v.channelUrl, 'https://www.youtube.com/@amy');
  });
});

describe('readYouTubePlayer', () => {
  beforeEach(() => { delete globalThis.ytInitialPlayerResponse; });
  afterEach(() => { delete globalThis.window; delete globalThis.document; delete globalThis.ytInitialPlayerResponse; });

  const player = ({ id, response, length = 0, ad = false } = {}) => ({
    getVideoData: () => ({ video_id: id }),
    getPlayerResponse: response === undefined ? undefined : () => response,
    getDuration: () => length,
    getCurrentTime: () => 12,
    classList: { contains: (c) => c === 'ad-showing' && ad },
  });
  const details = (videoId, lengthSeconds) => ({ videoDetails: { videoId, lengthSeconds: String(lengthSeconds) } });

  test("after moving to another video, the first video's length isn't used", () => {
    page({ url: 'https://www.youtube.com/watch?v=B', initial: details('A', 600), elements: { '#movie_player': player({ id: 'B', length: 90 }) } });
    assert.equal(readYouTubePlayer().duration, 90);
  });

  test("the player's own response wins, when it's this video", () => {
    page({ url: 'https://www.youtube.com/watch?v=B', initial: details('A', 600), elements: { '#movie_player': player({ id: 'B', response: details('B', 321), length: 15 }) } });
    assert.equal(readYouTubePlayer().duration, 321);
  });

  test('the first video of a tab: the initial response is used', () => {
    page({ url: 'https://www.youtube.com/watch?v=A', initial: details('A', 600), elements: { '#movie_player': player({ id: 'A', length: 15, ad: true }) } });
    assert.equal(readYouTubePlayer().duration, 600);
  });

  test("during an ad, the player's length (the ad's) isn't used", () => {
    page({ url: 'https://www.youtube.com/watch?v=B', initial: details('A', 600), elements: { '#movie_player': player({ id: 'B', length: 15, ad: true }) } });
    const r = readYouTubePlayer();
    assert.equal(r.duration, 0);
    assert.equal(r.adShowing, true);
  });
});
