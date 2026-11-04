'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const responsive = fs.readFileSync(path.join(root, 'src/renderer/browser/responsive.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/renderer/shared/style.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

assert.match(responsive, /new ResizeObserver\(scheduleResponsive\)/, 'layout tracks actual root size changes');
assert.match(responsive, /window\.addEventListener\('resize', scheduleResponsive\)/, 'layout tracks window resizing');
assert.match(responsive, /matchMedia\(`\(resolution:/, 'layout reflows when display scale/DPI changes');
assert.match(responsive, /scheduleTabLayout\(\)/, 'tab layout is recalculated after responsive changes');
assert.match(responsive, /layoutBookmarksBar\(\)/, 'bookmark overflow is recalculated after responsive changes');
assert.match(styles, /@media \(max-width: 520px\)/, 'narrow window styles exist');
assert.match(styles, /@media \(max-width: 780px\)/, 'small window styles exist');
assert.match(styles, /@media \(max-width: 950px\)/, 'medium window styles exist');
assert.match(styles, /@container ipage/, 'settings adapt to their own container width');
assert.match(styles, /\.about-update \.about-profile-row > button \{ width: 100%/, 'About update actions fill the narrow layout without overflowing');
assert.match(main, /screen\.on\('display-metrics-changed', relayout\)/, 'native browser view tracks display/DPI changes');
console.log('Responsive UI checks passed (11 assertions).');
