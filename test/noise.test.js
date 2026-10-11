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

// The program's operators in WebAssembly give the JS loops' bits, odd
// values included, both run to a plan and node by node (past the few
// point counts a program keeps plans for).
test('operators: WebAssembly matches JS', { skip: !N.wasm() }, () => {
  const special = [0, -0, 1, -1, 0.5, -0.5, 2.5, -2.5, 3, -3, 1e-40, -1e-40, 0.1, 7.75, -7.75, 1 / 3, 123456.78,
    1e30, -1e30, 3e9, -3e9, 2147483647, 2147483648, -2147483649, Infinity, -Infinity, NaN];
  const v = special.concat(Array.from({ length: 13 }, (_, i) => Math.sin(i * 7.1) * 10 ** (i % 5)));
  const xs = new Float32Array(v.length * v.length), ys = new Float32Array(xs.length);
  v.forEach((a, i) => v.forEach((b, j) => { xs[i * v.length + j] = a; ys[i * v.length + j] = b; }));
  const srcs = ['x + y', 'x - y', 'x * y', 'x / y', 'x % y', 'min(x, y)', 'max(x, y)', 'x < y', 'x <= y', 'x > y',
    'x >= y', 'x == y', 'x != y', 'x & y', 'x | y', '~x', '-x', 'abs(x)', 'floor(x)', 'ceil(x)', 'sqrt(x)',
    'clamp(x, -1.5, 2.25)', 'clamp(x, y, 4)', 'if(x - y, x, 3)', 'if(x, 0.25, y)', 'x ^ 2', 'x ^ 3', 'x ^ -2',
    'x ^ 0', 'x ^ 0.5', 'x ^ 1.7', 'x ^ -0.3', '2 ^ x', 'x + 0.1', '2.5 - x', '7 / x', 'x % 2.5', '5 % x', 'x & 6',
    'x + map_seed'];
  const prog = N.compile(D.modsets.vanilla, { seed: 123456789 }, srcs.map((src) => ({ src })));
  for (let n = xs.length; n > xs.length - 7; n--) {
    const w = prog.run(xs.subarray(0, n), ys.subarray(0, n)).map((a) => a.slice());
    N.wasm(false);
    const j = prog.run(xs.subarray(0, n), ys.subarray(0, n));
    N.wasm(true);
    srcs.forEach((src, k) => j[k].forEach((jv, i) => assert.ok(Object.is(jv, w[k][i]),
      `${src} at x = ${xs[i]}, y = ${ys[i]}: WebAssembly ${w[k][i]}, JS ${jv}`)));
  }
});

// Running a program again reuses its buffers.
test('programs reuse their buffers', { skip: !N.wasm() }, () => {
  const prog = N.compile(D.modsets.vanilla, { seed: 1 }, ['elevation', 'moisture']);
  const xs = Float32Array.from({ length: 1024 }, (_, i) => i % 32), ys = Float32Array.from({ length: 1024 }, (_, i) => i >> 5);
  const sizes = [1024, 1000, 999, 998, 997, 996, 995, 500];
  for (const n of sizes) prog.run(xs.subarray(0, n), ys.subarray(0, n));
  const used = N.heapUsed();
  for (let k = 0; k < 20; k++) for (const n of sizes.concat(sizes.map((n) => n - 100))) prog.run(xs.subarray(0, n), ys.subarray(0, n));
  assert.strictEqual(N.heapUsed(), used);
});
