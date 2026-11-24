# FoldTube — YouTube Tab Manager

> Instantly declutter your browser. Collapse all your open YouTube tabs into a clean, organized dashboard.

---

FoldTube is a powerful YouTube tab manager that helps you take back control of your browser. Instead of losing track of dozens of open YouTube tabs, fold them all into a sleek, persistent dark-mode dashboard where you can search, sort, filter, and reopen them whenever you're ready.

---

## Features

- **One-click collapse** via the toolbar icon or `Ctrl+Shift+Y` (Windows/Linux) / `Cmd+Shift+Y` (Mac)
- **Single-tab collapse** via `Ctrl+Shift+E` (Windows/Linux) / `Cmd+Shift+E` (Mac)
- **Right-click menu**: fold the YouTube video page you're on, or save a link to a YouTube video without opening it
- **Quick dashboard** without folding tabs via `Ctrl+Shift+U` (Windows/Linux) / `Cmd+Shift+U` (Mac)
- **Organized dashboard** with separate sections for Videos and Shorts
- **Pick up where you left off**: folding a video remembers how far you got, and opening it resumes from there
- **Light, Dark, and System theme** — follows your OS preference by default, or override it in Settings
- **Real-time search**, multiple sorting options, and duration filter pills
- **Bulk actions** — select, open, or remove multiple tabs at once
- **Auto-collapse on browser exit** with smart duplicate detection on restore
- **Metadata enrichment** via the YouTube Data API v3 (channel names, durations for sleeping tabs)
- **Import / Export** your library as JSON or a shareable HTML bookmark page
- **Instant Undo** for accidental deletions
- **History**: videos you open or remove stay there for 90 days, so you can put them back or delete them for good


---

## Installation

### Chrome / Brave / Edge
**Chrome Web Store:** [FoldTube - YouTube Tab Manager](https://chromewebstore.google.com/detail/phkhokoagdgofaaofmecfaibcnnahhoh)

### Firefox
**Firefox Add-ons:** [FoldTube - YouTube Tab Manager](https://addons.mozilla.org/firefox/addon/foldtube-youtube-tab-manager/)

### Manual / Developer Install

#### Chrome / Chromium-based browsers
1. Download or clone this repository
2. Open `chrome://extensions` (or `brave://extensions`) in your browser
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the root of this repository
5. Pin FoldTube to your toolbar and you're ready to go

#### Firefox
1. Download or clone this repository
2. Run `./package.sh firefox` to build the Firefox package
3. Open `about:debugging#/runtime/this-firefox`
4. Click **Load Temporary Add-on** and select the generated zip from the `dist/` folder
5. For permanent installation, install from the Mozilla Add-ons store (once published)

---

## Usage

| Action | How |
|---|---|
| Collapse all YouTube tabs | Click the FoldTube toolbar icon, or press `Ctrl+Shift+Y` (Windows/Linux) / `Cmd+Shift+Y` (Mac) |
| Collapse current YouTube tab | Press `Ctrl+Shift+E` (Windows/Linux) / `Cmd+Shift+E` (Mac) |
| Open dashboard (no fold) | Press `Ctrl+Shift+U` (Windows/Linux) / `Cmd+Shift+U` (Mac) |
| Open a saved video | Click any card on the dashboard |
| Delete a card | Click the `×` button on the card |
| Undo a deletion | Click **Undo** in the toast that appears |
| Bulk select | Click any card checkbox, then use the action bar |
| Filter by duration | Use the pill buttons above the grid |
| Settings | Click the `⚙️` icon in the top right of the dashboard |

---

## Optional: YouTube API Enrichment

By default, FoldTube extracts all metadata (title, channel, duration) directly from the page DOM. Tabs that were sleeping, discarded, or auto-collapsed on browser exit can't be read that way. For those, FoldTube asks YouTube's public oEmbed endpoint for the channel name, with no key and no cookies. Duration still needs an API key.

To enable automatic backfilling:

1. Generate a free **YouTube Data API v3** key at [console.cloud.google.com](https://console.cloud.google.com)
2. Open FoldTube Settings (`⚙️`) → **API & Enrichment**
3. Paste your key and click **Save Key**

FoldTube will automatically enrich any cards with missing data in the background. Your API key is stored only on your device and is sent only to Google's YouTube Data API.

---

## Theme

FoldTube supports three color themes, configurable under Settings (`⚙️`) → **Appearance**:

| Mode | Behaviour |
|---|---|
| **System** (default) | Automatically matches your OS light/dark preference and updates in real time |
| **Light** | Always uses the light theme, regardless of OS setting |
| **Dark** | Always uses the dark theme, regardless of OS setting |

Your preference is saved locally and applied immediately on every page load with no flash of unstyled content.

---

## Privacy Policy

*Last updated: November 24, 2026*

FoldTube is built to keep what you watch private. In short: your list stays in your browser, and FoldTube has no servers, accounts, ads, analytics, cookies or tracking. Nothing is ever sent to the developer.

### What FoldTube stores, and where

Everything FoldTube stores lives only in your browser's local storage, on your device. It's never synced, never sent to the developer, and the developer has no way to see it. This includes:

- **The videos you save:** the title, channel, length, link and thumbnail of each video, the date you saved it, and where you stopped watching.
- **Videos you open or remove:** they move to History, so you can restore them. After 90 days FoldTube deletes them.
- **Your settings:** theme, auto-collapse, and your YouTube API key if you choose to add one.
- **Your open YouTube video tabs:** a short list of the YouTube videos open in your browser, so they can still be saved if the browser quits while auto-collapse is on. A tab drops off the list when you close it or leave YouTube.

### What FoldTube sends, and to whom

FoldTube has no backend of its own. Any network requests go directly from your browser to YouTube or Google:

- **YouTube (for missing channel names):** if a saved video has no channel name (for example, it was saved from a sleeping tab or from a link), FoldTube fetches it from YouTube using only the video's ID. These requests carry no cookies and aren't linked to your YouTube or Google account.
- **Google's YouTube Data API (optional):** only if you add your own API key, FoldTube sends video IDs and your key directly to Google to fetch missing channel names and lengths. You can remove your key at any time in Settings → Advanced.

Opening a saved video loads YouTube in a normal browser tab, where YouTube's own privacy policy applies.

**No selling, sharing or other use:** your data never passes through the developer's servers, because there are none. It's never collected, sold or shared, and never used for anything outside the features described above.

### What FoldTube can access (browser permissions)

- **YouTube (youtube.com):** used only to find your open YouTube tabs, and to read a video's title, channel and length when you fold it.
- **Other websites:** only when you right-click a link to a YouTube video and choose "Save to FoldTube", to briefly show a "Saved" confirmation on that page. FoldTube reads nothing from other websites.
- **Browser storage:** used to save your video list and preferences on your device.
- **Notifications:** used only to confirm how many tabs were folded.

### Deleting your data

You're in full control of your data. Inside FoldTube you can remove videos from your list, delete them forever from History, clear all history, or remove your API key at any time. After you delete a video forever, FoldTube remembers only its ID, so it knows the video was deleted, and forgets that after 90 days. Uninstalling FoldTube erases everything it stored from your browser.

### Changes to this policy

If a future update ever changes how FoldTube handles data, for example if optional sync between devices is added, this policy will be updated beforehand, with a new date at the top.

### Contact

Questions about privacy: [hello+foldtube@osumapps.com](mailto:hello+foldtube@osumapps.com)

---

## Building Packages

FoldTube ships a single codebase that works on both Chrome and Firefox. The `package.sh` script produces browser-specific zip files ready for store submission:

```bash
./package.sh                # Build both Chrome and Firefox packages
./package.sh chrome         # Chrome only
./package.sh firefox        # Firefox only
./package.sh --output DIR   # Custom output directory (default: ./dist)
```

The script transforms the manifest per browser — Chrome gets `background.service_worker`, Firefox gets `background.scripts` — so the source `manifest.json` stays Chrome-native for local development.

## Development

Linting and tests use Node.js 22.13 or newer. These are development tools only; the extension itself still has no dependencies.

```bash
npm install     # Install ESLint (dev only)
npm run lint    # Lint all extension and test code
npm test        # Run unit tests with Node's built-in test runner
```

---

## Tech Stack

- **Manifest V3** extension — compatible with Chrome, Brave, Edge, and Firefox (142+)
- Vanilla HTML / CSS / JavaScript — zero runtime dependencies, zero frameworks
- `chrome.storage.local` for persistence
- `chrome.scripting` for DOM metadata extraction (with `world: 'MAIN'` for ad-safe duration capture)
- `chrome.contextMenus` for the page and link menus
- `chrome.tabs` events and `chrome.notifications` for tab management and user feedback, with no `tabs` permission: tab URLs and titles are read only on YouTube, through the host permission

---

## License

MIT
