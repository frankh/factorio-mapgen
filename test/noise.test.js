// Checks noise.js against values the game computed for the same expressions
// (LuaSurface.calculate_tile_properties on a 2.0.77 map, seed in the fixture),
// and its WebAssembly noise kernel against its JS one.
const test = require('node:test');
const assert = require('node:assert');
const N = require('../../../web/static/mapgen/noise.js');
const D = require('../../../web/static/mapgen/noisedata.js');
const fx = require('./noise-fixtures.json');

// Everything matches the game to the bit except Voronoi distances (worked
// out in double precision here) and what builds on them.
const TOLERANCE = { voronoi: 1e-5, coal: 1e-4 };

for (const [name, c] of Object.entries(fx.cases)) {
  test(name, () => {
    const prog = N.compile(D.modsets.vanilla, { seed: fx.seed }, [{ src: c.expression }]);
    const got = prog.run(Float32Array.from(fx.x), Float32Array.from(fx.y))[0].slice();
    const tol = TOLERANCE[name] || 0;
    c.values.forEach((want, i) => {
      const err = Math.abs(got[i] - Math.fround(want)) / Math.max(1, Math.abs(want));
      assert.ok(err <= tol, `${name} at (${fx.x[i]}, ${fx.y[i]}): got ${got[i]}, game ${want}`);
    });
    // The WebAssembly noise kernel (when it loads) and the JS one agree.
    if (N.wasm()) {
      N.wasm(false);
      const js = prog.run(Float32Array.from(fx.x), Float32Array.from(fx.y))[0];
      N.wasm(true);
      js.forEach((v, i) => assert.ok(Object.is(v, got[i]), `${name}: WebAssembly ${got[i]}, JS ${v} at ${i}`));
    }
  });
}

// On a chunk's grid the game's noise takes another path, rounding
// differently; the two kernels must agree there too.
test('grid path: WebAssembly matches JS', { skip: !N.wasm() }, () => {
  const srcs = [
    'basis_noise{x = x, y = y, seed0 = 12345, seed1 = 678, input_scale = 0.37, output_scale = 1.7}',
    'multioctave_noise{x = x, y = y, seed0 = 1, seed1 = 2, octaves = 5, persistence = 0.6, input_scale = 1/50, output_scale = 1.7}',
    'quick_multioctave_noise{x = x, y = y, seed0 = 5, seed1 = 9, input_scale = 1/20, output_scale = 1, octaves = 3, octave_output_scale_multiplier = 0.5, octave_input_scale_multiplier = 2, octave_seed0_shift = 1, offset_x = 3.5}',
    'variable_persistence_multioctave_noise{x = x, y = y, seed0 = 5, seed1 = 9, input_scale = 1/20, output_scale = 1, octaves = 4, persistence = 0.6, offset_x = 1.25}',
  ];
  const xs = new Float32Array(1024), ys = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { xs[i] = -96 + (i % 32); ys[i] = 64 + (i >> 5); }
  for (const src of srcs) {
    const prog = N.compile(D.modsets.vanilla, { seed: 1 }, [{ src }]);
    const w = prog.run(xs, ys, { x0: -96, y0: 64 })[0].slice();
    N.wasm(false);
    const j = prog.run(xs, ys, { x0: -96, y0: 64 })[0];
    N.wasm(true);
    j.forEach((v, i) => assert.ok(Object.is(v, w[i]), `${src}: WebAssembly ${w[i]}, JS ${v} at ${i}`));
  }
});
