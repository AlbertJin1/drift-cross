'use strict';
/* -----------------------------------------------------------------------------
   Drift profiles (browser chrome side).

   - A round avatar button in the toolbar shows the profile this window uses.
   - Its menu lists every profile; choosing one opens it in its own window.
   - "Add profile" / "Edit" use one dialog (name + colour). "Delete" asks first.
   - Settings > Profiles lists the same profiles with Open / Edit / Delete.

   All real work (creating, renaming, deleting, launching) happens in the main
   process (profiles.js + main.js); this file only draws and asks.
   ----------------------------------------------------------------------------- */

const PM = {
  open: false, list: null, activeId: '', colors: [], max: 20,
  loading: false, sig: '', rev: 0,
  dialog: { mode: 'new', id: '', color: '', busy: false }
};
const PM_DEFAULT_COLORS = ['#7c5cff', '#0ea5e9', '#22a06b', '#e5484d', '#f59e0b', '#4f46e5', '#64748b', '#14b8a6'];
const PM_COLOR_RE = /^#[0-9a-f]{6}$/i;
const PM_COLOR_NAMES = { '#7c5cff': 'Violet', '#0ea5e9': 'Sky', '#22a06b': 'Green', '#e5484d': 'Red', '#f59e0b': 'Amber', '#4f46e5': 'Indigo', '#64748b': 'Slate', '#14b8a6': 'Teal' };

const pmColor = (color) => (PM_COLOR_RE.test(color || '') ? color : PM_DEFAULT_COLORS[0]);
function pmInitial(name) { const first = Array.from(String(name || '').trim())[0]; return first ? first.toUpperCase() : '?'; }
function pmInk(color) { // readable letter colour on top of the avatar colour
  const n = parseInt(pmColor(color).slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 165 ? '#14161f' : '#ffffff';
}
// The letter lives in its own <b> so CSS can trim the font's built-in ascent/descent and centre the capital exactly.
function pmSetLetter(el, name) { el.innerHTML = `<b>${escapeHtml(pmInitial(name))}</b>`; }
function pmAvatar(profile, size = '') {
  return `<span class="profile-avatar ${size}" style="--pc:${pmColor(profile.color)};--pi:${pmInk(profile.color)}" aria-hidden="true"><b>${escapeHtml(pmInitial(profile.name))}</b></span>`;
}
const pmIcon = (name) => (window.fa ? window.fa(name) : '');
const pmCurrent = () => state.profile || { id: '', name: 'Default', color: PM_DEFAULT_COLORS[0], count: 1 };

// ---- Toolbar button ------------------------------------------------------------------
function syncProfileButton() {
  const p = state.profile; const btn = $('profile-btn');
  if (!btn || !p) return;
  const sig = `${p.name}|${p.color}|${p.count}|${p.isDefault}`;
  if (btn._sig === sig) return;
  btn._sig = sig;
  const avatar = $('profile-avatar');
  pmSetLetter(avatar, p.name);
  btn.style.setProperty('--pc', pmColor(p.color));
  const nm = $('profile-btn-name'); if (nm) nm.textContent = p.name;
  avatar.style.setProperty('--pc', pmColor(p.color));
  avatar.style.setProperty('--pi', pmInk(p.color));
  syncTaskbarBadge(p);
  btn.title = `Profile: ${p.name}`;
  btn.setAttribute('aria-label', `Profile menu. Current profile: ${p.name}`);
}

// ---- Taskbar icon ----------------------------------------------------------------------------------
// Each profile is its own taskbar app, so its button must say which profile it is. The icon is the Drift icon with a
// rounded-square "chip" in the profile colour, a contrasting ring and the profile's initial in the corner. Drawn here
// because only the renderer has fonts and a canvas; the main process packs the PNGs into a .ico and applies it to the
// window and to the pinned button. If drawing fails, a small overlay badge (the chip alone) is used instead.
// Nothing is shown while there is only the default profile.
function drawProfileChip(g, p, S = 64) { // draws the chip on a 64-unit grid scaled to S
  g.save(); g.scale(S / 64, S / 64);
  const squircle = (inset, r) => { g.beginPath(); g.roundRect(inset, inset, 64 - inset * 2, 64 - inset * 2, r); };
  const color = pmColor(p.color); const ink = pmInk(p.color);
  squircle(2, 20); g.fillStyle = 'rgba(12,14,22,.92)'; g.fill();          // dark outer edge keeps it visible on any taskbar
  squircle(6, 16); g.fillStyle = '#ffffff'; g.fill();                       // light ring
  squircle(10, 12); g.fillStyle = color; g.fill();
  g.save(); squircle(10, 12); g.clip();                                      // soft highlight across the top, a Drift-style sheen
  const sheen = g.createLinearGradient(0, 10, 0, 34); sheen.addColorStop(0, 'rgba(255,255,255,.35)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.fillRect(10, 10, 44, 24); g.restore();
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = '800 30px "Segoe UI", system-ui, sans-serif';
  const cap = g.measureText('H').actualBoundingBoxAscent; // centre the capital by its real height, not the font's line box
  g.fillText(pmInitial(p.name), 32, 32 + cap / 2);
  g.restore();
}
function profileBadgeDataUrl(p) { // the chip alone (fallback overlay icon)
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  drawProfileChip(canvas.getContext('2d'), p, 64);
  return canvas.toDataURL('image/png');
}
let pmBaseIcon = null;
function loadBaseIcon() { // the Drift app icon, handed over by the main process as a data URL (a file:// image would taint the canvas)
  return pmBaseIcon ||= drift.invoke('profile:icon-base').then((url) => new Promise((resolve, reject) => {
    if (!url) { reject(new Error('no base icon')); return; }
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('base icon failed to load')); img.src = url;
  })).catch((error) => { pmBaseIcon = null; throw error; });
}
const PM_ICON_SIZES = [256, 48, 32, 24, 16];
async function profileIconImages(p) {
  const base = await loadBaseIcon();
  return PM_ICON_SIZES.map((size) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(base, 0, 0, size, size);
    const chip = Math.round(size * (size <= 24 ? 0.62 : 0.5));      // bigger chip at tiny sizes so the letter stays readable
    g.save(); g.translate(size - chip, size - chip); drawProfileChip(g, p, chip); g.restore();
    return { size, dataUrl: canvas.toDataURL('image/png') };
  });
}
let pmIconToken = 0;
async function syncTaskbarBadge(p) {
  if (!window.drift || drift.platform !== 'win32') return;
  const token = ++pmIconToken;
  const show = (p.count || 1) > 1 || p.isDefault === false;
  const label = `Profile: ${p.name}`;
  if (!show) { // only the default profile exists: plain Drift icon
    try { drift.manage('profile:icon', [], ''); drift.manage('profile:badge', '', ''); } catch { /* cosmetic */ }
    return;
  }
  try {
    const images = await profileIconImages(p);
    if (token !== pmIconToken) return; // a newer name/colour arrived while drawing
    drift.manage('profile:icon', images, label);
  } catch {
    if (token !== pmIconToken) return;
    try { drift.manage('profile:badge', profileBadgeDataUrl(p), label); } catch { /* the badge is cosmetic */ }
  }
}

// ---- Data ------------------------------------------------------------------------------
function applyProfileList(result) {
  if (!result || !Array.isArray(result.profiles)) return false;
  PM.list = result.profiles;
  PM.activeId = result.activeId || PM.activeId;
  if (Array.isArray(result.colors) && result.colors.length) PM.colors = result.colors;
  if (Number.isInteger(result.max)) PM.max = result.max;
  const sig = JSON.stringify([PM.activeId, PM.list]);
  const changed = sig !== PM.sig;
  PM.sig = sig;
  if (changed) { PM.rev++; refreshProfileViews(); }
  return changed;
}
async function loadProfiles() {
  if (PM.loading) return;
  PM.loading = true;
  try { applyProfileList(await drift.invoke('profiles:list')); }
  catch { /* the list simply stays as it was */ }
  finally { PM.loading = false; }
}
function ensureProfilesLoaded() { if (!PM.list && !PM.loading) loadProfiles(); }
function onProfilesSettings() { return state.internalPage === 'settings' && currentSettingsSection === 'profiles'; }
function refreshProfileViews() {
  if (PM.open) renderProfileMenu();
  if (onProfilesSettings()) renderInternalPage(true);
}
// Keeps "Open in another window" accurate while the menu or the Profiles page is showing.
setInterval(() => { if (!document.hidden && (PM.open || onProfilesSettings())) loadProfiles(); }, 4000);

// ---- Menu --------------------------------------------------------------------------------
const pmRoot = document.createElement('div');
pmRoot.id = 'profile-menu'; pmRoot.className = 'drift-menu profile-menu hidden';
pmRoot.setAttribute('role', 'menu'); pmRoot.setAttribute('aria-label', 'Profiles');
document.body.appendChild(pmRoot);

function pmStatus(p) {
  if (p.id === PM.activeId || p.id === pmCurrent().id) return 'This window';
  return p.running ? 'Open in another window' : 'Click to open';
}
function pmState(p) { return (p.id === PM.activeId || p.id === pmCurrent().id) ? 'here' : p.running ? 'open' : 'idle'; }
function renderProfileMenu() {
  const focusId = pmRoot.contains(document.activeElement) ? (document.activeElement.dataset.profileId || document.activeElement.dataset.profileAction || '') : '';
  const cur = pmCurrent();
  const list = PM.list || [{ id: cur.id, name: cur.name, color: cur.color }];
  const activeId = PM.activeId || cur.id;
  const full = list.length >= PM.max;
  pmRoot.style.setProperty('--pc', pmColor(cur.color));
  pmRoot.innerHTML = `
    <div class="pm-current">
      ${pmAvatar(cur, 'lg')}
      <div class="pm-current-text"><small>Browsing as</small><strong title="${escapeHtml(cur.name)}">${escapeHtml(cur.name)}</strong></div>
      <button type="button" class="dm-row pm-edit" role="menuitem" data-profile-action="edit" data-profile-id="${escapeHtml(activeId)}" title="Edit this profile" aria-label="Edit profile ${escapeHtml(cur.name)}">${pmIcon('pen')}</button>
    </div>
    <div class="pm-head"><span>Switch profile</span><span class="pm-count">${list.length}/${PM.max}</span></div>
    <div class="pm-list" role="group" aria-label="Profiles">${list.map((p) => `
      <button type="button" class="dm-row pm-row${p.id === activeId ? ' current' : ''}" role="menuitemradio" aria-checked="${p.id === activeId}" data-profile-action="open" data-profile-id="${escapeHtml(p.id)}">
        <span class="pm-av">${pmAvatar(p)}<i class="pm-dot ${pmState(p)}" aria-hidden="true"></i></span>
        <span class="dm-text"><span class="dm-label">${escapeHtml(p.name)}</span><small>${pmStatus(p)}</small></span>
        ${p.id === activeId ? `<span class="pm-check">${pmIcon('check')}</span>` : `<span class="pm-go">${pmIcon('arrowRight')}</span>`}
      </button>`).join('')}
    </div>
    <div class="pm-foot">
      <button type="button" class="dm-row pm-foot-btn" role="menuitem" data-profile-action="add" ${full ? `disabled title="Limit of ${PM.max} profiles reached"` : ''}><span class="dm-ico">${pmIcon('userPlus')}</span><span class="dm-label">Add profile</span></button>
      <button type="button" class="dm-row pm-foot-btn" role="menuitem" data-profile-action="manage"><span class="dm-ico">${pmIcon('gear')}</span><span class="dm-label">Manage</span></button>
    </div>`;
  if (focusId) (pmRoot.querySelector(`[data-profile-id="${CSS.escape(focusId)}"]`) || pmRoot.querySelector(`[data-profile-action="${CSS.escape(focusId)}"]`))?.focus();
}
function positionProfileMenu() {
  const btn = $('profile-btn').getBoundingClientRect();
  const vw = window.innerWidth; const vh = window.innerHeight; const m = 8;
  pmRoot.style.maxHeight = `${Math.max(160, vh - btn.bottom - 12)}px`;
  const w = pmRoot.offsetWidth;
  pmRoot.style.left = `${Math.max(m, Math.min(btn.right - w, vw - w - m))}px`;
  pmRoot.style.top = `${btn.bottom + 6}px`;
}
function openProfileMenu() {
  if (PM.open) return;
  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeTabList === 'function') closeTabList();
  if (typeof DM !== 'undefined' && DM.open) closeDriftMenu();
  PM.open = true;
  renderProfileMenu();
  pmRoot.classList.remove('hidden');
  positionProfileMenu();
  $('profile-btn').classList.add('menu-open');
  $('profile-btn').setAttribute('aria-expanded', 'true');
  syncOverlay(true);
  loadProfiles();
  pmRoot.querySelector('.pm-row.current, .pm-row')?.focus();
}
function closeProfileMenu(returnFocus = false) {
  if (!PM.open) return;
  PM.open = false;
  pmRoot.classList.add('hidden'); pmRoot.innerHTML = '';
  $('profile-btn').classList.remove('menu-open');
  $('profile-btn').setAttribute('aria-expanded', 'false');
  syncOverlay();
  if (returnFocus) $('profile-btn').focus();
}
$('profile-btn').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); PM.open ? closeProfileMenu() : openProfileMenu(); });
document.addEventListener('pointerdown', (event) => {
  if (!PM.open || event.target.closest('#profile-menu, #profile-btn')) return;
  closeProfileMenu();
}, true);
window.addEventListener('resize', () => { if (PM.open) positionProfileMenu(); });
document.addEventListener('keydown', (event) => {
  if (!PM.open) return;
  const items = [...pmRoot.querySelectorAll('.dm-row:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeProfileMenu(true); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); (items[index + 1] || items[0])?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); (items[index - 1] || items[items.length - 1])?.focus(); }
  else if (event.key === 'Tab') { event.preventDefault(); (event.shiftKey ? items[index - 1] || items[items.length - 1] : items[index + 1] || items[0])?.focus(); }
}, true);
// A different menu opening (three-dot menu) closes this one.
document.addEventListener('pointerdown', (event) => { if (PM.open && event.target.closest('#toolbar-overflow')) closeProfileMenu(); }, true);

// ---- Add / edit dialog -------------------------------------------------------------------
function pmColors() { return PM.colors.length ? PM.colors : PM_DEFAULT_COLORS; }
function renderProfileSwatches() {
  $('profile-colors').innerHTML = pmColors().map((c) => {
    const on = c === PM.dialog.color;
    return `<button type="button" class="profile-swatch${on ? ' on' : ''}" role="radio" aria-checked="${on}" aria-label="${PM_COLOR_NAMES[c] || c}" title="${PM_COLOR_NAMES[c] || c}" data-profile-color="${c}" style="--pc:${pmColor(c)};--pi:${pmInk(c)}">${on ? pmIcon('check') : ''}</button>`;
  }).join('');
  renderProfilePreview();
}
function renderProfilePreview() {
  const preview = $('profile-preview');
  pmSetLetter(preview, $('profile-name').value);
  preview.style.setProperty('--pc', pmColor(PM.dialog.color));
  preview.style.setProperty('--pi', pmInk(PM.dialog.color));
}
function setProfileDialogError(message) {
  const el = $('profile-error');
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  $('profile-name').classList.toggle('invalid', !!message);
}
async function openProfileDialog(mode, id = '') {
  if (!PM.list) await loadProfiles();
  const existing = mode === 'edit' ? (PM.list || []).find((p) => p.id === id) : null;
  if (mode === 'edit' && !existing) return;
  if (mode === 'new' && (PM.list || []).length >= PM.max) { showAlert(`Drift supports up to ${PM.max} profiles. Delete one you no longer use to add another.`, 'Profile limit reached'); return; }
  const used = new Set((PM.list || []).map((p) => p.color));
  PM.dialog = { mode, id, busy: false, color: existing ? existing.color : (pmColors().find((c) => !used.has(c)) || pmColors()[0]) };
  $('profile-dialog-title').textContent = mode === 'new' ? 'Add profile' : 'Edit profile';
  $('profile-dialog-sub').textContent = mode === 'new'
    ? 'A profile keeps its own sign-ins, bookmarks, history, settings and extensions, separate from your other profiles.'
    : 'Change how this profile is named and colored.';
  $('profile-name').value = existing ? existing.name : '';
  $('profile-open-wrap').classList.toggle('hidden', mode !== 'new');
  $('profile-open').checked = true;
  $('profile-submit').textContent = mode === 'new' ? 'Create' : 'Save';
  $('profile-submit').disabled = false;
  setProfileDialogError('');
  renderProfileSwatches();
  openDialog('profileDialog');
  $('profile-name').focus(); $('profile-name').select();
}
$('profile-name').addEventListener('input', () => { setProfileDialogError(''); renderProfilePreview(); });
$('profile-colors').addEventListener('click', (event) => {
  const swatch = event.target.closest('[data-profile-color]');
  if (!swatch) return;
  PM.dialog.color = swatch.dataset.profileColor;
  renderProfileSwatches();
  $('profile-colors').querySelector('.profile-swatch.on')?.focus();
});
$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (PM.dialog.busy) return;
  const name = $('profile-name').value.trim();
  if (!name) { setProfileDialogError('Enter a name for the profile.'); $('profile-name').focus(); return; }
  PM.dialog.busy = true; $('profile-submit').disabled = true;
  let result;
  try {
    result = PM.dialog.mode === 'new'
      ? await drift.invoke('profiles:create', { name, color: PM.dialog.color, open: $('profile-open').checked })
      : await drift.invoke('profiles:update', PM.dialog.id, { name, color: PM.dialog.color });
  } catch (error) { result = { ok: false, error: 'Drift could not save the profile. Please try again.' }; }
  PM.dialog.busy = false; $('profile-submit').disabled = false;
  if (!result || !result.ok) { setProfileDialogError((result && result.error) || 'Drift could not save the profile.'); $('profile-name').focus(); return; }
  closeDialog('profileDialog');
  applyProfileList(result);
  if (result.warning) showAlert(`${result.warning}\n\nThe profile was created. You can open it from the profile menu.`, 'Profile created');
});

// ---- Actions ---------------------------------------------------------------------------------
async function openProfile(id) {
  const result = await drift.invoke('profiles:open', id).catch(() => ({ ok: false, error: 'Drift could not open the profile.' }));
  if (!result || !result.ok) { await showAlert((result && result.error) || 'Drift could not open the profile.', 'Could not open profile'); loadProfiles(); }
}
async function deleteProfile(id) {
  const profile = (PM.list || []).find((p) => p.id === id);
  if (!profile) return;
  const confirmed = await showConfirm({
    title: `Delete “${profile.name}”?`,
    message: 'This permanently erases this profile’s bookmarks, history, cookies and site sign-ins, settings and extensions from this computer. Files you downloaded are kept. This can’t be undone.',
    confirmLabel: 'Delete profile', danger: true
  });
  if (!confirmed) return;
  const result = await drift.invoke('profiles:remove', id).catch(() => ({ ok: false, error: 'Drift could not delete the profile.' }));
  if (!result || !result.ok) { await showAlert((result && result.error) || 'Drift could not delete the profile.', 'Could not delete profile'); loadProfiles(); return; }
  applyProfileList(result);
}
function showProfilesSettings() {
  currentSettingsSection = 'profiles';
  if (state.internalPage === 'settings') renderInternalPage(true);
  else drift.cmd('settings');
}
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-profile-action]');
  if (!el || el.disabled) return;
  event.preventDefault();
  const id = el.dataset.profileId || '';
  switch (el.dataset.profileAction) {
    case 'open': closeProfileMenu(); openProfile(id); break;
    case 'add': closeProfileMenu(); openProfileDialog('new'); break;
    case 'edit': closeProfileMenu(); openProfileDialog('edit', id); break;
    case 'delete': deleteProfile(id); break;
    case 'manage': closeProfileMenu(); showProfilesSettings(); break;
  }
});

// ---- Settings > Profiles ---------------------------------------------------------------------
function profileCardMarkup(p) {
  const isCurrent = p.id === PM.activeId;
  const status = isCurrent ? 'active' : p.running ? 'open' : 'idle';
  const statusText = isCurrent ? 'Browsing in this window' : p.running ? 'Open in another window' : 'Not open';
  const deleteBlocked = isCurrent ? 'You are using this profile' : p.running ? 'Close its window first' : '';
  const e = escapeHtml(p.id);
  return `<article class="profile-card${isCurrent ? ' current' : ''}" style="--pc:${pmColor(p.color)}">
    <div class="profile-card-top">
      ${pmAvatar(p, 'xl')}
      <div class="profile-card-id">
        <strong title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</strong>
        <span class="profile-status ${status}"><i aria-hidden="true"></i>${statusText}</span>
      </div>
      ${p.isDefault ? '<span class="profile-chip">Default</span>' : ''}
    </div>
    <div class="profile-card-actions">
      ${isCurrent ? '<span class="profile-chip current-chip">This window</span>' : `<button type="button" class="small-action primary-action" data-profile-action="open" data-profile-id="${e}">Open</button>`}
      <button type="button" class="small-action" data-profile-action="edit" data-profile-id="${e}">Edit</button>
      ${p.isDefault ? '' : `<button type="button" class="small-action remove-action" data-profile-action="delete" data-profile-id="${e}" ${deleteBlocked ? `disabled title="${deleteBlocked}"` : ''}>Delete</button>`}
    </div>
  </article>`;
}
function profilesSettingsCards() {
  const list = PM.list;
  const cur = pmCurrent();
  const full = !!list && list.length >= PM.max;
  const hero = `<div class="profile-hero" style="--pc:${pmColor(cur.color)}">
      ${pmAvatar(cur, 'xxl')}
      <div class="profile-hero-text"><small>You are browsing as</small><strong>${escapeHtml(cur.name)}</strong><span>Everything you do in this window is saved only to this profile.</span></div>
      <button type="button" class="small-action" data-profile-action="edit" data-profile-id="${escapeHtml(PM.activeId || cur.id)}">Edit profile</button>
    </div>`;
  const grid = !list
    ? '<p class="profile-loading">Loading profiles…</p>'
    : `<div class="profile-grid">${list.map(profileCardMarkup).join('')}
        <button type="button" class="profile-card profile-add-card" data-profile-action="add" ${full ? 'disabled' : ''}>
          <span class="profile-add-plus">${pmIcon('plus')}</span><strong>Add profile</strong><small>${full ? `Limit of ${PM.max} reached` : `${list.length} of ${PM.max} used`}</small>
        </button></div>`;
  const kept = [['Sign-ins & cookies', 'user'], ['Bookmarks', 'star'], ['History', 'history'], ['Settings & theme', 'gear'], ['Extensions', 'puzzle'], ['Open tabs & session', 'tab']]
    .map(([label, icon]) => `<li><span class="profile-kept-ico">${pmIcon(icon)}</span>${label}</li>`).join('');
  return [
    ['This profile', '', hero, 'profiles-card profiles-plain'],
    ['All profiles', 'Each profile opens in its own window. Opening one that is already open brings it to the front.', grid, 'profiles-card profiles-plain'],
    ['Kept separate for every profile', 'Nothing below is shared between profiles. Updates and review reminders are the only shared parts.',
      `<ul class="profile-kept">${kept}</ul>
       <p class="profile-note">Deleting a profile permanently erases its data from this computer. Files you downloaded are kept. Drift opens the profile you used last when it starts.</p>`, 'profiles-card']
  ];
}
