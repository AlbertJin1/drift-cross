# Drift

Developed by **Jessie Albert Regualos** (aka **Yotsuchi**).

A lightweight desktop browser for Windows, macOS and Linux, built on Electron with a plain HTML/CSS/JS interface. No framework, no runtime CDN, no account.

MIT licensed. Node.js 20+ required to build.

## Features

- **Tabs:** animated tab strip, favicons, loading indicators, reopen closed tabs (last 25), tab hover preview with memory use.
- **Address bar:** URLs, local addresses and search (DuckDuckGo, Google, Bing, Brave). Command palette on `Ctrl/Cmd+K`.
- **Page tools:** find in page, reader mode, zoom, print, developer tools, context menus.
- **Data:** reorderable bookmarks with folders, real website favicons, a quick-access bar, date-grouped history with site icons, downloads manager, and clear browsing data.
- **Privacy:** network-level ad/tracker blocking, a separate unsolicited pop-up blocker, a global switch and per-site ad-block exceptions.
- **Extensions:** Chrome Web Store (Manifest V3) and unpacked extensions.
- **Profiles:** separate browsing identities (work, personal, school...), each with its own sign-ins, bookmarks, history, settings and extensions.
- **Customisation:** light, dark or system appearance, eight accent themes plus custom accent colors, interface font and text scale, density, corner style, tab appearance and width, chrome tint, motion controls, bookmark labels, New Tab backgrounds, layouts and tile sizes.
- **Performance:** idle background tabs are discarded under a memory-aware policy, tab creation is lazy, and disk writes are coalesced and atomic.
- **Updates:** Windows releases use verified incremental binary-chunk updates when a compatible base installer is cached, with compressed ZIP and raw-installer fallbacks.

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

On Windows the build makes **one file, `Drift-Setup.exe`**: the custom Setup window (`src/setup`) with the Drift app packed inside it. There is no separate download and no GitHub step. It is a per-user install that needs no administrator rights. Setup tests the selected folder for current-user write access and refuses protected folders instead of requesting UAC elevation. Program files go to `%LOCALAPPDATA%\Programs\Drift`; the profile lives in `%APPDATA%\Drift` and is kept on uninstall. `publish/` contains the Setup, a SHA-256 checksum and a release manifest.

Preview the Setup window without building: `npx electron . --setup`.

## Updates

Windows installs update from the Universal App Monitor (the same gateway that receives usage reports). Drift uses **incremental installer updates** when a compatible, previously verified Setup package is cached:

1. Drift checks the latest release about 20 seconds after launch and every six hours (with retries after failures and after waking from sleep). The request carries the install ID, Drift version, PC name and LAN address, so the monitor shows one row per PC.
2. When the Monitor publishes a `psd-chunks-v1` manifest and Drift has a verified base installer from the currently installed version, Drift downloads only the content-defined chunks that are not already present in that base. It reconstructs the new `Drift-Setup.exe` locally and verifies each chunk and the complete executable with SHA-256.
3. If no compatible base exists, the release has no delta manifest, the delta is unavailable or invalid, or the delta would be larger than the compressed package, Drift downloads the Monitor's compressed one-file ZIP package instead. If ZIP metadata or extraction fails, it falls back to the raw installer. All paths verify the announced size and SHA-256 before staging.
4. After a successful install, the detached helper caches the verified Setup executable as the base for the next release. The first update after installing 1.3.13 will generally use the compressed full package because existing installations do not yet have a cached base; subsequent compatible updates can be incremental.
5. The updater launches the SHA-256-verified staged `Drift-Setup.exe` directly as a detached, hidden helper (no PowerShell dependency). Setup confirms its Electron runtime is ready, waits for the current Drift PID to exit normally, then performs a staged directory swap. For **Restart to update**, the new browser must load its chrome, show its main window, and write a one-time version/token health-check before Setup commits and removes the previous install. If the check fails, Setup rolls back, reopens the previous browser, and delays automatic retry; the profile is never touched. Earlier releases that already launched Setup through PowerShell remain compatible.

Updates are skipped on macOS and Linux, in development runs, and when the install folder requires administrator rights. They can be disabled in **Settings > General > Keep Drift up to date**. Logs: `%APPDATA%\Drift\Updates\updater.log` and `%APPDATA%\Drift\startup.log`.

To publish: bump `version` in `package.json`, add a `## <version>` section to `CHANGELOG.md` (it becomes the release notes), then run **`release.bat`**. It builds `publish\Drift-Setup.exe`, checks that the version inside the exe, `package.json` and `CHANGELOG.md` agree, and uploads it to the monitor (`publish_to_monitor.ps1`: LAN first, public tunnel as fallback, resumable chunks, SHA-256 verified).

```
release.bat [auto|public|local] [-Force] [-NoZip]
release.bat noupload        build and validate only
```

The Monitor API key comes from `DRIFT_MONITOR_KEY` (or `MONITOR_API_KEY`), a `monitor-key.txt` next to the script (git-ignored), or a prompt. It is never stored in the app. New users can run the same `Drift-Setup.exe`.

Configuration: `src/main/update-config.js` (gateway address and artifact size/time limits; `DRIFT_UPDATE_GATEWAY` overrides the gateway for testing). Tests: `npm run test:updater`, `npm run test:update-healthcheck`, `npm run test:installer-launch`, `npm run test:differential`, `npm run test:gateway`.

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

## Profiles

A profile is a completely separate browsing identity: its own cookies and site sign-ins, local storage, cache, permissions, bookmarks, history, downloads list, settings, tabs and extensions. Use the colored profile button in the toolbar to switch, or **Settings > Profiles** to add, rename, recolor and delete them (up to 20).

- Each profile runs in its own Drift window (its own process). Opening a profile that is already open brings its window to the front.
- Isolation comes from a separate Chromium data folder per profile, not from filtering: `%APPDATA%\Drift` holds the **Default** profile (so existing data needs no migration) and `%APPDATA%\Drift\Profiles\<id>` holds every other profile. `%APPDATA%\Drift\profiles.json` lists them.
- Start Drift normally to open the profile you used last, or run `Drift.exe --profile=<id>` for a specific one (in development: `npm start -- --profile=<id>`).
- Deleting a profile erases its folder. The Default profile, the profile in use and a profile that is open in another window cannot be deleted.
- Shared by all profiles: the update files, the anonymous install id and the review reminder. An update installs only when no other profile window is open, and only one open profile reports usage status.
- Profile logic lives in `src/main/profiles.js` (tested by `npm run test:profiles`); the toolbar menu, dialog and settings page are in `src/renderer/browser/profiles.js`.

## Project layout

```text
build/                 app icons
scripts/               build, icon generation, project check and tests
src/
  main/                browser core, profiles, updater, telemetry, storage,
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

## Automatic product review

Drift shows its product-review form in a modal after at least 30 minutes of accumulated application use. The form is not embedded in Settings or the About page. It follows the same general prompt cadence as PDF Studio Electron:

- The initial check is delayed for a few minutes after launch and uses a randomized check schedule after that.
- **Remind me later** snoozes the prompt for seven days. **Don’t ask me again** disables automatic prompts permanently for this profile.
- After a review is submitted, another automatic prompt is held for 90 days and requires at least 30 minutes of additional app use. A new major version removes the 90-day wait but still requires fresh use.
- Usage timing is stored locally in `%APPDATA%\\Drift\\review-prompt-state.json`, is independent of the optional remote usage-reporting setting, and pauses while Windows suspends the computer.
- A review submission uses the existing Universal App Monitor gateway. The review payload contains the rating, optional name, written feedback, app version and anonymous install ID. It does not contain tabs, browsing history, visited pages, PC name or LAN address.

Tests: `npm run test:review-prompt`.


### Tab optimization (1.3.8)

Open Settings > Appearance to customize the browser palette, typography, density, corners, tab strip, motion and New Tab design. Settings > Tabs lets you tune inactive-tab suspension, background renderer limits, memory-pressure behavior, New Tab expiry, recent-tab protection, and domains that should remain loaded. Visible, audible, captured, and downloading tabs are always protected.


## Recently closed tabs and windows

Use **Ctrl+Shift+T** (or **Cmd+Shift+T** on macOS) to restore the most recently closed tab or an entire closed Drift browser window. The recovery list is saved locally, so a closed browser session can be restored after relaunch. Repeated presses step backward through the closed history.

Drift installs per-user by default and validates that the selected install directory is writable without administrator privileges.
