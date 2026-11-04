'use strict';
const assert = require('node:assert/strict');
const { normalizeBookmarkUrl, normalizeFavicon, reorderBookmarkList, moveBookmarkBy } = require('../src/main/bookmark-utils');
const { evaluatePopup } = require('../src/main/protection');

const list = [
  { url: 'https://one.example/' },
  { url: 'https://two.example/' },
  { url: 'https://three.example/' },
  { url: 'https://four.example/' }
];
const urls = (items) => items.map((item) => item.url);

assert.equal(normalizeBookmarkUrl('https://example.com'), 'https://example.com/');
assert.equal(normalizeBookmarkUrl('javascript:alert(1)'), '');
assert.equal(normalizeBookmarkUrl('file:///tmp/page.html'), '');
assert.equal(normalizeFavicon('data:image/png;base64,AA=='), '');
assert.equal(normalizeFavicon('https://example.com/icon.png'), 'https://example.com/icon.png');

// Regression for the reported first-bookmark issue: the first item can move to
// the middle/end, and other items can move ahead of the first item.
assert.deepEqual(urls(reorderBookmarkList(list, list[0].url, list[2].url, true)), [list[1].url, list[2].url, list[0].url, list[3].url]);
assert.deepEqual(urls(reorderBookmarkList(list, list[0].url, list[3].url, true)), [list[1].url, list[2].url, list[3].url, list[0].url]);
assert.deepEqual(urls(reorderBookmarkList(list, list[2].url, list[0].url, false)), [list[2].url, list[0].url, list[1].url, list[3].url]);
assert.equal(reorderBookmarkList(list, list[0].url, 'https://missing.example/', false), null);
assert.equal(reorderBookmarkList(list, list[0].url, list[0].url, true), null);
assert.deepEqual(urls(moveBookmarkBy(list, list[0].url, 1)), [list[1].url, list[0].url, list[2].url, list[3].url]);
assert.equal(moveBookmarkBy(list, list[0].url, -1), null);
assert.deepEqual(urls(list), ['https://one.example/', 'https://two.example/', 'https://three.example/', 'https://four.example/'], 'helpers must not mutate persisted input arrays');

const isBlocked = (host) => host === 'doubleclick.net' || host.endsWith('.doubleclick.net') ? 'doubleclick.net' : '';
let result = evaluatePopup({ url: 'https://ads.doubleclick.net/popup', referrer: { url: 'https://publisher.example/' }, userGesture: true }, {
  now: 5000, lastGestureAt: 4800, adBlockEnabled: true, popupBlockEnabled: true, blockedDomainFor: isBlocked
});
assert.equal(result.block, true);
assert.equal(result.reason, 'advertising-host');
result = evaluatePopup({ url: 'https://popup.example/' }, {
  now: 5000, lastGestureAt: 0, adBlockEnabled: true, popupBlockEnabled: true, blockedDomainFor: isBlocked
});
assert.equal(result.block, true);
assert.equal(result.reason, 'no-recent-user-gesture');
result = evaluatePopup({ url: 'https://popup.example/' }, {
  now: 5000, lastGestureAt: 4500, adBlockEnabled: true, popupBlockEnabled: true, blockedDomainFor: isBlocked
});
assert.equal(result.block, false, 'recent trusted click/keyboard action allows a normal popup link');
result = evaluatePopup({ url: 'https://ads.doubleclick.net/popup', referrer: { url: 'https://trusted.example/' }, userGesture: true }, {
  now: 5000, lastGestureAt: 0, adBlockEnabled: true, popupBlockEnabled: true,
  blockedDomainFor: isBlocked, isSiteAllowed: (host) => host === 'trusted.example'
});
assert.equal(result.block, false, 'a trusted click on an excepted site may open its requested web page');
result = evaluatePopup({ url: 'https://popup.example/', referrer: { url: 'https://trusted.example/' } }, {
  now: 5000, lastGestureAt: 0, adBlockEnabled: true, popupBlockEnabled: true,
  blockedDomainFor: isBlocked, isSiteAllowed: (host) => host === 'trusted.example'
});
assert.equal(result.block, true, 'an ad-block site exception does not disable the independent pop-up blocker');
result = evaluatePopup({ url: 'javascript:alert(1)' }, { now: 5000, lastGestureAt: 4900, popupBlockEnabled: false });
assert.equal(result.block, true, 'unsupported schemes remain blocked even when popup blocking is disabled');
result = evaluatePopup({ url: 'https://popup.example/' }, { now: 5000, lastGestureAt: 0, popupBlockEnabled: false, adBlockEnabled: false });
assert.equal(result.block, false, 'turning off popup protection permits valid web popups');

console.log('Bookmark and protection tests passed (23 assertions).');
