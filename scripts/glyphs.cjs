'use strict';
/**
 * Drift Glyphs: the interface icon set, drawn for Drift.
 *
 * Design language
 *  - 24 x 24 grid, 1.8 stroke, round caps and joins, generous corner radii.
 *  - Duotone: the main silhouette uses currentColor; one detail per icon is
 *    marked class="ac" and takes the accent (--glyph-accent, usually the
 *    theme's cyan), the same way the wind lines pick out the Drift mark.
 *  - class="fl" shapes are solid (dots, filled states) and use the accent too.
 *  - class="so" shapes are solid in the main colour (filled star / bookmark).
 *
 * Edit this file, then run `npm run icons:build` to regenerate
 * src/renderer/shared/icons.js.
 */
module.exports = {
  // navigation + address bar
  back:     '<path d="M10.5 5.5 4 12l6.5 6.5"/><path d="M4.5 12H15"/><path class="ac" d="M18.5 12H20"/>',
  forward:  '<path d="M13.5 5.5 20 12l-6.5 6.5"/><path d="M19.5 12H9"/><path class="ac" d="M5.5 12H4"/>',
  home:     '<path d="M3.8 11.4 12 4l8.2 7.4"/><path d="M6 9.6v8.9A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V9.6"/><path class="ac" d="M10 20v-4.2a2 2 0 0 1 4 0V20"/>',
  reload:   '<path d="M19.6 12.2A7.7 7.7 0 1 1 17.3 6.7"/><path class="ac" d="M19.8 4.2v4.4h-4.4"/>',
  globe:    '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path class="ac" d="M12 3.4c2.4 2.3 3.6 5.1 3.6 8.6s-1.2 6.3-3.6 8.6c-2.4-2.3-3.6-5.1-3.6-8.6S9.6 5.7 12 3.4Z"/>',
  lock:     '<rect x="5" y="10.5" width="14" height="9.5" rx="3"/><path d="M8.2 10.5V8.2a3.8 3.8 0 0 1 7.6 0v2.3"/><path class="ac" d="M12 14.4v2"/>',
  star:     '<path d="m12 3.9 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-3.9 5.5-.8Z"/>',
  starFill: '<path class="so" d="m12 3.9 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-3.9 5.5-.8Z"/>',

  // toolbar
  bookmark:     '<path d="M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4.1L6 20V5.5A1.5 1.5 0 0 1 7.5 4Z"/><path class="ac" d="M9.6 8.2h4.8"/>',
  bookmarkFill: '<path class="so" d="M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4.1L6 20V5.5A1.5 1.5 0 0 1 7.5 4Z"/><path class="ac-on" d="M9.6 8.2h4.8"/>',
  history:  '<path d="M4.2 12a7.9 7.9 0 1 0 2.4-5.7"/><path d="M4.2 4.6v3.9h3.9"/><path class="ac" d="M12 8v4.2l2.9 1.8"/>',
  download: '<path d="M5 15v2.5A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V15"/><path class="ac" d="M12 4.5v10.2"/><path class="ac" d="m8 11 4 4 4-4"/>',
  puzzle:   '<path d="M9.2 5.4a2.3 2.3 0 0 1 4.6 0V6.5h3.1A1.6 1.6 0 0 1 18.5 8.1v3H19.6a2.3 2.3 0 0 1 0 4.6H18.5v2.9a1.6 1.6 0 0 1-1.6 1.6h-3.1v-1.1a2.3 2.3 0 0 0-4.6 0v1.1H6.1a1.6 1.6 0 0 1-1.6-1.6v-3.1H5.6a2.3 2.3 0 0 0 0-4.6H4.5V8.1a1.6 1.6 0 0 1 1.6-1.6h3.1Z"/>',
  shield:   '<path d="M12 3.4 5.2 6v5.4c0 4.3 2.8 7.4 6.8 9.2 4-1.8 6.8-4.9 6.8-9.2V6Z"/><path class="ac" d="m8.9 12 2.3 2.3 4-4.4"/>',
  search:   '<circle cx="10.6" cy="10.6" r="6.4"/><path class="ac" d="m15.4 15.4 4.6 4.6"/>',
  book:     '<path d="M12 6.4C10.2 5 7.8 4.6 4.6 4.8v12.6c3.2-.2 5.6.2 7.4 1.6 1.8-1.4 4.2-1.8 7.4-1.6V4.8c-3.2-.2-5.6.2-7.4 1.6Z"/><path class="ac" d="M12 6.4V19"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="3.5"/><path d="m8 10 3 2.4L8 14.8"/><path class="ac" d="M13 15h3.4"/>',
  gear:     '<circle class="ac" cx="12" cy="12" r="2.9"/><circle cx="12" cy="12" r="6.3"/><path d="M12 2.4v2M12 19.6v2M2.4 12h2M19.6 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  more:     '<circle class="fl" cx="5.5" cy="12" r="2"/><circle class="so" cx="12" cy="12" r="2"/><circle class="fl" cx="18.5" cy="12" r="2"/>',

  // window + tabs + dialogs
  minus:    '<path d="M5.5 12h13"/>',
  square:   '<rect x="5.5" y="5.5" width="13" height="13" rx="3.2"/>',
  restore:  '<rect x="4.5" y="9" width="10.5" height="10.5" rx="2.8"/><path class="ac" d="M9 9V7.8A2.8 2.8 0 0 1 11.8 5h5.4A2.8 2.8 0 0 1 20 7.8v5.4a2.8 2.8 0 0 1-2.8 2.8H15.5"/>',
  close:    '<path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8"/>',
  plus:     '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
  up:       '<path d="m6 14.8 6-6 6 6"/>',
  down:     '<path d="m6 9.2 6 6 6-6"/>',
  link:     '<path d="M10.2 13.8a3.9 3.9 0 0 0 5.5 0l3-3a3.9 3.9 0 0 0-5.5-5.5l-.9.9"/><path class="ac" d="M13.8 10.2a3.9 3.9 0 0 0-5.5 0l-3 3a3.9 3.9 0 0 0 5.5 5.5l.9-.9"/>',
  check:    '<path d="m5 12.6 4.6 4.6L19 7.6"/>',

  // settings + pages
  sliders:  '<path d="M4 7h8.5M17.5 7H20M4 12h2.5M11.5 12H20M4 17h9.5M18.5 17H20"/><circle class="ac" cx="15" cy="7" r="2.4"/><circle class="ac" cx="9" cy="12" r="2.4"/><circle class="ac" cx="16" cy="17" r="2.4"/>',
  palette:  '<path d="M12 3.6a8.4 8.4 0 1 0 0 16.8c1.4 0 2.1-.9 2.1-1.9 0-.6-.3-1.1-.6-1.5-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.9-1.8H17a3.5 3.5 0 0 0 3.5-3.5C20.5 7 16.7 3.6 12 3.6Z"/><circle class="fl" cx="7.8" cy="12" r="1.1"/><circle class="fl" cx="10" cy="7.9" r="1.1"/><circle class="fl" cx="14.6" cy="7.7" r="1.1"/>',
  newtab:   '<rect x="4" y="4" width="16" height="16" rx="4.6"/><path class="ac" d="M12 8.6v6.8M8.6 12h6.8"/>',
  list:     '<path d="M9.5 7h10.5M9.5 12h10.5M9.5 17h10.5"/><circle class="fl" cx="4.9" cy="7" r="1.2"/><circle class="fl" cx="4.9" cy="12" r="1.2"/><circle class="fl" cx="4.9" cy="17" r="1.2"/>',
  info:     '<circle cx="12" cy="12" r="8.6"/><path class="ac" d="M12 11.2v5"/><circle class="fl" cx="12" cy="7.9" r="1.1"/>',
  warn:     '<path d="M12 4.3 3.9 18.4a1.3 1.3 0 0 0 1.1 1.9h14a1.3 1.3 0 0 0 1.1-1.9Z"/><path class="ac" d="M12 9.6v4.4"/><circle class="fl" cx="12" cy="16.9" r="1"/>',
  file:     '<path d="M7.5 3.8h6l5 5V19a1.5 1.5 0 0 1-1.5 1.5H7.5A1.5 1.5 0 0 1 6 19V5.3a1.5 1.5 0 0 1 1.5-1.5Z"/><path class="ac" d="M13.5 3.8v5h5"/>',
  arrowRight: '<path d="M13.5 5.5 20 12l-6.5 6.5"/><path d="M19.5 12H9"/><path class="ac" d="M5.5 12H4"/>',

  // command palette
  external: '<path class="ac" d="M13.5 4.5h6v6M19.5 4.5l-8 8"/><path d="M17.5 14.5v3a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 1-2.5-2.5V9.5A2.5 2.5 0 0 1 7 7h3"/>',
  tab:      '<rect x="3.5" y="5" width="17" height="14" rx="3.5"/><path d="M3.5 9.6h17"/><circle class="fl" cx="7" cy="7.3" r=".9"/>'
};
