# Drift

Drift **v1.2.2** is a small, cross-platform browser for **Windows, macOS, and Linux**, built with Electron and a local HTML/CSS/JavaScript interface. Windows uses a custom frameless titlebar with native-feeling minimize, maximize/restore, and close controls. It keeps the browser chrome lightweight, restores session metadata, and opens tab contents only when needed.

## Highlights

- **A single, clean browser tab strip** with favicons, loading indicators, close controls, a nearby new-tab (+) control, with a single, focused browsing workspace.
- **Unified browser topbar** with integrated Drift branding, a draggable tab-strip area, a compact version chip, and minimize, maximize/restore, and close controls on Windows.
- **Live address bar** sourced from the active WebContents URL so redirects, in-page navigation, and tab changes keep it synchronized. Supports direct URLs, local addresses, and configurable DuckDuckGo, Google, Bing, or Brave Search in both the address bar and new-tab search.
- **Bookmarks end to end** — star/unstar pages, quick-access bookmarks bar, persistent storage, open in a new tab, rename, edit URL, and remove.
- **Built-in ad and tracker blocking** at the network-request layer, with an on/off switch, session counters, most-blocked host list, and per-site exceptions.
- **Performance-minded tab handling** — lazy tab creation, idle-tab discarding, background timer throttling, debounced chrome updates, session restore without eagerly loading every saved page, and manager datasets sent over IPC only while their respective manager page is open.
- **Per-user Windows installation** — the installer places application binaries in `%LOCALAPPDATA%\Programs\Drift` without requiring administrator rights. The browser profile, settings, bookmarks, history, session, and managed extensions live in `%APPDATA%\Drift`.
- **Downloads manager** with progress, pause/resume/cancel, open file, show in folder, and configurable save location.
- **Extensions manager** for loading/removing unpacked Chromium extension folders. Extension folders are copied into the Drift AppData profile and restored on the next launch, so they do not depend on the original extraction directory.
- **Command palette** (`Ctrl/Cmd+K`) for open tabs, bookmarks, history, URLs, and common commands.
- **Dedicated settings page** with General, Appearance, Search, Privacy & Security, Downloads, and About sections; preferences save automatically.
- **Eight selectable browser color themes** (Violet, Ocean, Forest, Rose, Sunset, Indigo, Graphite, and Mint), persisted in the AppData profile and reflected on the new-tab page.
- **Context-aware right-click menus** for tabs, bookmarks, web links, images, selected text, editable fields, and general page content. Tab menus include duplicate, reload, close, close other tabs, and close tabs to the right.
- **Polished motion and transitions** across browser tabs, controls, internal settings/manager pages, theme changes, the new-tab surface, and context menus; respects the operating system’s reduced-motion preference.
- **Find in page** with match count, next/previous navigation, and case matching; plus reader mode, persistent visit history, and light/dark appearance following the OS setting.
- **Tailwind CSS utilities** compiled locally before packaging; the bundled browser interface does not require a CSS CDN.
- Custom Drift branding, including **Windows ICO**, **macOS ICNS**, and **Linux PNG** app icons.

## Shortcuts

| Action | Shortcut |
|---|---|
| Command palette | Ctrl/Cmd + K |
| Settings | Ctrl/Cmd + , |
| New tab / Close tab | Ctrl/Cmd + T / W |
| Address bar | Ctrl/Cmd + L |
| Bookmark page | Ctrl/Cmd + D |
| Bookmarks manager | Ctrl/Cmd + Shift + B |
| History | Ctrl/Cmd + H |
| Downloads | Ctrl/Cmd + J |
| Extensions | Ctrl/Cmd + Shift + E |
| Find in page | Ctrl/Cmd + F |
| Toggle ad blocker | Ctrl/Cmd + Shift + A |
| Reload | Ctrl/Cmd + R |
| Back / Forward | Alt + Left / Right (Cmd + [ / ] on Mac) |
| Reader mode | Ctrl/Cmd + Shift + R |
| Developer tools | F12 |
| Next / Previous tab | Ctrl + Tab / Ctrl + Shift + Tab |

Middle-click a tab to close it.

## Run from source

Requires Node.js 20 or later.

```sh
npm install
npm start
```

`npm start` launches Electron directly and does not run a CSS compilation step, keeping browser opening fast. `npm run css:build` compiles Tailwind when developing the UI, and both publishing scripts compile it before packaging. The generated CSS is bundled with the app, so the browser has no runtime dependency on a CDN.

## Build release packages

Build each target on its corresponding operating system:

- **Windows:** run `build_publish.bat` — outputs `dist/Drift-Setup.exe`, a per-user installer.
- **macOS / Linux:** run `./build_publish.sh` — outputs a `.dmg` or `.AppImage`.

The project includes custom source and platform-specific icons in `build/`.

The Windows installer is intentionally not a portable self-extracting executable: portable executables unpack their application bundle into a temporary runtime directory. Drift now uses a per-user NSIS installer instead, so the installed program files remain in the user’s AppData tree while personal browser data is kept in the Roaming profile directory.

## Project layout

```text
main.js                 browser core, AppData profile initialization, tabs, downloads, managed extensions, request blocking and preferences
preload.js              allow-listed renderer/main IPC bridge
ui/index.html           unified tab strip, address bar, internal settings/managers, find bar, and privacy dialog
ui/ui.js                tab strip, settings, bookmarks, history, downloads, extensions, find-in-page, and protection UI
ui/style.css            color themes, transitions, context menus, and component styling
ui/tailwind.css         Tailwind build entry point
ui/tailwind.generated.css compiled utility CSS (rebuilt by npm scripts)
ui/palette.*            command palette
ui/newtab.html          local start page
build/icon.*            custom platform app icons
```

## Extensions note

Electron supports only a subset of the Chrome Extensions API. Drift loads unpacked extension folders that contain `manifest.json`; Chrome Web Store installation and automatic extension updates are not provided by this build. Extension compatibility depends on the APIs used by each extension. See the [Electron extension API documentation](https://www.electronjs.org/docs/latest/api/extensions-api).

## Notes

The ad blocker uses a bundled list of known advertising and analytics hosts and can be paused globally or for an individual site. Blocking can affect some site widgets; a per-site exception is available in the protection panel.

## License

MIT
