import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  menuItems, videoUrlFromLink, linkToVideo, MENU_FOLD_TAB, MENU_SAVE_LINK, VIDEO_LINK_PATTERNS,
} from '../lib/contextmenu.js';
import { YOUTUBE_TAB_PATTERNS, UNKNOWN_TITLE, UNKNOWN_CHANNEL } from '../lib/youtube.js';
import { needsChannelLookup } from '../lib/oembed.js';
import { applyVideoOp } from '../lib/store.js';

describe('menu items', () => {
  test('page menu only on video pages, link menu only on video links', () => {
    const [page, link] = menuItems();
    assert.equal(page.id, MENU_FOLD_TAB);
    assert.deepEqual(page.contexts, ['page']);
    assert.deepEqual(page.documentUrlPatterns, YOUTUBE_TAB_PATTERNS);
    assert.equal(link.id, MENU_SAVE_LINK);
    assert.deepEqual(link.contexts, ['link']);
    assert.deepEqual(link.targetUrlPatterns, VIDEO_LINK_PATTERNS);
    assert.ok(VIDEO_LINK_PATTERNS.includes('*://youtu.be/*'));
  });

  test('manifest asks for contextMenus', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest.permissions.includes('contextMenus'));
  });
});

describe('videoUrlFromLink', () => {
  test('watch, Shorts, live and youtu.be links → a clean URL', () => {
    const cases = {
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2&pp=abc': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'http://youtube.com/watch?v=dQw4w9WgXcQ': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/abc123XYZ_-': 'https://www.youtube.com/shorts/abc123XYZ_-',
      'https://www.youtube.com/live/liveID12345?si=x': 'https://www.youtube.com/watch?v=liveID12345',
      'https://youtu.be/dQw4w9WgXcQ?si=tracking&t=42': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    };
    for (const [link, expected] of Object.entries(cases)) assert.equal(videoUrlFromLink(link), expected, link);
  });

  test('anything else → null', () => {
    for (const link of [
      'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/watch',
      'https://www.youtube.com/playlist?list=PL1', 'https://youtu.be/', 'https://youtu.be/bad%20id',
      'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)', 'https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ', 'not a url', undefined,
    ]) {
      assert.equal(videoUrlFromLink(link), null, String(link));
    }
  });
});

describe('linkToVideo', () => {
  test('a URL-only record that the channel lookup picks up', () => {
    const now = new Date('2026-11-23T10:00:00.000Z');
    const video = linkToVideo('https://youtu.be/dQw4w9WgXcQ', now);
    assert.equal(video.videoId, 'dQw4w9WgXcQ');
    assert.equal(video.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(video.title, UNKNOWN_TITLE);
    assert.equal(video.channelName, UNKNOWN_CHANNEL);
    assert.equal(video.metadataSource, 'url-only');
    assert.equal(video.dateSaved, now.toISOString());
    assert.equal(video.pendingRestoreCheck, undefined, 'not tied to a closing tab');
    assert.equal(needsChannelLookup(video), true);
    assert.equal(linkToVideo('https://www.youtube.com/'), null);
  });

  test('a video already saved is not added twice', () => {
    const saved = [linkToVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')];
    const { videos, result } = applyVideoOp(saved, { type: 'add', videos: [linkToVideo('https://youtu.be/dQw4w9WgXcQ')] });
    assert.equal(result.added, 0);
    assert.equal(videos, saved);
  });
});
