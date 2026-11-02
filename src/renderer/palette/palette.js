const $ = (id) => document.getElementById(id);
const input = $('q'), list = $('list');
const KIND = { go: '\u2197', tab: '\u25A3', bookmark: '\u2605', history: '\u25F7', command: '\u2318' };
let items = [], sel = 0, seq = 0;

async function refresh() {
  const mine = ++seq;
  const res = await drift.query(input.value);
  if (mine !== seq) return;
  items = res; sel = 0; draw();
}

function draw() {
  list.replaceChildren(...items.map((it, i) => {
    const row = document.createElement('div'); row.className = 'row' + (i === sel ? ' on' : '');
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = KIND[it.kind] || '\u2022';
    const main = document.createElement('div'); main.className = 'main';
    const l = document.createElement('div'); l.className = 'label'; l.textContent = it.label;
    const s = document.createElement('div'); s.className = 'sub'; s.textContent = it.sub || '';
    main.append(l, s); row.append(k, main);
    row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
    row.addEventListener('click', () => drift.run(it.act));
    return row;
  }));
}

function mark() {
  [...list.children].forEach((r, i) => r.classList.toggle('on', i === sel));
  list.children[sel]?.scrollIntoView({ block: 'nearest' });
}

drift.on('palette:open', () => {
  input.value = '';
  const card = $('card'); card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
  refresh(); input.focus();
});

input.addEventListener('input', refresh);
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); mark(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); mark(); e.preventDefault(); }
  else if (e.key === 'Enter') { if (items[sel]) drift.run(items[sel].act); e.preventDefault(); }
  else if (e.key === 'Escape') drift.cmd('closePalette');
});
$('backdrop').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) drift.cmd('closePalette'); });
