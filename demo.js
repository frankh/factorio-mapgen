// The standalone map generator page (index.html).
const data = Object.values(window.FactorioMapGenData)[0];
const app = document.getElementById('app');
const out = document.getElementById('out');
const params = new URLSearchParams(location.search);
const download = (name, obj) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name; a.textContent = name; return a;
};
// The window is the game's width; with the preview open it fills the page.
// On narrow screens it is scaled down to fit.
const fit = (g) => {
  const avail = document.body.clientWidth - 32;
  const zoom = Math.min(1, avail / (g.previewOpen ? 1161 : 677));
  g.root.style.zoom = String(zoom);
  g.root.style.setProperty('--fmg-full-width', Math.max(1161, Math.floor(avail / zoom)) + 'px');
};
const gen = FactorioMapGen.mount(app, {
  data, modset: params.get('modset') || 'space-age', exchangeString: params.get('s') || undefined,
  modsetToggle: true,
  onChange: fit,
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
fit(gen);
window.addEventListener('resize', () => fit(gen));
window.gen = gen;
