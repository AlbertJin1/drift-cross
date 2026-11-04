# Drift

Developed by **Jessie Albert Regualos** (aka **Yotsuchi**).

A lightweight desktop browser for Windows, macOS and Linux, built on Electron with a plain HTML/CSS/JS interface. No framework, no runtime CDN, no account.

MIT licensed. Node.js 20+ required to build.

## Features

- **Tabs:** animated tab strip, favicons, loading indicators, reopen closed tabs (last 25), tab hover preview with memory use.
- **Address bar:** URLs, local addresses and search (DuckDuckGo, Google, Bing, Brave). Command palette on `Ctrl/Cmd+K`.
- **Page tools:** find in page, reader mode, zoom, print, developer tools, context menus.
- **Data:** bookmarks with folders and a quick-access bar, persistent history, downloads manager, clear browsing data.
- **Privacy:** ad and tracker blocking at the request layer, with a global switch and per-site exceptions.
- **Extensions:** Chrome Web Store (Manifest V3) and unpacked extensions.
- **Customisation:** light, dark or system appearance, eight accent themes, pinnable toolbar tools, configurable startup and new-tab behaviour.
- **Performance:** idle background tabs are discarded under a memory-aware policy, tab creation is lazy, and disk writes are coalesced and atomic.

## Keyboard shortcuts

On macOS use `Cmd` in place of `Ctrl`.

| Action | Shortcut |
|---|---|
| New / close / reopen tab | `Ctrl+T` / `Ctrl+W` / `Ctrl+Shift+T` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Jump to tab 1–8 / last tab | `Ctrl+1…8` / `Ctrl+9` |
| Address bar | `Ctrl+L`, `Alt+D`, `F6` |
| Back / forward / home | `Alt+←` / `Alt+→` / `Alt+Home` |
| Reload / hard reload | `Ctrl+R`, `F5` / `Ctrl+F5` |
| Command palette | `Ctrl+K` |
| Find / next / previous | `Ctrl+F` / `Ctrl+G` / `Ctrl+Shift+G` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Reader mode | `Ctrl+Shift+R` |
| Bookmark page / manager | `Ctrl+D` / `Ctrl+Shift+B` |
| History / clear data | `Ctrl+H` / `Ctrl+Shift+Delete` |
| Downloads / extensions / settings | `Ctrl+J` / `Ctrl+Shift+E` / `Ctrl+,` |
| Toggle ad blocker | `Ctrl+Shift+A` |
| Developer tools | `F12`, `Ctrl+Shift+I` |

## Development

```sh
npm install
npm start
```

`npm start` skips CSS compilation. After changing Tailwind classes, run `npm run css:build`. After changing the icon set in `scripts/build_icons.cjs`, run `npm run icons:build`.

```sh
npm run check   # project preflight
npm test        # unit tests
```

## Building

Build each target on its own operating system.

| Platform | Command | Output |
|---|---|---|
| Windows | `build_publish.bat` | `dist-setup/Drift-Setup.exe`, `publish/` |
| macOS | `./scripts/build_publish.sh` | `.dmg` |
| Linux | `./scripts/build_publish.sh` | `.AppImage` |

On Windows the build makes **one file, `Drift-Setup.exe`**: the custom Setup window (`src/setup`) with the Drift app packed inside it. There is no separate download and no GitHub step. It is a per-user install that needs no administrator rights. Program files go to `%LOCALAPPDATA%\Programs\Drift`; the profile lives in `%APPDATA%\Drift` and is kept on uninstall. `publish/` contains the Setup, a SHA-256 checksum and a release manifest.

Preview the Setup window without building: `npx electron . --setup`.

## Updates

Windows installs update from the Universal App Monitor (the same gateway that receives usage reports).

1. Drift asks the monitor for the latest Drift release about 20 seconds after launch and every six hours (with retries after a failure and after waking from sleep). The request carries the install ID, Drift version, PC name and LAN address, so the monitor shows one row per PC.
2. A newer `Drift-Setup.exe` is downloaded from the monitor and rejected unless its size and SHA-256 match what the monitor announced.
3. The Setup runs headless (`--silent-update`) when Drift closes, or at the next launch if that did not happen. The profile is never touched.

Updates are skipped on macOS and Linux, in development runs, and when the install folder requires administrator rights. They can be disabled in **Settings > General > Keep Drift up to date**. Log: `%APPDATA%\Drift\Updates\updater.log`.

To publish: bump `version` in `package.json`, add a `## <version>` section to `CHANGELOG.md` (it becomes the release notes), then run **`release.bat`**. It builds `publish\Drift-Setup.exe`, checks that the version inside the exe, `package.json` and `CHANGELOG.md` agree, and uploads it to the monitor (`publish_to_monitor.ps1`: LAN first, public tunnel as fallback, resumable chunks, SHA-256 verified).

```
release.bat [auto|public|local] [-Force] [-NoZip]
release.bat noupload        build and validate only
```

The Monitor API key comes from `DRIFT_MONITOR_KEY` (or `MONITOR_API_KEY`), a `monitor-key.txt` next to the script (git-ignored), or a prompt. It is never stored in the app. New users can run the same `Drift-Setup.exe`.

Configuration: `src/main/update-config.js` (gateway address, `DRIFT_UPDATE_GATEWAY` overrides it for testing). Tests: `npm run test:updater`, `npm run test:gateway`.

## Usage reporting

Packaged builds report to the Universal App Monitor (app id `drift`) through its client gateway.

- **Events:** `open` after launch, `heartbeat` about once a minute, `close` on quit.
- **Sent:** random install ID, Drift version, OS version, PC name, LAN address, random per-launch session ID.
- **Never sent:** sites visited, tabs, searches, bookmarks, history or downloads.
- **Control:** off in **Settings > General > Share usage status**. Development runs never report; set `DRIFT_REPORT_DEV=1` to test against a monitor.
- **Log:** `%APPDATA%\Drift\Updates\telemetry.log`.

Tests: `npm run test:telemetry`.

## Extensions

Open *Extensions* (`Ctrl/Cmd+Shift+E`), paste a Chrome Web Store link or 32-letter extension ID, and choose *Add from Chrome Web Store*. Store installs are limited to Manifest V3 and update automatically. *Install unpacked* copies a folder containing `manifest.json` (V2 or V3) into the profile.

Electron implements a subset of the Chrome extension APIs, so compatibility varies. Powered by [`electron-chrome-web-store`](https://www.npmjs.com/package/electron-chrome-web-store) (MIT).

## Project layout

```text
build/                 app icons
scripts/               build, icon generation, project check and tests
src/
  main/                browser core, updater, telemetry, storage,
                       memory manager, shortcuts, extensions
  preload/             allow-listed renderer <-> main IPC bridge
  renderer/
    browser/           tab strip, address bar, settings and manager pages
    newtab/            start page
    palette/           command palette
    shared/            styles, generated icons, assets
  setup/               all-in-one Setup (installer window + app)
```

## Memory management

`src/main/memory-manager.js` runs every 15 seconds and measures memory only when a background tab holds a renderer.

| Rule | Default |
|---|---|
| Idle expiry | 3 min (75 s moderate pressure, 40 s high) |
| Idle New Tab page | 20 s |
| Background tabs keeping a renderer | 4, least recently used released first |
| Early release under high pressure | 3 heaviest tabs idle 15 s+, per pass |
| Never discarded | visible tab, audio, capture, active download |

Pressure compares Drift's private memory with 30% of installed RAM (minimum 1.25 GB); moderate starts at 70% of that budget. Windows also factors in system free memory (moderate under 25% free, high under 12%). Tab views also run without spellcheck and WebSQL, and Chromium's translation, Cast discovery, optimization-hint and autofill-server services are switched off.

## License

[MIT](LICENSE). Interface icons are [Font Awesome Free](https://fontawesome.com/license/free) (CC BY 4.0) via `react-icons` (MIT).
