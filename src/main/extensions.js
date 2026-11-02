// Extension management for Drift.
//
// Drift loads Chromium (Chrome-compatible) extensions in two ways:
//   1. Chrome Web Store  — paste a store URL / extension ID in the Extensions
//      page, or click "Add to Chrome" on chromewebstore.google.com. Extensions
//      are downloaded as CRX files and auto-updated.
//   2. Unpacked folders  — any folder containing a Chromium manifest.json.
//
// Electron implements only a subset of the Chrome extension APIs, so
// compatibility depends on which APIs a given extension uses.

const path = require('path');
const fs = require('fs');
const {
  installChromeWebStore,
  downloadExtension,
  uninstallExtension,
  updateExtensions
} = require('electron-chrome-web-store');
const { describeExtension } = require('./extension-info');

// Chrome extension IDs are 32 characters using the letters a-p.
const EXTENSION_ID_PATTERN = /\b[a-p]{32}\b/;

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function extensionDirectoryName(manifest) {
  const rawName = String(manifest?.name || 'extension').replace(/__MSG_.*?__/g, 'extension');
  const safeName = rawName.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'extension';
  return `${safeName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Accepts a bare extension ID or any Chrome Web Store URL and returns the ID. */
function parseExtensionId(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const match = text.match(EXTENSION_ID_PATTERN);
  return match ? match[0] : null;
}

/**
 * @param {object} options
 * @param {(info: object) => Promise<boolean>} options.confirmInstall  shows Drift's themed "Add extension" dialog
 */
function createExtensionManager({ session: getSession, appDataDir, readJson, writeJson, confirmInstall, onChange }) {
  // Unpacked extensions are copied here so they survive the source folder moving.
  const UNPACKED_DIR = path.join(appDataDir, 'Extensions');
  // Chrome Web Store extensions are managed by electron-chrome-web-store.
  const WEBSTORE_DIR = path.join(appDataDir, 'ChromeWebStore');
  const UNPACKED_INDEX = 'extensions.json';

  let unpackedDirectories = [];
  const ses = () => getSession();
  const changed = () => { try { onChange?.(); } catch { /* UI refresh is best-effort */ } };

  function list() {
    try {
      return ses().extensions.getAllExtensions().map((extension) => ({
        id: extension.id,
        name: extension.name || 'Unnamed extension',
        version: extension.version || '',
        description: extension.manifest?.description || '',
        path: extension.path || '',
        source: isPathInside(WEBSTORE_DIR, extension.path || '') ? 'chrome-web-store' : 'unpacked'
      }));
    } catch { return []; }
  }

  /** "Add to Chrome" clicked on chromewebstore.google.com. */
  async function beforeWebStoreInstall(details) {
    let iconDataUrl = '';
    try { iconDataUrl = details?.icon && !details.icon.isEmpty() ? details.icon.toDataURL() : ''; } catch { /* no icon */ }
    const info = describeExtension({ id: details?.id, manifest: details?.manifest, name: details?.localizedName, iconDataUrl });
    const allowed = await confirmInstall({ ...info, source: 'web-page' });
    return { action: allowed ? 'allow' : 'deny' };
  }

  /** Enables "Add to Chrome" on chromewebstore.google.com and restores installed store extensions. */
  async function setupWebStore() {
    fs.mkdirSync(WEBSTORE_DIR, { recursive: true });
    try {
      await installChromeWebStore({
        session: ses(),
        extensionsPath: WEBSTORE_DIR,
        loadExtensions: true,
        autoUpdate: true,
        minimumManifestVersion: 3,
        beforeInstall: beforeWebStoreInstall
      });
    } catch (error) {
      console.warn('Drift could not enable the Chrome Web Store:', error?.message || error);
    }
  }

  /**
   * Pasted link / ID flow: download the CRX, show the themed confirmation with the
   * real manifest, then load it. Declining deletes the downloaded files.
   */
  async function installFromWebStore(input) {
    const id = parseExtensionId(input);
    if (!id) throw new Error('Paste a Chrome Web Store link or a 32-letter extension ID.');
    if (list().some((entry) => entry.id === id)) throw new Error('That extension is already installed.');

    fs.mkdirSync(WEBSTORE_DIR, { recursive: true });
    let folder;
    try { folder = await downloadExtension(id, WEBSTORE_DIR); }
    catch (error) {
      throw new Error(`Could not download that extension from the Chrome Web Store. Check the link or ID and your connection. (${error?.message || error})`);
    }
    const discard = () => { try { fs.rmSync(path.join(WEBSTORE_DIR, id), { recursive: true, force: true }); } catch { /* best effort */ } };

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')); }
    catch { discard(); throw new Error('The downloaded extension has an invalid manifest.'); }
    if (Number(manifest.manifest_version) < 3) {
      discard();
      throw new Error('This extension uses the outdated Manifest V2 format, which Drift does not install from the Chrome Web Store.');
    }

    const info = describeExtension({ id, manifest, folder });
    const allowed = await confirmInstall({ ...info, source: 'pasted-link' });
    if (!allowed) { discard(); const cancelled = new Error('cancelled'); cancelled.cancelled = true; throw cancelled; }

    try {
      const extension = await ses().extensions.loadExtension(folder, { allowFileAccess: false });
      changed();
      return extension;
    } catch (error) {
      discard();
      throw error;
    }
  }

  async function installFromFolder(folder) {
    const chosenFolder = String(folder || '').trim();
    if (!chosenFolder) throw new Error('Select an unpacked extension folder containing manifest.json.');
    const sourceFolder = path.resolve(chosenFolder);
    const sourceManifestPath = path.join(sourceFolder, 'manifest.json');
    if (!fs.existsSync(sourceManifestPath)) throw new Error('Select an unpacked extension folder containing manifest.json.');

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')); }
    catch { throw new Error('The selected extension has an invalid manifest.json file.'); }
    if (!manifest || ![2, 3].includes(Number(manifest.manifest_version))) throw new Error('The extension manifest must use Chromium Manifest V2 or V3.');

    // Copy into the Drift profile so availability does not depend on the
    // original extraction folder or a removable drive.
    let managedFolder = sourceFolder;
    let copiedFolder = false;
    if (!isPathInside(UNPACKED_DIR, sourceFolder)) {
      managedFolder = path.join(UNPACKED_DIR, extensionDirectoryName(manifest));
      try { fs.cpSync(sourceFolder, managedFolder, { recursive: true, errorOnExist: true, force: false, dereference: true }); }
      catch (error) { throw new Error(`Could not copy the extension into Drift's AppData profile: ${error?.message || error}`); }
      copiedFolder = true;
    }

    if (unpackedDirectories.some((entry) => path.resolve(entry) === path.resolve(managedFolder))) return list();
    try {
      await ses().extensions.loadExtension(managedFolder, { allowFileAccess: false });
    } catch (error) {
      if (copiedFolder) { try { fs.rmSync(managedFolder, { recursive: true, force: true }); } catch { /* preserve install error */ } }
      throw error;
    }
    unpackedDirectories.push(managedFolder);
    writeJson(UNPACKED_INDEX, unpackedDirectories);
    changed();
    return list();
  }

  async function remove(id) {
    const extensionId = String(id || '');
    const extension = list().find((entry) => entry.id === extensionId);
    if (!extension) throw new Error('Extension not found.');

    if (extension.source === 'chrome-web-store') {
      await uninstallExtension(extensionId, { session: ses(), extensionsPath: WEBSTORE_DIR });
      return;
    }
    await ses().extensions.removeExtension(extensionId);
    unpackedDirectories = unpackedDirectories.filter((folder) => path.resolve(folder) !== path.resolve(extension.path));
    if (isPathInside(UNPACKED_DIR, extension.path)) {
      try { fs.rmSync(extension.path, { recursive: true, force: true }); }
      catch (error) { console.warn('Drift could not remove extension files:', error?.message || error); }
    }
    writeJson(UNPACKED_INDEX, unpackedDirectories);
  }

  /** Called once at startup, after the session is configured. */
  async function restore() {
    fs.mkdirSync(UNPACKED_DIR, { recursive: true });

    // Chrome Web Store extensions (also loads previously installed ones).
    await setupWebStore();

    // Unpacked extensions.
    const saved = readJson(UNPACKED_INDEX, []);
    unpackedDirectories = Array.isArray(saved) ? saved : [];
    const restored = [];
    for (const savedFolder of unpackedDirectories.slice()) {
      let folder = path.resolve(String(savedFolder || ''));
      try {
        const manifestPath = path.join(folder, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        if (!isPathInside(UNPACKED_DIR, folder)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const managedFolder = path.join(UNPACKED_DIR, extensionDirectoryName(manifest));
          fs.cpSync(folder, managedFolder, { recursive: true, errorOnExist: true, force: false, dereference: true });
          folder = managedFolder;
        }
        await ses().extensions.loadExtension(folder, { allowFileAccess: false });
        restored.push(folder);
      } catch (error) {
        console.warn('Drift skipped an unavailable extension:', folder, error?.message || error);
      }
    }
    if (JSON.stringify(restored) !== JSON.stringify(unpackedDirectories)) {
      unpackedDirectories = restored;
      writeJson(UNPACKED_INDEX, unpackedDirectories);
    }
  }

  /** Checks all Chrome Web Store extensions for updates (also runs automatically). */
  async function checkForUpdates() {
    try { await updateExtensions(ses()); changed(); } catch (error) { console.warn('Extension update check failed:', error?.message || error); }
  }

  return {
    directory: UNPACKED_DIR,
    webStoreDirectory: WEBSTORE_DIR,
    list,
    restore,
    installFromWebStore,
    installFromFolder,
    remove,
    checkForUpdates
  };
}

module.exports = { createExtensionManager, parseExtensionId };
