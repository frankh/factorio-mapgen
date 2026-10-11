// Renders the map preview off the main thread, a chunk at a time, the way
// the game's preview fills in: terrain first, nearest the middle first, then
// entities on top.
//
// Messages in:  {type: 'start', job, modset, planet, mgs, size, scale, chunks: [[cx, cy], ...]}
//               {type: 'stop', job}
// Messages out: {type: 'chunk', job, pass, cx, cy, w, h, pixels (RGBA)}
//               {type: 'done', job}, {type: 'error', job, message}
/* global importScripts, FactorioNoise, FactorioNoiseData, FactorioPreview */
importScripts('noise.js?v=3', 'noisedata.js?v=3', 'preview.js?v=3');

let current = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'stop') { if (m.job === current) current = 0; return; }
  if (m.type !== 'start') return;
  current = m.job;
  let renderer;
  try {
    renderer = FactorioPreview.renderer(FactorioNoiseData.modsets[m.modset], m.planet, m.mgs, m.scale);
  } catch (err) {
    self.postMessage({ type: 'error', job: m.job, message: String(err && err.message || err) });
    return;
  }
  const C = FactorioPreview.CHUNK;
  const passes = renderer.passes;
  // One pass at a time over every chunk, so the whole map gets terrain before
  // any of it gets trees and ore. Yield between chunks so 'stop' is seen.
  let pass = 0, i = 0;
  const state = new Map();
  const step = () => {
    if (current !== m.job) return;
    if (pass >= passes) { self.postMessage({ type: 'done', job: m.job }); return; }
    const [cx, cy] = m.chunks[i];
    const key = cx + ',' + cy;
    try {
      const pixels = renderer.render(pass, cx, cy, state.get(key));
      state.set(key, pixels);
      const copy = pixels.slice();
      self.postMessage({ type: 'chunk', job: m.job, pass, cx, cy, w: C, h: C, pixels: copy }, [copy.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', job: m.job, message: String(err && err.message || err) });
      return;
    }
    if (++i >= m.chunks.length) { i = 0; pass++; }
    setTimeout(step, 0);
  };
  step();
};
