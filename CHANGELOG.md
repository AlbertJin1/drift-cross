## 1.3.19 — Browser Profiles

- Added browser profiles. Each profile is a separate browsing identity with its own cookies and site sign-ins, local storage, cache, permissions, bookmarks, history, downloads list, settings, tabs, recently closed tabs and extensions. Isolation comes from giving each profile its own Chromium data folder, so nothing is shared by accident.
- New profile button (colored initial) in the toolbar. Its menu shows the current profile, switches to any other profile, adds a profile and opens Manage profiles.
- New Settings > Profiles page: add, rename, recolor, open and delete profiles. Names are cleaned and must be unique; up to 20 profiles.
- Opening a profile starts it in its own window. If it is already open, its window is brought to the front instead of starting a second copy.
- Deleting a profile erases its data from disk. The Default profile cannot be deleted, the profile you are using cannot be deleted, and a profile that is open in another window must be closed first. Deletion is crash-safe: an interrupted delete is finished at the next start.
- Starting Drift normally opens the profile you used last; `Drift.exe --profile=<id>` opens a specific one. The window title shows the profile name once more than one exists.
- Existing installs keep everything: the current data becomes the Default profile in place, with no migration or copying.
- Updates, the anonymous install identity and review reminders are shared by all profiles. An update is installed only when no other profile window is open, and only one open profile sends usage status, so a multi-profile install still counts as one install.
- Added the `user` glyph, `npm run test:profiles` (16 tests) and the new files to the project preflight.
- Bumped the application and lockfile version to 1.3.19.

## 1.3.18 — Update Window and Reliable Restart

- Added an "Updating Drift" window. Restart to update now shows each step (closing Drift, installing files, switching versions, opening the new browser) with a progress bar, and shows the real error with a Close button if something fails.
- Fixed Drift reopening invisibly after an update: the helper launched Drift with a hidden-window flag, so Windows hid the browser window and left a process in Task Manager. Drift is now started normally.
- Fixed the update waiting on a Drift process that never exited: the helper now waits 10 seconds, then ends the old Drift process tree (including VPN/child processes) so the install folder is free. Drift itself also force-exits 5 seconds after Restart to update.
- If Windows keeps a file locked and the folder swap fails, Setup now copies the new files over the install folder instead of giving up and keeping the old version.
- A new browser that is running but slow to acknowledge startup is no longer rolled back; only a browser that actually exits triggers the rollback to the previous version.
- The update lock is released before an error is shown, so the reopened browser never waits behind the helper.
- Bumped the application version to 1.3.18.

## 1.3.17 — Windows Update Helper Reliability

- Removed PowerShell from the manual Restart to update path. Drift now launches the SHA-256-verified staged `Drift-Setup.exe` directly as a hidden, detached helper.
- The Setup process writes a one-time readiness token after its Electron runtime initializes, then waits for the current Drift PID to exit normally before replacing the installation.
- Setup owns its update lock, performs the install, checks that the new browser window opens, and rolls back/reopens the previous version if validation fails.
- Moved differential base caching into the Setup process and added deferred staged-installer cleanup after the helper exits.
- Kept compatibility with earlier releases that still start Setup through their PowerShell helper.
- Settings > About now displays the actual Setup startup failure reason rather than a generic Windows helper error.
- Bumped the application and lockfile version to 1.3.17.

## 1.3.16

- Restyled the bookmarks bar with consistent bookmark chips, better favicon sizing, clearer spacing, stronger focus states, and responsive truncation.
- Restored a visible floating drag preview that follows the pointer, plus an animated insertion placeholder that previews the exact drop position in both the bar and bookmarks manager.
- Added pointer capture and focus-loss cleanup so bookmark drags remain stable when the pointer leaves the original item.
- Enforced current-user-only installation: the setup validates that the selected folder is writable before copying files and refuses protected folders rather than requesting UAC/admin elevation.
- Clarified setup messaging and kept installation metadata in per-user registry locations.

## 1.3.15

### Critical Windows update and relaunch repair
- Fixed the restart-to-update transaction: the updated browser now writes a tokenized health-check only after the browser chrome has loaded and the main window is visible. Setup verifies the exact expected version and token before deleting the previous installation.
- This closes a release-blocking gap where Setup launched the new Drift process but never received the browser's launch acknowledgement, treated the update as failed, and restored the old version. The previous build could therefore remain installed even after the updater said the new release was ready.
- If the new executable cannot open, reports the wrong version, or exits before acknowledging startup, Setup now stops the new install's processes, restores the previous folder, returns a failure code, and lets the helper reopen the previous Drift. Failed attempts record a 15-minute retry delay rather than immediately cycling on every launch; the user can still force a manual retry from Settings > About.
- Corrected the close-time update path to execute its `.ps1` helper with PowerShell instead of routing it through `cmd.exe` (which cannot execute PowerShell scripts). Both manual Restart and close-time installation now use the same PowerShell helper format.
- Helper readiness is confirmed by a unique marker, not merely by the existence of a child PID. Added diagnostics to `%APPDATA%\Drift\Updates\updater.log` and `%APPDATA%\Drift\startup.log` for helper startup, installed-version health-check, rollback and relaunch outcomes.
- Kept `pending.json` and the staged Setup executable until the running updated browser has passed startup health-check and the helper has finished caching the verified installer for future differential updates.

### Compatibility and recovery
- Existing profiles, bookmarks, history, extensions, and incremental-update cache remain intact. No Monitor changes or database schema migration are required.
- Users currently on a release whose updater lacks the matching health-check acknowledgement must perform this release once using the full v1.3.15 Setup installer. Later updates can use the repaired incremental/manual update path.

### Verification
- Added regression tests for token/version/path validation, post-window-show acknowledgement wiring, failed child launches despite assigned PIDs, and the PowerShell helper's health-check arguments.

## 1.3.14

### Bookmarks and history
- Replaced native bookmark drag-and-drop with pointer-driven reordering. Drops are resolved across bookmark gaps and edges, including moving the first bookmark to later positions; an immutable reorder operation updates the saved list.
- Added explicit Move Up / Move Down controls in the Bookmarks manager as an accessible fallback, and made the main-process reorder operation share the same tested ordering rules.
- Bookmarks now retain Chromium's discovered favicon. The bookmark bar, bookmark manager and history page render actual site icons with a safe fallback chain (saved icon, site `/favicon.ico`, domain-icon fallback, then initials).
- History now stores the page favicon when available and groups visits by Today, Yesterday and calendar date, with host and visit time metadata and a one-click search reset.
- Improved narrow-window behavior for bookmark creation, manager actions and history rows.

### Privacy protection
- Added an independently configurable pop-up blocker. It denies unsupported schemes, known advertising-host pop-ups and unsolicited window opens without a recent trusted pointer or keyboard action; normal user-initiated web links continue to open in tabs.
- Added a tiny isolated page preload to signal trusted pointer/keyboard activity to the main process. The page cannot access the IPC bridge, and the signal is rate-limited.
- Expanded the bundled high-confidence ad/tracker host rules and exposed pop-up blocking in Settings > Privacy and the protection dialog. Per-site ad-block exceptions do not silently disable the independent pop-up blocker.
- Added regression tests for first-item reordering in both directions, immutable order changes, safe favicon URLs, pop-up gesture handling, ad-host decisions and site-exception behavior.

### Compatibility
- Existing bookmarks and history files remain compatible. Favicon metadata is optional and is populated as Chromium discovers icons; existing entries use a fallback icon until then.
- Pop-up blocking is enabled by default for existing profiles. It can be disabled in Settings > Privacy or in the protection dialog.

## 1.3.13

### What's new
- Added incremental Windows updates using the Universal App Monitor's `psd-chunks-v1` content-defined chunk manifests. Drift compares the latest installer against a previously verified installer cache, downloads only missing chunks, reconstructs the new Setup executable, and verifies every chunk plus the complete file SHA-256 before staging it.
- Added a compressed one-file ZIP package fallback. Existing installs without a compatible cached base (including the first update after installing 1.3.13), old Monitor deployments, unavailable manifests, oversized deltas, and corrupt/incompatible delta responses automatically use the verified compressed package; if that package is unavailable or invalid, Drift falls back to the verified raw Setup executable.
- After a successful update, the helper retains the newly installed, already-verified Setup executable as the next differential base. Only the current base is retained to limit disk usage. The profile, browsing data, and installed browser files are not used as delta bases.
- Added bounded manifest/archive/package downloads, strict ZIP entry and local-header validation, per-chunk SHA-256 checks, complete reconstructed-file SHA-256 and Windows executable checks, and end-to-end regression tests against a simulated Universal App Monitor gateway. The updater also reports comparison/download progress and the actual transfer size/savings in Settings > About.
- Cached base indexing computes the whole-file checksum in the same streaming pass, rejects cache files changed during indexing, and avoids blocking the browser UI with synchronous file hashing. A verified ZIP extraction safely replaces an older staged installer on Windows.

### Compatibility and rollout
- No Monitor database migration is required. The supplied Universal App Monitor already exposes Drift's manifest and delta endpoints and publishes the compressed ZIP package metadata. The Monitor must generate a `psd-chunks-v1` manifest for each new Drift release; releases without one remain compatible through the full-package fallback.
- Existing users upgrading from 1.3.12 normally download the compressed full package once because they do not yet have a cached base installer. After 1.3.13 installs successfully, later releases can use changed-chunk downloads when that saves bandwidth.

### Verification
- Added tests for PHP/JS-compatible chunk indexing, manifest validation, delta parsing, chunk and whole-file integrity, ZIP safety, incremental download, first-update fallback, corrupted-delta fallback, and caching the next base installer.

## 1.3.12

### Fixes
- Settings > About now waits for Windows to confirm that the detached update helper actually started before Drift quits. If both the headless console helper and hidden `cmd.exe` fallback fail, Drift remains open, the downloaded installer is kept, the apply lock is removed, and the user can retry.
- The update installer now keeps the previous installation as a rollback copy until the new `Drift.exe` confirms startup. If the updated executable cannot be launched, Setup restores the previous version instead of reporting a successful update with no browser window.
- Startup and user-requested updates verify staged installer checksums asynchronously so large update files do not block Electron's main thread while hashing.
- About > Updates now displays an installing state and a clear retry action when the Windows helper cannot be started.
- Audited responsive layout behavior: the toolbar, tabs, bookmarks, settings pages, dialogs and native tab view continue to reflow on actual resize, container-width and display-DPI changes.

### Verification
- Added installer launch/rollback handoff tests and responsive-layout regression checks. Windows installer execution still requires an actual Windows test machine.

## 1.3.11

### What's new
- Windows taskbar identity is now consistent between the running Drift browser and the Start Menu/Desktop shortcuts (`org.drift.browser`). A launch from the pinned shortcut is routed to the already-running Drift window rather than opening a second visible browser instance.
- `Ctrl+Shift+T` now restores the most recently closed tab or complete browser window. Closed-window recovery preserves tab order and the active tab, survives normal restarts, and can recover the last durable browser session after an unclean termination.
- The Recently closed menu now distinguishes individual tabs from closed browser windows and lets users restore a specific item.
- Added a polished browser-chrome entrance, window fade-in/fade-out, and refined tab, page, dialog, and menu transitions. Full / Reduced / Off motion preferences and the OS reduced-motion preference remain respected.

### Fixes and compatibility
- The existing app ID remains `org.drift.browser`; no new application identity or profile directory is introduced.
- Startup mode `Continue where you left off` does not add a duplicate closed-window entry because that same session already opens automatically.
- The new restore history is stored locally in `recently-closed.json`; it does not contain browser telemetry or get transmitted to the Monitor.

# Drift changelog

Each release needs a `## <version>` section matching `version` in package.json: release.bat refuses to upload without
one, and publish_to_monitor.ps1 sends that section to the monitor as the release notes.

## 1.3.10

### Fixes
- Fixed Drift not opening (a Drift process in Task Manager but no window) and very slow first launches after an update. A Drift started by the update installer waited up to 2.5 minutes, invisibly, for the installer's own cleanup to finish, and while it waited it held Drift's single-instance lock, so clicking Drift again did nothing. A launch of the already-updated version no longer waits at all.
- An update lock left behind by an installer helper that was killed (sign-out, antivirus, Task Manager) is now detected immediately instead of blocking launches for minutes.
- If a launch really must wait for an installer, a small "Finishing the update" window is shown instead of nothing.
- The window can no longer stay hidden because of a slow extension or Chrome Web Store start-up: Drift waits at most a few seconds for extensions, which keep loading in the background, and a watchdog shows the window after 8 seconds in any case.
- Restarting after an update releases the single-instance lock first, so the new copy can no longer start, find the lock taken and quit silently.
- If Drift fails while starting it now says so (with the path of the log) instead of quitting silently.
- The silent updater copies several files at once and its helper commands have time limits, so a stuck step cannot hang the update.

### Technical notes
- Every launch appends timed lines to `%APPDATA%\Drift\startup.log`; the last line shows where a launch stopped.
- 1.3.9 installs that already fail to open must be fixed once by running the new Drift-Setup.exe by hand (it keeps your bookmarks, history and settings); later updates are then automatic.

## 1.3.9

### What's new
- Expanded Settings > Appearance with custom accent colors, interface density, text scaling, font selection, corner styles, browser-chrome tint, tab styles and widths, bookmark label visibility, and configurable motion.
- Added New Tab visual presets (Aurora, Midnight, Paper, Forest, Sunset), page-width layouts, and shortcut-tile sizing.
- Appearance preferences are validated, saved in the user profile, applied immediately, and propagated to newly opened or already-open New Tab pages.

### Fixes
- Kept browser content bounds stable while allowing horizontal density and tab sizing to change, preventing the website viewport from shifting vertically.
- Added regression coverage for appearance-setting normalization and invalid-value rejection.

## 1.3.8

### What's new
- Added Settings > Tabs with user-defined automatic tab optimization: toggle suspension, choose the idle timeout, set the live background-tab limit, configure the New Tab timeout and recently-used grace period, and select balanced, aggressive, or disabled memory-pressure handling.
- Added per-domain keep-active exceptions (up to 100 domains, including matching subdomains).
- Settings are validated and persisted in the Drift profile. Visible, audible, captured, and downloading tabs remain protected; sleeping tabs restore when selected.

### Fixes
- Replaced hard-coded tab-discard thresholds with a configurable, test-covered policy. A background-tab limit of “No limit” now genuinely disables the LRU cap.


## 1.3.7

### Fixes
- Fixed the “A JavaScript error occurred in the main process” dialogs (“Object has been destroyed” and “Cannot read properties of undefined (reading 'isDestroyed')”) that appeared when Drift closed to install an update. Background timers (window-state refresh, idle-tab discarding) kept running after the window and its tabs were already destroyed; they now stand down as soon as Drift starts quitting, and teardown errors can no longer raise a blocking dialog.

### What's new
- Settings > About has a **Check for updates** button. It checks right away (even if background updates are switched off), shows download progress, and offers **Restart to update**, which installs the update and reopens Drift with your tabs.

### Technical notes
- 1.3.5 and 1.3.6 installs still contain the old shutdown bug. If one shows the error dialog while updating, click OK: the update installs anyway once Drift exits. The dialog is gone from 1.3.7 onwards.

## 1.3.6

### What's new
- Maintenance release for the Universal App Monitor connection: open / heartbeat / close usage reports, update checks and review submissions were re-checked end to end, and every installed copy now reports under version 1.3.6 once it updates.

### Fixes
- The About page is redesigned: a version header with Electron/Chromium chips, a developer card that no longer splits its avatar from its text, and a profile-location panel with the path in a proper field.
- Pairs with Universal App Monitor 2.5.3, which no longer erases a PC's recorded Windows version when a Drift update check or review arrives.

- Every toggle switch now keeps its knob centred in the track, including in narrow Settings windows where the switch used to stretch.
- Added a manual way to leave a review: “Rate Drift” in the menu and a “Write a review” button in Settings > About. Manual reviews don't affect the automatic prompt schedule.

### Technical notes
- No change to what Drift sends: install id, version, OS, PC name and LAN address with usage reports; reviews still carry only rating, optional name, feedback and version.
- Installed 1.3.5 copies pick this release up through the normal silent update and install it when Drift closes.

## 1.3.5

### What's new
- Added a PDF Studio-style automatic review modal after 30 minutes of accumulated Drift use, with 1–5-star ratings and optional written feedback.
- Tabs use less memory: idle background tabs are released sooner and fewer stay loaded.
- Window controls now sit flush in the top-right corner, and the bookmarks bar is bigger and better looking.
- Developer credit added to Setup and the About page.

### Fixes
- Setup no longer fails with "illegal operation on a directory" while copying the app.
- Uninstalling or updating no longer flashes a console window.

### Technical notes
- Review timing, reminders and opt-out are stored locally in the Drift profile. “Remind me later” pauses prompts for seven days; “Don’t ask me again” permanently opts out; after a submitted review, another prompt requires 90 days and 30 minutes of fresh use (or a new major version and 30 minutes of fresh use).
- Review submissions use the existing telemetry gateway and anonymous install identity. They include only the rating, optional name, feedback and app metadata; browsing data, tabs, PC name and LAN address are not sent. The monitor may record the request IP for abuse prevention.
- Local review-use accounting pauses while the computer is suspended and works independently of the optional remote usage-reporting setting.
- Setup copies its payload with original-fs; cleanup and update helpers run under conhost --headless.

## 1.3.4

### What's new
- One installer: Drift-Setup.exe is the Setup window and the browser in a single file, with nothing to download.
- Drift updates itself from the Universal App Monitor again; updates install quietly when Drift closes.

### Technical notes
- Windows build is the portable all-in-one Setup (src/setup); the GitHub-downloading installer and NSIS files are gone.