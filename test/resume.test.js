import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeParam, timestampFromUrl, resumeSeconds, openUrlFor, positionFromPlayer,
  urlToVideoData, sanitizeImportedVideo, buildHtmlExport, RESUME_MIN_SECONDS,
} from '../lib/youtube.js';
import { applyVideoOp } from '../lib/store.js';

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

describe('reading t from a URL', () => {
  test('every form YouTube uses', () => {
    const cases = { '90': 90, '90s': 90, '1m30s': 90, '1m': 60, '2h': 7200, '1h2m3s': 3723, '0': 0, ' 45s ': 45 };
    for (const [value, seconds] of Object.entries(cases)) assert.equal(parseTimeParam(value), seconds, value);
  });

  test('anything else → 0', () => {
    for (const value of ['', 's', 'abc', '1:30', '-5', '1.5', 'm30', undefined, null, 90]) {
      assert.equal(parseTimeParam(value), 0, String(value));
    }
  });

  test('from a watch URL; Shorts and /live/ always 0', () => {
    assert.equal(timestampFromUrl(`${WATCH}&t=1m30s`), 90);
    assert.equal(timestampFromUrl(`${WATCH}&list=PL1&t=754`), 754);
    assert.equal(timestampFromUrl(WATCH), 0);
    assert.equal(timestampFromUrl('https://www.youtube.com/shorts/abc123?t=30'), 0);
    assert.equal(timestampFromUrl('https://www.youtube.com/live/xyz789?t=300'), 0);
    assert.equal(timestampFromUrl('not a url'), 0);
  });

  test('sleeping tabs and auto-collapse take it from the URL', () => {
    assert.equal(urlToVideoData(`${WATCH}&t=125`, 'A').timestampSeconds, 125);
    assert.equal(urlToVideoData(WATCH, 'A').timestampSeconds, 0);
  });
});

describe('position from the player at fold time', () => {
  const video = { url: WATCH, videoType: 'video' };
  const at = (seconds, source) => ({ seconds, source });

  test('floored to whole seconds', () => {
    assert.deepEqual(positionFromPlayer(video, { position: 754.9 }), at(754, 'player'));
    assert.deepEqual(positionFromPlayer(video, { position: 0 }), at(0, 'player'));
  });

  test('Shorts and live streams store 0', () => {
    assert.equal(positionFromPlayer({ url: 'https://www.youtube.com/shorts/abc', videoType: 'short' }, { position: 40 }).seconds, 0);
    assert.equal(positionFromPlayer(video, { position: 900, isLive: true }).seconds, 0);
  });

  test('during an ad, or with no player, the URL is used', () => {
    const withT = { url: `${WATCH}&t=300`, videoType: 'video' };
    assert.deepEqual(positionFromPlayer(withT, { position: 12, adShowing: true }), at(300, 'url'));
    assert.deepEqual(positionFromPlayer(withT, null), at(300, 'url'));
    assert.deepEqual(positionFromPlayer(withT, { position: null }), at(300, 'url'));
    assert.deepEqual(positionFromPlayer(video, { position: 5, adShowing: true }), at(0, 'url'));
  });
});

describe('where a saved video opens', () => {
  test(`positions under ${RESUME_MIN_SECONDS}s open from the start`, () => {
    assert.equal(resumeSeconds({ videoType: 'video', timestampSeconds: 59 }), 0);
    assert.equal(resumeSeconds({ videoType: 'video', timestampSeconds: 60 }), 60);
    assert.equal(resumeSeconds({ videoType: 'video', timestampSeconds: 3599.7 }), 3599);
    assert.equal(resumeSeconds({ videoType: 'video' }), 0, 'saved before this feature');
    assert.equal(resumeSeconds({ videoType: 'short', timestampSeconds: 300 }), 0);
  });

  test('t is set, replaced or removed', () => {
    assert.equal(openUrlFor({ url: WATCH, videoType: 'video', timestampSeconds: 754 }), `${WATCH}&t=754s`);
    assert.equal(openUrlFor({ url: `${WATCH}&t=90&list=PL1`, videoType: 'video', timestampSeconds: 754 }), `${WATCH}&list=PL1&t=754s`);
    assert.equal(openUrlFor({ url: `${WATCH}&t=90`, videoType: 'video', timestampSeconds: 30 }), WATCH);
    assert.equal(openUrlFor({ url: WATCH, videoType: 'video' }), WATCH);
  });

  test('Shorts and other URLs open as saved', () => {
    const short = 'https://www.youtube.com/shorts/abc123';
    assert.equal(openUrlFor({ url: short, videoType: 'short', timestampSeconds: 300 }), short);
    const live = 'https://www.youtube.com/live/xyz789';
    assert.equal(openUrlFor({ url: live, videoType: 'video', timestampSeconds: 300 }), live);
    assert.equal(openUrlFor({ url: 'not a url', timestampSeconds: 300 }), 'not a url');
  });

  test('the HTML export links to the resume position', () => {
    const html = buildHtmlExport([{ videoId: 'dQw4w9WgXcQ', url: WATCH, videoType: 'video', title: 'A', channelName: 'C', timestampSeconds: 120 }], { date: 'd', exportedAt: 'e' });
    assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=120s"/);
  });
});

describe('folding a video that is already saved', () => {
  const saved = (t) => ({ videoId: 'a', url: WATCH, videoType: 'video', timestampSeconds: t, positionSource: 'player' });
  const folded = (t, source, url = WATCH) => ({ videoId: 'a', url, videoType: 'video', timestampSeconds: t, positionSource: source, metadataSource: 'scrape' });

  test('a newer position read from the player replaces the saved one, in place', () => {
    const videos = [{ videoId: 'x' }, saved(100)];
    const { videos: after, result } = applyVideoOp(videos, { type: 'add', videos: [folded(900, 'player')] });
    assert.equal(result.added, 0);
    assert.deepEqual(after.map(v => v.videoId), ['x', 'a']);
    assert.equal(after[1].timestampSeconds, 900);
  });

  test('rewound before folding: the earlier position wins, even under a minute', () => {
    assert.equal(applyVideoOp([saved(754)], { type: 'add', videos: [folded(190, 'player')] }).videos[0].timestampSeconds, 190);
    assert.equal(applyVideoOp([saved(754)], { type: 'add', videos: [folded(10, 'player')] }).videos[0].timestampSeconds, 10);
  });

  test('folded during an ad, no t in the URL: the saved position is kept', () => {
    const videos = [saved(754)];
    const { videos: after } = applyVideoOp(videos, { type: 'add', videos: [folded(0, 'url')] });
    assert.equal(after, videos, 'nothing written');
  });

  test('folded during an ad, with t in the URL: the URL position is used', () => {
    const { videos } = applyVideoOp([saved(900)], { type: 'add', videos: [folded(300, 'url', `${WATCH}&t=300s`)] });
    assert.equal(videos[0].timestampSeconds, 300);
  });

  test('a sleeping tab or link save with no t keeps the saved position', () => {
    const videos = [saved(900)];
    const urlOnly = { ...urlToVideoData(WATCH, 'A'), videoId: 'a' };
    assert.equal(applyVideoOp(videos, { type: 'add', videos: [urlOnly] }).videos, videos);
  });
});

describe('backups', () => {
  const base = { videoId: 'dQw4w9WgXcQ', url: WATCH, title: 'A', videoType: 'video' };

  test('the position is imported; older backups import as 0', () => {
    assert.equal(sanitizeImportedVideo({ ...base, timestampSeconds: 754.6 }).timestampSeconds, 754);
    assert.equal(sanitizeImportedVideo(base).timestampSeconds, 0);
    for (const bad of [-5, 'x', null, Infinity]) {
      assert.equal(sanitizeImportedVideo({ ...base, timestampSeconds: bad }).timestampSeconds, 0, String(bad));
    }
    assert.equal(sanitizeImportedVideo({ ...base, videoType: 'short', timestampSeconds: 300 }).timestampSeconds, 0);
  });
});
