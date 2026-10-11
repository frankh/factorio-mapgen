// Factorio's noise expressions in plain JS: the noise functions the game has
// built in, reproduced exactly, and a compiler that turns the game's
// expression strings into a program evaluated over many positions at once.
//
//   var prog = FactorioNoise.compile(defs, mapGenSettings, ['elevation', 'tile:water:probability']);
//   var out = prog.run(xs, ys);          // Float32Arrays, one per output
//
// defs holds the game's noise_expression and noise_function prototypes (see
// tools/mapgen/extract_noise.py). Results match the game's own
// LuaSurface.calculate_tile_properties to the bit for nearly every builtin
// (Voronoi distances to float precision); see tools/mapgen/README.md for how
// each was worked out. run(xs, ys, grid) with grid set for a chunk's
// positions takes the game's grid path through the noise, as map generation
// does.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FactorioNoise = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- random

  // Tausworthe taus88, as LuaRandomGenerator. Seeds below 341 act as 341.
  function Taus88(seed) {
    seed = seed >>> 0;
    if (seed < 341) seed = 341;
    this.s1 = this.s2 = this.s3 = seed;
  }
  Taus88.prototype.next = function () {
    var b;
    b = (((this.s1 << 13) ^ this.s1) >>> 19);
    this.s1 = (((this.s1 & 0xFFFFFFFE) << 12) ^ b) >>> 0;
    b = (((this.s2 << 2) ^ this.s2) >>> 25);
    this.s2 = (((this.s2 & 0xFFFFFFF8) << 4) ^ b) >>> 0;
    b = (((this.s3 << 3) ^ this.s3) >>> 11);
    this.s3 = (((this.s3 & 0xFFFFFFF0) << 17) ^ b) >>> 0;
    return (this.s1 ^ this.s2 ^ this.s3) >>> 0;
  };

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32str(s) {
    var bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Buffer.from(s, 'utf8');
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------------------------------------------------------------- basis noise

  // Four permutation tables per seed: T0 mixes in seed1, T1/T2 hash the
  // lattice y/x, T3 picks one of 256 gradient directions.
  var tableCache = new Map();
  function tables(seed) {
    seed = seed >>> 0;
    if (seed < 341) seed = 341;
    var t = tableCache.get(seed);
    if (t) return t;
    var r = new Taus88(seed);
    t = [];
    for (var n = 0; n < 4; n++) {
      var a = new Uint8Array(256);
      for (var i = 0; i < 256; i++) a[i] = i;
      for (i = 255; i > 0; i--) {
        var j = r.next() % (i + 1);
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      }
      t.push(a);
    }
    if (tableCache.size > 256) tableCache.clear();
    tableCache.set(seed, t);
    return t;
  }

  // seed1 picks the table set too: seed0 + 7 * (seed1 >> 8), seed1 & 255.
  function seedPair(seed0, seed1) {
    seed1 = seed1 >>> 0;
    return [(seed0 + 7 * (seed1 >>> 8)) >>> 0, seed1 & 255];
  }

  // The game's 256 gradients (Noise::defaultNoise, read from a running game:
  // 4.2 at 256 angles, but not quite any formula's rounding), as (x, y)
  // float pairs.
  var GRAD = (function () {
    var b64 = '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';
    var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  })();

  // A seed's noise tables, as Noise::setSeed lays them out: rows (y) and
  // columns (x) hash through T1 and T2 with seed1's byte s mixed in, and
  // pick a gradient pair from G, the gradients shuffled by T3.
  var seedCache = new Map();
  function noiseTables(seed0, seed1) {
    var sp = seedPair(seed0, seed1), key = sp[0] * 256 + sp[1], t = seedCache.get(key);
    if (t) return t;
    var T = tables(sp[0]), G = new Float32Array(512);
    for (var j = 0; j < 256; j++) { G[2 * j] = GRAD[2 * T[3][j]]; G[2 * j + 1] = GRAD[2 * T[3][j] + 1]; }
    t = { key: key, T1: T[1], T2: T[2], s: T[0][sp[1]], G: G };
    if (seedCache.size > 256) seedCache.clear();
    seedCache.set(key, t);
    return t;
  }

  // The corner sums of Noise::noise for points already in lattice units:
  //   out[i] += amp * sum over the four corners of (g . d) q^3
  // in single precision, exactly as the game does it. It has two versions:
  // for a chunk's grid of positions, q = max((1 - dy^2) - dx^2, 0) and the
  // corners sum by column; for other points, q = 1 - min(dx^2 + dy^2, 1)
  // and they sum by row.
  function noiseKernel(grid, X, Y, n, t, amp, out) {
    var f = Math.fround, T1 = t.T1, T2 = t.T2, s = t.s, G = t.G, scalarAmp = typeof amp === 'number';
    for (var i = 0; i < n; i++) {
      var xv = X[i], yv = Y[i], x0 = Math.floor(xv), y0 = Math.floor(yv);
      var fx = f(xv - x0), fy = f(yv - y0), gx = f(fx - 1), gy = f(fy - 1);
      var c0 = T2[x0 & 255], c1 = T2[(x0 + 1) & 255], r0 = T1[y0 & 255] ^ s, r1 = T1[(y0 + 1) & 255] ^ s;
      var k00 = (c0 ^ r0) << 1, k01 = (c0 ^ r1) << 1, k10 = (c1 ^ r0) << 1, k11 = (c1 ^ r1) << 1;
      var fxx = f(fx * fx), gxx = f(gx * gx), fyy = f(fy * fy), gyy = f(gy * gy), q00, q01, q10, q11;
      if (grid) {
        var a0 = f(1 - fyy), a1 = f(1 - gyy);
        q00 = Math.max(f(a0 - fxx), 0); q10 = Math.max(f(a0 - gxx), 0);
        q01 = Math.max(f(a1 - fxx), 0); q11 = Math.max(f(a1 - gxx), 0);
      } else {
        q00 = f(1 - Math.min(f(fxx + fyy), 1)); q01 = f(1 - Math.min(f(fxx + gyy), 1));
        q10 = f(1 - Math.min(f(gxx + fyy), 1)); q11 = f(1 - Math.min(f(gxx + gyy), 1));
      }
      var c00 = f(f(f(fx * G[k00]) + f(fy * G[k00 + 1])) * f(f(q00 * q00) * q00));
      var c01 = f(f(f(fx * G[k01]) + f(gy * G[k01 + 1])) * f(f(q01 * q01) * q01));
      var c10 = f(f(f(gx * G[k10]) + f(fy * G[k10 + 1])) * f(f(q10 * q10) * q10));
      var c11 = f(f(f(gx * G[k11]) + f(gy * G[k11 + 1])) * f(f(q11 * q11) * q11));
      var sum = grid ? f(f(c11 + c10) + f(c01 + c00)) : f(f(c11 + c01) + f(c10 + c00));
      out[i] = f(out[i] + f(sum * (scalarAmp ? amp : amp[i])));
    }
  }

  // The same kernel in WebAssembly with SIMD, four points at a time (from
  // tools/mapgen/wasm/basis.c; build.sh there regenerates BASIS_WASM). Its
  // results are the same to the bit. Browsers without WebAssembly SIMD, or
  // pages whose CSP forbids compiling it, use the loop above.
  var BASIS_WASM = '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';
  var useWasm = true;
  var wasmKernel = (function () {
    try {
      if (!BASIS_WASM || typeof WebAssembly !== 'object' || typeof atob !== 'function') return null;
      var bin = atob(BASIS_WASM), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports, buf = ex.memory.buffer, cap = ex.cap();
      return {
        ex: ex, cap: cap, key: -1,
        xs: new Float32Array(buf, ex.xs(), cap), ys: new Float32Array(buf, ex.ys(), cap),
        ox: new Float32Array(buf, ex.ox(), cap), oy: new Float32Array(buf, ex.oy(), cap),
        x: new Float32Array(buf, ex.x(), cap), y: new Float32Array(buf, ex.y(), cap),
        out: new Float32Array(buf, ex.out(), cap), amp: new Float32Array(buf, ex.amp(), cap),
        g: new Float32Array(buf, ex.g(), 512), t1: new Uint8Array(buf, ex.t1(), 256), t2: new Uint8Array(buf, ex.t2(), 256),
      };
    } catch (e) {
      return null;
    }
  })();

  // Octaves of noise summed into out over the points xs/ys (and, on a
  // chunk's grid, grid.x0/y0 their chunk's corner): add() one octave at a
  // time, then end(). Each octave's points go into lattice units one of four
  // ways, as the game's callers do it:
  //   'point'   (x + offx) * s
  //   'grid'    ((x - x0) + (offx + x0)) * s
  //   'mpoint'  x * s + c, the add in double (multioctave, c = 17.17 k)
  //   'mgrid'   ((x - x0) * st + (x0 * st + c)) * s, the inner add in double
  //             (multioctave on a grid, c = 17.17 k / s)
  // and y the same without c. In WebAssembly the points and the sum stay in
  // its memory throughout.
  var KINDS = { point: 0, grid: 1, mpoint: 2, mgrid: 3 };
  function noiseSum(out, xs, ys, n, grid) {
    var W = wasmKernel, gx = grid && grid.x0, gy = grid && grid.y0, i;
    if (!W || !useWasm || n > W.cap) {
      var X = new Float32Array(n), Y = new Float32Array(n);
      return {
        add: function (kind, t, amp, s, offx, offy, c, st) {
          for (i = 0; i < n; i++) {
            var x = xs[i], y = ys[i];
            if (kind === 'point') { X[i] = fr(fr(x + offx) * s); Y[i] = fr(fr(y + offy) * s); continue; }
            if (kind === 'mpoint') { X[i] = fr(fr(x * s) + c); Y[i] = fr(y * s); continue; }
            var ox = typeof gx === 'number' ? gx : gx[i], oy = typeof gy === 'number' ? gy : gy[i];
            if (kind === 'grid') { X[i] = fr(fr(fr(x - ox) + fr(offx + ox)) * s); Y[i] = fr(fr(fr(y - oy) + fr(offy + oy)) * s); }
            else { X[i] = fr(fr(fr(fr(x - ox) * st) + fr(fr(ox * st) + c)) * s); Y[i] = fr(fr(fr(fr(y - oy) * st) + fr(oy * st)) * s); }
          }
          noiseKernel(kind === 'grid' || kind === 'mgrid', X, Y, n, t, amp, out);
        },
        end: function () {},
      };
    }
    var m = (n + 3) & ~3;
    W.xs.set(xs.subarray(0, n)); W.ys.set(ys.subarray(0, n)); W.out.set(out.subarray(0, n));
    if (grid) {
      if (typeof gx === 'number') W.ox.fill(gx, 0, m); else W.ox.set(gx.subarray(0, n));
      if (typeof gy === 'number') W.oy.fill(gy, 0, m); else W.oy.set(gy.subarray(0, n));
    }
    return {
      add: function (kind, t, amp, s, offx, offy, c, st) {
        if (W.key !== t.key) { W.g.set(t.G); W.t1.set(t.T1); W.t2.set(t.T2); W.key = t.key; }
        var k = KINDS[kind];
        W.ex.coords(m, k, s, offx || 0, offy || 0, c || 0, st || 0);
        if (typeof amp === 'number') W.ex.kernel(m, k & 1, t.s, amp, 0);
        else { W.amp.set(amp.subarray(0, n)); W.ex.kernel(m, k & 1, t.s, 0, 1); }
      },
      end: function () { out.set(W.out.subarray(0, n)); },
    };
  }

  // Noise::noise for one octave, as BasisNoise and the octave noises call
  // it: on a chunk's grid when x and y are the plain positions and the
  // lattice fits the cache's scratch, otherwise point by point.
  var SCRATCH = 1025, CHUNK_W = 32;
  function gridFits(s, octaves) {
    var c = Math.ceil(fr(fr(CHUNK_W) * s));
    return octaves ? SCRATCH > 2 * c : SCRATCH >= c + 1;
  }
  function onGrid(nd, ctx) { return !!(ctx && ctx.grid && nd.args[0] === ctx.b.X && nd.args[1] === ctx.b.Y); }
  function noiseOctave(sum, grid, t, s, amp, offx, offy) {
    sum.add(grid && s > 0 && gridFits(s) ? 'grid' : 'point', t, amp, s, offx, offy);
  }

  // ---------------------------------------------------------------- program

  // A program is a list of nodes, deduplicated by structure. Each evaluates
  // to a number (constant) or a Float32Array over the positions.
  function Builder(defs, mgs) {
    this.defs = defs;
    this.mgs = mgs || {};
    this.nodes = [];
    this.keys = new Map();
    this.globals = new Map();
    this.parsed = new Map();
    this.X = this.node('x', []);
    this.Y = this.node('y', []);
  }

  // The game's own versions of pow, sin and cos (NoiseOperations::Functions),
  // which trade precision for speed.
  var F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
  function gameFastPow(a, b) {
    var fr = Math.fround;
    F32[0] = a;
    var vi = U32[0];
    U32[0] = (vi & 0x007FFFFF) | 0x3f000000;
    var mx = F32[0];
    var lg = fr(fr(fr(fr(vi * 1.1920928955078125e-7) - 124.22551727294922) - fr(1.4980303049087524 * mx)) - fr(1.7258800268173218 / fr(0.35208871960639954 + mx)));
    var p = fr(lg * b);
    var offset = p < 0 ? 1 : 0;
    var clipp = p < -126 ? -126 : p;
    var z = fr(fr(clipp - Math.trunc(clipp)) + offset);
    var v = fr(fr(fr(clipp + 121.27405548095703) + fr(27.728023529052734 / fr(4.842525482177734 - z))) - fr(1.4901291131973267 * z));
    U32[0] = Math.trunc(fr(v * 8388608)) >>> 0;
    return F32[0];
  }
  function gamePow(a, b) {
    var fr = Math.fround;
    if (a === 0) return b === 0 ? 1 : b < 0 ? Infinity : 0;
    if (Math.trunc(b) === b && Math.abs(b) < 2147483648) {
      var e = Math.abs(b), r = 1, x = a;
      while (true) {
        if (e & 1) r = fr(r * x);
        if (e < 2) break;
        x = fr(x * x); e = e >>> 1;
      }
      return b < 0 ? fr(1 / r) : r;
    }
    if (!(a >= 0)) return NaN;
    return gameFastPow(a, b);
  }
  // Bitwise operators work on the values truncated to 32-bit integers.
  function toInt(v) { return v !== v ? 0 : v >= 2147483648 ? 2147483647 : v <= -2147483649 ? -2147483648 : Math.trunc(v) | 0; }
  function roundEven(v) { var r = Math.round(v); return (r - v === 0.5 && r % 2 !== 0) ? r - 1 : r; }
  function gameSin(x) { var t = x * 0.15915494309189535 + -0.25; return gameSinCos2(t); }
  function gameCos(x) { var t = x * 0.15915494309189535; return gameSinCos2(t); }
  function gameSinCos2(t) {
    t = t - roundEven(t);
    var u = 0.25 - Math.abs(t), z = u * u, z2 = z * z;
    return Math.fround(((6.283185269630412 + z * -41.34167506665737) + z2 * (81.60201529595571 + z * -76.56887678023256) + z2 * z2 * 39.65735524898863) * u);
  }

  var FOLD = {
    add: function (a, b) { return a + b; },
    sub: function (a, b) { return a - b; },
    mul: function (a, b) { return a * b; },
    div: function (a, b) { return a / b; },
    mod: function (a, b) { return a - Math.floor(a / b) * b; },
    pow: gamePow,
    lt: function (a, b) { return a < b ? 1 : 0; },
    le: function (a, b) { return a <= b ? 1 : 0; },
    gt: function (a, b) { return a > b ? 1 : 0; },
    ge: function (a, b) { return a >= b ? 1 : 0; },
    eq: function (a, b) { return a === b ? 1 : 0; },
    ne: function (a, b) { return a !== b ? 1 : 0; },
    neg: function (a) { return -a; },
    band: function (a, b) { return toInt(a) & toInt(b); },
    bor: function (a, b) { return toInt(a) | toInt(b); },
    bxor: function (a, b) { return toInt(a) ^ toInt(b); },
    bnot: function (a) { return ~toInt(a); },
    abs: Math.abs, sqrt: Math.sqrt, sin: gameSin, cos: gameCos, floor: Math.floor, ceil: Math.ceil,
    log2: function (a) { return Math.log2(a); },
    atan2: function (a, b) { return Math.atan2(a, b); },
    min: Math.min, max: Math.max,
    clamp: function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
    ifelse: function (c, a, b) { return c !== 0 ? a : b; },
  };

  Builder.prototype.node = function (op, args, extra) {
    var allConst = FOLD[op] && args.every(function (a) { return this.nodes[a].op === 'const'; }, this);
    if (allConst) {
      var vals = args.map(function (a) { return this.nodes[a].value; }, this);
      return this.constant(Math.fround(FOLD[op].apply(null, vals)));
    }
    var key = op + '(' + args.join(',') + (extra !== undefined ? ';' + JSON.stringify(extra) : '') + ')';
    var id = this.keys.get(key);
    if (id !== undefined) return id;
    id = this.nodes.length;
    this.nodes.push({ op: op, args: args, extra: extra });
    this.keys.set(key, id);
    return id;
  };
  Builder.prototype.constant = function (v) {
    var key = 'c' + (Object.is(v, -0) ? '-0' : String(v));
    var id = this.keys.get(key);
    if (id !== undefined) return id;
    id = this.nodes.length;
    this.nodes.push({ op: 'const', args: [], value: v });
    this.keys.set(key, id);
    return id;
  };
  Builder.prototype.constValue = function (id) {
    var n = this.nodes[id];
    if (n.op !== 'const') throw new Error('expected a constant');
    return n.value;
  };

  // ------------------------------------------------------------- parser

  function tokenize(src) {
    var toks = [], i = 0;
    while (i < src.length) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      var m;
      var rest = src.slice(i);
      if ((m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest))) {
        toks.push({ t: 'num', v: parseFloat(m[1]) }); i += m[1].length; continue;
      }
      if ((m = /^[A-Za-z_][A-Za-z0-9_:]*/.exec(rest))) {
        // Identifiers may hold ':' (control:water:size).
        toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
      }
      if (c === "'" || c === '"') {
        var j = src.indexOf(c, i + 1);
        toks.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue;
      }
      var two = src.substr(i, 2);
      if (['<=', '>=', '==', '!=', '~='].indexOf(two) >= 0) { toks.push({ t: 'op', v: two === '~=' ? '!=' : two }); i += 2; continue; }
      toks.push({ t: 'op', v: c }); i++;
    }
    toks.push({ t: 'eof' });
    return toks;
  }

  // Precedence, loosest first: comparisons, + -, * / %, unary -, ^ (right).
  function parse(src) {
    if (typeof src === 'number') return { k: 'num', v: src };
    var toks = tokenize(String(src)), p = 0;
    var peek = function () { return toks[p]; };
    var isOp = function (v) { return toks[p].t === 'op' && toks[p].v === v; };
    var expect = function (v) {
      if (!isOp(v)) throw new Error('expected ' + v + ' in ' + src);
      p++;
    };
    var BIN = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne', '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '&': 'band', '|': 'bor' };
    function level(ops, next) {
      return function () {
        var a = next();
        while (peek().t === 'op' && ops.indexOf(peek().v) >= 0) {
          var o = toks[p++].v;
          a = { k: 'bin', op: BIN[o], a: a, b: next() };
        }
        return a;
      };
    }
    function power() {
      var a = primary();
      if (isOp('^')) { p++; return { k: 'bin', op: 'pow', a: a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
      if (isOp('~')) { p++; return { k: 'bnot', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return power();
    }
    var mul = level(['*', '/', '%'], unary);
    var add = level(['+', '-'], mul);
    var rel = level(['<', '<=', '>', '>=', '==', '!='], add);
    var band = level(['&'], rel);
    var cmp = level(['|'], band);
    function primary() {
      var tk = toks[p++];
      if (tk.t === 'num') return { k: 'num', v: tk.v };
      if (tk.t === 'str') return { k: 'str', v: tk.v };
      if (tk.t === 'op' && tk.v === '(') { var e = cmp(); expect(')'); return e; }
      if (tk.t !== 'id') throw new Error('unexpected ' + JSON.stringify(tk) + ' in ' + src);
      if (isOp('(')) {
        p++;
        var args = [];
        if (!isOp(')')) { args.push(cmp()); while (isOp(',')) { p++; args.push(cmp()); } }
        expect(')');
        return { k: 'call', name: tk.v, args: args };
      }
      if (isOp('{')) {
        p++;
        var named = {};
        while (!isOp('}')) {
          var nm = toks[p++].v;
          expect('=');
          named[nm] = cmp();
          if (isOp(',')) p++;
        }
        p++;
        return { k: 'call', name: tk.v, named: named };
      }
      return { k: 'id', v: tk.v };
    }
    var e = cmp();
    if (peek().t !== 'eof') throw new Error('trailing input in ' + src);
    return e;
  }

  Builder.prototype.parse = function (src) {
    var key = typeof src === 'number' ? src : String(src);
    var a = this.parsed.get(key);
    if (!a) { a = parse(src); this.parsed.set(key, a); }
    return a;
  };

  // ------------------------------------------------------------- scopes

  // A scope maps names to node ids (lazily, for local expressions) and to
  // local functions. ctx carries the x/y nodes, so multisample can shift them.
  function Scope(parent, ctx) {
    this.parent = parent;
    this.ctx = ctx || (parent && parent.ctx);
    this.vals = Object.create(null);
    this.lazy = Object.create(null);
    this.srcs = Object.create(null);
    this.funcs = Object.create(null);
  }
  Scope.prototype.lookup = function (b, name) {
    for (var s = this; s; s = s.parent) {
      if (name in s.vals) return s.vals[name];
      if (name in s.lazy) {
        var src = s.lazy[name];
        delete s.lazy[name];
        s.srcs[name] = src;
        s.vals[name] = b.compile(src, s);
        return s.vals[name];
      }
    }
    return undefined;
  };
  Scope.prototype.func = function (name) {
    for (var s = this; s; s = s.parent) if (name in s.funcs) return s.funcs[name];
    return undefined;
  };

  // A definition with local_expressions / local_functions.
  Builder.prototype.withLocals = function (def, scope) {
    if (!def.local_expressions && !def.local_functions) return scope;
    var s = new Scope(scope);
    var le = def.local_expressions || {};
    for (var k in le) s.lazy[k] = le[k];
    var lf = def.local_functions || {};
    for (k in lf) s.funcs[k] = { def: lf[k], scope: s };
    return s;
  };

  // Named expressions, after the map's property_expression_names overrides.
  Builder.prototype.global = function (name, ctx) {
    var key = name + '@' + ctx.x + ',' + ctx.y;
    if (this.globals.has(key)) {
      var v = this.globals.get(key);
      if (v === null) throw new Error('noise expression loop at ' + name);
      return v;
    }
    this.globals.set(key, null);
    var pen = this.mgs.property_expression_names || {};
    var id;
    if (Object.prototype.hasOwnProperty.call(pen, name) && pen[name] !== name) {
      var o = pen[name];
      var num = typeof o === 'number' ? o : (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(o) ? parseFloat(o) : null);
      id = num !== null ? this.constant(Math.fround(num)) : this.compile(o, new Scope(null, ctx));
    } else {
      id = this.named(name, ctx);
    }
    this.globals.set(key, id);
    return id;
  };

  Builder.prototype.named = function (name, ctx) {
    var def = this.defs.noise_expression[name];
    if (def) return this.compile(def.expression, this.withLocals(def, new Scope(null, ctx)));
    var m = /^control:(.+):(frequency|size|richness|bias)$/.exec(name);
    if (m) {
      var c = (this.mgs.autoplace_controls || {})[m[1]];
      var v = m[2] === 'bias' ? 0 : c && c[m[2]] !== undefined ? c[m[2]] : 1;
      return this.constant(Math.fround(v));
    }
    var b = this.builtinVar(name, ctx);
    if (b !== undefined) return b;
    throw new Error('unknown noise expression ' + name);
  };

  Builder.prototype.builtinVar = function (name, ctx) {
    var mgs = this.mgs, seed = (mgs.seed || 0) >>> 0;
    var cliff = mgs.cliff_settings || {};
    switch (name) {
      case 'x': return ctx.x;
      case 'y': return ctx.y;
      case 'map_seed': return this.constant(seed);
      case 'map_seed_normalized': return this.constant(Math.fround(seed / 4294967296));
      case 'map_seed_small': return this.constant(seed & 0xFFFF);
      case 'pi': return this.constant(Math.fround(Math.PI));
      case 'e': return this.constant(Math.fround(Math.E));
      case 'inf': return this.constant(Infinity);
      case 'starting_area_radius': return this.constant(Math.fround(150 * (mgs.starting_area === undefined ? 1 : mgs.starting_area)));
      case 'no_enemies_mode': return this.constant(mgs.no_enemies_mode ? 1 : 0);
      case 'peaceful_mode': return this.constant(mgs.peaceful_mode ? 1 : 0);
      case 'cliff_richness': return this.constant(Math.fround(cliff.richness === undefined ? 1 : cliff.richness));
      case 'cliff_elevation_interval': return this.constant(Math.fround(cliff.cliff_elevation_interval === undefined ? 40 : cliff.cliff_elevation_interval));
      case 'cliff_elevation_0': return this.constant(Math.fround(cliff.cliff_elevation_0 === undefined ? 10 : cliff.cliff_elevation_0));
      case 'cliff_smoothing': return this.constant(Math.fround(cliff.cliff_smoothing === undefined ? 1 : cliff.cliff_smoothing));
      case 'map_width': return this.constant(mgs.width || 2000000);
      case 'map_height': return this.constant(mgs.height || 2000000);
    }
    return undefined;
  };

  // The game's own points lists.
  Builder.prototype.points = function (name) {
    var mgs = this.mgs;
    var sp = mgs.starting_points && mgs.starting_points.length ? mgs.starting_points : [{ x: 0, y: 0 }];
    if (name === 'starting_positions') return sp.map(function (p) { return [p.x, p.y]; });
    if (name === 'starting_lake_positions') {
      // One lake per starting point, half the starting area radius out at
      // an angle from the map seed.
      var r = new Taus88(mgs.seed || 0);
      var radius = 75 * (mgs.starting_area === undefined ? 1 : mgs.starting_area);
      return sp.map(function (p) {
        var a = r.next() / 4294967296 * 2 * Math.PI;
        return [p.x + Math.trunc(radius * Math.cos(a)), p.y + Math.trunc(radius * Math.sin(a))];
      });
    }
    throw new Error('unknown points list ' + name);
  };

  // ------------------------------------------------------------- compile

  Builder.prototype.compile = function (src, scope) {
    return this.expr(this.parse(src), scope);
  };

  Builder.prototype.expr = function (a, scope) {
    switch (a.k) {
      case 'num': return this.constant(Math.fround(a.v));
      case 'str': throw new Error('string "' + a.v + '" used as a value');
      case 'neg': return this.node('neg', [this.expr(a.a, scope)]);
      case 'bnot': return this.node('bnot', [this.expr(a.a, scope)]);
      case 'bin': return this.node(a.op, [this.expr(a.a, scope), this.expr(a.b, scope)]);
      case 'id': {
        var v = scope.lookup(this, a.v);
        if (v !== undefined) return v;
        return this.global(a.v, scope.ctx);
      }
      case 'call': return this.call(a, scope);
    }
    throw new Error('bad node ' + a.k);
  };

  // Arguments of a builtin, by name or by position.
  function argGetter(b, a, scope, order) {
    return function (name, dflt) {
      var node;
      if (a.named) node = a.named[name];
      else { var i = order.indexOf(name); node = i >= 0 ? a.args[i] : undefined; }
      if (node === undefined) {
        if (dflt === undefined) throw new Error(a.name + ': missing ' + name);
        return typeof dflt === 'number' ? b.constant(Math.fround(dflt)) : dflt;
      }
      return node;
    };
  }

  Builder.prototype.call = function (a, scope) {
    var self = this;
    var name = a.name;
    var raw = function (n, d) { return argGetter(self, a, scope, ORDER[name] || [])(n, d); };
    var arg = function (n, d) {
      var r = raw(n, d);
      return typeof r === 'number' ? r : self.expr(r, scope);
    };
    var konst = function (n, d) { return self.constValue(arg(n, d)); };
    var seed1 = function () {
      var r = raw('seed1');
      if (r.k === 'str') return crc32str(r.v);
      return konst('seed1') >>> 0;
    };
    var pos = function () { return a.args.map(function (x) { return self.expr(x, scope); }); };

    // Local and prototype functions first, as the game does.
    var lf = scope.func(name);
    var fdef = lf ? lf.def : this.defs.noise_function[name];
    if (fdef) {
      var fs = new Scope(lf ? lf.scope : new Scope(null, scope.ctx), scope.ctx);
      fs.ctx = scope.ctx;
      var params = fdef.parameters || [];
      params.forEach(function (p, i) {
        var node = a.named ? a.named[p] : a.args[i];
        if (node === undefined) throw new Error(name + ': missing argument ' + p);
        fs.vals[p] = self.expr(node, scope);
      });
      return this.compile(fdef.expression, this.withLocals(fdef, fs));
    }

    switch (name) {
      case 'var': {
        var s = a.args[0];
        if (s.k !== 'str') throw new Error('var() takes a string');
        return this.global(s.v, scope.ctx);
      }
      case 'if': return this.node('ifelse', pos());
      case 'min': case 'max': {
        var xs = pos();
        return xs.reduce(function (acc, x) { return self.node(name, [acc, x]); });
      }
      case 'clamp': case 'abs': case 'sqrt': case 'sin': case 'cos': case 'log2': case 'floor': case 'ceil': case 'atan2':
        return this.node(name, pos());
      case 'pow': return this.node('pow', pos());
      case 'expression_in_range': {
        // (slope, max, v1..vn, from1..fromn, to1..ton)
        var e = pos();
        var n = (e.length - 2) / 3, acc = null;
        for (var i = 0; i < n; i++) {
          var v = e[2 + i], lo = e[2 + n + i], hi = e[2 + 2 * n + i];
          var m = this.node('min', [this.node('sub', [v, lo]), this.node('sub', [hi, v])]);
          acc = acc === null ? m : this.node('min', [acc, m]);
        }
        return this.node('min', [e[1], this.node('mul', [e[0], acc])]);
      }
      case 'multisample': {
        var dx = this.constValue(this.expr(a.args[1], scope)), dy = this.constValue(this.expr(a.args[2], scope));
        if (this.spacing) { dx *= this.spacing[0]; dy *= this.spacing[1]; }
        var ctx = { x: this.node('add', [scope.ctx.x, this.constant(dx)]), y: this.node('add', [scope.ctx.y, this.constant(dy)]) };
        // Locals already compiled at the unshifted position are redone.
        return this.expr(a.args[0], this.shifted(scope, ctx));
      }
      case 'basis_noise':
        return this.node('basis', [arg('x'), arg('y')], [konst('seed0') >>> 0, seed1(), konst('input_scale', 1), konst('output_scale', 1)]);
      case 'multioctave_noise':
        return this.node('multioctave', [arg('x'), arg('y'), arg('persistence')],
          [konst('seed0') >>> 0, seed1(), konst('octaves'), konst('input_scale', 1), konst('output_scale', 1)]);
      case 'quick_multioctave_noise':
        return this.node('quick', [arg('x'), arg('y')],
          [konst('seed0') >>> 0, seed1(), konst('octaves'), konst('input_scale', 1), konst('output_scale', 1),
            konst('offset_x', 0), konst('octave_output_scale_multiplier', 0.5), konst('octave_input_scale_multiplier', 2),
            konst('octave_seed0_shift', 1)]);
      case 'variable_persistence_multioctave_noise':
        return this.node('varpersist', [arg('x'), arg('y'), arg('persistence')],
          [konst('seed0') >>> 0, seed1(), konst('octaves'), konst('input_scale', 1), konst('output_scale', 1), konst('offset_x', 0)]);
      case 'distance_from_nearest_point': case 'distance_from_nearest_point_x': case 'distance_from_nearest_point_y': {
        var pr = raw('points');
        if (pr.k !== 'id') throw new Error(name + ': points must be a named list');
        var pts = this.points(pr.v);
        var md = konst('maximum_distance', Infinity);
        return this.node(name === 'distance_from_nearest_point' ? 'dist' : name === 'distance_from_nearest_point_x' ? 'distx' : 'disty',
          [arg('x'), arg('y')], [pts, md]);
      }
    }
    if (BUILTIN_EXT[name]) return BUILTIN_EXT[name](this, a, scope, { raw: raw, arg: arg, konst: konst, seed1: seed1, pos: pos });
    throw new Error('unknown function ' + name);
  };

  // A copy of scope whose x/y are shifted and whose local values are
  // recompiled there.
  Builder.prototype.shifted = function (scope, ctx) {
    if (!scope) return null;
    var s = new Scope(this.shifted(scope.parent, ctx), ctx);
    s.ctx = ctx;
    for (var k in scope.funcs) s.funcs[k] = scope.funcs[k];
    // Values captured as parameters stay as they are (the game binds them at
    // the call); local expressions are re-evaluated.
    for (k in scope.vals) {
      if (k in scope.srcs) s.lazy[k] = scope.srcs[k];
      else s.vals[k] = scope.vals[k];
    }
    for (k in scope.lazy) s.lazy[k] = scope.lazy[k];
    return s;
  };

  var ORDER = {
    basis_noise: ['x', 'y', 'seed0', 'seed1', 'input_scale', 'output_scale'],
    distance_from_nearest_point: ['x', 'y', 'points', 'maximum_distance'],
    distance_from_nearest_point_x: ['x', 'y', 'points', 'maximum_distance'],
    distance_from_nearest_point_y: ['x', 'y', 'points', 'maximum_distance'],
  };
  var BUILTIN_EXT = {};

  // ------------------------------------------------------------- spot noise
  //
  // As the game does it (NoiseOperations::SpotNoise and
  // ThreadSafeSpotNoiseCache in the binary):
  // - The plane is cut into region_size squares centred on multiples of
  //   region_size. Each region seeds taus88 with
  //   (7919 rx + 7907 ry + 7927 seed1 + 0x3fbe2c) ^ seed0 and draws candidate
  //   points: x = rng % size + corner, then y likewise. A point closer than
  //   the minimum spacing to an earlier one is redrawn, with the squared
  //   spacing cut by 0.9375 each time.
  // - Every skip_span-th candidate from skip_offset is kept. Density,
  //   quantity, radius and favorability are evaluated at each; the region's
  //   target is mean(density) * size^2.
  // - In descending favorability order (stable), each candidate with positive
  //   quantity and radius becomes a cone of volume quantity, until the target
  //   is met. With hard_region_target_quantity the last one is cut to fit,
  //   its radius scaled by the cube root of the cut.
  // - A point's value is the highest cone (height - distance * slope) within
  //   maximum_spot_basement_radius, else basement_value.

  var f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  var fr = Math.fround;
  // Paul Mineiro's fastapprox, which the game uses for this power.
  function fastlog2(x) {
    f32[0] = x;
    var vi = u32[0];
    u32[0] = (vi & 0x007FFFFF) | 0x3f000000;
    var mx = f32[0];
    var y = fr(vi * 1.1920928955078125e-7);
    return fr(fr(fr(y - 124.22551727294922) - fr(1.4980303049087524 * mx)) - fr(1.7258800268173218 / fr(0.35208871960639954 + mx)));
  }
  function fastpow2(p) {
    var offset = p < 0 ? 1 : 0;
    var clipp = p < -126 ? -126 : p;
    var w = Math.trunc(clipp);
    var z = fr(fr(clipp - w) + offset);
    var v = fr(fr(fr(clipp + 121.27405548095703) + fr(27.728023529052734 / fr(4.842525482177734 - z))) - fr(1.4901291131973267 * z));
    u32[0] = Math.trunc(fr(v * 8388608)) >>> 0;
    return f32[0];
  }
  function fastcbrt(x) { return fastpow2(fr(fastlog2(x) * 0.3333333432674408)); }

  function spotRegion(nd, b, rx, ry) {
    var e = nd.extra, rs = e.regionSize;
    var seed = (((Math.imul(rx, 7919) + Math.imul(ry, 7907) + Math.imul(e.seed1, 7927) + 0x3fbe2c) >>> 0) ^ e.seed0) >>> 0;
    if (seed < 342) seed = 341;
    var r = new Taus88(seed);
    var K = e.count, x0 = rs * rx - (rs >>> 1), y0 = rs * ry - (rs >>> 1);
    var cx = new Float32Array(K), cy = new Float32Array(K);
    var spacing2 = fr(e.spacing * e.spacing);
    for (var i = 0; i < K; i++) {
      for (;;) {
        var px = rs >= 2 ? r.next() % rs + x0 : x0;
        var py = rs >= 2 ? r.next() % rs + y0 : y0;
        var ok = true;
        for (var j = 0; j < i; j++) {
          var dx = fr(px - cx[j]), dy = fr(py - cy[j]);
          if (spacing2 > fr(fr(dx * dx) + fr(dy * dy))) { ok = false; break; }
        }
        if (ok) { cx[i] = px; cy[i] = py; break; }
        spacing2 = fr(spacing2 * 0.9375);
      }
    }
    var n = 0, sx = [], sy = [];
    for (i = e.skipOffset; i < K; i += e.skipSpan) { sx.push(cx[i]); sy.push(cy[i]); n++; }
    if (!n) return [];
    if (!nd.sub) nd.sub = new Program(b, e.sub);
    var v = nd.sub.run(Float32Array.from(sx), Float32Array.from(sy));
    var dens = v[0], qty = v[1], rad = v[2], fav = v[3];
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (a, c) { return fav[c] > fav[a] ? 1 : fav[a] > fav[c] ? -1 : a - c; });
    var sum = 0;
    for (i = 0; i < n; i++) sum = fr(sum + dens[i]);
    var target = fr(fr(sum / n) * fr(rs * rs));
    var spots = [], acc = 0;
    if (!(target > 0)) return spots;
    for (var k = 0; k < n; k++) {
      var idx = order[k], q = qty[idx];
      if (q > 0) {
        var radius = Math.min(e.maxRadius, rad[idx]);
        if (radius > 0) {
          if (e.hard) {
            var q2 = Math.min(q, fr(target - acc));
            radius = fr(radius * fastcbrt(fr(q2 / q)));
            q = q2;
          }
          var h = fr((q * 3) / (3.1416 * radius * radius));
          spots.push({ x: sx[idx], y: sy[idx], q: q, h: h, slope: fr(h / radius) });
          acc = fr(acc + q);
        }
      }
      if (!(target > acc)) break;
    }
    return spots;
  }

  function evalSpot(nd, a, n, alloc, ctx) {
    var b = ctx.b;
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    out.fill(e.basement);
    if (!n) return out;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < n; i++) {
      if (xs[i] < minx) minx = xs[i]; if (xs[i] > maxx) maxx = xs[i];
      if (ys[i] < miny) miny = ys[i]; if (ys[i] > maxy) maxy = ys[i];
    }
    var R = e.maxRadius, rs = e.regionSize, half = rs >>> 1;
    var lx = fr(minx - R), hx = fr(maxx + R), ly = fr(miny - R), hy = fr(maxy + R);
    var rx0 = Math.floor((lx + half) / rs), rx1 = Math.ceil((hx + half) / rs);
    var ry0 = Math.floor((ly + half) / rs), ry1 = Math.ceil((hy + half) / rs);
    var cache = nd.cache || (nd.cache = new Map());
    for (var ry = ry0; ry < ry1; ry++) for (var rx = rx0; rx < rx1; rx++) {
      var key = rx + ',' + ry;
      var spots = cache.get(key);
      if (!spots) {
        spots = spotRegion(nd, b, rx, ry);
        if (cache.size > 4096) cache.clear();
        cache.set(key, spots);
      }
      for (var s = 0; s < spots.length; s++) {
        var sp = spots[s];
        if (lx > sp.x || sp.x > hx || ly > sp.y || sp.y > hy) continue;
        for (i = 0; i < n; i++) {
          var dx = fr(xs[i] - sp.x), dy = fr(ys[i] - sp.y);
          var d = fr(Math.sqrt(fr(fr(dx * dx) + fr(dy * dy))));
          if (R >= d) {
            var v = fr(sp.h - fr(d * sp.slope));
            if (v > out[i]) out[i] = v;
          }
        }
      }
    }
    return out;
  }

  BUILTIN_EXT.spot_noise = function (b, a, scope, h) {
    var given = function (n) { return a.named && a.named[n] !== undefined; };
    var regionSize = given('region_size') ? h.konst('region_size') >>> 0 : 512;
    var skipSpan = given('skip_span') ? h.konst('skip_span') >>> 0 : 1;
    var skipOffset = given('skip_offset') ? h.konst('skip_offset') >>> 0 : 0;
    var count = given('candidate_point_count') ? h.konst('candidate_point_count') >>> 0
      : given('candidate_spot_count') ? Math.imul(h.konst('candidate_spot_count') >>> 0, skipSpan) >>> 0 : 256;
    var spacing = given('suggested_minimum_candidate_point_spacing') ? h.konst('suggested_minimum_candidate_point_spacing')
      : Math.sqrt(Math.floor(regionSize * regionSize / count)) * 0.5;
    var extra = {
      seed0: h.konst('seed0') >>> 0, seed1: h.seed1(), regionSize: regionSize, count: count, spacing: fr(spacing),
      skipSpan: Math.max(1, skipSpan), skipOffset: skipOffset,
      basement: fr(h.konst('basement_value')), maxRadius: fr(h.konst('maximum_spot_basement_radius')),
      hard: given('hard_region_target_quantity') ? h.konst('hard_region_target_quantity') > 0 : true,
    };
    // Evaluated at the candidate points only, by a sub-program.
    extra.sub = [h.arg('density_expression'), h.arg('spot_quantity_expression'), h.arg('spot_radius_expression'),
      h.arg('spot_favorability_expression')];
    return b.node('spot', [h.arg('x'), h.arg('y')], extra);
  };

  // random_penalty, as NoiseOperations::RandomPenalty: one taus88 stream per
  // evaluated batch, seeded from the batch's first position, walked from the
  // last position to the first. Positions whose source is not positive are
  // passed through and draw nothing.
  function evalPenalty(nd, a, n, alloc) {
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n), src = a[2];
    if (!n) return out;
    var x0 = xs[0], y0 = fr(e.seed + ys[0]);
    var sx = x0 !== x0 ? 0x3fbe2c : (Math.imul(Math.trunc(x0) | 0, 7919) + 0x3fbe2c) | 0;
    var sy = y0 !== y0 ? 0 : Math.imul(Math.trunc(y0) | 0, 7907);
    var seed = (sx + sy) >>> 0;
    var r = new Taus88(seed < 342 ? 341 : seed);
    for (var i = n - 1; i >= 0; i--) {
      var s = typeof src === 'number' ? src : src[i];
      out[i] = s <= 0 ? s : s + e.amplitude * (r.next() * -2.3283064365386963e-10);
    }
    return out;
  }
  BUILTIN_EXT.random_penalty = function (b, a, scope, h) {
    return b.node('rpenalty', [h.arg('x'), h.arg('y'), h.arg('source')],
      { seed: h.konst('seed', 1) >>> 0, amplitude: fr(h.konst('amplitude', 1)) });
  };

  // terrace{value, offset, width, strength}, as NoiseOperations::Terrace:
  // flat steps of the given width, each rising to the next over the part of
  // the step past `strength`.
  BUILTIN_EXT.terrace = function (b, a, scope, h) {
    return b.node('terrace', [h.arg('value'), h.arg('strength')], [fr(h.konst('offset')), fr(h.konst('width'))]);
  };
  function evalTerrace(nd, a, n, alloc) {
    var off = nd.extra[0], w = nd.extra[1], out = alloc();
    var v = arr(a[0], n), st = a[1];
    for (var i = 0; i < n; i++) {
      var t = fr(fr(v[i] - off) / w), f = Math.floor(t), frac = fr(t - f);
      var s = typeof st === 'number' ? st : st[i];
      var up = s < frac ? fr(fr(frac - s) / fr(1 - s)) : 0;
      out[i] = fr(fr(fr(up + f) * w) + off);
    }
    return out;
  }

  // voronoi_cell_id / _spot_noise / _facet_noise / _pyramid_noise, as
  // NoiseOperations::VoronoiNoise. Each grid cell holds one point, placed by
  // Bob Jenkins' integer hash of the cell and seed (seed0 + seed1):
  // ((1 - jitter) / 2 + jitter * u) within the cell, plus an id in [0, 1).
  // cell_id is the nearest point's id, spot the distance to it (in cells),
  // facet the gap to the second nearest, pyramid the distance to the cell's
  // edge. The game keeps grid_size as a 16-bit integer.
  function jenkinsHead(a) {
    a = (a + 0x7ed55d16 + (a << 12)) >>> 0;
    a = ((a ^ 0xc761c23c) ^ (a >>> 19)) >>> 0;
    a = (a + 0x165667b1 + (a << 5)) >>> 0;
    a = ((a + 0xd3a2646c) ^ (a << 9)) >>> 0;
    return (a + 0xfd7046c5 + (a << 3)) >>> 0;
  }
  function jenkins(a) { a = jenkinsHead(a); return ((a ^ 0xb55a4f09) ^ (a >>> 16)) >>> 0; }
  function voronoiCell(seed, cx, cy, jitter) {
    var ry = ((cy << 16) | (cy >>> 16)) >>> 0;
    var hy = jenkinsHead(ry), hx = jenkinsHead(cx >>> 0);
    var k = (((hx ^ hy) >>> 16) ^ seed ^ hy ^ hx) >>> 0;
    var base = fr(fr(1 - jitter) * 0.5);
    return [
      fr(base + fr(jitter * fr(jenkins(k) * 2.3283064365386963e-10))),
      fr(base + fr(jitter * fr(jenkins((k + 1) >>> 0) * 2.3283064365386963e-10))),
      fr(jenkins((k + 2) >>> 0) * 2.3283064365386963e-10),
    ];
  }
  var VORONOI_DIST = {
    euclidean: function (dx, dy) { return fr(Math.sqrt(fr(fr(dx * dx) + fr(dy * dy)))); },
    manhattan: function (dx, dy) { return fr(Math.abs(dx) + Math.abs(dy)); },
    chebyshev: function (dx, dy) { return Math.max(Math.abs(dx), Math.abs(dy)); },
    minkowski3: function (dx, dy) {
      dx = Math.abs(dx); dy = Math.abs(dy);
      return gameFastPow(fr(fr(fr(dx * dx) * dx) + fr(fr(dy * dy) * dy)), 0.3333333432674408);
    },
  };
  // Euclidean distance from q to the manhattan bisector of a and b: a ray,
  // a 45-degree segment and a ray.
  function segDist(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay, l = vx * vx + vy * vy;
    var t = l === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l));
    return Math.hypot(px - ax - t * vx, py - ay - t * vy);
  }
  function l1BisectorDistance(qx, qy, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, px = qx - ax, py = qy - ay, t;
    if (dx < 0) { dx = -dx; px = -px; }
    if (dy < 0) { dy = -dy; py = -py; }
    if (dy > dx) { t = dx; dx = dy; dy = t; t = px; px = py; py = t; }
    var x1 = (dx + dy) / 2, x2 = (dx - dy) / 2, far = 1e9;
    return Math.min(segDist(px, py, x1, 0, x2, dy), segDist(px, py, x1, 0, x1, -far), segDist(px, py, x2, dy, x2, far));
  }
  // The cells a batch can reach, laid out in typed arrays: cell (k, j) of
  // the box at index (j - y0) * w + (k - x0).
  function voronoiGrid(e, x0, y0, w, h) {
    var m = w * h, px = new Float32Array(m), py = new Float32Array(m), id = new Float32Array(m);
    for (var j = 0; j < h; j++) for (var k = 0; k < w; k++) {
      var c = voronoiCell(e.seed, x0 + k, y0 + j, e.jitter), at = j * w + k;
      px[at] = fr(x0 + k + c[0]); py[at] = fr(y0 + j + c[1]); id[at] = c[2];
    }
    return { x0: x0, y0: y0, w: w, h: h, px: px, py: py, id: id };
  }
  function evalVoronoi(nd, a, n, alloc, ctx) {
    var memo = ctx && ctx.memo;
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    var dist = VORONOI_DIST[e.type], g = e.grid;
    var pyramid = e.mode === 'pyramid', euclid = e.type === 'euclidean', cheb = e.type === 'chebyshev';
    // Manhattan and chebyshev pyramids look two cells out: with full jitter
    // a cell edge can come from there (as the game does).
    var R = pyramid && !euclid ? 2 : 1, side = 2 * R + 1;
    var qx = new Float32Array(n), qy = new Float32Array(n);
    var lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (var i = 0; i < n; i++) {
      var u = fr(xs[i] / g), v = fr(ys[i] / g);
      qx[i] = u; qy[i] = v;
      if (u < lx) lx = u; if (u > hx) hx = u; if (v < ly) ly = v; if (v > hy) hy = v;
    }
    if (!n || !(hx - lx < 4096 && hy - ly < 4096)) return evalVoronoiScattered(nd, qx, qy, n, out, R);
    var x0 = Math.floor(lx) - R, y0 = Math.floor(ly) - R;
    // Nodes over the same points, cells and metric (cell_id and facet, say)
    // share the nearest-point search.
    var key = memo && [nd.args[0], nd.args[1], e.seed, g, e.jitter, e.type, R].join('|');
    var S = key && memo.get(key);
    if (!S) {
      S = { d1: new Float64Array(n), d2: new Float64Array(n), best: new Int32Array(n),
        G: voronoiGrid(e, x0, y0, Math.floor(hx) + R - x0 + 1, Math.floor(hy) + R - y0 + 1) };
      var Gs = S.G;
      for (i = 0; i < n; i++) {
        var sx = qx[i], sy = qy[i], scx = Math.floor(sx), scy = Math.floor(sy);
        var e1 = Infinity, e2 = Infinity, b1 = -1;
        for (var sj = scy - R; sj <= scy + R; sj++) {
          var srow = (sj - y0) * Gs.w - x0;
          for (var sk = scx - R; sk <= scx + R; sk++) {
            var sat = srow + sk, sd = dist(fr(sx - Gs.px[sat]), fr(sy - Gs.py[sat]));
            if (sd < e1) { e2 = e1; e1 = sd; b1 = sat; } else if (sd < e2) e2 = sd;
          }
        }
        S.d1[i] = e1; S.d2[i] = e2; S.best[i] = b1;
      }
      if (key) memo.set(key, S);
    }
    var G = S.G, gx = G.px, gy = G.py, gid = G.id, gw = G.w;
    if (e.mode === 'cell_id') { for (i = 0; i < n; i++) out[i] = gid[S.best[i]]; return out; }
    if (e.mode === 'spot') { for (i = 0; i < n; i++) out[i] = S.d1[i]; return out; }
    if (e.mode === 'facet') { for (i = 0; i < n; i++) out[i] = fr(S.d2[i] - S.d1[i]); return out; }
    var cand = new Int32Array(side * side), bound = new Float64Array(side * side), done = new Uint8Array(side * side);
    for (i = 0; i < n; i++) {
      var x = qx[i], y = qy[i], cx = Math.floor(x), cy = Math.floor(y), best1 = S.best[i], nc = 0;
      for (var j = cy - R; j <= cy + R; j++) {
        var row = (j - y0) * gw - x0;
        for (var k = cx - R; k <= cx + R; k++) cand[nc++] = row + k;
      }
      var ax = gx[best1], ay = gy[best1], best = Infinity, c;
      if (euclid) {
        for (c = 0; c < nc; c++) {
          var bx = gx[cand[c]], by = gy[cand[c]];
          if (bx === ax && by === ay) continue;
          var l = Math.hypot(bx - ax, by - ay);
          var val = ((x - bx) * (x - bx) + (y - by) * (y - by) - (x - ax) * (x - ax) - (y - ay) * (y - ay)) / (2 * l);
          if (val < best) best = val;
        }
        out[i] = best;
        continue;
      }
      // Manhattan (or chebyshev, which is manhattan turned 45 degrees and
      // scaled by 0.75, as the game does). The distance to the bisector of
      // a and b is at least (|q - b|1 - |q - a|1) / (2 sqrt 2), so take the
      // candidates nearest first and stop once that bound can't win.
      var tx = cheb ? 0.75 * (x + y) : x, ty = cheb ? 0.75 * (x - y) : y;
      var tax = cheb ? 0.75 * (ax + ay) : ax, tay = cheb ? 0.75 * (ax - ay) : ay;
      var la = Math.abs(tx - tax) + Math.abs(ty - tay);
      for (c = 0; c < nc; c++) {
        var cbx = gx[cand[c]], cby = gy[cand[c]];
        var tbx = cheb ? 0.75 * (cbx + cby) : cbx, tby = cheb ? 0.75 * (cbx - cby) : cby;
        bound[c] = (Math.abs(tx - tbx) + Math.abs(ty - tby) - la) * 0.35355339059327373 * (1 - 1e-9);
        done[c] = (cbx === ax && cby === ay) ? 1 : 0;
      }
      for (;;) {
        var pick = -1, pb = Infinity;
        for (c = 0; c < nc; c++) if (!done[c] && bound[c] < pb) { pb = bound[c]; pick = c; }
        if (pick < 0 || !(pb < best)) break;
        done[pick] = 1;
        var qbx = gx[cand[pick]], qby = gy[cand[pick]];
        var vv = cheb
          ? l1BisectorDistance(tx, ty, tax, tay, 0.75 * (qbx + qby), 0.75 * (qbx - qby))
          : l1BisectorDistance(x, y, ax, ay, qbx, qby);
        if (vv < best) best = vv;
      }
      out[i] = best;
    }
    return out;
  }
  // The same for points spread too far apart to lay their cells out: cell
  // points cached by key.
  function evalVoronoiScattered(nd, qx, qy, n, out, R) {
    var e = nd.extra, dist = VORONOI_DIST[e.type], cache = nd.cache || (nd.cache = new Map());
    var cellAt = function (cx, cy) {
      var key = cx + ',' + cy, c = cache.get(key);
      if (!c) { c = voronoiCell(e.seed, cx, cy, e.jitter); if (cache.size > 65536) cache.clear(); cache.set(key, c); }
      return c;
    };
    for (var i = 0; i < n; i++) {
      var x = qx[i], y = qy[i], cx = Math.floor(x), cy = Math.floor(y);
      var d1 = Infinity, d2 = Infinity, id = 0, ax = 0, ay = 0, pts = [];
      for (var j = cy - R; j <= cy + R; j++) for (var k = cx - R; k <= cx + R; k++) {
        var c = cellAt(k, j), px = fr(k + c[0]), py = fr(j + c[1]);
        var d = dist(fr(x - px), fr(y - py));
        pts.push(px, py);
        if (d < d1) { d2 = d1; d1 = d; id = c[2]; ax = px; ay = py; } else if (d < d2) d2 = d;
      }
      if (e.mode === 'cell_id') out[i] = id;
      else if (e.mode === 'spot') out[i] = d1;
      else if (e.mode === 'facet') out[i] = fr(d2 - d1);
      else {
        var best = Infinity;
        for (var m = 0; m < pts.length; m += 2) {
          var bx = pts[m], by = pts[m + 1];
          if (bx === ax && by === ay) continue;
          var v;
          if (e.type === 'euclidean') {
            var l = Math.hypot(bx - ax, by - ay);
            v = ((x - bx) * (x - bx) + (y - by) * (y - by) - (x - ax) * (x - ax) - (y - ay) * (y - ay)) / (2 * l);
          } else if (e.type === 'manhattan') {
            v = l1BisectorDistance(x, y, ax, ay, bx, by);
          } else {
            v = l1BisectorDistance(0.75 * (x + y), 0.75 * (x - y), 0.75 * (ax + ay), 0.75 * (ax - ay), 0.75 * (bx + by), 0.75 * (bx - by));
          }
          if (v < best) best = v;
        }
        out[i] = best;
      }
    }
    return out;
  }
  ['cell_id', 'spot_noise', 'facet_noise', 'pyramid_noise'].forEach(function (name) {
    BUILTIN_EXT['voronoi_' + name] = function (b, a, scope, h) {
      var t = h.raw('distance_type', null);
      var type = t && t.k === 'str' ? t.v : 'euclidean';
      if (!VORONOI_DIST[type]) throw new Error('voronoi: unknown distance type ' + type);
      var mode = name.replace('_noise', '');
      if (mode === 'pyramid' && type === 'minkowski3') throw new Error('voronoi_pyramid_noise does not support minkowski3 distance');
      return b.node('voronoi', [h.arg('x'), h.arg('y')], {
        mode: mode, type: type, seed: ((h.konst('seed0') >>> 0) + h.seed1()) >>> 0,
        grid: Math.trunc(h.konst('grid_size')) & 0xFFFF, jitter: fr(h.konst('jitter', 1)),
      });
    };
  });

  // ------------------------------------------------------------- evaluation

  function Program(b, outputs) {
    // Keep only nodes the outputs need, in dependency order.
    var need = new Uint8Array(b.nodes.length);
    var stack = outputs.slice();
    while (stack.length) {
      var id = stack.pop();
      if (need[id]) continue;
      need[id] = 1;
      b.nodes[id].args.forEach(function (x) { stack.push(x); });
    }
    this.nodes = b.nodes;
    this.b = b;
    this.order = [];
    for (var i = 0; i < need.length; i++) if (need[i]) this.order.push(i);
    this.outputs = outputs;
    // Last use of each node, so buffers can be reused.
    var last = new Int32Array(b.nodes.length).fill(-1);
    this.order.forEach(function (id, at) { b.nodes[id].args.forEach(function (x) { last[x] = at; }); });
    outputs.forEach(function (o) { last[o] = 1 << 30; });
    this.last = last;
  }

  // grid: for a chunk's positions, {x0, y0} its corner (numbers, or arrays
  // per point), so noise takes the game's grid path where it would.
  Program.prototype.run = function (xs, ys, grid) {
    var n = xs.length, nodes = this.nodes, order = this.order, last = this.last;
    // Buffers come back to the pool when their last reader is done. The
    // previous run's outputs go back too: they are only good until the
    // next run.
    if (this.poolN !== n) { this.pool = []; this.poolN = n; this.prev = null; }
    var pool = this.pool;
    if (this.prev) for (var p = 0; p < this.prev.length; p++) if (this.prev[p]) pool.push(this.prev[p]);
    var alloc = function () { return pool.length ? pool.pop() : new Float32Array(n); };
    var vals = this.vals || (this.vals = new Array(nodes.length));
    // Work that several nodes of this run can share (see evalVoronoi).
    var ctx = { b: this.b, memo: new Map(), grid: grid || null };
    var argv = this.argv || (this.argv = order.map(function (id) { return new Array(nodes[id].args.length); }));
    for (var at = 0; at < order.length; at++) {
      var id = order[at], nd = nodes[id], args = nd.args, v;
      if (nd.op === 'const') v = nd.value;
      else if (nd.op === 'x') { v = alloc(); v.set(xs); }
      else if (nd.op === 'y') { v = alloc(); v.set(ys); }
      else {
        var av = argv[at];
        for (var j = 0; j < args.length; j++) av[j] = vals[args[j]];
        v = EVAL[nd.op](nd, av, n, alloc, ctx);
      }
      vals[id] = v;
      for (j = 0; j < args.length; j++) {
        var a = args[j];
        if (last[a] === at && vals[a] && typeof vals[a] !== 'number') { pool.push(vals[a]); vals[a] = undefined; }
      }
    }
    var outs = this.outputs, res = new Array(outs.length), seen = new Set();
    this.prev = new Array(outs.length);
    for (var o = 0; o < outs.length; o++) {
      v = vals[outs[o]];
      if (typeof v === 'number') { var f = alloc(); f.fill(v); v = f; }
      else if (seen.has(v)) { v = v.slice(); }
      seen.add(v);
      res[o] = v;
      this.prev[o] = v;
    }
    for (o = 0; o < outs.length; o++) vals[outs[o]] = undefined;
    return res;
  };

  var EVAL = {};
  // Element-wise ops, one loop per operand shape (generated; see FOLD for
  // the same ops on constants).
  EVAL.add = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a + b; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a + b; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a + b; }
    return o;
  };
  EVAL.sub = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a - b; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a - b; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a - b; }
    return o;
  };
  EVAL.mul = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a * b; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a * b; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a * b; }
    return o;
  };
  EVAL.div = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a / b; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a / b; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a / b; }
    return o;
  };
  EVAL.mod = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a - Math.floor(a / b) * b; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a - Math.floor(a / b) * b; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a - Math.floor(a / b) * b; }
    return o;
  };
  EVAL.pow = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = gamePow(a, b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = gamePow(a, b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = gamePow(a, b); }
    return o;
  };
  EVAL.lt = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a < b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a < b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a < b ? 1 : 0; }
    return o;
  };
  EVAL.le = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a <= b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a <= b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a <= b ? 1 : 0; }
    return o;
  };
  EVAL.gt = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a > b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a > b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a > b ? 1 : 0; }
    return o;
  };
  EVAL.ge = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a >= b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a >= b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a >= b ? 1 : 0; }
    return o;
  };
  EVAL.eq = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a === b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a === b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a === b ? 1 : 0; }
    return o;
  };
  EVAL.ne = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = a !== b ? 1 : 0; } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = a !== b ? 1 : 0; } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = a !== b ? 1 : 0; }
    return o;
  };
  EVAL.band = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = toInt(a) & toInt(b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = toInt(a) & toInt(b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = toInt(a) & toInt(b); }
    return o;
  };
  EVAL.bor = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = toInt(a) | toInt(b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = toInt(a) | toInt(b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = toInt(a) | toInt(b); }
    return o;
  };
  EVAL.bxor = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = toInt(a) ^ toInt(b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = toInt(a) ^ toInt(b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = toInt(a) ^ toInt(b); }
    return o;
  };
  EVAL.min = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = Math.min(a, b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = Math.min(a, b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = Math.min(a, b); }
    return o;
  };
  EVAL.max = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = Math.max(a, b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = Math.max(a, b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = Math.max(a, b); }
    return o;
  };
  EVAL.atan2 = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], y = v[1], i, a, b;
    if (typeof x === 'number') { a = x; for (i = 0; i < n; i++) { b = y[i]; o[i] = Math.atan2(a, b); } }
    else if (typeof y === 'number') { b = y; for (i = 0; i < n; i++) { a = x[i]; o[i] = Math.atan2(a, b); } }
    else for (i = 0; i < n; i++) { a = x[i]; b = y[i]; o[i] = Math.atan2(a, b); }
    return o;
  };
  EVAL.neg = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = -a; }
    return o;
  };
  EVAL.abs = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = Math.abs(a); }
    return o;
  };
  EVAL.sqrt = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = Math.sqrt(a); }
    return o;
  };
  EVAL.sin = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = gameSin(a); }
    return o;
  };
  EVAL.cos = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = gameCos(a); }
    return o;
  };
  EVAL.floor = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = Math.floor(a); }
    return o;
  };
  EVAL.ceil = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = Math.ceil(a); }
    return o;
  };
  EVAL.log2 = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = Math.log2(a); }
    return o;
  };
  EVAL.bnot = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], a;
    for (var i = 0; i < n; i++) { a = x[i]; o[i] = ~toInt(a); }
    return o;
  };

  EVAL.clamp = function (nd, v, n, alloc) {
    var o = alloc(), x = v[0], lo = v[1], hi = v[2], i, a;
    if (typeof lo === 'number' && typeof hi === 'number') {
      for (i = 0; i < n; i++) { a = x[i]; o[i] = a < lo ? lo : a > hi ? hi : a; }
    } else {
      for (i = 0; i < n; i++) {
        a = typeof x === 'number' ? x : x[i];
        var l = typeof lo === 'number' ? lo : lo[i], h = typeof hi === 'number' ? hi : hi[i];
        o[i] = a < l ? l : a > h ? h : a;
      }
    }
    return o;
  };
  var arr = function (v, n) { if (typeof v !== 'number') return v; var f = new Float32Array(n); f.fill(v); return f; };

  EVAL.basis = function (nd, a, n, alloc, ctx) {
    var e = nd.extra, out = alloc();
    out.fill(0);
    var sum = noiseSum(out, arr(a[0], n), arr(a[1], n), n, onGrid(nd, ctx) && ctx.grid);
    noiseOctave(sum, onGrid(nd, ctx), noiseTables(e[0], e[1]), fr(e[2]), fr(e[3]), 0, 0);
    sum.end();
    return out;
  };
  // NoiseOperations::MultioctaveNoise. Octave k (finest first) has input
  // scale s / 2^k and weight w_k, the finest octave's weight in closed form,
  // sqrt((q - 1) / (q^n - 1)) times output_scale with q = 1/p^2 and the power
  // from the fast approximation, then times 1/p for each coarser one. Point
  // by point, octave k is noise at (x s_k + 17.17 k, y s_k); on a chunk's
  // grid the octave's grid is scaled instead, its origin moved by
  // 17.17 k / s.
  EVAL.multioctave = function (nd, a, n, alloc, ctx) {
    var e = nd.extra, oct = e[2], out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n), p = a[2];
    out.fill(0);
    var t = noiseTables(e[0], e[1]), is = fr(e[3]), i, k, sk;
    var grid = onGrid(nd, ctx) && is > 0 && gridFits(is, true), sum = noiseSum(out, xs, ys, n, grid && ctx.grid);
    if (typeof p !== 'number') {
      // Persistence per point (the game only takes a constant): weights
      // p^(octaves - 1 - k), normalised by their root sum of squares.
      var w = new Float32Array(n), nn = new Float64Array(n);
      for (k = 0, sk = is; k < oct; k++) {
        for (i = 0; i < n; i++) { w[i] = Math.pow(p[i], oct - 1 - k); nn[i] += w[i] * w[i]; }
        sum.add('mpoint', t, w, sk, 0, 0, k * 17.17);
        sk = fr(sk * 0.5);
      }
      sum.end();
      for (i = 0; i < n; i++) out[i] = out[i] / Math.sqrt(nn[i]) * e[4];
      return out;
    }
    var amp, ip = fr(1 / p);
    if (ip === 1) amp = fr(e[4] / Math.sqrt(oct));
    else if (ip === 0) amp = fr(e[4]);
    else {
      var q = fr(ip * ip), r = gameFastPow(q, oct);
      amp = fr(Math.sqrt(fr(fr(q - 1) / fr(r - 1))) * e[4]);
    }
    if (grid) {
      for (k = 0, sk = 1; k < oct; k++) {
        sum.add('mgrid', t, amp, is, 0, 0, k * 17.17 / is, sk);
        sk = fr(sk * 0.5); amp = fr(amp * ip);
      }
    } else {
      for (k = 0, sk = is; k < oct; k++) {
        sum.add('mpoint', t, amp, sk, 0, 0, k * 17.17);
        sk = fr(sk * 0.5); amp = fr(amp * ip);
      }
    }
    sum.end();
    return out;
  };
  // quick_multioctave_noise compiles to basis noises: octave k has seed0
  // shifted by k * octave_seed0_shift, and input and output scales
  // multiplied along in single precision.
  EVAL.quick = function (nd, a, n, alloc, ctx) {
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    out.fill(0);
    var s = fr(e[3]), amp = fr(e[4]), min = fr(e[7]), mout = fr(e[6]), grid = onGrid(nd, ctx);
    var sum = noiseSum(out, xs, ys, n, grid && ctx.grid);
    for (var k = 0; k < e[2]; k++) {
      noiseOctave(sum, grid, noiseTables((e[0] + k * e[8]) >>> 0, e[1]), s, amp, fr(e[5]), 0);
      s = fr(s * min); amp = fr(amp * mout);
    }
    sum.end();
    return out;
  };
  // NoiseOperations::VariablePersistenceMultioctaveNoise: octaves from the
  // finest (input_scale / 2) down, each weight 1, the running sum times the
  // persistence before each next one (Horner), then times output_scale * 2^n.
  EVAL.varpersist = function (nd, a, n, alloc, ctx) {
    var e = nd.extra, oct = e[2], out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n), p = a[2], t = noiseTables(e[0], e[1]);
    out.fill(0);
    var s = fr(fr(e[3]) * 0.5), offx = fr(e[5]), i, grid = onGrid(nd, ctx);
    for (var k = 0; k < oct; k++) {
      var sum = noiseSum(out, xs, ys, n, grid && ctx.grid);
      noiseOctave(sum, grid, t, s, 1, offx, 0);
      sum.end();
      s = fr(s * 0.5);
      if (k < oct - 1) {
        if (typeof p === 'number') for (i = 0; i < n; i++) out[i] = fr(p * out[i]);
        else for (i = 0; i < n; i++) out[i] = fr(p[i] * out[i]);
      }
    }
    var os = fr(fr(e[4]) * Math.pow(2, oct));
    for (i = 0; i < n; i++) out[i] = fr(os * out[i]);
    return out;
  };
  function nearest(nd, a, n, alloc, which) {
    var pts = nd.extra[0], md = nd.extra[1], out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    for (var i = 0; i < n; i++) {
      var best = Infinity, bx = 0, by = 0;
      for (var k = 0; k < pts.length; k++) {
        var dx = xs[i] - pts[k][0], dy = ys[i] - pts[k][1], d = dx * dx + dy * dy;
        if (d < best) { best = d; bx = dx; by = dy; }
      }
      out[i] = which === 0 ? Math.min(Math.sqrt(best), md) : which === 1 ? bx : by;
    }
    return out;
  }
  EVAL.dist = function (nd, a, n, alloc) { return nearest(nd, a, n, alloc, 0); };
  EVAL.distx = function (nd, a, n, alloc) { return nearest(nd, a, n, alloc, 1); };
  EVAL.disty = function (nd, a, n, alloc) { return nearest(nd, a, n, alloc, 2); };
  EVAL.spot = evalSpot;
  EVAL.voronoi = evalVoronoi;
  EVAL.terrace = evalTerrace;
  EVAL.rpenalty = evalPenalty;
  EVAL.ifelse = function (nd, a, n, alloc) {
    var o = alloc(), c = a[0], x = a[1], y = a[2];
    for (var i = 0; i < n; i++) {
      var cv = typeof c === 'number' ? c : c[i];
      o[i] = cv !== 0 ? (typeof x === 'number' ? x : x[i]) : (typeof y === 'number' ? y : y[i]);
    }
    return o;
  };

  // ------------------------------------------------------------- api

  // outputs: names of noise expressions, or {src, scope} objects. Returns a
  // program whose run(xs, ys) gives one Float32Array per output.
  // opts.spacing: the distance between neighbouring sample points, which is
  // what multisample's offsets count in (1 for tiles, the grid size for the
  // cliff lattice).
  function compile(defs, mgs, outputs, opts) {
    var b = new Builder(defs, mgs);
    if (opts && opts.spacing) b.spacing = opts.spacing;
    var ctx = { x: b.X, y: b.Y };
    var ids = outputs.map(function (o) {
      if (typeof o === 'string') return b.global(o, ctx);
      var scope = new Scope(null, ctx);
      if (o.def) scope = b.withLocals(o.def, scope);
      return b.compile(o.src, scope);
    });
    var p = new Program(b, ids);
    p.builder = b;
    return p;
  }

  return {
    Taus88: Taus88, crc32str: crc32str, tables: tables, noiseTables: noiseTables, noiseKernel: noiseKernel, GRAD: GRAD,
    // Whether the noise kernel runs in WebAssembly (when it loads); false
    // forces the JS loop.
    wasm: function (on) { if (on !== undefined) useWasm = on; return !!wasmKernel && useWasm; },
    parse: parse, compile: compile, Builder: Builder, Scope: Scope, Program: Program,
    EVAL: EVAL, FOLD: FOLD, BUILTIN_EXT: BUILTIN_EXT,
  };
});
