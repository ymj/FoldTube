// Keyboard shortcuts as the user has them bound, formatted for their OS.
// Shared by Settings, the empty state and the welcome page.
//
// Browsers report bindings differently:
//   Chrome on macOS   "⇧⌘Y"            (symbols, no separators)
//   Chrome elsewhere  "Ctrl+Shift+Y"
//   Firefox           "Ctrl+Shift+Y"   (on macOS, Ctrl means ⌘; MacCtrl means ⌃)
//                     "Command+Shift+U"
//   unbound           ""
//
// This file is pure: callers pass in the result of chrome.commands.getAll()
// and the OS from chrome.runtime.getPlatformInfo().

/** FoldTube's commands, in display order, with the label shown to the user. */
export const COMMANDS = [
  { name: '_execute_action', label: 'Fold all YouTube tabs' },
  { name: 'fold-current-tab', label: 'Fold the current tab' },
  { name: 'open-dashboard', label: 'Open the dashboard' },
];

export const NOT_SET = 'Not set';

const MAC_SYMBOLS = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const MAC_ORDER = ['ctrl', 'alt', 'shift', 'cmd']; // Apple's order: ⌃⌥⇧⌘
const OTHER_NAMES = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Meta' };
const OTHER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];

const MAC_KEYS = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
const KEY_NAMES = { Comma: ',', Period: '.', Space: 'Space' };

/**
 * Split a reported binding into modifiers and the key.
 * @param {string} shortcut
 * @param {boolean} isMac
 * @returns {{ modifiers: Set<string>, key: string } | null}
 */
export function parseShortcut(shortcut, isMac) {
  if (typeof shortcut !== 'string' || !shortcut.trim()) return null;
  const modifiers = new Set();
  let key;

  if (shortcut.includes('+')) {
    const parts = shortcut.split('+').map(p => p.trim()).filter(Boolean);
    key = parts.pop() || '';
    for (const part of parts) {
      switch (part.toLowerCase()) {
        case 'ctrl': case 'control': modifiers.add(isMac ? 'cmd' : 'ctrl'); break;
        case 'macctrl': modifiers.add('ctrl'); break;
        case 'alt': case 'option': modifiers.add('alt'); break;
        case 'shift': modifiers.add('shift'); break;
        case 'command': case 'cmd': case 'meta': modifiers.add('cmd'); break;
        default: return null;
      }
    }
  } else {
    // macOS symbol form: modifier symbols, then the key.
    const bySymbol = { '⌃': 'ctrl', '⌥': 'alt', '⇧': 'shift', '⌘': 'cmd' };
    let i = 0;
    for (const ch of shortcut) {
      if (!bySymbol[ch]) break;
      modifiers.add(bySymbol[ch]);
      i += ch.length;
    }
    key = shortcut.slice(i).trim();
  }

  return key ? { modifiers, key } : null;
}

/**
 * The binding as the user should read it, e.g. "⇧⌘Y" on macOS or
 * "Ctrl+Shift+Y" elsewhere. Unbound or unreadable → "Not set".
 * @param {string} shortcut as reported by chrome.commands.getAll()
 * @param {string} os chrome.runtime.PlatformOs, e.g. 'mac', 'win', 'linux'
 * @returns {string}
 */
export function formatShortcut(shortcut, os) {
  const isMac = os === 'mac';
  const parsed = parseShortcut(shortcut, isMac);
  if (!parsed) return NOT_SET;
  const { modifiers, key } = parsed;
  if (isMac) {
    const mods = MAC_ORDER.filter(m => modifiers.has(m)).map(m => MAC_SYMBOLS[m]).join('');
    return mods + (MAC_KEYS[key] || KEY_NAMES[key] || key);
  }
  const mods = OTHER_ORDER.filter(m => modifiers.has(m)).map(m => OTHER_NAMES[m]);
  return [...mods, KEY_NAMES[key] || key].join('+');
}

/**
 * FoldTube's commands with their current bindings, in display order.
 * @param {{ name?: string, shortcut?: string }[]} commands from chrome.commands.getAll()
 * @param {string} os
 * @returns {{ name: string, label: string, keys: string, isSet: boolean }[]}
 */
export function describeShortcuts(commands, os) {
  const byName = new Map((Array.isArray(commands) ? commands : []).map(c => [c?.name, c]));
  return COMMANDS.map(({ name, label }) => {
    const keys = formatShortcut(byName.get(name)?.shortcut, os);
    return { name, label, keys, isSet: keys !== NOT_SET };
  });
}
