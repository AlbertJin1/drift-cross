# Drift

Drift **v1.3.0** is a small, cross-platform browser for **Windows, macOS, and Linux**, built with Electron and a local HTML/CSS/JavaScript interface. Windows uses a custom frameless titlebar with native-feeling minimize, maximize/restore, and close controls. It keeps the browser chrome lightweight, restores session metadata, and opens tab contents only when needed.

## Highlights

- **A single, clean browser tab strip** with favicons, loading indicators, close controls, a nearby new-tab (+) control, with a single, focused browsing workspace.
- **Unified browser topbar** with integrated Drift branding, a draggable tab-strip area, a compact version chip, and minimize, maximize/restore, and close controls on Windows.
- **Live address bar** sourced from the active WebContents URL so redirects, in-page navigation, and tab changes keep it synchronized. Supports direct URLs, local addresses, and configurable DuckDuckGo, Google, Bing, or Brave Search in both the address bar and new-tab search.
- **Bookmarks end to end** — star/unstar pages, quick-access bookmarks bar, persistent storage, open in a new tab, rename, edit URL, and remove.
- **Built-in ad and tracker blocking** at the network-request layer, with an on/off switch, session counters, most-blocked host list, and per-site exceptions.
- **Performance-minded tab handling** — lazy tab creation, idle-tab discarding, background timer throttling, debounced chrome updates, session restore without eagerly loading every saved page, and manager datasets sent over IPC only while their respective manager page is open.
- **Per-user Windows installation** — the installer places application binaries in `%LOCALAPPDATA%\Programs\Drift` without requiring administrator rights. The browser profile, settings, bookmarks, history, session, and managed extensions live in `%APPDATA%\Drift`.
- **Downloads manager** with progress, pause/resume/cancel, open file, show in folder, and configurable save location.
- **Chrome-compatible extensions** — install from the **Chrome Web Store** by pasting a store link or extension ID (or by clicking *Add to Chrome* on chromewebstore.google.com inside Drift), with automatic updates. Unpacked Chromium extension folders are still supported and are copied into the Drift AppData profile so they do not depend on the original folder.
- **Command palette** (`Ctrl/Cmd+K`) for open tabs, bookmarks, history, URLs, and common commands.
- **Dedicated settings page** with General, Appearance, Search, Privacy & Security, Downloads, and About sections; preferences save automatically.
- **Light, dark, or system appearance** with a visual picker. *System* follows your OS live; the choice also drives `prefers-color-scheme`, so websites that support dark mode follow it. Each of the eight accent themes has a tuned light-mode palette.
- **Eight selectable browser color themes** (Violet, Ocean, Forest, Rose, Sunset, Indigo, Graphite, and Mint), persisted in the AppData profile and reflected on the new-tab page.
- **Full startup control** (*Settings → General*): open the New Tab page, continue where you left off, open a set of specific pages (up to 12, with a *Use open tabs* shortcut), or open your home page. Also: home page + optional Home button, window size on startup (default / maximized / remember last size and position), and launch at login (Windows/macOS, packaged builds).
- **New tab options** (*Settings → New tab*): new tabs can open the New Tab page, your home page, or a blank page; shortcuts can show most-visited sites or recent bookmarks (or be hidden); the clock can be turned off.
- **Redesigned New Tab page** with a time-aware greeting, a search box with an engine switcher and live suggestions (from your shortcuts and bookmarks), a most-visited / bookmarks grid, pinnable custom shortcuts, and keyboard hints. Type anywhere on the page to start searching.
- **Context-aware right-click menus** for tabs, bookmarks, web links, images, selected text, editable fields, and general page content. Tab menus include duplicate, reload, close, close other tabs, and close tabs to the right.
- **Polished motion and transitions** across browser tabs, controls, internal settings/manager pages, theme changes, the new-tab surface, and context menus; respects the operating system’s reduced-motion preference.
- **Find in page** with match count, next/previous navigation, and case matching; plus reader mode, persistent visit history, and light/dark appearance following the OS setting.
- **Tailwind CSS utilities** compiled locally before packaging; the bundled browser interface does not require a CSS CDN.
- Custom Drift branding, including **Windows ICO**, **macOS ICNS**, and **Linux PNG** app icons.

## Shortcuts

Shortcuts work from any surface (page, address bar, command palette, internal pages). On macOS use Cmd instead of Ctrl.

| Action | Shortcut |
|---|---|
| New tab / Close tab | Ctrl + T / W |
| **Reopen closed tab** (up to 25) | Ctrl + Shift + T |
| Next / Previous tab | Ctrl + Tab, Ctrl + PageDown / Ctrl + Shift + Tab, Ctrl + PageUp |
| Jump to tab 1–8 / last tab | Ctrl + 1…8 / Ctrl + 9 |
| Close window | Ctrl + Shift + W |
| Command palette | Ctrl + K |
| Address bar | Ctrl + L, Alt + D, F6 |
| Back / Forward / Home | Alt + Left / Alt + Right / Alt + Home (Cmd + [ / ] on Mac) |
| Reload / Hard reload | Ctrl + R, F5 / Ctrl + F5, Shift + F5 |
| Find in page / Next / Previous | Ctrl + F / Ctrl + G / Ctrl + Shift + G |
| Zoom in / out / reset | Ctrl + = (or +) / Ctrl + - / Ctrl + 0 (also Ctrl + mouse wheel) |
| Print | Ctrl + P |
| Bookmark page | Ctrl + D |
| Bookmarks manager | Ctrl + Shift + B (or O) |
| History / Clear browsing data page | Ctrl + H / Ctrl + Shift + Delete |
| Downloads | Ctrl + J |
| Extensions | Ctrl + Shift + E |
| Settings | Ctrl + , |
| Reader mode | Ctrl + Shift + R |
| Toggle ad blocker | Ctrl + Shift + A |
| Developer tools | F12, Ctrl + Shift + I |
| Full screen | F11 |

Middle-click a tab to close it. Drift is a single-window browser, so New window / Incognito shortcuts are not included.

## Run from source

Requires Node.js 20 or later.

```sh
npm install
npm start
```

`npm start` launches Electron directly and does not run a CSS compilation step, keeping browser opening fast. `npm run css:build` compiles Tailwind when developing the UI, and both publishing scripts compile it before packaging. The generated CSS is bundled with the app, so the browser has no runtime dependency on a CDN.

## Build release packages

Build each target on its corresponding operating system:

- **Windows:** run `scripts\build_publish.bat` — outputs `dist/Drift-Setup.exe`, a per-user installer.
- **macOS / Linux:** run `./scripts/build_publish.sh` — outputs a `.dmg` or `.AppImage`.

The project includes custom source and platform-specific icons in `build/`.

The Windows installer is intentionally not a portable self-extracting executable: portable executables unpack their application bundle into a temporary runtime directory. Drift now uses a per-user NSIS installer instead, so the installed program files remain in the user’s AppData tree while personal browser data is kept in the Roaming profile directory.

## Project layout

```text
package.json, package-lock.json, tailwind.config.cjs, LICENSE, README.md
build/                       app icons (icon.ico / icon.icns / icon.png / icon.svg)
scripts/
  build_publish.bat          Windows per-user installer build
  build_publish.sh           macOS / Linux build
src/
  main/
    main.js                  browser core: profile init, tabs, downloads, request blocking, preferences, IPC
    shortcuts.js             keyboard shortcut table (handled on every surface)
    extensions.js            Chrome Web Store + unpacked extension manager
    extension-info.js        names, icons and readable permissions for the Add extension dialog
  preload/
    preload.js               allow-listed renderer/main IPC bridge
  renderer/
    browser/                 index.html + ui.js — tab strip, address bar, settings and manager pages
    newtab/                  local start page
    palette/                 command palette
    shared/                  style.css, Tailwind entry/output, assets/
```

## Extensions

Drift uses Chromium through Electron, so it runs Chrome extensions:

- **Chrome Web Store** — open *Extensions* (`Ctrl/Cmd+Shift+E`), paste a Web Store link or the 32-letter extension ID, and press *Add from Chrome Web Store*. You can also browse chromewebstore.google.com in a tab and use *Add to Chrome*. Installs open a themed confirmation dialog listing what the extension can access, only Manifest V3 extensions are accepted from the store, and installed extensions update automatically. Powered by [`electron-chrome-web-store`](https://www.npmjs.com/package/electron-chrome-web-store) (MIT).
- **Unpacked folders** — *Install unpacked* copies a folder containing `manifest.json` (Manifest V2 or V3) into the Drift profile.

Electron implements only a subset of the Chrome Extensions API, so compatibility depends on the APIs each extension uses. See the [Electron extension API documentation](https://www.electronjs.org/docs/latest/api/extensions-api). Profile data lives in `Extensions/` (unpacked) and `ChromeWebStore/` (store installs) under the Drift AppData directory.

## Notes

The ad blocker uses a bundled list of known advertising and analytics hosts and can be paused globally or for an individual site. Blocking can affect some site widgets; a per-site exception is available in the protection panel.

## License

MIT
