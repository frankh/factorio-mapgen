// The standalone map generator page (index.html).
const data = Object.values(window.FactorioMapGenData)[0];
const app = document.getElementById('app');
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
  // Play shows the result over the window, like the game's own dialogs.
  onPlay: (r) => {
    const box = document.createElement('textarea');
    box.className = 'fmg-textbox'; box.readOnly = true; box.spellcheck = false; box.value = r.exchangeString;
    const files = document.createElement('p');
    files.className = 'fmg-files';
    files.append('Headless server files:', download('map-gen-settings.json', r.mapGenSettings), download('map-settings.json', r.mapSettings));
    const btn = (cls, text, onclick) => {
      const b = document.createElement('button');
      b.className = 'fmg-dialog-btn ' + cls; b.type = 'button'; b.textContent = text; b.onclick = onclick;
      return b;
    };
    const spacer = document.createElement('div'); spacer.className = 'fmg-drag';
    const m = gen.modal(gen.t('gui', 'map-exchange-string'), [box, files], [
      btn('fmg-back', gen.t('gui', 'close'), () => m.remove()),
      spacer,
      btn('', gen.t('gui', 'copy'), () => { box.select(); (navigator.clipboard ? navigator.clipboard.writeText(r.exchangeString) : Promise.reject()).catch(() => document.execCommand('copy')); }),
    ]);
    box.focus(); box.select();
  },
});
fit(gen);
window.addEventListener('resize', () => fit(gen));
window.gen = gen;
