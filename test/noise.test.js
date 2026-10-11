// Checks noise.js against values the game computed for the same expressions
// (LuaSurface.calculate_tile_properties on a 2.0.77 map, seed in the fixture).
const test = require('node:test');
const assert = require('node:assert');
const N = require('../../../web/static/mapgen/noise.js');
const D = require('../../../web/static/mapgen/noisedata.js');
const fx = require('./noise-fixtures.json');

// The game evaluates in 32-bit floats; long chains of octaves can drift by
// a few float steps, and patch fields reach the tens of thousands.
// multioctave_noise weighs its octaves with the game's fast pow
// approximation, which isn't reproduced yet: off by ~2e-5.
const TOLERANCE = { elevation: 0.01, moisture: 1e-4, coal: 2, multioctave: 1e-4 };

for (const [name, c] of Object.entries(fx.cases)) {
  test(name, () => {
    const prog = N.compile(D.modsets.vanilla, { seed: fx.seed }, [{ src: c.expression }]);
    const got = prog.run(Float32Array.from(fx.x), Float32Array.from(fx.y))[0];
    const tol = TOLERANCE[name] || 1e-5;
    c.values.forEach((want, i) => {
      const err = Math.abs(got[i] - want) / Math.max(1, Math.abs(want));
      assert.ok(err <= tol, `${name} at (${fx.x[i]}, ${fx.y[i]}): got ${got[i]}, game ${want}`);
    });
  });
}
