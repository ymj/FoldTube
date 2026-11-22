import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('manifest is MV3 with a semver version', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('extension pages only load packaged scripts', () => {
  const csp = manifest.content_security_policy?.extension_pages ?? "script-src 'self'";
  assert.doesNotMatch(csp, /https?:/);
});

test('scraper module exports scrapeYouTubeTab', async () => {
  const { scrapeYouTubeTab } = await import('../content/scraper.js');
  assert.equal(typeof scrapeYouTubeTab, 'function');
});
