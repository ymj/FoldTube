import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShortcut, describeShortcuts, parseShortcut, COMMANDS, NOT_SET } from '../lib/shortcuts.js';

describe('formatShortcut', () => {
  test('Chrome on macOS reports symbols; shown as is, in Apple order', () => {
    assert.equal(formatShortcut('⇧⌘Y', 'mac'), '⇧⌘Y');
    assert.equal(formatShortcut('⌘⇧E', 'mac'), '⇧⌘E');
    assert.equal(formatShortcut('⌃⌥⇧⌘K', 'mac'), '⌃⌥⇧⌘K');
  });

  test('Firefox on macOS: Ctrl and Command both mean ⌘, MacCtrl means ⌃', () => {
    assert.equal(formatShortcut('Ctrl+Shift+Y', 'mac'), '⇧⌘Y');
    assert.equal(formatShortcut('Command+Shift+U', 'mac'), '⇧⌘U');
    assert.equal(formatShortcut('MacCtrl+Shift+E', 'mac'), '⌃⇧E');
    assert.equal(formatShortcut('Alt+Shift+Up', 'mac'), '⌥⇧↑');
  });

  test('Windows and Linux: Ctrl+Shift+Y, modifiers in a fixed order', () => {
    assert.equal(formatShortcut('Ctrl+Shift+Y', 'win'), 'Ctrl+Shift+Y');
    assert.equal(formatShortcut('Shift+Ctrl+Y', 'linux'), 'Ctrl+Shift+Y');
    assert.equal(formatShortcut('Alt+Shift+Comma', 'win'), 'Alt+Shift+,');
    assert.equal(formatShortcut('Ctrl+Shift+Up', 'win'), 'Ctrl+Shift+Up');
  });

  test('unbound or unreadable → Not set', () => {
    for (const s of ['', '   ', undefined, null, 42, '⇧⌘', 'Hyper+Y', '+']) {
      assert.equal(formatShortcut(s, 'mac'), NOT_SET, String(s));
      assert.equal(formatShortcut(s, 'win'), NOT_SET, String(s));
    }
  });

  test('a bare key with no modifiers (Chrome media keys)', () => {
    assert.deepEqual([...parseShortcut('MediaPlayPause', false).modifiers], []);
    assert.equal(formatShortcut('MediaPlayPause', 'win'), 'MediaPlayPause');
  });
});

describe('describeShortcuts', () => {
  const chromeMac = [
    { name: '_execute_action', description: '', shortcut: '⇧⌘Y' },
    { name: 'open-dashboard', description: 'Open FoldTube dashboard without folding tabs', shortcut: '⇧⌘U' },
    { name: 'fold-current-tab', description: 'Fold current YouTube tab', shortcut: '' },
  ];

  test('every FoldTube command, in display order, with its live binding', () => {
    const rows = describeShortcuts(chromeMac, 'mac');
    assert.deepEqual(rows.map(r => r.name), COMMANDS.map(c => c.name));
    assert.deepEqual(rows.map(r => r.keys), ['⇧⌘Y', NOT_SET, '⇧⌘U']);
    assert.deepEqual(rows.map(r => r.isSet), [true, false, true]);
    assert.equal(rows[0].label, 'Fold all YouTube tabs');
  });

  test('a command the browser omits is shown as Not set; unknown commands are ignored', () => {
    const rows = describeShortcuts([{ name: 'something-else', shortcut: 'Ctrl+Q' }], 'win');
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.keys === NOT_SET));
    assert.equal(describeShortcuts(undefined, 'win').length, 3);
  });

  test('manifest commands all have a label', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(manifest.commands).sort(), COMMANDS.map(c => c.name).sort());
  });
});
