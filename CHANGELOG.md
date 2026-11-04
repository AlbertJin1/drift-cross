# Drift changelog

Each release needs a `## <version>` section matching `version` in package.json: release.bat refuses to upload without
one, and publish_to_monitor.ps1 sends that section to the monitor as the release notes.

## 1.3.5

### What's new
- Tabs use less memory: idle background tabs are released sooner and fewer stay loaded.
- Window controls now sit flush in the top-right corner, and the bookmarks bar is bigger and better looking.
- Developer credit added to Setup and the About page.

### Fixes
- Setup no longer fails with "illegal operation on a directory" while copying the app.
- Uninstalling or updating no longer flashes a console window.

### Technical notes
- Setup copies its payload with original-fs; cleanup and update helpers run under conhost --headless.

## 1.3.4

### What's new
- One installer: Drift-Setup.exe is the Setup window and the browser in a single file, with nothing to download.
- Drift updates itself from the Universal App Monitor again; updates install quietly when Drift closes.

### Technical notes
- Windows build is the portable all-in-one Setup (src/setup); the GitHub-downloading installer and NSIS files are gone.
