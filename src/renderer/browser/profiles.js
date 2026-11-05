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
function pmAvatar(profile, size = '') {
  return `<span class="profile-avatar ${size}" style="--pc:${pmColor(profile.color)};--pi:${pmInk(profile.color)}" aria-hidden="true">${escapeHtml(pmInitial(profile.name))}</span>`;
}
const pmIcon = (name) => (window.fa ? window.fa(name) : '');
const pmCurrent = () => state.profile || { id: '', name: 'Default', color: PM_DEFAULT_COLORS[0], count: 1 };

// ---- Toolbar button ------------------------------------------------------------------
function syncProfileButton() {
  const p = state.profile; const btn = $('profile-btn');
  if (!btn || !p) return;
  const sig = `${p.name}|${p.color}`;
  if (btn._sig === sig) return;
  btn._sig = sig;
  const avatar = $('profile-avatar');
  avatar.textContent = pmInitial(p.name);
  avatar.style.setProperty('--pc', pmColor(p.color));
  avatar.style.setProperty('--pi', pmInk(p.color));
  btn.title = `Profile: ${p.name}`;
  btn.setAttribute('aria-label', `Profile menu. Current profile: ${p.name}`);
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
  return p.running ? 'Open in another window' : '';
}
function renderProfileMenu() {
  const focusId = pmRoot.contains(document.activeElement) ? (document.activeElement.dataset.profileId || '') : '';
  const cur = pmCurrent();
  const list = PM.list || [{ id: cur.id, name: cur.name, color: cur.color }];
  const activeId = PM.activeId || cur.id;
  const full = list.length >= PM.max;
  pmRoot.innerHTML = `
    <div class="pm-current">${pmAvatar(cur, 'lg')}<div class="pm-current-text"><small>Browsing as</small><strong>${escapeHtml(cur.name)}</strong></div></div>
    <div class="dm-sep" role="separator"></div>
    <div class="dm-head">Switch profile</div>
    <div class="pm-list" role="group" aria-label="Profiles">${list.map((p) => `
      <button type="button" class="dm-row pm-row${p.id === activeId ? ' current' : ''}" role="menuitemradio" aria-checked="${p.id === activeId}" data-profile-action="open" data-profile-id="${escapeHtml(p.id)}">
        ${pmAvatar(p)}
        <span class="dm-text"><span class="dm-label">${escapeHtml(p.name)}</span>${pmStatus(p) ? `<small>${pmStatus(p)}</small>` : ''}</span>
        ${p.id === activeId ? `<span class="pm-check">${pmIcon('check')}</span>` : ''}
      </button>`).join('')}
    </div>
    <div class="dm-sep" role="separator"></div>
    <button type="button" class="dm-row" role="menuitem" data-profile-action="add" ${full ? 'disabled' : ''}><span class="dm-ico">${pmIcon('plus')}</span><span class="dm-text"><span class="dm-label">Add profile</span>${full ? `<small>Limit of ${PM.max} reached</small>` : ''}</span></button>
    <button type="button" class="dm-row" role="menuitem" data-profile-action="manage"><span class="dm-ico">${pmIcon('gear')}</span><span class="dm-text"><span class="dm-label">Manage profiles</span></span></button>`;
  if (focusId) pmRoot.querySelector(`[data-profile-id="${CSS.escape(focusId)}"]`)?.focus();
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
  preview.textContent = pmInitial($('profile-name').value);
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
function profileItemMarkup(p) {
  const isCurrent = p.id === PM.activeId;
  const status = isCurrent ? 'Browsing now in this window' : p.running ? 'Open in another window' : p.isDefault ? 'Default profile' : 'Not open';
  const deleteBlocked = isCurrent ? 'You are using this profile' : p.running ? 'Close its window first' : '';
  return `<div class="profile-item${isCurrent ? ' current' : ''}">
    ${pmAvatar(p, 'lg')}
    <div class="profile-meta"><strong>${escapeHtml(p.name)}</strong><small>${status}</small></div>
    <div class="profile-actions">
      ${isCurrent ? '<span class="profile-chip">This window</span>' : `<button type="button" class="small-action" data-profile-action="open" data-profile-id="${escapeHtml(p.id)}">Open</button>`}
      <button type="button" class="small-action" data-profile-action="edit" data-profile-id="${escapeHtml(p.id)}">Edit</button>
      ${p.isDefault ? '' : `<button type="button" class="small-action remove-action" data-profile-action="delete" data-profile-id="${escapeHtml(p.id)}" ${deleteBlocked ? `disabled title="${deleteBlocked}"` : ''}>Delete</button>`}
    </div>
  </div>`;
}
function profilesSettingsCards() {
  const list = PM.list;
  const full = !!list && list.length >= PM.max;
  const body = !list
    ? '<p class="profile-loading">Loading profiles…</p>'
    : `<div class="profile-list">${list.map(profileItemMarkup).join('')}</div>
       <div class="profile-add-row"><button type="button" class="small-action primary-action" data-profile-action="add" ${full ? 'disabled' : ''}>Add profile</button><small>${list.length} of ${PM.max} profiles</small></div>`;
  return [
    ['Your profiles', 'Each profile opens in its own window with its own sign-ins, cookies, bookmarks, history, settings and extensions.', body, 'profiles-card'],
    ['How profiles work', '', `<ul class="profile-notes">
      <li>Signing in to a website in one profile never signs you in anywhere else. Clearing browsing data only affects the profile you clear it in.</li>
      <li>Opening a profile that is already open brings its window to the front.</li>
      <li>Starting Drift normally opens the profile you used last. The window title shows the profile’s name once you have more than one.</li>
      <li>Deleting a profile erases its data from this computer. Updates and Drift’s review reminders are shared by all profiles.</li>
    </ul>`, 'profiles-card']
  ];
}
