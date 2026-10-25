const $ = (id) => document.getElementById(id);
const mod = drift.platform === 'darwin' ? '\u2318' : 'Ctrl+';
$('kNew').textContent = mod + 'T';

let state = { spaces: [], tabs: [], url: '' };
const tabEls = new Map();

drift.on('state', (s) => { state = s; render(); });
drift.on('focus-address', () => { $('addr').focus(); $('addr').select(); });

const X_SVG = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function makeTab(id) {
  const e = document.createElement('div');
  e.className = 'tab';
  const ico = document.createElement('div'); ico.className = 'ico';
  const title = document.createElement('span'); title.className = 'title';
  const x = document.createElement('button'); x.className = 'x'; x.title = 'Close tab'; x.innerHTML = X_SVG;
  e.append(ico, title, x);
  e._id = id; e._ico = ico; e._title = title;
  e.addEventListener('click', (ev) => drift.cmd(ev.target.closest('.x') ? 'close' : 'activate', e._id));
  e.addEventListener('auxclick', (ev) => { if (ev.button === 1) drift.cmd('close', e._id); });
  return e;
}

function updateTab(e, t) {
  e.className = 'tab' + (t.active ? ' active' : '');
  e._title.textContent = t.title || 'New tab';
  e.title = t.title || '';
  e._ico.replaceChildren();
  if (t.loading) {
    const s = document.createElement('div'); s.className = 'spin'; e._ico.append(s);
  } else if (t.favicon) {
    const img = document.createElement('img'); img.src = t.favicon;
    img.onerror = () => img.replaceWith(dot(t));
    e._ico.append(img);
  } else e._ico.append(dot(t));
}

function dot(t) {
  const d = document.createElement('div'); d.className = 'dot';
  d.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
  return d;
}

function render() {
  document.body.classList.toggle('loading', !!state.loading);

  const sp = $('spaces');
  sp.replaceChildren(...state.spaces.map((name, i) => {
    const b = document.createElement('button');
    b.className = 'space' + (name === state.space ? ' on' : '');
    b.textContent = name; b.title = `${name} (${mod}${i + 1})`;
    b.onclick = () => drift.cmd('space', name);
    return b;
  }));

  const box = $('tabs'); const seen = new Set();
  state.tabs.forEach((t, i) => {
    let e = tabEls.get(t.id);
    if (!e) { e = makeTab(t.id); tabEls.set(t.id, e); }
    updateTab(e, t);
    if (box.children[i] !== e) box.insertBefore(e, box.children[i] || null);
    seen.add(t.id);
  });
  for (const [id, e] of tabEls) if (!seen.has(id)) { e.remove(); tabEls.delete(id); }

  if (document.activeElement !== $('addr')) $('addr').value = state.url || '';
  $('omni').classList.toggle('secure', (state.url || '').startsWith('https:'));
  $('back').disabled = !state.canBack;
  $('forward').disabled = !state.canForward;
  $('star').classList.toggle('on', !!state.bookmarked);
  $('blocked').textContent = state.blocked || 0;
}

$('omni').addEventListener('submit', (e) => { e.preventDefault(); drift.cmd('go', $('addr').value); $('addr').blur(); });
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('addr').value = state.url || ''; $('addr').blur(); } });
$('addr').addEventListener('focus', () => setTimeout(() => $('addr').select(), 0));
for (const [id, name] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload'], ['reader', 'reader'],
  ['star', 'bookmark'], ['palette', 'palette'], ['newtab', 'new']]) {
  $(id).addEventListener('click', () => drift.cmd(name));
}
