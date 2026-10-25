const tiles = [
    ['DuckDuckGo','https://duckduckgo.com','D','tile-duck'],
    ['Wikipedia','https://wikipedia.org','W','tile-wiki'],
    ['GitHub','https://github.com','G','tile-github'],
    ['YouTube','https://youtube.com','Y','tile-youtube'],
    ['Reddit','https://reddit.com','R','tile-reddit']
  ];
  const grid = document.getElementById('tiles');
  grid.replaceChildren(...tiles.map(([label,url,letter,color]) => {
    const link = document.createElement('a'); link.className = 'tile'; link.href = url; link.title = label;
    const mark = document.createElement('span'); mark.className = 'tile-mark ' + color; mark.textContent = letter;
    const text = document.createElement('span'); text.className = 'tile-label'; text.textContent = label;
    link.append(mark,text); return link;
  }));
  document.getElementById('k').textContent = navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K';
  const tick = () => {
    const now = new Date();
    document.getElementById('day').textContent = now.toLocaleDateString([], {weekday:'long',month:'long',day:'numeric'});
    document.getElementById('clock').textContent = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  };
  tick(); setInterval(tick, 15000);
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = document.getElementById('q').value.trim(); if (!raw) return;
    let target;
    if (/^(https?|file|about|data):/i.test(raw)) target = raw;
    else if (/^localhost(?::\d+)?(?:\/|$)/i.test(raw) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/i.test(raw)) target = 'http://' + raw;
    else if (!/\s/.test(raw) && raw.includes('.')) target = 'https://' + raw;
    else target = 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
    location.href = target;
  });
