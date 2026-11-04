'use strict';

const DEFAULT_APPEARANCE_OPTIONS = Object.freeze({
  accentColor: '',
  density: 'comfortable',
  fontScale: 100,
  fontFamily: 'system',
  cornerStyle: 'soft',
  tabStyle: 'underline',
  tabWidth: 'balanced',
  motion: 'full',
  chromeTint: 'balanced',
  bookmarkDisplay: 'labels',
  newTabBackground: 'aurora',
  newTabLayout: 'centered',
  newTabTileSize: 'medium'
});

const ENUMS = Object.freeze({
  density: ['compact', 'comfortable', 'spacious'],
  fontFamily: ['system', 'inter', 'segoe', 'arial'],
  cornerStyle: ['square', 'soft', 'rounded'],
  tabStyle: ['underline', 'card', 'pill', 'minimal'],
  tabWidth: ['compact', 'balanced', 'wide'],
  motion: ['full', 'reduced', 'off'],
  chromeTint: ['neutral', 'subtle', 'balanced', 'strong'],
  bookmarkDisplay: ['labels', 'icons'],
  newTabBackground: ['aurora', 'midnight', 'paper', 'forest', 'sunset'],
  newTabLayout: ['centered', 'wide', 'compact'],
  newTabTileSize: ['small', 'medium', 'large']
});
const FONT_SCALES = new Set([90, 95, 100, 105, 110, 115, 120]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeAppearanceOptions(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = { ...DEFAULT_APPEARANCE_OPTIONS };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(source[key])) result[key] = source[key];
  }
  const fontScale = Number(source.fontScale);
  if (FONT_SCALES.has(fontScale)) result.fontScale = fontScale;
  if (typeof source.accentColor === 'string' && (source.accentColor === '' || HEX_COLOR.test(source.accentColor))) {
    result.accentColor = source.accentColor.toLowerCase();
  }
  return result;
}

module.exports = { DEFAULT_APPEARANCE_OPTIONS, normalizeAppearanceOptions };
