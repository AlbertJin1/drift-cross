# Drift changelog

Each release needs a `## <version>` section matching `version` in package.json: release.bat refuses to upload without
one, and publish_to_monitor.ps1 sends that section to the monitor as the release notes.

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
