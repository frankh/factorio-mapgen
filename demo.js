// The standalone map generator page (index.html).
const data = Object.values(window.FactorioMapGenData)[0];
const sa = document.getElementById('sa');
const out = document.getElementById('out');
const params = new URLSearchParams(location.search);
const download = (name, obj) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name; a.textContent = name; return a;
};
const gen = FactorioMapGen.mount(document.getElementById('app'), {
  data, modset: params.get('modset') || 'space-age', exchangeString: params.get('s') || undefined,
  onModsetChange: (m) => { sa.checked = m === 'space-age'; },
  onBack: () => { out.hidden = true; },
  onPlay: (r) => {
    out.hidden = false; out.textContent = '';
    const win = document.createElement('div'); win.className = 'fmg-window';
    const t = document.createElement('div'); t.className = 'fmg-title'; t.textContent = 'Map exchange string';
    const pre = document.createElement('pre'); pre.textContent = r.exchangeString;
    const p = document.createElement('p');
    p.append('Start a headless server with these: ', download('map-gen-settings.json', r.mapGenSettings), ' ', download('map-settings.json', r.mapSettings));
    win.append(t, pre, p); out.append(win);
    out.scrollIntoView({ behavior: 'smooth' });
  },
});
sa.checked = gen.modset === 'space-age';
sa.addEventListener('change', () => gen.setModset(sa.checked ? 'space-age' : 'vanilla'));
window.gen = gen;
