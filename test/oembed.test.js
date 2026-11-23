import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_UNAVAILABLE, MAX_LOOKUPS_PER_RUN, needsChannelLookup, videoIdsForLookup,
  oembedUrl, classifyOembedStatus, oembedPatch, applyOembedResults,
} from '../lib/oembed.js';
import { urlToVideoData, UNKNOWN_CHANNEL, UNKNOWN_TITLE } from '../lib/youtube.js';

const unknown = (videoId, extra) => ({ ...urlToVideoData(`https://www.youtube.com/watch?v=${videoId}`, `Tab ${videoId}`), ...extra });
const known = (videoId) => ({ videoId, channelName: 'Some Channel', title: 'Real' });

const response = {
  title: 'Never Gonna Give You Up',
  author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/@RickAstleyYT',
  type: 'video',
};

describe('choosing videos to look up', () => {
  test('unknown channel, not yet marked unavailable', () => {
    assert.equal(needsChannelLookup(unknown('a')), true);
    assert.equal(needsChannelLookup({ videoId: 'a', channelName: '' }), true);
    assert.equal(needsChannelLookup(known('a')), false);
    assert.equal(needsChannelLookup(unknown('a', { channelLookup: CHANNEL_UNAVAILABLE })), false);
  });

  test('covers window-close, url-only and discarded saves', () => {
    for (const metadataSource of ['auto-collapsed', 'url-only', 'discarded']) {
      assert.equal(needsChannelLookup(unknown('a', { metadataSource })), true, metadataSource);
    }
  });

  test('newest first, no repeats, capped per run', () => {
    const videos = [unknown('a'), known('b'), unknown('c'), unknown('a')];
    assert.deepEqual(videoIdsForLookup(videos), ['a', 'c']);

    const backlog = Array.from({ length: 200 }, (_, i) => unknown(`v${i}`));
    const ids = videoIdsForLookup(backlog);
    assert.equal(ids.length, MAX_LOOKUPS_PER_RUN);
    assert.equal(ids[0], 'v0');
  });
});

describe('oEmbed request and response', () => {
  test('request URL asks for the watch page, encoded', () => {
    const url = new URL(oembedUrl('dQw4w9WgXcQ'));
    assert.equal(url.origin + url.pathname, 'https://www.youtube.com/oembed');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('status: success, never-retry, and try-later', () => {
    assert.equal(classifyOembedStatus(200), 'ok');
    for (const s of [400, 401, 403, 404]) assert.equal(classifyOembedStatus(s), 'unavailable', String(s));
    for (const s of [429, 500, 502, 503]) assert.equal(classifyOembedStatus(s), 'retry', String(s));
  });

  test('patch sets channel name and URL', () => {
    const patch = oembedPatch(unknown('a'), response);
    assert.equal(patch.channelName, 'Rick Astley');
    assert.equal(patch.channelUrl, 'https://www.youtube.com/@RickAstleyYT');
  });

  test('title replaced only when the stored one is a fallback', () => {
    assert.equal(oembedPatch(unknown('a'), response).title, undefined, 'a real tab title is kept');
    for (const title of [UNKNOWN_TITLE, 'YouTube', '(3) Never Gonna Give You Up', '']) {
      assert.equal(oembedPatch(unknown('a', { title }), response).title, 'Never Gonna Give You Up', title);
    }
  });

  test('untrusted response: no channel → null; non-YouTube channel URL dropped', () => {
    assert.equal(oembedPatch(unknown('a'), {}), null);
    assert.equal(oembedPatch(unknown('a'), { author_name: '   ' }), null);
    assert.equal(oembedPatch(unknown('a'), null), null);
    assert.equal(oembedPatch(unknown('a'), { author_name: 42 }), null);
    const patch = oembedPatch(unknown('a'), { author_name: 'X', author_url: 'javascript:alert(1)' });
    assert.deepEqual(patch, { channelName: 'X' });
  });
});

describe('applyOembedResults', () => {
  test('fills found channels, marks permanent failures unavailable', () => {
    const videos = [unknown('a'), unknown('b'), known('c')];
    const { videos: after, result } = applyOembedResults(videos, new Map([['a', response], ['b', null]]));
    assert.equal(result.patched, 2);
    assert.equal(after[0].channelName, 'Rick Astley');
    assert.equal(after[1].channelName, UNKNOWN_CHANNEL);
    assert.equal(after[1].channelLookup, CHANNEL_UNAVAILABLE);
    assert.equal(after[2], videos[2]);
    assert.deepEqual(videoIdsForLookup(after), [], 'neither is asked about again');
  });

  test('a response without a channel also marks it unavailable', () => {
    const { videos } = applyOembedResults([unknown('a')], new Map([['a', { title: 'x' }]]));
    assert.equal(videos[0].channelLookup, CHANNEL_UNAVAILABLE);
  });

  test('deleted meanwhile, or filled in by API enrichment meanwhile: untouched', () => {
    const enriched = { ...unknown('b'), channelName: 'From API', metadataSource: 'api-enriched' };
    const videos = [enriched];
    const { videos: after } = applyOembedResults(videos, new Map([['a', response], ['b', response]]));
    assert.equal(after, videos, 'same array: no write');
  });

  test('keeps every other field and the list order', () => {
    const videos = [known('x'), unknown('a', { durationSeconds: 0, dateSaved: '2026-01-01T00:00:00.000Z' })];
    const { videos: after } = applyOembedResults(videos, new Map([['a', response]]));
    assert.deepEqual(after.map(v => v.videoId), ['x', 'a']);
    assert.equal(after[1].dateSaved, '2026-01-01T00:00:00.000Z');
    assert.equal(after[1].metadataSource, 'auto-collapsed');
  });
});
