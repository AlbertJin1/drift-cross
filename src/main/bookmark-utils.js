'use strict';

function normalizeBookmarkUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    return parsed.href;
  } catch { return ''; }
}

function normalizeFavicon(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

// Returns a new list so the caller never leaves a renderer-owned array or the
// cached snapshot half-mutated if a target is missing.
function reorderBookmarkList(bookmarks, sourceUrl, targetUrl, after = false) {
  if (!Array.isArray(bookmarks) || !sourceUrl || !targetUrl || sourceUrl === targetUrl) return null;
  const sourceIndex = bookmarks.findIndex((item) => item?.url === sourceUrl);
  if (sourceIndex < 0) return null;
  const next = bookmarks.slice();
  const [source] = next.splice(sourceIndex, 1);
  const targetIndex = next.findIndex((item) => item?.url === targetUrl);
  if (targetIndex < 0) return null;
  const insertAt = Math.max(0, Math.min(next.length, targetIndex + (after === true ? 1 : 0)));
  next.splice(insertAt, 0, source);
  return next;
}

function moveBookmarkBy(bookmarks, url, delta) {
  if (!Array.isArray(bookmarks) || !url || ![-1, 1].includes(delta)) return null;
  const index = bookmarks.findIndex((item) => item?.url === url);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= bookmarks.length) return null;
  const next = bookmarks.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

module.exports = { normalizeBookmarkUrl, normalizeFavicon, reorderBookmarkList, moveBookmarkBy };
