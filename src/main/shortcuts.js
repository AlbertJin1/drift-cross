// Central keyboard shortcut table for Drift.
//
// Shortcuts are matched from `before-input-event` on every WebContents (tabs,
// browser chrome, command palette) so they behave the same no matter which
// surface has focus, and so pages cannot swallow them. The application menu
// shows the same accelerators for discoverability.
//
// matchShortcut(input) returns { name, arg } for Drift's `command()` handler,
// or null when the key press should pass through to the page untouched.

const MAC = process.platform === 'darwin';

const DIGIT_CODES = {
  Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9,
  Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4, Numpad5: 5, Numpad6: 6, Numpad7: 7, Numpad8: 8, Numpad9: 9
};

function matchShortcut(input) {
  if (!input || input.type !== 'keyDown' || input.isComposing) return null;

  const key = String(input.key || '');
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const code = String(input.code || '');
  const shift = !!input.shift;
  const alt = !!input.alt;
  const ctrl = !!input.control;
  const meta = !!input.meta;
  const primary = MAC ? meta : ctrl; // Cmd on macOS, Ctrl elsewhere
  const repeat = !!input.isAutoRepeat;
  const result = (name, arg, { allowRepeat = false } = {}) => (repeat && !allowRepeat ? null : { name, arg });

  // ---- Function keys ---------------------------------------------------
  if (!primary && !alt && !ctrl && !meta) {
    if (key === 'F5') return result('reload', shift ? 'hard' : undefined);
    if (key === 'F6') return result('address');
    if (key === 'F11') return result('fullscreen');
    if (key === 'F12') return result('devtools');
  }
  if (ctrl && !alt && !meta && key === 'F5') return result('reload', 'hard');

  // ---- Tab switching with Ctrl+Tab (Ctrl on every platform) -----------
  if (ctrl && !alt && key === 'Tab') return result(shift ? 'previous-tab' : 'next-tab', undefined, { allowRepeat: true });

  // ---- macOS back / forward / tab navigation -----------------------
  if (MAC && meta && !ctrl) {
    if (!alt && !shift && key === '[') return result('back');
    if (!alt && !shift && key === ']') return result('forward');
    if (alt && !shift && key === 'ArrowRight') return result('next-tab', undefined, { allowRepeat: true });
    if (alt && !shift && key === 'ArrowLeft') return result('previous-tab', undefined, { allowRepeat: true });
    if (shift && !alt && key === ']') return result('next-tab', undefined, { allowRepeat: true });
    if (shift && !alt && key === '[') return result('previous-tab', undefined, { allowRepeat: true });
  }

  // ---- Alt shortcuts (Windows / Linux) ------------------------------
  if (!MAC && alt && !ctrl && !meta && !shift) {
    if (key === 'ArrowLeft') return result('back', undefined, { allowRepeat: true });
    if (key === 'ArrowRight') return result('forward', undefined, { allowRepeat: true });
    if (key === 'Home') return result('home');
    if (lower === 'd') return result('address');
  }

  if (!primary || alt) return null;

  // ---- Primary-modifier shortcuts (Ctrl on Win/Linux, Cmd on macOS) ---
  // Tab selection by number: 1-8 pick that tab, 9 picks the last tab.
  if (!shift && DIGIT_CODES[code]) return result('select-tab', DIGIT_CODES[code], { allowRepeat: true });

  if (key === 'PageDown') return result('next-tab', undefined, { allowRepeat: true });
  if (key === 'PageUp') return result('previous-tab', undefined, { allowRepeat: true });

  // Zoom. Match physical keys too so Ctrl+= works without holding Shift.
  if (!shift || key === '+') {
    if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return result('zoom-in', undefined, { allowRepeat: true });
  }
  if (!shift && (key === '-' || code === 'Minus' || code === 'NumpadSubtract')) return result('zoom-out', undefined, { allowRepeat: true });
  if (!shift && (code === 'Digit0' || code === 'Numpad0')) return result('zoom-reset');

  if (shift && key === 'Delete') return result('clear-data');
  if (key === ',' && !shift) return result('settings');

  switch (lower) {
    case 't': return result(shift ? 'reopen-tab' : 'new');
    case 'w': return result(shift ? 'close-window' : 'close');
    case 'l': return shift ? null : result('address');
    case 'k': return shift ? null : result('palette');
    case 'd': return shift ? null : result('bookmark');
    case 'b': return shift ? result('bookmarks') : null;
    case 'o': return shift ? result('bookmarks') : null;
    case 'h': return shift ? null : result('history');
    case 'j': return shift ? null : result('downloads');
    case 'e': return shift ? result('extensions') : null;
    case 'f': return shift ? null : result('find');
    case 'g': return result('find-next', shift ? 'previous' : 'next', { allowRepeat: true });
    case 'r': return shift ? result('reader') : result('reload');
    case 'a': return shift ? result('adblock') : null;
    case 'p': return shift ? null : result('print');
    case 'i': return shift ? result('devtools') : null;
    default: return null;
  }
}

module.exports = { matchShortcut };
