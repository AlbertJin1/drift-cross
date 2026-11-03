# Drift

A fast, lightweight browser for **Windows, macOS and Linux**, built on Electron with a local HTML/CSS/JS interface. No framework, no runtime CDN, no account.

**Version 1.3.0** · MIT licensed · Node.js 20+ to build

---

## Contents

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Getting started](#getting-started)
- [Building installers](#building-installers)
- [Automatic updates](#automatic-updates)
- [Usage monitoring](#usage-monitoring)
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

- **Browser-session proxy tunnel.** Settings → VPN adds HTTPS proxy (TLS to the server), HTTP proxy and SOCKS5 endpoints and applies them to Drift only. Drift signs in for you, including SOCKS5 (a loopback relay does the sign-in Chromium cannot), checks the server and shows your exit address on connect, never falls back to a direct connection while connected, and restricts WebRTC to help prevent direct-address leaks. Saved passwords are encrypted with the OS (DPAPI on Windows) and never sent to the interface. Code: `src/main/vpn.js`, tests: `npm run test:vpn`.
- **VPN Gate browser-only tunnel.** Settings → VPN fetches the live VPN Gate relay list and connects supported OpenVPN profiles through Drift's bundled userspace OpenVPN + gVisor network-stack helper. It exposes a loopback-only SOCKS5 endpoint and assigns it to Drift's Electron session; it does not create a Windows TUN adapter, alter routes, require elevation, or tunnel other applications. SOCKS5 destination names are resolved through the proxy, Chromium DNS prefetch is disabled to prevent speculative local DNS lookups, and WebRTC non-proxied UDP is restricted while connected. Drift verifies the exit IP before showing Connected and keeps the browser session fail-closed if the helper unexpectedly exits. Relay compatibility is checked individually: the pinned OpenVPN implementation supports AES-GCM and AES-CBC + HMAC, optional inline `tls-auth` / `tls-crypt`, and a TLS control channel with no extra wrapper. Drift rejects BF-CBC, active compression, TAP, `tls-crypt-v2`, external key-file references and profiles that require unsupported negotiation directives or scripts rather than silently dropping those requirements. Every connection is pinned to the current server IP from VPN Gate's CSV directory, avoiding dependency on `.opengw.net` DNS. `.ovpn` export remains available. The separately built helper uses `github.com/buengese/go-openvpn` (LGPL-2.1-or-later with usage exception) and gVisor; the matching vendored source archive, licenses and version metadata are included in Windows packages. Build it with `scripts\build_vpn_helper.bat` (Go 1.25.5+; the module's declared toolchain is selected automatically), or use `build_publish.bat`, which builds the helper before packaging. The bundled helper is currently built for Windows x64; macOS/Linux builds can browse the directory and export profiles but do not expose Connect until a platform helper is supplied. Code: `src/main/vpn-gate.js`; tests: `npm run test:vpn-gate`.
- **Standalone management model.** Drift has no organization-enrollment or remote-browser-management service in this build. It does not disable or bypass Windows device controls or administrator-enforced Chromium policies.
- **Tab hover preview.** Hovering a tab shows a card with a thumbnail of the page as it currently looks (so it follows the scroll position), its title and site, and the memory its renderer is using (refreshed every 2.5 seconds while the card is open). Background tabs show the view they had when you left them; a discarded tab shows its last view dimmed and reads "Sleeping · 0 MB". When Chromium hosts several tabs in one process the figure is marked "shared process". The chrome is raised above the page only while the card is visible and never takes keyboard focus.
- **Memory-aware tab discarding.** Background tabs give their renderer process back after 5 minutes idle (2 minutes under moderate memory pressure, 1 minute under high pressure), an idle New Tab page after 45 seconds, and no more than 6 background tabs keep a renderer at once (least recently used go first). Under high pressure the heaviest idle tabs are released early. Tabs playing audio, being captured or running a download are never discarded. A discarded tab keeps its title, icon and place in the strip and reloads when selected. See [Memory management](#memory-management).
- Lazy tab creation, background timer throttling, and session restore that does not eagerly load every saved page.
- The command palette's renderer is released a minute after you close it and recreated on demand.
- Only the visible tab is resized with the window; hidden tabs are fixed up when they are selected.
- History, session and download progress are saved in coalesced, non-blocking writes (and flushed on quit) so a busy page can never stall the browser on disk I/O.
- Ad and tracker blocking uses a cached, constant-time host lookup; the blocked counter reaches the UI a few times a second at most.
- Extensions load while the window and browser chrome load, instead of before them.
- Debounced chrome updates; the toolbar only rebuilds the parts of the UI that changed.
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

## Automatic updates

Windows installs update themselves silently, using the Universal App Monitor (app id `drift`).

1. About a minute after launch, and every six hours while Drift stays open, Drift asks the monitor's public client gateway for the latest release. The request carries the app version and a random install id kept in the profile (`Updates\state.json`); nothing else. Usage monitoring (below) is separate and can be switched off.
2. A newer `Drift-Setup.exe` is downloaded in the background, rejected unless its size and SHA-256 match what the monitor announced, and parked in `%APPDATA%\Drift\Updates`.
3. When Drift closes, a hidden helper waits for the browser to exit and runs the installer silently over the existing install. The next launch is the new version.
4. If that did not happen (crash, shutdown, antivirus), the staged installer is applied at the next launch, before a window opens, and Drift reopens by itself.

Bookmarks, history and settings live in `%APPDATA%\Drift` and are never touched. Updates are skipped on macOS/Linux, in development runs, and when the install folder needs administrator rights (a silent install cannot show a UAC prompt). Turn them off in **Settings > General > Keep Drift up to date**. Progress and errors are written to `%APPDATA%\Drift\Updates\updater.log`.

- **Gateway address:** `src/main/update-config.js` (`gatewayUrl`, or the `DRIFT_UPDATE_GATEWAY` environment variable for testing).
- **Publishing:** build the installer, then upload `Drift-Setup.exe` in the monitor's Drift tab > Releases. The version must be higher than the installed one; it is read from the file, so bump `version` in `package.json` first.
- **Which installer:** both work. The NSIS installer is run with `/S`; the custom Setup build has a headless `--silent-update` mode that swaps the new files in next to the old ones and keeps the previous folder until the swap succeeds.
- **Tests:** `npm run test:updater` runs the updater against a fake gateway (no Windows needed); `npm test` runs the updater, usage-reporting, memory-policy and storage tests (`npm run test:memory`, `npm run test:storage`).

## Usage monitoring

Packaged Drift builds also tell the Universal App Monitor (app id `drift`) when the browser is open, so the **Drift** tab shows which PCs are online right now, their version and when they last reported. It uses the same public client gateway as the updater (`resource=telemetry`); the monitor's API key stays on the server.

- **`open`** a few seconds after launch (a new session), **`heartbeat`** about once a minute while Drift stays open, and **`close`** when Drift quits (capped at ~2.5 seconds so closing is never slowed). If the close is lost (crash, power cut), the monitor shows the session as ended once the heartbeats stop.
- **What is sent:** the random install id (the same one the updater uses), the Drift version, the operating-system version, the PC name, the LAN address and a random per-launch session id. **Never** the sites you visit, tabs, searches, bookmarks, history or downloads.
- **Control:** **Settings > General > Share usage status** switches it off at any time (the open session is closed immediately). Development runs (`npm start`) never report.
- **Install id:** if the monitor already knows this PC under another install id, it answers with that one and Drift adopts it, so one PC stays one install.
- **Diagnostics:** failures are written to `%APPDATA%\Drift\Updates\telemetry.log`; they never interrupt the browser.
- **Tests:** `npm run test:telemetry` runs the reporter against a fake gateway that applies the real gateway's validation (no Windows needed).

Reporting needs the monitor with `desktop_sessions` enabled for `drift` (Universal App Monitor 2.5.2 or newer) and a published Drift release that contains it (1.3.2 or newer): installed copies pick it up through the normal silent update.

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
    memory-manager.js        tab discard policy and memory-pressure measurement (pure, unit tested)
    vpn.js                   browser-session proxy profiles, proxy rules and SOCKS5 sign-in relay (unit tested)
    vpn-gate.js              VPN Gate server directory, compatibility detection, userspace OpenVPN bridge and safe profile export (unit tested)
    storage.js               durable profile reads/writes plus coalesced non-blocking saves
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
resources/vpn/               bundled browser-only OpenVPN/SOCKS5 helper, license and corresponding source archive (built on Windows)
```

## Design notes

### Memory management

`src/main/memory-manager.js` decides what to release; `main.js` runs it every 30 seconds and only measures anything when a background tab actually holds a renderer.

| Rule | Default |
|---|---|
| Idle expiry | 5 min (2 min moderate pressure, 1 min high pressure) |
| Idle New Tab page | 45 s |
| Background tabs allowed to keep a renderer | 6, least recently used released first (never one used in the last minute) |
| Early release under high pressure | the 2 heaviest tabs idle for 20 s+, per pass |
| Never discarded | the visible tab, tabs playing audio, tabs being captured, tabs with a running download |

Pressure is Drift's own footprint (private memory of all its processes) compared with 35% of installed RAM (never less than 1.5 GB); moderate starts at 70% of that budget. On Windows the system's available memory is used as well (under 20% free = moderate, under 10% = high). macOS and Linux report "free" memory without the file cache, so they use only the footprint rule. The thresholds are the `DEFAULTS` in `memory-manager.js`.

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
