# Drift

Drift **v1.1.0** is a small, portable, cross-platform browser for **Windows, macOS, and Linux**, built with Electron and a local HTML/CSS/JavaScript interface. Windows uses a custom frameless titlebar with native-feeling minimize, maximize/restore, and close controls. It keeps the browser chrome lightweight, restores session metadata, and opens tab contents only when needed.

## Highlights

- **Horizontal tabs** with a nearby new-tab (+) control, favicons, loading indicators, close controls, and Home / Work / Fun spaces.
- **Custom Windows titlebar** with integrated Drift branding, the active page title, version chip, draggable window area, and window controls.
- **Live address bar** sourced from the active WebContents URL so redirects, in-page navigation, and tab changes keep it synchronized. Supports direct URLs, local addresses, and configurable DuckDuckGo, Google, Bing, or Brave Search.
- **Bookmarks end to end** — star/unstar pages, quick-access bookmarks bar, persistent storage, open in a new tab, rename, edit URL, and remove.
- **Built-in ad and tracker blocking** at the network-request layer, with an on/off switch, session counters, most-blocked host list, and per-site exceptions.
- **Performance-minded tab handling** — lazy tab creation, idle-tab discarding, background timer throttling, debounced chrome updates, and session restore without eagerly loading every saved page.
- **Command palette** (`Ctrl/Cmd+K`) for open tabs, bookmarks, history, URLs, and common commands.
- **Settings and version panel** with system/light/dark appearance, default search engine, bookmark-bar visibility, previous-session restore, and live app/Electron/Chromium version details.
- **Reader mode**, session history, and light/dark appearance following the OS setting.
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
| Toggle ad blocker | Ctrl/Cmd + Shift + A |
| Reload | Ctrl/Cmd + R |
| Back / Forward | Alt + Left / Right (Cmd + [ / ] on Mac) |
| Reader mode | Ctrl/Cmd + Shift + R |
| Switch space | Ctrl/Cmd + 1 / 2 / 3 |
| Developer tools | F12 |

Middle-click a tab to close it.

## Run from source

Requires Node.js 20 or later.

```sh
npm install
npm start
```

`npm start` launches Electron directly and does not run a CSS compilation step, keeping browser opening fast. `npm run css:build` compiles Tailwind when developing the UI, and both publishing scripts compile it before packaging. The generated CSS is bundled with the app, so the browser has no runtime dependency on a CDN.

## Build portable releases

Build each target on its corresponding operating system:

- **Windows:** run `build_publish.bat` — outputs a portable `dist/Drift.exe`.
- **macOS / Linux:** run `./build_publish.sh` — outputs a `.dmg` or `.AppImage`.

The project includes custom source and platform-specific icons in `build/`.

## Project layout

```text
main.js                 browser core, live URL sync, tabs, session restore, request blocking and preferences
preload.js              allow-listed renderer/main IPC bridge
ui/index.html           browser chrome, custom window controls, address bar, settings/bookmark/protection dialogs
ui/ui.js                tab, bookmark, and protection UI interactions
ui/style.css            visual theme and component styling
ui/tailwind.css         Tailwind build entry point
ui/tailwind.generated.css compiled utility CSS (rebuilt by npm scripts)
ui/palette.*            command palette
ui/newtab.html          local start page
build/icon.*            custom platform app icons
```

## Notes

The ad blocker uses a bundled list of known advertising and analytics hosts and can be paused globally or for an individual site. Blocking can affect some site widgets; a per-site exception is available in the protection panel.

## License

MIT
