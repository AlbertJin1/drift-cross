# Drift

A fast, lightweight browser for **Windows, macOS and Linux**, built on Electron with a local HTML/CSS/JS interface. No framework, no runtime CDN, no account.

**Version 1.3.0** · MIT licensed · Node.js 20+ to build

---

## Contents

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Getting started](#getting-started)
- [Building installers](#building-installers)
- [Extensions](#extensions)
- [Project layout](#project-layout)
- [Design notes](#design-notes)
- [License](#license)

## Features

### Browsing

- **One clean tab strip** with favicons, loading indicators, close buttons and a new-tab (+) button beside the last tab. Tabs open and close with animation and the strip stays steady while you close several in a row (see [Design notes](#design-notes)).
- **Live address bar** driven by the active page, so redirects, in-page navigation and tab switches stay in sync. Accepts URLs, local addresses and searches (DuckDuckGo, Google, Bing or Brave). A lock replaces the globe on HTTPS pages.
- **Command palette** (`Ctrl/Cmd+K`) for open tabs, bookmarks, history, URLs and commands.
- **Find in page** with match count, next/previous and case matching, plus **reader mode**.
- **Context menus** for tabs, bookmarks, links, images, selected text, editable fields and pages. Tab menus include duplicate, reload, close, close others and close to the right.
- **Reopen closed tabs** (the last 25) and middle-click to close.

### Your data

- **Bookmarks** with a quick-access bar, star/unstar, folders, rename, edit URL and remove.
- **History** that persists between sessions, with search and per-item removal.
- **Downloads manager** with progress, pause/resume/cancel, open file, show in folder and a configurable save location.
- **Clear browsing data** with basic and advanced modes and a time range.

### Privacy

- **Ad and tracker blocking** at the network-request layer, with a global switch, session counters, a most-blocked host list and per-site exceptions.

### Customisation

- **Appearance:** light, dark or system (follows the OS live and drives `prefers-color-scheme`, so sites that support dark mode follow it).
- **Eight accent themes:** Violet, Ocean, Forest, Rose, Sunset, Indigo, Graphite and Mint, each tuned for light and dark, and mirrored on the new-tab page.
- **Pinned tools:** pin any item from the ⋯ menu (Bookmarks, History, Downloads, Extensions, Privacy, Find, Reader, Command palette, Print, Developer tools, Settings and more) next to the address bar. Drag to reorder in the toolbar or in *Settings > Appearance > Pinned tools* (or `Alt`+arrow keys). The list is saved in `settings.json`.
- **Reliable saving:** every setting is written to disk the moment it changes (temp file, flush, atomic swap, with a `.bak` copy that is used automatically if the file is ever damaged) and flushed again on quit.
- **Startup:** a fresh install opens the New Tab page (the default); you can instead continue where you left off, open up to 12 specific pages (with a *Use open tabs* shortcut), or open your home page. Also: optional Home button, window size on startup (default, maximized or remembered), and launch at login (Windows/macOS, packaged builds).
- **New tab:** open the New Tab page, your home page or a blank page; show most-visited sites or recent bookmarks (or neither); toggle the clock.
- **New Tab page:** time-aware greeting, search box with engine switcher and live suggestions, a shortcut grid with pinnable custom shortcuts, and keyboard hints. Start typing anywhere to search.
- **Settings** has General, Appearance, Search, Privacy & Security, Downloads and About sections. Changes save automatically.

### Performance

- Lazy tab creation, idle-tab discarding and background timer throttling.
- Debounced chrome updates, and session restore that does not eagerly load every saved page.
- Manager data (bookmarks, history, downloads, extensions) is sent over IPC only while its page is open.
- Per-user Windows installer: no administrator rights needed.

## Keyboard shortcuts

Shortcuts work from every surface: page, address bar, palette and internal pages. On macOS use `Cmd` in place of `Ctrl`.

| Area | Action | Shortcut |
|---|---|---|
| **Tabs** | New / close tab | `Ctrl+T` / `Ctrl+W` |
| | Reopen closed tab | `Ctrl+Shift+T` |
| | Next / previous tab | `Ctrl+Tab`, `Ctrl+PageDown` / `Ctrl+Shift+Tab`, `Ctrl+PageUp` |
| | Jump to tab 1–8 / last tab | `Ctrl+1…8` / `Ctrl+9` |
| | Close window | `Ctrl+Shift+W` |
| **Navigation** | Address bar | `Ctrl+L`, `Alt+D`, `F6` |
| | Back / forward / home | `Alt+←` / `Alt+→` / `Alt+Home` (`Cmd+[` / `Cmd+]` on Mac) |
| | Reload / hard reload | `Ctrl+R`, `F5` / `Ctrl+F5`, `Shift+F5` |
| | Command palette | `Ctrl+K` |
| **Page** | Find / next / previous | `Ctrl+F` / `Ctrl+G` / `Ctrl+Shift+G` |
| | Zoom in / out / reset | `Ctrl+=` or `+` / `Ctrl+-` / `Ctrl+0` (also `Ctrl` + mouse wheel) |
| | Reader mode | `Ctrl+Shift+R` |
| | Print | `Ctrl+P` |
| | Full screen | `F11` |
| **Manage** | Bookmark page | `Ctrl+D` |
| | Bookmarks manager | `Ctrl+Shift+B` (or `O`) |
| | History / clear browsing data | `Ctrl+H` / `Ctrl+Shift+Delete` |
| | Downloads | `Ctrl+J` |
| | Extensions | `Ctrl+Shift+E` |
| | Settings | `Ctrl+,` |
| | Toggle ad blocker | `Ctrl+Shift+A` |
| | Developer tools | `F12`, `Ctrl+Shift+I` |

Drift is a single-window browser, so there are no *New window* or *Incognito* shortcuts.

## Getting started

```sh
npm install
npm start
```

`npm start` launches Electron directly and skips CSS compilation to keep startup fast. After changing Tailwind classes, rebuild the stylesheet:

```sh
npm run css:build
```

After changing the icon set in `scripts/build_icons.cjs`, regenerate the icon file (needs `npm install` first):

```sh
npm run icons:build
```

The generated CSS ships inside the app, so nothing is fetched at runtime. The publish scripts run this step for you.

## Building installers

Build each target on its own operating system.

| Platform | Command | Output |
|---|---|---|
| Windows | `build_publish.bat` or `scripts\build_publish.bat` | `dist/Drift-Setup.exe` and `publish/` (branded NSIS installer; current-user default) |
| macOS | `./scripts/build_publish.sh` | `.dmg` |
| Linux | `./scripts/build_publish.sh` | `.AppImage` |

**Windows install model.** Drift uses a branded, multi-step NSIS installer rather than a portable self-extracting executable. The installer presents Drift artwork and welcome/uninstall pages, allows the app installation folder to be changed, creates Start menu and desktop shortcuts, and defaults to the current Windows user without requesting administrator access (an administrator can choose an all-users install). Program files go to `%LOCALAPPDATA%\Programs\Drift` by default; your profile (settings, bookmarks, history, session and extensions) lives separately in `%APPDATA%\Drift` and is preserved when the app is uninstalled. The `publish/` folder contains the installer, a SHA-256 checksum, release manifest and installation notes.

App icons for every platform (`.ico`, `.icns`, `.png` and the `.svg` source) are in `build/`.

## Extensions

Drift runs Chrome extensions through Chromium:

- **Chrome Web Store.** Open *Extensions* (`Ctrl/Cmd+Shift+E`), paste a store link or the 32-letter extension ID, and choose *Add from Chrome Web Store*. You can also browse chromewebstore.google.com in a tab and click *Add to Chrome*. A confirmation dialog lists what the extension can access, only Manifest V3 extensions are accepted from the store, and installed extensions update automatically. Powered by [`electron-chrome-web-store`](https://www.npmjs.com/package/electron-chrome-web-store) (MIT).
- **Unpacked folders.** *Install unpacked* copies a folder containing `manifest.json` (Manifest V2 or V3) into your Drift profile, so it no longer depends on the original folder.

Electron implements only a subset of the Chrome Extensions API, so compatibility depends on which APIs an extension uses. See the [Electron extension API docs](https://www.electronjs.org/docs/latest/api/extensions-api). Extensions are stored in `Extensions/` (unpacked) and `ChromeWebStore/` (store installs) inside the Drift profile directory.

## Project layout

```text
package.json, tailwind.config.cjs, LICENSE, README.md
build/                       app icons (icon.ico / .icns / .png / .svg)
scripts/
  build_publish.bat          Root-level Windows installer entry point
  build/installer.nsh        Drift-specific NSIS page and install-mode customizations
  build/installer-*.bmp      Original Drift installer artwork
  scripts/build_publish.bat  Windows x64 build and publish pipeline
  build_publish.sh           macOS / Linux build
  build_icons.cjs            generates shared/icons.js from Font Awesome (react-icons/fa6)
src/
  main/
    main.js                  browser core: profile, tabs, downloads, request blocking, settings, IPC
    shortcuts.js             shortcut table, handled on every surface
    extensions.js            Chrome Web Store + unpacked extension manager
    extension-info.js        names, icons and readable permissions for the Add extension dialog
  preload/
    preload.js               allow-listed renderer <-> main IPC bridge
  renderer/
    browser/                 index.html + ui.js: tab strip, address bar, settings and manager pages
    newtab/                  start page
    palette/                 command palette
    shared/                  style.css, icons.js (generated), Tailwind entry and output, assets/
```

## Design notes

### Tab strip

Every tab shares one width, `--tab-w`, which `ui.js` computes from the space actually left on the row after the brand, new-tab button and window controls. Because the width is an explicit value, CSS can animate it:

- **Opening** a tab grows it in from zero while its neighbours glide to their new width.
- **Closing** a tab folds it away in place before it is removed from the DOM.
- **Closing with the mouse** holds the remaining tabs at their current width until the pointer leaves the strip, so the next close button stays under your cursor (the same behaviour as Chrome). Keyboard closes reflow immediately.
- **Crowded strips** shrink tabs to a minimum width, then scroll; the active tab is scrolled into view.
- **Window resizes** skip the animation so widths track the window without lag.

### Motion and icons

- Easing curves and durations are shared tokens (`--ease-out`, `--ease-in-out`, `--ease-spring`, `--dur-*`) at the bottom of `style.css`.
- Toolbar icons respond on hover and press: the reload arrow turns (and spins while a page loads), back/forward nudge, the star pops when you bookmark, and the gear rotates.
- **Icons are Font Awesome Free 6**, taken from [`react-icons`](https://react-icons.github.io/react-icons/) (`react-icons/fa6`). Drift has no React, so `scripts/build_icons.cjs` uses `react-icons` at development time to render each glyph to SVG and writes `src/renderer/shared/icons.js`. That file is committed, so running and packaging the app need no build step.
- In markup, write `<svg data-fa="gear"></svg>` (or call `fa('gear')` in script). `icons.js` fills the placeholder, including for UI rendered later, and glyphs use `currentColor`, so they follow every theme.
- Everything respects the operating system's *reduce motion* setting.

### Ad blocker

The blocker uses a bundled list of known advertising and analytics hosts, and can be paused globally or per site. Blocking can break some site widgets; use the per-site exception in the protection panel.

## License

Drift is [MIT](LICENSE) licensed. Interface icons are [Font Awesome Free](https://fontawesome.com/license/free) (icons under CC BY 4.0), delivered through `react-icons` (MIT).
