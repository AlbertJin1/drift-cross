# Drift

A small, fast, open-source browser for **Windows, macOS and Linux**.
Built on Electron, so every platform gets the same Chromium engine and the same interface.
The whole UI is plain HTML/CSS/JS in `ui/` - easy to restyle.

## What makes it different
- **Spaces** - Home / Work / Fun, each with its own tabs. Switch with a click or Ctrl/Cmd+1-3.
- **Vertical tabs** with favicons, loading spinners and hover close buttons.
- **Command palette (Ctrl/Cmd+K)** - one box for open tabs, bookmarks, history, URLs, searches and commands.
- **Memory saver** - tabs idle for 5+ minutes are discarded and reloaded when you return.
- **Tracker and ad blocking** with a live counter (edit `BLOCKED` in `main.js`).
- **Reader mode** - clean, readable text (Ctrl/Cmd+Shift+R).
- **Session restore**, bookmarks and history.
- Automatic **light / dark** theme following your OS.

## Shortcuts
| Action | Shortcut |
|---|---|
| Command palette | Ctrl/Cmd + K |
| New tab / Close tab | Ctrl/Cmd + T / W |
| Address bar | Ctrl/Cmd + L |
| Bookmark | Ctrl/Cmd + D |
| Reload | Ctrl/Cmd + R |
| Back / Forward | Alt + Left / Right (Cmd + [ / ] on Mac) |
| Reader mode | Ctrl/Cmd + Shift + R |
| Switch space | Ctrl/Cmd + 1 / 2 / 3 |
| Dev tools | F12 |

Middle-click a tab to close it.

## Run from source
Requires Node.js 20+.

    npm install
    npm start

## Build installers
- **Windows**: double-click `build_publish.bat` -> `dist\Drift.exe` (single portable file)
- **macOS / Linux**: run `./build_publish.sh` -> `.dmg` / `.AppImage` in `dist/`

Build each platform on that platform. Add an `icon.ico` / `icon.icns` / `icon.png` in a `build/` folder to replace the default icon.

## Project layout
    main.js        browser core: window, tabs, spaces, palette, blocking
    preload.js     safe bridge between UI pages and main process
    ui/index.html  sidebar + toolbar      ui/style.css  all styling (themes)
    ui/palette.*   command palette        ui/newtab.html  start page

## Ideas to extend
Downloads panel, move tab between spaces, drag-to-reorder tabs, find-in-page, custom blocklists, extensions.

## License
MIT
