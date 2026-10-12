// The Factorio "Map generator" window (Single player → New game) in plain JS.
//
//   const gen = FactorioMapGen.mount(element, {
//     data: FactorioMapGenData['2.0.77'],   // from gamedata.js
//     modset: 'space-age' | 'vanilla',
//     exchangeString: '>>>…<<<',            // optional starting settings
//     onPlay(result) {}, onBack() {},       // result: {exchangeString, mapGenSettings, mapSettings}
//     iconBase: '/icons/',                  // optional: where the game icons live (default: icons/ next to this script)
//     modsetToggle: true,                   // optional: a Space Age checkbox beside the seed
//     shareUrl: (exchangeString) => url,    // optional: adds a Share link button that copies this URL
//   });
//
// Needs vendor/pako.min.js, mapexchange.js and gamedata.js loaded first.
(function (root) {
  'use strict';
  const MX = root.FactorioMapExchange;

  // The 12 notches of the map generator sliders: 17% … 600%.
  const NOTCHES = [1 / 6, 1 / 4, 1 / 3, 1 / 2, 3 / 4, 1, 4 / 3, 3 / 2, 2, 3, 4, 6];
  const BIAS_NOTCHES = Array.from({ length: 21 }, (_, i) => Math.round((i - 10) * 5) / 100);
  // Words presets may use instead of numbers (MapGenSize).
  const MAPGEN_SIZE = {
    none: 0, 'very-low': 0.5, 'very-small': 0.5, 'very-poor': 0.5,
    low: Math.SQRT1_2, small: Math.SQRT1_2, poor: Math.SQRT1_2,
    normal: 1, medium: 1, regular: 1,
    high: Math.SQRT2, big: Math.SQRT2, good: Math.SQRT2,
    'very-high': 2, 'very-big': 2, 'very-good': 2,
  };
  const DEFAULT_SIZE = 2000000;
  const f32 = Math.fround;

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pct = (v) => Math.round(v * 100) + '%';
  function nearestIndex(list, v) {
    let best = 0, bd = Infinity;
    list.forEach((x, i) => { const d = Math.abs(Math.log(Math.max(x, 1e-9)) - Math.log(Math.max(v, 1e-9))); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function nearestLinear(list, v) {
    let best = 0, bd = Infinity;
    list.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  // What Lua's tostring gives for a number: the game turns preset expression
  // values like trees_forest_path_cutout = 1 into the string "1".
  function luaNumber(v) {
    if (typeof v !== 'number') return String(v);
    if (Number.isInteger(v)) return String(v);
    return String(parseFloat(v.toPrecision(14)));
  }
  // Values the climate sliders write, formatted like C's %f.
  const fixed6 = (v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
  function mapGenSize(v) {
    if (typeof v === 'number') return v;
    if (v in MAPGEN_SIZE) return NOTCHES[nearestIndex(NOTCHES, MAPGEN_SIZE[v])] * (MAPGEN_SIZE[v] === 0 ? 0 : 1);
    return 1;
  }
  function deepMerge(dst, src) {
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') deepMerge(dst[k], v);
      else dst[k] = clone(v);
    }
    return dst;
  }
  function leafDiffs(a, b, path, out) {
    if (a && typeof a === 'object' && b && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiffs(a[k], b[k], path + '.' + k, out);
    } else if (typeof a === 'number' && typeof b === 'number' ? f32(a) !== f32(b) : JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
    return out;
  }
  function randomSeed() {
    const a = new Uint32Array(1);
    (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4294967296));
    return a[0];
  }

  // Icon colours for the CSS stand-ins, when no real game icons are given.
  const ORE = {
    'iron-ore': '#7d98b8', 'copper-ore': '#d0703f', stone: '#c9ab76', coal: '#3a3a3a', 'crude-oil': '#2a2420',
    'uranium-ore': '#62d23f', calcite: '#ececec', 'sulfuric-acid-geyser': '#e7d74b', 'tungsten-ore': '#5a4d93',
    scrap: '#8e6c4e', 'lithium-brine': '#d6ecea', 'fluorine-vent': '#79c8ee',
  };

  // The preview's zoom, in tiles per screen pixel (1 is the game's), and the
  // most chunks it keeps drawn.
  // Tiles per device pixel at each zoom step, nearest first. Zoomed out, the
  // view goes as far as MAX_ZOOM tiles per CSS pixel, and draws a pixel per
  // CSS pixel (on a high-density screen, each covers several device pixels),
  // so the levels it draws go up to MAX_ZOOM.
  const ZOOMS = [0.25, 0.5, 1, 2, 4, 8, 16], MAX_ZOOM = 16;
  // Wheel travel per zoom step, and the wait after the last zoom step before
  // asking for the new level's chunks.
  const WHEEL_STEP = 60, ZOOM_SETTLE = 250;
  // Chunks are kept in blocks of BLOCK x BLOCK, a canvas each, so a frame
  // draws a few dozen images rather than thousands; at most MAX_BLOCKS.
  const BLOCK = 8, MAX_BLOCKS = 256;

  // The game's GUI glyphs (icons/*.png), drawn as masks so CSS sets their colour.
  const ICON_BASE = (() => {
    const src = document.currentScript && document.currentScript.src;
    return src ? src.replace(/[^/]*$/, '') + 'icons/' : 'icons/';
  })();
  const glyph = (name) => el('span', { class: 'fmg-glyph fmg-glyph-' + name, style: { '--glyph': 'url(' + ICON_BASE + name + '.png)' } });

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; }
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }

  class MapGenerator {
    constructor(container, opts) {
      this.opts = opts;
      this.data = opts.data;
      this.L = this.data.locale;
      this.root = el('div', { class: 'fmg', style: { position: 'relative', display: 'inline-block' } });
      container.append(this.root);
      this.tab = 'resources';
      this.disabledSizes = {};
      this.setModset(opts.modset || 'space-age', true);
      this.seed = randomSeed();
      this.loadPreset(this.defaultPreset().name);
      if (opts.exchangeString) { try { this.importString(opts.exchangeString); } catch (e) { /* keep defaults */ } }
      this.render();
    }

    // ---- data and settings ----

    t(section, key, ...args) {
      let s = (this.L[section] || {})[key];
      if (s === undefined) return key;
      // __plural_for_parameter__1__{1=option|rest=options}__ first: it
      // contains "__1__" itself.
      s = s.replace(/__plural_for_parameter__(\d+)__\{([^}]*)\}__/g, (m, n, alts) => {
        const v = Number(args[Number(n) - 1]);
        for (const alt of alts.split('|')) { const [cond, text] = alt.split('='); if (cond === 'rest' || Number(cond) === v) return text; }
        return '';
      });
      args.forEach((a, i) => { s = s.split('__' + (i + 1) + '__').join(a); });
      return s;
    }
    get modsetData() { return this.data.modsets[this.modset]; }
    get is21() { const v = this.template._raw.version; return v[0] > 2 || (v[0] === 2 && v[1] >= 1); }
    defaultPreset() { return this.modsetData.presets.find((p) => p.default) || this.modsetData.presets[0]; }
    control(name) { return this.modsetData.controls.find((c) => c.name === name); }

    setModset(modset, initial) {
      this.modset = this.data.modsets[modset] ? modset : Object.keys(this.data.modsets)[0];
      this.template = MX.decode(this.modsetData.default_exchange_string);
      if (!initial) {
        const keep = this.settings;
        this.loadPreset(this.presetName);
        // Carry over what still applies.
        for (const [k, v] of Object.entries(keep.mgs.autoplace_controls)) if (this.settings.mgs.autoplace_controls[k]) this.settings.mgs.autoplace_controls[k] = v;
        for (const k of ['width', 'height', 'starting_area', 'peaceful_mode', 'no_enemies_mode', 'property_expression_names']) this.settings.mgs[k] = keep.mgs[k];
        this.settings.ms = deepMerge(this.settings.ms, keep.ms);
        this.render();
      }
    }

    // The settings a preset gives, as the game builds them when it is picked.
    presetSettings(name) {
      const preset = this.modsetData.presets.find((p) => p.name === name) || this.defaultPreset();
      const mgs = clone(this.template.map_gen_settings), ms = clone(this.template.map_settings);
      if (!preset.default) {
        // Picking any preset but Default leaves the cliff prototype name empty
        // (seen in strings the game exports); the planet supplies it instead.
        mgs.cliff_settings.name = '';
        const b = preset.basic_settings || {};
        for (const [k, v] of Object.entries(b)) {
          if (k === 'autoplace_controls') {
            for (const [c, s] of Object.entries(v)) {
              const cur = mgs.autoplace_controls[c] || (mgs.autoplace_controls[c] = { frequency: 1, size: 1, richness: 1 });
              for (const f of ['frequency', 'size', 'richness']) if (s[f] !== undefined) cur[f] = f32(mapGenSize(s[f]));
            }
          } else if (k === 'property_expression_names') {
            for (const [p, e] of Object.entries(v)) mgs.property_expression_names[p] = luaNumber(e);
          } else if (k === 'cliff_settings') {
            for (const [p, e] of Object.entries(v)) mgs.cliff_settings[p] = typeof e === 'string' && p !== 'name' && p !== 'control' ? mapGenSize(e) : e;
          } else if (k === 'starting_area') {
            mgs.starting_area = f32(mapGenSize(v));
          } else if (k === 'starting_points' || k === 'autoplace_settings' || k === 'territory_settings') {
            mgs[k] = clone(v);
          } else if (k !== 'seed') {
            mgs[k] = v;
          }
        }
        deepMerge(ms, preset.advanced_settings || {});
      }
      return { mgs, ms };
    }

    loadPreset(name) {
      this.presetName = name;
      this.settings = this.presetSettings(name);
      this.disabledSizes = {};
    }

    modifiedOptions() {
      const p = this.presetSettings(this.presetName);
      const a = clone(this.settings), b = clone(p);
      delete a.mgs.seed; delete b.mgs.seed;
      return leafDiffs(b, a, '', []);
    }

    result() {
      const mgs = clone(this.settings.mgs);
      mgs.seed = this.seed >>> 0;
      const obj = { map_gen_settings: mgs, map_settings: clone(this.settings.ms), _raw: clone(this.template._raw) };
      return { exchangeString: MX.encode(obj), mapGenSettings: mgs, mapSettings: obj.map_settings, version: this.data.version, modset: this.modset };
    }

    importString(str) {
      const d = MX.decode(str);
      const v = d._raw.version, tv = this.template._raw.version;
      if (v[0] !== tv[0] || v[1] !== tv[1]) {
        throw new Error('This map exchange string is from Factorio ' + (d.imported_from || v).slice(0, 3).join('.') + '; these settings are for ' + this.data.version + '.');
      }
      // A Space Age string has the Space Age planets' controls. A 1.1 string
      // has neither planet's, so it keeps the current mods, as in the game.
      const hasSA = Object.keys(d.map_gen_settings.autoplace_controls).some((c) => c === 'vulcanus_coal' || c === 'scrap');
      if (!d.imported_from && this.opts.followImportModset !== false && hasSA !== (this.modset === 'space-age') && this.data.modsets[hasSA ? 'space-age' : 'vanilla']) {
        this.modset = hasSA ? 'space-age' : 'vanilla';
        this.template = MX.decode(this.modsetData.default_exchange_string);
        if (this.opts.onModsetChange) this.opts.onModsetChange(this.modset);
      }
      this.seed = d.map_gen_settings.seed;
      const mgs = clone(d.map_gen_settings);
      // The game fills in the controls a 1.1 string doesn't know about
      // (cliffs, rocks, the Space Age planets' resources) at their defaults.
      if (d.imported_from) {
        for (const k of Object.keys(this.template.map_gen_settings.autoplace_controls)) {
          if (!mgs.autoplace_controls[k]) mgs.autoplace_controls[k] = { frequency: 1, size: 1, richness: 1 };
        }
      }
      // 1.1 map types 2.0 doesn't have (0.16 terrain, starting plateau) are
      // kept by the parser, but the game ignores them when it creates the
      // map and uses the default (Nauvis) elevation, so show that.
      const pen = mgs.property_expression_names || {};
      if (d.imported_from && pen.elevation && !this.modsetData.elevation.some((x) => x.name === pen.elevation)) delete pen.elevation;
      // Keep the imported string's own raw bytes (version etc.) out; we export
      // with this game version, as the game does.
      this.settings = { mgs, ms: clone(d.map_settings) };
      // Pick the preset these settings match, if any.
      const match = this.modsetData.presets.find((p) => {
        const s = this.presetSettings(p.name), a = clone(this.settings), b = clone(s);
        delete a.mgs.seed; delete b.mgs.seed;
        return leafDiffs(b, a, '', []).length === 0;
      });
      this.presetName = (match || this.defaultPreset()).name;
      this.disabledSizes = {};
    }

    // ---- rendering ----

    render() {
      const keepScroll = this.panel ? this.panel.scrollTop : 0;
      this.root.textContent = '';
      this.tooltip = this.tooltip || el('div', { class: 'fmg-tooltip', hidden: true });
      this.tooltip.hidden = true; // its element may be about to go
      document.body.append(this.tooltip);
      const md = this.modsetData;
      const modified = this.modifiedOptions();

      const presetSelect = this.dropdown({
        label: 'Preset', width: 232, value: this.presetName,
        options: md.presets.map((p) => ({ value: p.name, text: p.label + (p.name === this.presetName && modified.length ? ' ' + this.t('gui-map-generator', 'custom') : '') })),
        onChange: (v) => { this.loadPreset(v); this.render(); },
      });
      const resetBtn = el('button', {
        class: 'fmg-btn fmg-reset', type: 'button', disabled: !modified.length,
        onclick: () => { this.loadPreset(this.presetName); this.render(); },
      }, glyph('reset'));
      // A disabled button gets no mouse events, so the tooltip sits on a wrapper.
      const resetWrap = el('span', { class: 'fmg-reset-wrap' }, resetBtn);
      this.tip(resetWrap, () => modified.length ? this.t('gui-map-generator', 'reset-to-preset', modified.length) : this.t('gui-map-generator', 'reset-to-preset-disabled'));
      const seedInput = el('input', {
        class: 'fmg-text', value: String(this.seed), inputmode: 'numeric', 'aria-label': 'Seed', style: { width: '148px' },
        oninput: (e) => {
          const v = e.target.value.trim();
          const ok = /^\d+$/.test(v) && Number(v) <= 4294967295;
          e.target.classList.toggle('fmg-invalid', !ok);
          if (ok) { this.seed = Number(v); this.seedChanged(); }
        },
      });
      const shuffle = el('button', { class: 'fmg-btn fmg-icon', type: 'button', onclick: () => { this.seed = randomSeed(); seedInput.value = String(this.seed); seedInput.classList.remove('fmg-invalid'); this.seedChanged(); } }, glyph('shuffle'));
      this.tip(shuffle, () => this.t('gui-map-generator', 'randomize-map-seed'));
      const preset = md.presets.find((p) => p.name === this.presetName);

      const tabs = [
        ['resources', this.t('gui-map-generator', 'resources-tab-title')],
        ['terrain', this.t('gui-map-generator', 'terrain-tab-title')],
        ['enemy', this.t('gui-map-generator', 'enemy-tab-title')],
        ['advanced', this.t('gui-map-generator', 'advanced-tab-title')],
      ];
      this.panel = el('div', { class: 'fmg-tabpanel', role: 'tabpanel' }, this.renderTab(this.tab));

      const importBtn = el('button', { class: 'fmg-btn fmg-icon', type: 'button', onclick: () => this.openImport() }, glyph('import'));
      const exportBtn = el('button', { class: 'fmg-btn fmg-icon', type: 'button', onclick: () => this.openExport() }, glyph('export'));
      this.tip(importBtn, () => this.t('gui-map-generator', 'import-exchange-string-tt'));
      this.tip(exportBtn, () => this.t('gui-map-generator', 'export-exchange-string-tt'));

      const canPreview = typeof Worker !== 'undefined';
      const previewBtn = this.previewOpen
        ? el('button', { class: 'fmg-dialog-btn fmg-back fmg-close-preview', type: 'button', onclick: () => { this.previewOpen = false; this.render(); } },
          glyph('close'), this.t('gui-map-generator', 'hide-preview'))
        : el('button', { class: 'fmg-dialog-btn fmg-forward', type: 'button', disabled: !canPreview, onclick: () => { this.previewOpen = true; this.render(); } },
          glyph('warning'), this.t('gui-map-generator', 'show-preview'));
      if (!this.previewOpen) this.tip(previewBtn, () => this.t('gui-map-generator', 'show-preview-warning'));

      const win = el('div', { class: 'fmg-window', role: 'dialog', 'aria-label': this.t('gui-map-generator', 'title') },
        el('div', { class: 'fmg-titlebar' }, el('div', { class: 'fmg-title' }, this.t('gui-map-generator', 'title')), el('div', { class: 'fmg-drag' })),
        el('div', { class: 'fmg-body' }, el('div', { class: 'fmg-deep fmg-main' },
          el('div', { class: 'fmg-subheader' },
            presetSelect, resetWrap,
            el('div', { class: 'fmg-spacer' }),
            this.opts.modsetToggle && this.data.modsets['space-age'] && this.data.modsets.vanilla
              ? el('span', { class: 'fmg-modset' }, this.checkbox(this.modset === 'space-age', (v) => {
                this.setModset(v ? 'space-age' : 'vanilla');
                if (this.opts.onModsetChange) this.opts.onModsetChange(this.modset);
              }, 'Space Age'))
              : null,
            el('span', { class: 'fmg-label-bold fmg-seed-label' }, this.t('gui-map-generator', 'map-seed')), seedInput, shuffle),
          el('div', { class: 'fmg-desc' }, preset ? preset.description : ''),
          el('div', { class: 'fmg-tabbar', role: 'tablist' }, tabs.map(([id, label]) => el('button', {
            class: 'fmg-tab', role: 'tab', type: 'button', 'aria-selected': String(id === this.tab),
            onclick: () => { this.tab = id; this.render(); },
          }, label))),
          this.panel,
          el('div', { class: 'fmg-exchange' }, this.opts.shareUrl ? this.shareButton() : null,
            el('span', { class: 'fmg-label-bold' }, this.t('gui', 'map-exchange-string')), importBtn, exportBtn)),
        this.previewOpen ? this.renderPreview() : null),
        this.renderFooter(previewBtn));
      this.root.classList.toggle('fmg-previewing', !!this.previewOpen);
      this.root.append(win);
      this.panel.scrollTop = keepScroll;
      if (this.previewOpen) this.schedulePreview();
      if (this.opts.onChange) this.opts.onChange(this);
    }

    // Back … Preview, Play; with the preview open the game splits the bar
    // under its two columns: Back on the left, Close preview and a wide Play
    // under the map.
    renderFooter(previewBtn) {
      const back = el('button', { class: 'fmg-dialog-btn fmg-back', type: 'button', onclick: () => this.opts.onBack && this.opts.onBack() }, this.t('gui', 'cancel'));
      const mods = this.opts.onModSettings ? el('button', { class: 'fmg-dialog-btn', type: 'button', onclick: () => this.opts.onModSettings() }, this.t('gui-menu', 'mod-settings')) : null;
      const play = el('button', { class: 'fmg-dialog-btn fmg-confirm', type: 'button', onclick: () => this.play() }, this.opts.playLabel || this.t('gui-map-generator', 'play'));
      if (!this.previewOpen) return el('div', { class: 'fmg-footer' }, back, el('div', { class: 'fmg-drag' }), mods, previewBtn, play);
      return el('div', { class: 'fmg-footer fmg-footer-split' },
        el('div', { class: 'fmg-footer-part' }, back, el('div', { class: 'fmg-drag' }), mods),
        el('div', { class: 'fmg-footer-part' }, previewBtn, el('div', { class: 'fmg-drag' }), play));
    }

    // A Factorio dropdown: a button showing the choice, and a list that opens
    // under it (dark items, orange on hover).
    dropdown({ options, value, onChange, width, label }) {
      const cur = options.find((o) => o.value === value) || options[0];
      const icon = (o) => (o.icon ? el('img', { class: 'fmg-dd-icon', src: o.icon, alt: '' }) : null);
      const btn = el('button', { class: 'fmg-dd-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label },
        icon(cur), el('span', { class: 'fmg-dd-text' }, cur ? cur.text : ''), el('span', { class: 'fmg-dd-arrow' }));
      const wrap = el('div', { class: 'fmg-dropdown', style: width ? { width: width + 'px' } : null }, btn);
      const close = () => {
        const list = wrap.querySelector('.fmg-dd-list');
        if (list) list.remove();
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', outside, true);
      };
      const outside = (e) => { if (!wrap.contains(e.target)) close(); };
      const pick = (v) => { close(); btn.focus(); if (v !== value) onChange(v); };
      const open = (byKey) => {
        if (wrap.querySelector('.fmg-dd-list')) return close();
        const items = options.map((o) => el('button', {
          class: 'fmg-dd-item' + (o.value === value ? ' fmg-dd-current' : ''), type: 'button', role: 'option',
          'aria-selected': String(o.value === value), onclick: () => pick(o.value),
          onkeydown: (e) => {
            const all = [...list.children], i = all.indexOf(e.currentTarget);
            if (e.key === 'ArrowDown') { e.preventDefault(); (all[i + 1] || all[i]).focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || all[i]).focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
            else if (e.key === 'Tab') close();
          },
        }, icon(o), el('span', {}, o.text)));
        const list = el('div', { class: 'fmg-dd-list', role: 'listbox', 'aria-label': label, tabindex: '-1',
          onkeydown: (e) => {
            if (e.target !== list) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (list.querySelector('.fmg-dd-current') || list.firstChild).focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
          } }, items);
        wrap.append(list);
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', outside, true);
        // From the keyboard, start on the current choice; from the mouse only
        // the hovered item lights up, as in the game.
        if (byKey) (list.querySelector('.fmg-dd-current') || list.firstChild).focus();
        else list.focus();
      };
      btn.addEventListener('click', (e) => open(e.detail === 0));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(true); }
      });
      return wrap;
    }

    // Re-render after a change without losing the scroll position.
    changed() { this.render(); }

    // ---- preview ----
    //
    // Rendered in the browser, as the game does: Web Workers run the game's
    // own noise expressions (noise.js, preview.js) a chunk at a time,
    // nearest the middle first, terrain before entities. Ungenerated chunks
    // stay black. The picture is one tile per screen pixel and can be dragged.

    previewKey() {
      return JSON.stringify([this.modset, this.previewPlanet || 'nauvis', this.result().mapGenSettings]);
    }

    renderPreview() {
      const G = (k) => this.t('gui-map-generator', k);
      // Auto-refresh starts on (the game starts it off).
      const st = this.previewState || (this.previewState = { auto: true });
      const planets = this.modsetData.planets;
      if (!this.previewCanvas) this.previewCanvas = el('canvas', { class: 'fmg-preview-canvas', width: 1, height: 1 });
      if (!this.view) this.view = { x: 0, y: 0, z: 1 };
      const status = st.error ? el('div', { class: 'fmg-preview-status fmg-error' }, G('preview-error') + '\n' + st.error) : null;
      const refresh = el('button', { class: 'fmg-btn fmg-icon', type: 'button', 'aria-label': this.t('gui', 'refresh'), onclick: () => this.loadPreview(true) }, glyph('refresh'));
      this.tip(refresh, () => this.t('gui', 'refresh'));
      const auto = this.checkbox(st.auto, (v) => { st.auto = v; if (v) this.loadPreview(false); }, G('preview-auto-update'), G('preview-auto-update-tt'));
      const planet = this.dropdown({
        label: 'Planet', width: 116, value: this.previewPlanet || 'nauvis',
        options: planets.map((p) => ({ value: p.name, text: p.label, icon: this.iconBase + 'planet/' + p.name + '.png' })),
        onChange: (v) => { this.previewPlanet = v; this.loadPreview(true); },
      });
      const zoomBtn = (text, label, f) => {
        const b = el('button', { class: 'fmg-btn fmg-icon fmg-zoom', type: 'button', 'aria-label': label, onclick: () => this.zoomView(f) }, text);
        this.tip(b, label);
        return b;
      };
      const home = el('button', { class: 'fmg-btn fmg-zoom-home', type: 'button', onclick: () => { this.view = { x: 0, y: 0, z: 1 }; this.viewChanged(); } }, 'Spawn');
      this.tip(home, 'Back to the spawn, one tile a pixel');
      const frame = el('div', { class: 'fmg-preview-frame', tabindex: 0 }, this.previewCanvas, status);
      this.panAndZoom(frame);
      if (this.previewResize) this.previewResize.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        this.previewResize = new ResizeObserver(() => this.viewChanged());
        this.previewResize.observe(frame);
      }
      requestAnimationFrame(() => this.viewChanged());
      this.watchPixelRatio();
      return el('div', { class: 'fmg-deep fmg-preview' },
        el('div', { class: 'fmg-subheader' }, zoomBtn('−', 'Zoom out', 1), zoomBtn('+', 'Zoom in', -1), home,
          el('div', { class: 'fmg-spacer' }), auto, planet, refresh),
        frame);
    }

    // ---- the map view ----
    //
    // view: the tile at the middle of the preview (x, y) and the tiles per
    // screen pixel (z; 1 by default, as in the game, so a scaled display or
    // a zoomed-out window shows as much of the map as the game does). The
    // map is drawn from chunks of 32x32 pixels at a level: level 1 is a
    // chunk of tiles; level L samples every Lth tile (an overview of tiles
    // and ore). z is one of ZOOMS; zoomed in, the view uses level 1, else
    // level z, and shows a coarser level's chunk (or a black square) until a
    // chunk arrives.

    level() {
      const z = this.view.z;
      return z <= 1 ? 1 : Math.min(MAX_ZOOM, z * this.pixelRatio());
    }

    // Device pixels per CSS pixel, to a power of two.
    pixelRatio() {
      const k = (window.devicePixelRatio || 1) * (parseFloat(this.root.style.zoom) || 1);
      return Math.max(1, Math.pow(2, Math.round(Math.log2(k))));
    }

    // The zoom steps this screen can use.
    zooms() {
      const k = this.pixelRatio();
      return ZOOMS.filter((z) => z <= 1 || z * k <= MAX_ZOOM);
    }

    // Device pixels of the preview, and its size in them.
    canvasSize() {
      const c = this.previewCanvas, frame = c.parentNode;
      if (!frame || !frame.isConnected) return null;
      const z = parseFloat(this.root.style.zoom) || 1;
      const k = (window.devicePixelRatio || 1) * z;
      return [Math.max(1, Math.round(frame.clientWidth * k)), Math.max(1, Math.round(frame.clientHeight * k))];
    }

    viewChanged() {
      if (this.viewFrame) return;
      this.viewFrame = requestAnimationFrame(() => {
        this.viewFrame = 0;
        if (this.drawPending) { cancelAnimationFrame(this.drawPending); this.drawPending = 0; }
        this.drawView();
        this.requestSoon();
      });
    }

    // Zoom a step out (dir 1) or in (-1), keeping the map point at (px, py)
    // (device pixels in the preview; its middle by default) where it is. The
    // view is redrawn from the chunks at hand straight away, but the new
    // level's chunks are only asked for once zooming stops.
    zoomView(dir, px, py) {
      const v = this.view, size = this.canvasSize();
      if (!size) return;
      const zooms = this.zooms();
      let i = zooms.indexOf(v.z);
      if (i < 0) i = zooms.indexOf(1);
      const nz = zooms[Math.max(0, Math.min(zooms.length - 1, i + dir))];
      if (nz === v.z) return;
      const dx = (px === undefined ? (size[0] >> 1) : px) - (size[0] >> 1), dy = (py === undefined ? (size[1] >> 1) : py) - (size[1] >> 1);
      v.x += dx * (v.z - nz); v.y += dy * (v.z - nz);
      v.z = nz;
      // Stop the workers on the level being left.
      if (this.previewWorkers && this.previewJob) this.previewWorkers.forEach((w) => w.postMessage({ type: 'want', job: this.previewJob, items: [] }));
      this.wantKey = '';
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => { this.zoomTimer = 0; this.requestChunks(); }, ZOOM_SETTLE);
      this.viewChanged();
    }

    // Ask for chunks at most every 100 ms while the view moves.
    requestSoon() {
      if (this.requestTimer) { this.requestAgain = true; return; }
      this.requestChunks();
      this.requestTimer = setTimeout(() => {
        this.requestTimer = 0;
        if (this.requestAgain) { this.requestAgain = false; this.requestSoon(); }
      }, 100);
    }

    // The chunks the view needs at its level, nearest the middle first, with
    // a margin around it.
    visibleChunks(L) {
      const v = this.view, size = this.canvasSize();
      if (!size) return [];
      const span = 32 * L;
      const x0 = v.x - (size[0] >> 1) * v.z, y0 = v.y - (size[1] >> 1) * v.z;
      const x1 = v.x + (size[0] >> 1) * v.z, y1 = v.y + (size[1] >> 1) * v.z;
      // A margin of about 256 device pixels, so a drag rarely shows black.
      const m = Math.max(1, Math.ceil(256 * v.z / span)), out = [];
      for (let cy = Math.floor(y0 / span) - m; cy <= Math.floor(y1 / span) + m; cy++) {
        for (let cx = Math.floor(x0 / span) - m; cx <= Math.floor(x1 / span) + m; cx++) out.push([cx, cy]);
      }
      const mx = v.x / span - 0.5, my = v.y / span - 0.5;
      out.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
      return out;
    }

    // Tell each worker what it should render now. A region of 8x8 chunks
    // always goes to the same worker, which keeps the tiles pass 1 needs
    // from the chunks around.
    requestChunks() {
      const st = this.previewState;
      if (!this.previewJob || !this.previewWorkers || (st && st.error) || this.zoomTimer) return;
      const L = this.level(), chunks = this.visibleChunks(L);
      // The same chunks as last time: the workers already have the list.
      const key = this.previewJob + ':' + L + ':' + (chunks.length && chunks[0]) + ':' + chunks.length + ':' + (chunks.length && chunks[chunks.length - 1]) + ':' + !!this.dragging;
      if (key === this.wantKey) return;
      this.wantKey = key;
      const cache = this.chunkCache, lists = this.previewWorkers.map(() => []);
      const want = (M, cx, cy, only) => {
        let h = Math.imul(cx >> 3, 0x9e3779b1) ^ Math.imul(cy >> 3, 0x85ebca6b) ^ M;
        h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
        lists[((h ^ (h >>> 12)) >>> 0) % lists.length].push(only ? [M, cx, cy, 1] : [M, cx, cy]);
      };
      // First the coarsest level's tiles, a few quick chunks to show under
      // the view's level until it arrives.
      if (L < MAX_ZOOM) {
        for (const [cx, cy] of this.visibleChunks(MAX_ZOOM)) if (!cache.has(MAX_ZOOM + ':' + cx + ',' + cy)) want(MAX_ZOOM, cx, cy, true);
      }
      for (const [cx, cy] of chunks) {
        const got = cache.get(L + ':' + cx + ',' + cy);
        if (!got || !got.last) want(L, cx, cy, false);
      }
      // While dragging, only the quick first pass: the rest once it stops.
      this.previewWorkers.forEach((w, i) => w.postMessage({ type: 'want', job: this.previewJob, items: lists[i], quick: !!this.dragging }));
    }

    drawView() {
      const c = this.previewCanvas, size = this.canvasSize();
      if (!size) return;
      if (c.width !== size[0] || c.height !== size[1]) { c.width = size[0]; c.height = size[1]; }
      const ctx = c.getContext('2d'), L = this.level(), v = this.view;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size[0], size[1]);
      this.arrived = [];
      this.redrawAll = false;
      if (!this.blocks) return;
      // Coarser levels first: they show through where the view's level has
      // no chunk yet.
      const x0 = v.x - (size[0] >> 1) * v.z, y0 = v.y - (size[1] >> 1) * v.z;
      for (let M = MAX_ZOOM; M >= L; M /= 2) {
        const span = 32 * BLOCK * M;
        for (let by = Math.floor(y0 / span); by * span < y0 + size[1] * v.z; by++) {
          for (let bx = Math.floor(x0 / span); bx * span < x0 + size[0] * v.z; bx++) {
            const key = M + ':' + bx + ',' + by, b = this.blocks.get(key);
            if (!b) continue;
            // Most recently seen last, so the least seen go first.
            if (M === L) { this.blocks.delete(key); this.blocks.set(key, b); }
            const r = this.screenRect(size, span, bx, by);
            ctx.drawImage(b.canvas, r[0], r[1], r[2], r[3]);
          }
        }
      }
    }

    // Where a square of span tiles, the (i, j)th of its size, goes in the
    // preview, in whole device pixels.
    screenRect(size, span, i, j) {
      const v = this.view;
      const x0 = v.x - (size[0] >> 1) * v.z, y0 = v.y - (size[1] >> 1) * v.z;
      const dx = Math.round((i * span - x0) / v.z), dy = Math.round((j * span - y0) / v.z);
      return [dx, dy, Math.round(((i + 1) * span - x0) / v.z) - dx, Math.round(((j + 1) * span - y0) / v.z) - dy];
    }

    // Put a chunk in its block.
    keepChunk(L, cx, cy, bitmap, last) {
      const bx = Math.floor(cx / BLOCK), by = Math.floor(cy / BLOCK), key = L + ':' + bx + ',' + by;
      let b = this.blocks.get(key);
      if (!b) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32 * BLOCK;
        b = { canvas, ctx: canvas.getContext('2d'), chunks: [] };
        this.blocks.set(key, b);
        if (this.blocks.size > MAX_BLOCKS) {
          const [k, old] = this.blocks.entries().next().value;
          this.blocks.delete(k);
          old.chunks.forEach((c) => this.chunkCache.delete(c));
          old.canvas.width = old.canvas.height = 0;
        }
      }
      const ck = L + ':' + cx + ',' + cy;
      if (!this.chunkCache.has(ck)) b.chunks.push(ck);
      this.chunkCache.set(ck, { last });
      b.ctx.drawImage(bitmap, (cx - bx * BLOCK) * 32, (cy - by * BLOCK) * 32);
      return b;
    }

    // Resizing, browser zoom and moving to a screen with another scale all
    // change the device pixel ratio; not all of them fire a resize.
    watchPixelRatio() {
      if (this.previewWatch || this.destroyed) return;
      const resize = () => this.viewChanged();
      let mq = null;
      const listen = () => {
        if (mq) mq.removeEventListener('change', onRatio);
        mq = window.matchMedia ? window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)') : null;
        if (mq) mq.addEventListener('change', onRatio);
      };
      const onRatio = () => { listen(); resize(); };
      listen();
      window.addEventListener('resize', resize);
      this.previewWatch = () => { window.removeEventListener('resize', resize); if (mq) mq.removeEventListener('change', onRatio); };
    }

    dropChunks() {
      if (this.blocks) for (const b of this.blocks.values()) b.canvas.width = b.canvas.height = 0;
      this.blocks = this.chunkCache = null;
    }

    // For a host that removes the window: stop the preview and let go of it.
    destroy() {
      clearTimeout(this.zoomTimer);
      clearTimeout(this.requestTimer);
      this.dropChunks();
      clearTimeout(this.previewTimer);
      this.destroyed = true;
      (this.previewWorkers || []).forEach((w) => { w.onmessage = w.onerror = null; w.terminate(); });
      this.previewWorkers = null;
      if (this.previewWatch) this.previewWatch();
      this.previewWatch = null;
      if (this.previewResize) this.previewResize.disconnect();
      if (this.tooltip) this.tooltip.remove();
    }

    // Drag to move the map, the wheel or a pinch to zoom, keys too.
    panAndZoom(frame) {
      const pointers = new Map();
      let pinch = 0;
      // A pointer's position in device pixels of the preview.
      const at = (e) => {
        const r = this.previewCanvas.getBoundingClientRect(), c = this.previewCanvas;
        return [(e.clientX - r.left) / r.width * c.width, (e.clientY - r.top) / r.height * c.height];
      };
      frame.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target !== this.previewCanvas) return;
        pointers.set(e.pointerId, at(e));
        frame.setPointerCapture(e.pointerId);
        frame.classList.add('fmg-dragging');
        this.dragging = true;
        if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
        frame.focus({ preventScroll: true });
        e.preventDefault();
      });
      frame.addEventListener('pointermove', (e) => {
        const was = pointers.get(e.pointerId);
        if (!was) return;
        const now = at(e);
        pointers.set(e.pointerId, now);
        if (pointers.size === 1) {
          this.view.x -= (now[0] - was[0]) * this.view.z;
          this.view.y -= (now[1] - was[1]) * this.view.z;
          this.viewChanged();
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
          // Half the move pans, the change in spread zooms about the middle.
          this.view.x -= (now[0] - was[0]) / 2 * this.view.z;
          this.view.y -= (now[1] - was[1]) / 2 * this.view.z;
          // A step for each doubling or halving of the spread.
          if (pinch > 0 && dist > 0 && Math.abs(Math.log2(pinch / dist)) >= 0.7) {
            this.zoomView(pinch > dist ? 1 : -1, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
            pinch = dist;
          }
          this.viewChanged();
        }
      });
      const end = (e) => {
        if (!pointers.delete(e.pointerId)) return;
        pinch = 0;
        if (!pointers.size) {
          frame.classList.remove('fmg-dragging');
          this.dragging = false;
          this.requestSoon();
        }
      };
      frame.addEventListener('pointerup', end);
      frame.addEventListener('pointercancel', end);
      // The wheel zooms a step for each WHEEL_STEP of travel in one direction:
      // a mouse wheel's notch is one step, a touchpad's small moves add up.
      let wheel = 0, wheelAt = 0;
      frame.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        if (!dy) return;
        if (Math.sign(dy) !== Math.sign(wheel) || e.timeStamp - wheelAt > 400) wheel = 0;
        wheelAt = e.timeStamp;
        wheel += dy;
        if (Math.abs(wheel) < WHEEL_STEP) return;
        wheel = 0;
        const p = at(e);
        this.zoomView(Math.sign(dy), p[0], p[1]);
      }, { passive: false });
      frame.addEventListener('dblclick', (e) => { const p = at(e); this.zoomView(-1, p[0], p[1]); });
      frame.addEventListener('keydown', (e) => {
        const step = 64 * Math.max(1, (window.devicePixelRatio || 1)) * this.view.z;
        const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (keys[e.key]) { this.view.x += keys[e.key][0]; this.view.y += keys[e.key][1]; this.viewChanged(); }
        else if (e.key === '+' || e.key === '=') this.zoomView(-1);
        else if (e.key === '-' || e.key === '_') this.zoomView(1);
        else if (e.key === 'Home') { this.view = { x: 0, y: 0, z: 1 }; this.viewChanged(); }
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // The seed box doesn't re-render the window, so tell the preview itself.
    seedChanged() {
      if (this.previewOpen) this.schedulePreview();
    }

    schedulePreview() {
      const st = this.previewState;
      if (!st || (!st.auto && st.key)) return;
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.loadPreview(false), 300);
    }

    workers() {
      if (this.previewWorkers) return this.previewWorkers;
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      const url = this.opts.workerUrl || ICON_BASE.replace(/icons\/$/, '') + 'mapgen-worker.js?v=13';
      this.previewWorkers = [];
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.onmessage = (e) => this.onPreviewMessage(e.data);
        w.onerror = (e) => this.onPreviewMessage({ type: 'error', job: this.previewJob, message: e.message || 'worker failed' });
        this.previewWorkers.push(w);
      }
      return this.previewWorkers;
    }

    // New settings: start again with an empty map, where the view is.
    loadPreview(force) {
      const st = this.previewState;
      const key = this.previewKey();
      if (!force && key === st.key) return;
      st.key = key; st.error = '';
      const job = (this.previewJob = (this.previewJob || 0) + 1);
      this.dropChunks();
      this.chunkCache = new Map();
      this.blocks = new Map();
      this.wantKey = '';
      let workers;
      try { workers = this.workers(); } catch (e) { st.error = String(e.message || e); this.updatePreviewView(); return; }
      const mgs = this.result().mapGenSettings;
      workers.forEach((w) => w.postMessage({ type: 'config', job, modset: this.modset, planet: this.previewPlanet || 'nauvis', mgs }));
      this.updatePreviewView();
      this.viewChanged();
    }

    onPreviewMessage(m) {
      if (this.destroyed || m.job !== this.previewJob) return;
      if (m.type === 'chunk') {
        const b = this.keepChunk(m.level, m.cx, m.cy, m.bitmap, m.last);
        m.bitmap.close();
        // Draw just the new chunks, once a frame, unless the whole view is
        // being redrawn anyway.
        if (m.level === this.level()) (this.arrived || (this.arrived = [])).push([m.cx, m.cy, b]);
        else this.redrawAll = true;
        if (!this.drawPending && !this.viewFrame) {
          this.drawPending = requestAnimationFrame(() => {
            this.drawPending = 0;
            const size = this.canvasSize(), L = this.level(), c = this.previewCanvas;
            const list = this.arrived || [];
            this.arrived = [];
            // A coarser chunk goes under the others: draw them all again.
            if (this.redrawAll || !size || c.width !== size[0] || c.height !== size[1]) { this.drawView(); return; }
            const ctx = c.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            for (const [cx, cy, b] of list) {
              const r = this.screenRect(size, 32 * L, cx, cy);
              if (b.canvas.width && r[0] < size[0] && r[1] < size[1] && r[0] + r[2] > 0 && r[1] + r[3] > 0) {
                ctx.drawImage(b.canvas, (cx - Math.floor(cx / BLOCK) * BLOCK) * 32, (cy - Math.floor(cy / BLOCK) * BLOCK) * 32, 32, 32, r[0], r[1], r[2], r[3]);
              }
            }
          });
        }
      } else if (m.type === 'error') {
        this.previewFailed(m.message);
      }
    }

    previewFailed(message) {
      this.previewState.error = message;
      this.previewState.key = '';
      this.updatePreviewView();
    }

    // Swap just the preview pane, so typing and dragging aren't disturbed.
    updatePreviewView() {
      const old = this.root.querySelector('.fmg-preview');
      if (old && this.previewOpen) old.replaceWith(this.renderPreview());
    }

    play() {
      const r = this.result();
      if (this.opts.onPlay) this.opts.onPlay(r);
    }

    renderTab(tab) {
      if (tab === 'resources') return this.renderResources();
      if (tab === 'terrain') return this.renderTerrain();
      if (tab === 'enemy') return this.renderEnemy();
      return this.renderAdvanced();
    }

    // ---- small building blocks ----

    tip(node, text) {
      node.addEventListener('mouseenter', (e) => { const s = typeof text === 'function' ? text() : text; if (!s) return; this.tooltip.textContent = s; this.tooltip.hidden = false; this.moveTip(e); });
      node.addEventListener('mousemove', (e) => this.moveTip(e));
      node.addEventListener('mouseleave', () => { this.tooltip.hidden = true; });
    }
    moveTip(e) { this.tooltip.style.left = (e.clientX + 16) + 'px'; this.tooltip.style.top = (e.clientY + 20) + 'px'; }

    label(text, tooltip) {
      const span = el('span', {}, text, tooltip ? el('img', { class: 'fmg-i', src: ICON_BASE + 'info.png', alt: '' }) : null);
      if (tooltip) this.tip(span, tooltip);
      return span;
    }

    get iconBase() { return this.opts.iconBase || ICON_BASE; }
    icon(type, name) {
      if (type === 'entity' && ORE[name]) return el('img', { class: 'fmg-ico fmg-sprite', src: this.iconBase + 'entity/' + name + '.png', alt: '' });
      if (ORE[name]) return el('span', { class: 'fmg-ico fmg-ore', style: { '--ore': ORE[name] } });
      return el('span', { class: 'fmg-ico' });
    }
    planets(c) {
      return el('span', {}, c.planets.map((p) => {
        const planet = this.modsetData.planets.find((x) => x.name === p);
        const node = el('img', { class: 'fmg-planet fmg-sprite', src: this.iconBase + 'planet/' + p + '.png', alt: planet ? planet.label : p });
        this.tip(node, planet ? planet.label : p);
        return node;
      }));
    }
    // "[entity=iron-ore] Iron ore" → icon + text.
    richName(c) {
      const m = /^\[(entity|item|tile|fluid)=([^\]]+)\]\s*(.*)$/.exec(c.label);
      if (!m) return el('span', {}, c.label);
      return el('span', { class: 'fmg-name' }, this.icon(m[1], m[2]), m[3]);
    }

    // A notched slider over `values`; get/set work on the real value.
    slider({ values, get, set, format, disabled, linear, plain, width }) {
      const n = values.length;
      const s = el('div', { class: 'fmg-slider' + (disabled ? ' fmg-disabled' : '') + (plain ? ' fmg-plain' : ''), style: width ? { width: width + 'px' } : null, role: 'slider', tabindex: disabled ? -1 : 0 });
      const notches = el('div', { class: 'fmg-notches' });
      if (!plain) for (let i = 0; i < n; i++) notches.append(el('div', { class: 'fmg-notch', style: { left: (6 + (i / (n - 1)) * (100 - 12 * 100 / (width || 108))) + '%' } }));
      const fill = el('div', { class: 'fmg-fill' }), thumb = el('div', { class: 'fmg-thumb' });
      s.append(notches, el('div', { class: 'fmg-track' }), fill, thumb);
      const W = () => s.clientWidth || width || 108;
      const indexOf = (v) => (linear ? nearestLinear(values, v) : nearestIndex(values, v));
      const place = () => {
        const i = indexOf(get());
        const x = 6 + (i / (n - 1)) * (W() - 12);
        thumb.style.left = x + 'px'; fill.style.width = x + 'px';
        s.setAttribute('aria-valuenow', String(get()));
        s.setAttribute('aria-valuetext', format(get()));
      };
      const pick = (clientX) => {
        const r = s.getBoundingClientRect();
        const scale = r.width / W();
        const x = (clientX - r.left) / scale;
        const i = Math.max(0, Math.min(n - 1, Math.round(((x - 6) / (W() - 12)) * (n - 1))));
        if (indexOf(get()) !== i || values[i] !== get()) { set(values[i]); place(); this.afterSlide(); }
        this.tooltip.textContent = format(get()); this.tooltip.hidden = false;
      };
      s.addEventListener('pointerdown', (e) => {
        if (disabled) return;
        s.setPointerCapture(e.pointerId); s.classList.add('fmg-drag-on'); pick(e.clientX); this.moveTip(e);
        const move = (ev) => { pick(ev.clientX); this.moveTip(ev); };
        const up = () => { s.classList.remove('fmg-drag-on'); s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); this.tooltip.hidden = true; this.changed(); };
        s.addEventListener('pointermove', move); s.addEventListener('pointerup', up);
      });
      s.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = Math.max(0, Math.min(n - 1, indexOf(get()) + d));
        set(values[i]); this.changed();
      });
      this.tip(s, () => format(get()));
      requestAnimationFrame(place); place();
      return s;
    }
    afterSlide() { if (this.onSlide) this.onSlide(); }

    checkbox(checked, onchange, text, tooltip, disabled) {
      const input = el('input', { type: 'checkbox', checked, disabled, onchange: (e) => { onchange(e.target.checked); this.changed(); } });
      const lab = el('label', { class: 'fmg-check' }, input, text !== undefined ? this.label(text, tooltip) : null);
      return lab;
    }

    // ---- tabs ----

    controlSliders(c, fields) {
      const apc = this.settings.mgs.autoplace_controls;
      const cur = apc[c.name] || (apc[c.name] = { frequency: 1, size: 1, richness: 1 });
      const off = cur.size === 0;
      return fields.map((f) => {
        if (!f) return el('td', { class: 'fmg-col-slider' });
        const inverse = f.inverse;
        return el('td', { class: 'fmg-col-slider' }, this.slider({
          values: NOTCHES,
          get: () => (inverse ? 1 / cur[f.key] : cur[f.key]),
          set: (v) => { cur[f.key] = f32(inverse ? 1 / v : v); },
          format: pct,
          disabled: off && f.key !== 'size' ? true : off,
        }));
      });
    }

    controlCheckbox(c) {
      if (!c.can_be_disabled) return null;
      const apc = this.settings.mgs.autoplace_controls;
      const cur = apc[c.name] || (apc[c.name] = { frequency: 1, size: 1, richness: 1 });
      // Unticking a control stores size 0, as the game does.
      return this.checkbox(cur.size !== 0, (on) => {
        if (on) cur.size = this.disabledSizes[c.name] || 1;
        else { this.disabledSizes[c.name] = cur.size; cur.size = 0; }
      });
    }

    header(cols) {
      const cls = ['fmg-c-name', 'fmg-c-planet', 'fmg-c-a', 'fmg-c-b', 'fmg-c-c'];
      return [el('colgroup', {}, cols.map((c, i) => el('col', { class: cls[i] }))),
        el('tr', {}, cols.map((c) => el('th', {}, c ? this.label(c.text, c.tip) : '')))];
    }

    renderResources() {
      const G = (k) => this.t('gui-map-generator', k);
      const rows = this.modsetData.controls.filter((c) => c.category === 'resource');
      return el('table', { class: 'fmg-table' },
        this.header([null, { text: G('appears-on'), tip: G('appears-on-description'), planet: true },
          { text: G('frequency'), tip: G('resource-frequency-description') },
          { text: G('size'), tip: G('resource-size-description') },
          { text: G('richness'), tip: G('resource-richness-description') }]),
        rows.map((c) => el('tr', {},
          el('td', {}, el('span', { class: 'fmg-name' }, this.controlCheckbox(c), this.richName(c))),
          el('td', {}, this.planets(c)),
          ...this.controlSliders(c, [{ key: 'frequency' }, { key: 'size' }, c.richness ? { key: 'richness' } : null]))));
    }

    renderTerrain() {
      const G = (k) => this.t('gui-map-generator', k);
      const md = this.modsetData, pen = this.settings.mgs.property_expression_names;
      const elevations = md.elevation;
      const curElev = pen.elevation || 'elevation';
      const mapType = this.dropdown({
        label: G('map-type'), width: 196, value: curElev,
        options: elevations.map((x) => ({ value: x.name, text: x.label })),
        onChange: (v) => { if (v === 'elevation') delete pen.elevation; else pen.elevation = v; this.changed(); },
      });
      const terrain = md.controls.filter((c) => c.category === 'terrain');
      const cliffs = md.controls.filter((c) => c.category === 'cliff');
      const nameCell = (c) => el('td', {}, el('span', { class: 'fmg-name' }, this.controlCheckbox(c), this.label(c.label, c.description)));
      const climate = (kind, labelKey, tipKey) => {
        const fk = 'control:' + kind + ':frequency', bk = 'control:' + kind + ':bias';
        return el('tr', {},
          el('td', {}, this.label(G(labelKey), G(tipKey))),
          el('td', {}, this.planets({ planets: ['nauvis'] })),
          el('td', { class: 'fmg-col-slider' }, this.slider({
            values: NOTCHES,
            get: () => 1 / (pen[fk] !== undefined ? Number(pen[fk]) : 1),
            set: (v) => { if (v === 1) delete pen[fk]; else pen[fk] = fixed6(1 / v); },
            format: pct,
          })),
          el('td', { class: 'fmg-col-slider' }, this.slider({
            values: BIAS_NOTCHES, linear: true,
            get: () => (pen[bk] !== undefined ? Number(pen[bk]) : 0),
            set: (v) => { if (v === 0) delete pen[bk]; else pen[bk] = fixed6(v); },
            format: (v) => (v > 0 ? '+' : '') + v.toFixed(2),
          })));
      };
      return el('div', {},
        el('div', { class: 'fmg-group fmg-row', style: { marginBottom: '4px' } }, el('span', { class: 'fmg-row-label' }, G('map-type')), mapType),
        el('table', { class: 'fmg-table fmg-wide-first' },
          this.header([null, { text: G('appears-on'), tip: G('appears-on-description'), planet: true },
            { text: G('scale'), tip: G('terrain-scale-description') }, { text: G('coverage'), tip: G('terrain-coverage-description') }]),
          terrain.map((c) => el('tr', {}, nameCell(c), el('td', {}, this.planets(c)),
            ...this.controlSliders(c, [{ key: 'frequency', inverse: true }, { key: 'size' }])))),
        el('table', { class: 'fmg-table fmg-wide-first' },
          this.header([null, { text: G('appears-on'), tip: G('appears-on-description'), planet: true },
            { text: G('cliff-frequency'), tip: G('cliff-frequency-description') }, { text: G('cliff-continuity'), tip: G('cliff-continuity-description') }]),
          cliffs.map((c) => el('tr', {}, nameCell(c), el('td', {}, this.planets(c)),
            ...this.controlSliders(c, [{ key: 'frequency' }, { key: 'size' }])))),
        el('table', { class: 'fmg-table fmg-wide-first' },
          this.header([null, { text: G('appears-on'), tip: G('appears-on-description'), planet: true },
            { text: G('scale'), tip: G('terrain-scale-description') }, { text: G('bias'), tip: G('terrain-bias-description') }]),
          climate('moisture', 'moisture', 'moisture-description'),
          climate('aux', 'aux', 'aux-description')));
    }

    // A "label … slider [value]" row for the enemy and advanced settings.
    // These ranges are this page's own choice: the game's are not in its data files.
    valueRow({ label, tip, get, set, min, max, step, toDisplay, fromDisplay, unit, int }) {
      const values = [];
      for (let v = min; v <= max + 1e-9; v += step) values.push(Math.round(v * 1e6) / 1e6);
      const show = (v) => { const d = toDisplay(v); return (int ? String(Math.round(d)) : String(parseFloat(d.toPrecision(6)))) + (unit || ''); };
      const text = el('input', {
        class: 'fmg-text fmg-short', value: show(get()),
        onchange: (e) => {
          const d = parseFloat(String(e.target.value).replace(/[^0-9.\-]/g, ''));
          if (!isFinite(d) || d < 0) { e.target.classList.add('fmg-invalid'); return; }
          set(fromDisplay(int ? Math.round(d) : d)); this.changed();
        },
      });
      const sl = this.slider({
        values, linear: true, plain: true, width: 208,
        get: () => toDisplay(get()), set: (d) => { set(fromDisplay(d)); text.value = show(get()); }, format: () => show(get()),
      });
      return el('div', { class: 'fmg-row' }, el('span', { class: 'fmg-row-label' }, this.label(label, tip)), sl, text);
    }

    renderEnemy() {
      const G = (k, ...a) => this.t('gui-map-generator', k, ...a);
      const mgs = this.settings.mgs, ms = this.settings.ms;
      const enemies = this.modsetData.controls.filter((c) => c.category === 'enemy');
      const ex = ms.enemy_expansion, ev = ms.enemy_evolution;
      const def = MX.defaultMapSettings(this.template._raw.version);
      const MIN = 3600;
      const expRows = [
        this.is21 && this.valueRow({ label: G('enemy-expansion-minimum-expansion-distance'), tip: G('enemy-expansion-minimum-expansion-distance-description', def.enemy_expansion.min_expansion_distance),
          get: () => ex.min_expansion_distance, set: (v) => { ex.min_expansion_distance = v; }, min: 1, max: 20, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true }),
        this.valueRow({ label: G('enemy-expansion-maximum-expansion-distance'), tip: G('enemy-expansion-maximum-expansion-distance-description', def.enemy_expansion.max_expansion_distance),
          get: () => ex.max_expansion_distance, set: (v) => { ex.max_expansion_distance = v; }, min: 1, max: 20, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true }),
        this.is21 ? this.valueRow({ label: G('enemy-expansion-evolution-group-size-factor'), tip: G('enemy-expansion-evolution-group-size-factor-description', def.enemy_expansion.evolution_group_size_factor),
          get: () => ex.evolution_group_size_factor, set: (v) => { ex.evolution_group_size_factor = v; }, min: 1, max: 20, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d })
          : [this.valueRow({ label: G('enemy-expansion-minimum-expansion-group-size'), tip: G('enemy-expansion-minimum-expansion-group-size-description', def.enemy_expansion.settler_group_min_size),
            get: () => ex.settler_group_min_size, set: (v) => { ex.settler_group_min_size = v; }, min: 1, max: 50, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true }),
          this.valueRow({ label: G('enemy-expansion-maximum-expansion-group-size'), tip: G('enemy-expansion-maximum-expansion-group-size-description', def.enemy_expansion.settler_group_max_size),
            get: () => ex.settler_group_max_size, set: (v) => { ex.settler_group_max_size = v; }, min: 1, max: 100, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true })],
        this.valueRow({ label: G('enemy-expansion-minimum-expansion-cooldown'), tip: G('enemy-expansion-minimum-expansion-cooldown-description', def.enemy_expansion.min_expansion_cooldown / MIN + ' ' + G('enemy-expansion-minutes')),
          get: () => ex.min_expansion_cooldown, set: (v) => { ex.min_expansion_cooldown = v; }, min: 1, max: 60, step: 1, toDisplay: (v) => v / MIN, fromDisplay: (d) => Math.round(d * MIN), unit: ' ' + G('enemy-expansion-minutes') }),
        this.valueRow({ label: G('enemy-expansion-maximum-expansion-cooldown'), tip: G('enemy-expansion-maximum-expansion-cooldown-description', def.enemy_expansion.max_expansion_cooldown / MIN + ' ' + G('enemy-expansion-minutes')),
          get: () => ex.max_expansion_cooldown, set: (v) => { ex.max_expansion_cooldown = v; }, min: 1, max: 180, step: 1, toDisplay: (v) => v / MIN, fromDisplay: (d) => Math.round(d * MIN), unit: ' ' + G('enemy-expansion-minutes') }),
      ];
      const evRows = [
        this.valueRow({ label: G('evolution-time-factor'), tip: G('evolution-time-factor-description', Math.round(def.enemy_evolution.time_factor * 1e7)),
          get: () => ev.time_factor, set: (v) => { ev.time_factor = v; }, min: 0, max: 1000, step: 1, toDisplay: (v) => v * 1e7, fromDisplay: (d) => d / 1e7, int: true }),
        this.valueRow({ label: G('evolution-destroy-factor'), tip: G('evolution-destroy-factor-description', Math.round(def.enemy_evolution.destroy_factor * 1e5)),
          get: () => ev.destroy_factor, set: (v) => { ev.destroy_factor = v; }, min: 0, max: 1000, step: 1, toDisplay: (v) => v * 1e5, fromDisplay: (d) => d / 1e5, int: true }),
        this.valueRow({ label: G('evolution-pollution-factor'), tip: G('evolution-pollution-factor-description', Math.round(def.enemy_evolution.pollution_factor * 1e7)),
          get: () => ev.pollution_factor, set: (v) => { ev.pollution_factor = v; }, min: 0, max: 1000, step: 1, toDisplay: (v) => v * 1e7, fromDisplay: (d) => d / 1e7, int: true }),
      ];
      return el('div', {},
        el('table', { class: 'fmg-table fmg-wide-first' },
          this.header([null, { text: G('appears-on'), tip: G('appears-on-description'), planet: true },
            { text: G('frequency'), tip: G('enemy-frequency-description') }, { text: G('size'), tip: G('enemy-size-description') }]),
          enemies.map((c) => el('tr', {}, el('td', {}, this.label(c.label, G('enemy-frequency-description'))), el('td', {}, this.planets(c)),
            ...this.controlSliders(Object.assign({}, c), [{ key: 'frequency' }, { key: 'size' }])))),
        el('div', { class: 'fmg-group' },
          el('div', {}, this.checkbox(mgs.no_enemies_mode, (v) => { mgs.no_enemies_mode = v; }, G('no-enemies-mode-checkbox'), G('no-enemies-mode-description'))),
          el('div', {}, this.checkbox(mgs.peaceful_mode, (v) => { mgs.peaceful_mode = v; }, G('peaceful-mode-checkbox'), G('peaceful-mode-description')))),
        el('div', { class: 'fmg-group fmg-row' }, el('span', { class: 'fmg-row-label' }, this.label(G('starting-area-size'), G('starting-area-size-description'))),
          el('div', { style: { width: '124px' } }, this.slider({ values: NOTCHES, get: () => mgs.starting_area, set: (v) => { mgs.starting_area = f32(v); }, format: pct }))),
        el('div', { class: 'fmg-group' + (ex.enabled ? '' : ' fmg-off') },
          el('div', { class: 'fmg-group-title' }, this.checkbox(ex.enabled, (v) => { ex.enabled = v; }, G('enemy-expansion-group-tile'), G('enemy-expansion-group-tile-description'))),
          expRows),
        el('div', { class: 'fmg-group' + (ev.enabled ? '' : ' fmg-off') },
          el('div', { class: 'fmg-group-title' }, this.checkbox(ev.enabled, (v) => { ev.enabled = v; }, G('evolution'), G('evolution-description'))),
          evRows));
    }

    renderAdvanced() {
      const G = (k, ...a) => this.t('gui-map-generator', k, ...a);
      const mgs = this.settings.mgs, ms = this.settings.ms, p = ms.pollution;
      const def = MX.defaultMapSettings(this.template._raw.version);
      const sizeField = (key) => el('input', {
        class: 'fmg-text', value: mgs[key] && mgs[key] !== DEFAULT_SIZE ? String(mgs[key]) : '', inputmode: 'numeric',
        onchange: (e) => {
          const v = e.target.value.trim();
          if (v === '' || v === '0') { mgs[key] = DEFAULT_SIZE; e.target.classList.remove('fmg-invalid'); this.changed(); return; }
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > DEFAULT_SIZE) { e.target.classList.add('fmg-invalid'); return; }
          mgs[key] = n; this.changed();
        },
      });
      const priceField = el('input', {
        class: 'fmg-text', value: String(parseFloat(ms.difficulty_settings.technology_price_multiplier.toPrecision(6))),
        onchange: (e) => {
          const n = Number(e.target.value);
          if (!isFinite(n) || n < 0.001 || n > 1000) { e.target.classList.add('fmg-invalid'); return; }
          ms.difficulty_settings.technology_price_multiplier = n; this.changed();
        },
      });
      const pctRow = (label, tip, obj, key, max) => this.valueRow({ label, tip, get: () => obj[key], set: (v) => { obj[key] = v; }, min: 0, max, step: 1, toDisplay: (v) => v * 100, fromDisplay: (d) => d / 100, unit: '%', int: true });
      const spaceAge = this.modset === 'space-age';
      return el('div', {},
        el('div', { class: 'fmg-group fmg-map-group' },
          el('div', { class: 'fmg-group-title' }, G('map-size-group-tile')),
          el('div', {},
            el('div', { class: 'fmg-row fmg-row-right' }, el('span', {}, G('map-width')), sizeField('width')),
            el('div', { class: 'fmg-row fmg-row-right' }, el('span', {}, G('map-height')), sizeField('height')))),
        el('div', { class: 'fmg-group' },
          el('div', { class: 'fmg-group-title' }, G('technology-difficulty-group-tile')),
          el('div', { class: 'fmg-row fmg-row-right' }, el('span', {}, G('price-multiplier')), priceField)),
        el('div', { class: 'fmg-group' + (p.enabled ? '' : ' fmg-off') },
          el('div', { class: 'fmg-group-title' }, this.checkbox(p.enabled, (v) => { p.enabled = v; }, G('pollution'), G('pollution-description'))),
          pctRow(G('pollution-absorption-modifier'), G('pollution-absorption-modifier-description'), p, 'ageing', 400),
          pctRow(G('enemy-attack-pollution-consumption-modifier'), G('enemy-attack-pollution-consumption-modifier-description'), p, 'enemy_attack_pollution_consumption_modifier', 400),
          this.valueRow({ label: G('minimum-pollution-to-damage-trees'), tip: G('minimum-pollution-to-damage-trees-description', def.pollution.min_pollution_to_damage_trees),
            get: () => p.min_pollution_to_damage_trees, set: (v) => { p.min_pollution_to_damage_trees = v; }, min: 0, max: 9999, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true }),
          this.valueRow({ label: G('pollution-absorbed-per-tree-damaged'), tip: G('pollution-absorbed-per-tree-damaged-description', def.pollution.pollution_restored_per_tree_damage),
            get: () => p.pollution_restored_per_tree_damage, set: (v) => { p.pollution_restored_per_tree_damage = v; }, min: 0, max: 400, step: 1, toDisplay: (v) => v, fromDisplay: (d) => d, int: true }),
          this.valueRow({ label: G('pollution-diffusion-ratio'), tip: G('pollution-diffusion-ratio-description', pct(def.pollution.diffusion_ratio)),
            get: () => p.diffusion_ratio, set: (v) => { p.diffusion_ratio = v; }, min: 0, max: 25, step: 1, toDisplay: (v) => v * 100, fromDisplay: (d) => d / 100, unit: '%', int: true })),
        spaceAge && el('div', { class: 'fmg-group' },
          el('div', { class: 'fmg-group-title' }, G('asteroids')),
          pctRow(G('asteroids-spawning-rate'), G('asteroids-spawning-rate-description'), ms.asteroids, 'spawning_rate', 400)),
        spaceAge && el('div', { class: 'fmg-group' },
          el('div', { class: 'fmg-group-title' }, G('spoiling')),
          this.valueRow({ label: G('spoiling-rate'), tip: G('spoiling-rate-description'),
            get: () => ms.difficulty_settings.spoil_time_modifier, set: (v) => { ms.difficulty_settings.spoil_time_modifier = v; },
            min: 10, max: 1000, step: 10, toDisplay: (v) => 100 / v, fromDisplay: (d) => 100 / Math.max(d, 1), unit: '%', int: true })));
    }

    // ---- import / export dialogs ----

    modal(title, body, buttons) {
      const m = el('div', { class: 'fmg-modal', onclick: (e) => { if (e.target === m) m.remove(); } },
        el('div', { class: 'fmg-window', role: 'dialog', 'aria-label': title },
          el('div', { class: 'fmg-titlebar' }, el('div', { class: 'fmg-title' }, title), el('div', { class: 'fmg-drag' })),
          el('div', { class: 'fmg-deep', style: { padding: '12px', background: 'var(--shallow)' } }, body),
          el('div', { class: 'fmg-footer' }, buttons)));
      this.root.append(m);
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); m.remove(); } });
      return m;
    }

    openImport() {
      const G = (k) => this.t('gui-map-generator', k);
      const box = el('textarea', { class: 'fmg-textbox', spellcheck: 'false', 'aria-label': G('exchange-string-import') });
      const err = el('div', { class: 'fmg-error', role: 'alert' });
      const m = this.modal(G('exchange-string-import'), [box, err], [
        el('button', { class: 'fmg-dialog-btn fmg-back', type: 'button', onclick: () => m.remove() }, this.t('gui', 'cancel')),
        el('div', { class: 'fmg-drag' }),
        el('button', { class: 'fmg-dialog-btn fmg-confirm', style: { width: 'auto', minWidth: '112px' }, type: 'button', onclick: () => {
          try { this.importString(box.value); m.remove(); this.render(); }
          catch (e) { err.textContent = /from Factorio/.test(e.message) ? e.message : G('error-importing-exchange-string'); }
        } }, G('import'))]);
      box.focus();
    }

    // Copies a link (from opts.shareUrl) that opens these settings. Without
    // clipboard access it shows the link to copy by hand.
    shareButton() {
      const btn = el('button', { class: 'fmg-btn fmg-share', type: 'button' }, 'Share link');
      btn.onclick = () => {
        const url = this.opts.shareUrl(this.result().exchangeString);
        const copied = () => { btn.textContent = 'Link copied'; clearTimeout(this.shareTimer); this.shareTimer = setTimeout(() => { btn.textContent = 'Share link'; }, 1500); };
        const manual = () => {
          const box = el('textarea', { class: 'fmg-textbox', readonly: true, spellcheck: 'false', 'aria-label': 'Share link' });
          box.value = url;
          const m = this.modal('Share link', [box], [
            el('button', { class: 'fmg-dialog-btn fmg-back', type: 'button', onclick: () => m.remove() }, this.t('gui', 'close'))]);
          box.focus(); box.select();
        };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(copied, manual);
        else manual();
      };
      this.tip(btn, 'Copy a link that opens this map');
      return btn;
    }

    openExport() {
      const G = (k) => this.t('gui-map-generator', k);
      const s = this.result().exchangeString;
      const box = el('textarea', { class: 'fmg-textbox', readonly: true, spellcheck: 'false', 'aria-label': G('exchange-string-export') });
      box.value = s;
      const m = this.modal(G('exchange-string-export'), [box], [
        el('button', { class: 'fmg-dialog-btn fmg-back', type: 'button', onclick: () => m.remove() }, this.t('gui', 'cancel')),
        el('div', { class: 'fmg-drag' }),
        el('button', { class: 'fmg-dialog-btn', type: 'button', onclick: () => { box.select(); if (navigator.clipboard) navigator.clipboard.writeText(s).catch(() => document.execCommand('copy')); else document.execCommand('copy'); } }, this.t('gui', 'copy'))]);
      box.focus(); box.select();
    }
  }

  root.FactorioMapGen = {
    mount: (container, opts) => new MapGenerator(container, opts),
    NOTCHES, MapGenerator,
  };
})(typeof self !== 'undefined' ? self : this);
