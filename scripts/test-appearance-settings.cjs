'use strict';
const assert = require('node:assert/strict');
const { DEFAULT_APPEARANCE_OPTIONS, normalizeAppearanceOptions } = require('../src/main/appearance-settings');

const defaults = normalizeAppearanceOptions();
assert.deepEqual(defaults, { ...DEFAULT_APPEARANCE_OPTIONS });

const valid = normalizeAppearanceOptions({
  accentColor: '#12aBcD', density: 'spacious', fontScale: 115, fontFamily: 'segoe',
  cornerStyle: 'rounded', tabStyle: 'pill', tabWidth: 'wide', motion: 'reduced',
  chromeTint: 'strong', bookmarkDisplay: 'icons', newTabBackground: 'forest',
  newTabLayout: 'wide', newTabTileSize: 'large'
});
assert.equal(valid.accentColor, '#12abcd');
assert.equal(valid.density, 'spacious');
assert.equal(valid.fontScale, 115);
assert.equal(valid.tabStyle, 'pill');
assert.equal(valid.newTabBackground, 'forest');
assert.equal(valid.newTabTileSize, 'large');

const invalid = normalizeAppearanceOptions({
  accentColor: 'url(javascript:alert(1))', density: 'ultra', fontScale: 999,
  fontFamily: 'Comic Sans from nowhere', cornerStyle: '__proto__', tabStyle: 'injected',
  tabWidth: 0, motion: 'blink', chromeTint: 'full', bookmarkDisplay: 'everything',
  newTabBackground: 'file:///etc/passwd', newTabLayout: 'absolute', newTabTileSize: -1
});
assert.deepEqual(invalid, { ...DEFAULT_APPEARANCE_OPTIONS });
assert.deepEqual(normalizeAppearanceOptions(null), { ...DEFAULT_APPEARANCE_OPTIONS });
assert.deepEqual(normalizeAppearanceOptions(['dark']), { ...DEFAULT_APPEARANCE_OPTIONS });
assert.equal(normalizeAppearanceOptions({ accentColor: '#000000' }).accentColor, '#000000');
assert.equal(normalizeAppearanceOptions({ accentColor: '#fff' }).accentColor, '');
console.log('Appearance settings tests passed (11 assertions).');
