// Builds the data shown in Drift's "Add extension" confirmation dialog:
// a resolved name/description, an icon, and human-readable permissions.

const fs = require('fs');
const path = require('path');

// level: 'normal' | 'broad' (broad = can see or change a lot of personal data)
const PERMISSION_TEXT = {
  activeTab: ['Access the current tab when you use the extension', 'normal'],
  alarms: ['Schedule background tasks', 'normal'],
  background: null,
  bookmarks: ['Read and change your bookmarks', 'broad'],
  browsingData: ['Clear your browsing data', 'broad'],
  clipboardRead: ['Read data you copy to the clipboard', 'broad'],
  clipboardWrite: ['Write to the clipboard', 'normal'],
  contextMenus: ['Add items to the right-click menu', 'normal'],
  cookies: ['Read and change your cookies', 'broad'],
  declarativeContent: ['Take actions based on page content', 'normal'],
  declarativeNetRequest: ['Block content on pages', 'normal'],
  declarativeNetRequestWithHostAccess: ['Block or modify content on pages you visit', 'normal'],
  declarativeNetRequestFeedback: ['See which content it blocked', 'normal'],
  downloads: ['Manage your downloads', 'normal'],
  favicon: ['Read site icons', 'normal'],
  geolocation: ['Detect your physical location', 'broad'],
  history: ['Read and change your browsing history', 'broad'],
  identity: ['Identify you with your account', 'normal'],
  idle: ['Detect when you are idle', 'normal'],
  management: ['Manage your other extensions', 'broad'],
  nativeMessaging: ['Communicate with other programs on your computer', 'broad'],
  notifications: ['Show notifications', 'normal'],
  offscreen: ['Run hidden background pages', 'normal'],
  privacy: ['Change your privacy settings', 'broad'],
  proxy: ['Control your proxy settings', 'broad'],
  scripting: ['Run scripts on the sites it can access', 'normal'],
  sessions: ['Read recently closed tabs', 'normal'],
  sidePanel: ['Show a side panel', 'normal'],
  storage: ['Store its settings in your profile', 'normal'],
  tabGroups: ['Organize your tab groups', 'normal'],
  tabs: ['See the addresses and titles of your open tabs', 'broad'],
  topSites: ['See your most visited sites', 'broad'],
  unlimitedStorage: ['Store unlimited data', 'normal'],
  webNavigation: ['See how you move between pages', 'broad'],
  webRequest: ['Observe the network requests your tabs make', 'broad'],
  webRequestBlocking: ['Block or modify network requests', 'broad']
};

const ALL_SITE_PATTERN = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\/?|https?:\/\/\*\/?)$/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Resolves "__MSG_key__" using the extension's own _locales folder. */
function localize(value, manifest, folder) {
  const text = String(value || '');
  const match = text.match(/^__MSG_(.+)__$/);
  if (!match || !folder) return text;
  const key = match[1];
  const locales = [manifest?.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const locale of locales) {
    const messages = readJson(path.join(folder, '_locales', locale, 'messages.json'));
    const entry = messages && (messages[key] || messages[key.toLowerCase()] ||
      Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]);
    if (entry?.message) return String(entry.message);
  }
  return '';
}

function readIcon(manifest, folder) {
  if (!folder) return '';
  const icons = manifest?.icons || manifest?.action?.default_icon || manifest?.browser_action?.default_icon || {};
  const candidates = typeof icons === 'string' ? [[0, icons]] : Object.entries(icons).map(([size, file]) => [Number(size) || 0, file]);
  candidates.sort((a, b) => b[0] - a[0]);
  for (const [, file] of candidates) {
    if (typeof file !== 'string') continue;
    const full = path.resolve(folder, file);
    const relative = path.relative(path.resolve(folder), full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const ext = path.extname(full).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : '';
    if (!mime) continue;
    try {
      const data = fs.readFileSync(full);
      if (data.length <= 512 * 1024) return `data:${mime};base64,${data.toString('base64')}`;
    } catch { /* try the next size */ }
  }
  return '';
}

function describeSites(patterns) {
  const hosts = [];
  for (const pattern of patterns) {
    const match = String(pattern).match(/^(?:\*|https?|file|ftp):\/\/([^/]+)/i);
    if (match) hosts.push(match[1].replace(/^\*\./, ''));
  }
  const unique = [...new Set(hosts)];
  if (!unique.length) return null;
  const shown = unique.slice(0, 3).join(', ');
  return `Read and change your data on ${shown}${unique.length > 3 ? ` and ${unique.length - 3} more site${unique.length - 3 === 1 ? '' : 's'}` : ''}`;
}

function describePermissions(manifest) {
  const items = [];
  const hostPatterns = [
    ...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : []),
    ...(Array.isArray(manifest?.permissions) ? manifest.permissions.filter((p) => typeof p === 'string' && (/^<all_urls>$/.test(p) || /:\/\//.test(p))) : [])
  ].filter((p) => typeof p === 'string');

  if (hostPatterns.some((pattern) => ALL_SITE_PATTERN.test(pattern))) {
    items.push({ text: 'Read and change your data on all websites', level: 'broad' });
  } else {
    const sites = describeSites(hostPatterns);
    if (sites) items.push({ text: sites, level: 'broad' });
  }

  const apiPermissions = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  for (const permission of apiPermissions) {
    if (typeof permission !== 'string' || permission === '<all_urls>' || /:\/\//.test(permission)) continue;
    if (Object.prototype.hasOwnProperty.call(PERMISSION_TEXT, permission)) {
      const entry = PERMISSION_TEXT[permission];
      if (entry) items.push({ text: entry[0], level: entry[1] });
    } else {
      items.push({ text: `Use the “${permission}” permission`, level: 'normal' });
    }
  }

  // Broad access first, then alphabetical for a stable, scannable list.
  const rank = (entry) => (/^Read and change your data on/.test(entry.text) ? 0 : entry.level === 'broad' ? 1 : 2);
  items.sort((a, b) => (rank(a) - rank(b)) || a.text.localeCompare(b.text));
  const seen = new Set();
  return items.filter((entry) => (seen.has(entry.text) ? false : seen.add(entry.text)));
}

/**
 * @param {object} args
 * @param {string} args.id            Chrome Web Store extension id
 * @param {object} args.manifest      parsed manifest.json
 * @param {string} [args.folder]      extracted extension folder (for icons / locales)
 * @param {string} [args.name]        pre-localized name, if known
 * @param {string} [args.iconDataUrl] pre-rendered icon, if known
 */
function describeExtension({ id, manifest, folder, name, iconDataUrl }) {
  const resolvedName = name || localize(manifest?.name, manifest, folder) || manifest?.short_name || 'This extension';
  return {
    id,
    name: resolvedName,
    version: String(manifest?.version || ''),
    description: localize(manifest?.description, manifest, folder),
    icon: iconDataUrl || readIcon(manifest, folder),
    manifestVersion: Number(manifest?.manifest_version) || 0,
    permissions: describePermissions(manifest)
  };
}

module.exports = { describeExtension, describePermissions };
