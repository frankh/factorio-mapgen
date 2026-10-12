// Renders the map preview off the main thread, a chunk at a time, the way
// the game's preview fills in: terrain first, then entities on top.
//
// A chunk is 32x32 pixels at a level: level 1 is one tile a pixel (with
// cliffs, trees, rocks, enemies and ore); level L > 1 samples every Lth
// tile, an overview of tiles and ore (FactorioPreview.renderer's scale).
//
// Messages in:  {type: 'config', job, modset, planet, mgs}: new settings
//               {type: 'want', job, items: [[level, cx, cy], ...]}: the
//                 chunks wanted, most wanted first; replaces the last list
// Messages out: {type: 'chunk', job, level, pass, last, cx, cy, w, h, pixels (RGBA)}
//               {type: 'error', job, message}
/* global importScripts, FactorioNoise, FactorioNoiseData, FactorioPreview */
importScripts('noise.js?v=10', 'noisedata.js?v=7', 'preview.js?v=10');

// Pass 0's chunks kept for pass 1 (and a renderer's own caches), at most.
const KEEP = 3000;

let config = null, renderers = new Map(), wanted = [], terrain = new Map();

// Yields between chunks so new messages get through. setTimeout won't do: a
// chain of them is held to 4 ms apiece, longer than most chunks take. A
// message to ourselves comes straight back.
const tick = new MessageChannel();
let posted = false;
tick.port1.onmessage = () => { posted = false; step(); };
const later = () => { if (!posted) { posted = true; tick.port2.postMessage(0); } };

function renderer(level) {
  let r = renderers.get(level);
  if (!r) {
    r = FactorioPreview.renderer(FactorioNoiseData.modsets[config.modset], config.planet, config.mgs, level);
    renderers.set(level, r);
  }
  return r;
}

// The next piece of work: the first wanted chunk without terrain, else the
// first with terrain still waiting for its entities.
function next() {
  for (const it of wanted) if (!terrain.has(it.key)) return [it, 0];
  for (const it of wanted) if (terrain.has(it.key)) return [it, 1];
  return null;
}

function step() {
  if (!config || !wanted.length) return;
  const job = config.job;
  try {
    const work = next();
    if (!work) return;
    const [it, pass] = work;
    const r = renderer(it.level);
    const pixels = r.render(pass, it.cx, it.cy, terrain.get(it.key));
    const last = pass === r.passes - 1;
    if (last) {
      terrain.delete(it.key);
      wanted.splice(wanted.indexOf(it), 1);
    } else {
      terrain.set(it.key, pixels);
      if (terrain.size > KEEP) terrain.delete(terrain.keys().next().value);
    }
    r.trim(KEEP);
    const copy = pixels.slice();
    self.postMessage({ type: 'chunk', job, level: it.level, pass, last, cx: it.cx, cy: it.cy, w: FactorioPreview.CHUNK, h: FactorioPreview.CHUNK, pixels: copy }, [copy.buffer]);
  } catch (err) {
    wanted = [];
    self.postMessage({ type: 'error', job, message: String(err && err.message || err) });
    return;
  }
  later();
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'config') {
    // The last settings' buffers won't be read again.
    FactorioNoise.resetHeap();
    config = m; renderers = new Map(); wanted = []; terrain = new Map();
    return;
  }
  if (m.type === 'want') {
    if (!config || m.job !== config.job) return;
    wanted = m.items.map(([level, cx, cy]) => ({ level, cx, cy, key: level + ':' + cx + ',' + cy }));
    later();
  }
};
