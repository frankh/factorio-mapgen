// Factorio's noise expressions in plain JS: the noise functions the game has
// built in, reproduced exactly, and a compiler that turns the game's
// expression strings into a program evaluated over many positions at once.
//
//   var prog = FactorioNoise.compile(defs, mapGenSettings, ['elevation', 'tile:water:probability']);
//   var out = prog.run(xs, ys);          // Float32Arrays, one per output
//
// defs holds the game's noise_expression and noise_function prototypes (see
// tools/mapgen/extract.py). Results match the game's own
// LuaSurface.calculate_tile_properties to float precision; see
// tools/mapgen/README.md for how each builtin was worked out.
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

  var GX = new Float64Array(256), GY = new Float64Array(256);
  for (var g = 0; g < 256; g++) {
    GX[g] = 4.2 * Math.cos(g * 2 * Math.PI / 256);
    GY[g] = 4.2 * Math.sin(g * 2 * Math.PI / 256);
  }

  // seed1 picks the table set too: seed0 + 7 * (seed1 >> 8), seed1 & 255.
  function seedPair(seed0, seed1) {
    seed1 = seed1 >>> 0;
    return [(seed0 + 7 * (seed1 >>> 8)) >>> 0, seed1 & 255];
  }

  // out[i] += amp * basis((x[i] + ox) * scale + lx, y[i] * scale)
  function basisAdd(out, xs, ys, n, seed0, seed1, ox, scale, lx, amp) {
    var sp = seedPair(seed0, seed1);
    var T = tables(sp[0]);
    var T1 = T[1], T2 = T[2], T3 = T[3];
    var s = T[0][sp[1]];
    var scalarAmp = typeof amp === 'number';
    for (var i = 0; i < n; i++) {
      var x = (xs[i] + ox) * scale + lx, y = ys[i] * scale;
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      var tot = 0;
      for (var dx = 0; dx < 2; dx++) {
        var hx = T2[(x0 + dx) & 255];
        var ddx = fx - dx;
        for (var dy = 0; dy < 2; dy++) {
          var ddy = fy - dy;
          var q = 1 - ddx * ddx - ddy * ddy;
          if (q <= 0) continue;
          var k = T3[hx ^ T1[(y0 + dy) & 255] ^ s];
          tot += (GX[k] * ddx + GY[k] * ddy) * q * q * q;
        }
      }
      out[i] += tot * (scalarAmp ? amp : amp[i]);
    }
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
      case 'cliff_smoothing': return this.constant(Math.fround(cliff.cliff_smoothing === undefined ? 0 : cliff.cliff_smoothing));
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

  function evalSpot(nd, a, n, alloc, b) {
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
  // edge (euclidean only so far).
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
  function evalVoronoi(nd, a, n, alloc) {
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    var dist = VORONOI_DIST[e.type], g = e.grid, J = e.jitter, cache = nd.cache || (nd.cache = new Map());
    var cellAt = function (cx, cy) {
      var key = cx + ',' + cy, c = cache.get(key);
      if (!c) { c = voronoiCell(e.seed, cx, cy, J); if (cache.size > 65536) cache.clear(); cache.set(key, c); }
      return c;
    };
    for (var i = 0; i < n; i++) {
      var qx = fr(xs[i] / g), qy = fr(ys[i] / g), cx = Math.floor(qx), cy = Math.floor(qy);
      var d1 = Infinity, d2 = Infinity, id = 0, ax = 0, ay = 0, pts = [];
      for (var j = cy - 1; j <= cy + 1; j++) for (var k = cx - 1; k <= cx + 1; k++) {
        var c = cellAt(k, j), px = fr(k + c[0]), py = fr(j + c[1]);
        var d = dist(fr(qx - px), fr(qy - py));
        if (e.mode === 'pyramid') pts.push(px, py);
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
          var l = Math.hypot(bx - ax, by - ay);
          var v = ((qx - bx) * (qx - bx) + (qy - by) * (qy - by) - (qx - ax) * (qx - ax) - (qy - ay) * (qy - ay)) / (2 * l);
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
      if (mode === 'pyramid' && type !== 'euclidean') throw new Error('voronoi_pyramid_noise with ' + type + ' distance is not supported here');
      return b.node('voronoi', [h.arg('x'), h.arg('y')], {
        mode: mode, type: type, seed: ((h.konst('seed0') >>> 0) + h.seed1()) >>> 0,
        grid: fr(h.konst('grid_size')), jitter: fr(h.konst('jitter', 1)),
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

  Program.prototype.run = function (xs, ys) {
    var n = xs.length, nodes = this.nodes, vals = new Array(nodes.length), pool = [];
    var alloc = function () { return pool.length ? pool.pop() : new Float32Array(n); };
    for (var at = 0; at < this.order.length; at++) {
      var id = this.order[at], nd = nodes[id];
      var v;
      if (nd.op === 'const') v = nd.value;
      else if (nd.op === 'x') { v = alloc(); v.set(xs); }
      else if (nd.op === 'y') { v = alloc(); v.set(ys); }
      else v = EVAL[nd.op](nd, nd.args.map(function (x) { return vals[x]; }), n, alloc, this.b);
      vals[id] = v;
      for (var j = 0; j < nd.args.length; j++) {
        var a = nd.args[j];
        if (this.last[a] === at && vals[a] && typeof vals[a] !== 'number') { pool.push(vals[a]); vals[a] = undefined; }
      }
    }
    return this.outputs.map(function (o) {
      var v = vals[o];
      if (typeof v === 'number') { var f = new Float32Array(n); f.fill(v); return f; }
      return v;
    });
  };

  function elementwise(f) {
    return function (nd, args, n, alloc) {
      var out = alloc();
      var k = args.length;
      if (k === 1) {
        var a = args[0];
        for (var i = 0; i < n; i++) out[i] = f(a[i]);
      } else if (k === 2) {
        var a0 = args[0], a1 = args[1];
        var c0 = typeof a0 === 'number', c1 = typeof a1 === 'number';
        for (i = 0; i < n; i++) out[i] = f(c0 ? a0 : a0[i], c1 ? a1 : a1[i]);
      } else {
        for (i = 0; i < n; i++) {
          var vs = args.map(function (a) { return typeof a === 'number' ? a : a[i]; });
          out[i] = f.apply(null, vs);
        }
      }
      return out;
    };
  }

  var EVAL = {};
  Object.keys(FOLD).forEach(function (op) { EVAL[op] = elementwise(FOLD[op]); });
  // Hot paths without the closure call.
  EVAL.add = function (nd, a, n, alloc) {
    var o = alloc(), x = a[0], y = a[1];
    if (typeof x === 'number') for (var i = 0; i < n; i++) o[i] = x + y[i];
    else if (typeof y === 'number') for (i = 0; i < n; i++) o[i] = x[i] + y;
    else for (i = 0; i < n; i++) o[i] = x[i] + y[i];
    return o;
  };
  EVAL.mul = function (nd, a, n, alloc) {
    var o = alloc(), x = a[0], y = a[1];
    if (typeof x === 'number') for (var i = 0; i < n; i++) o[i] = x * y[i];
    else if (typeof y === 'number') for (i = 0; i < n; i++) o[i] = x[i] * y;
    else for (i = 0; i < n; i++) o[i] = x[i] * y[i];
    return o;
  };
  var arr = function (v, n) { if (typeof v !== 'number') return v; var f = new Float32Array(n); f.fill(v); return f; };

  EVAL.basis = function (nd, a, n, alloc) {
    var e = nd.extra, out = alloc();
    out.fill(0);
    basisAdd(out, arr(a[0], n), arr(a[1], n), n, e[0], e[1], 0, e[2], 0, e[3]);
    return out;
  };
  // Octave k (finest first) is basis(x * s / 2^k + 17.17 k, y * s / 2^k),
  // weighted persistence^(octaves - 1 - k), the sum divided by the root of
  // the summed squared weights.
  EVAL.multioctave = function (nd, a, n, alloc) {
    var e = nd.extra, oct = e[2], out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n), p = a[2];
    out.fill(0);
    if (typeof p === 'number') {
      var amps = [], norm = 0;
      for (var k = 0; k < oct; k++) { amps.push(gamePow(p, oct - 1 - k)); norm = fr(norm + fr(amps[k] * amps[k])); }
      norm = fr(Math.sqrt(norm));
      for (k = 0; k < oct; k++) basisAdd(out, xs, ys, n, e[0], e[1], 0, e[3] / Math.pow(2, k), 17.17 * k, fr(fr(amps[k] / norm) * e[4]));
    } else {
      var w = new Float32Array(n), nn = new Float64Array(n);
      for (k = 0; k < oct; k++) {
        for (var i = 0; i < n; i++) { w[i] = Math.pow(p[i], oct - 1 - k); nn[i] += w[i] * w[i]; }
        basisAdd(out, xs, ys, n, e[0], e[1], 0, e[3] / Math.pow(2, k), 17.17 * k, w);
      }
      for (i = 0; i < n; i++) out[i] = out[i] / Math.sqrt(nn[i]) * e[4];
    }
    return out;
  };
  // Octave k: basis((x + offset_x) * s * m_in^k, y * s * m_in^k) * out * m_out^k,
  // seed0 shifted by k * octave_seed0_shift.
  EVAL.quick = function (nd, a, n, alloc) {
    var e = nd.extra, out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n);
    out.fill(0);
    var s = e[3], amp = e[4];
    for (var k = 0; k < e[2]; k++) {
      basisAdd(out, xs, ys, n, (e[0] + k * e[8]) >>> 0, e[1], e[5], s, 0, amp);
      s *= e[7]; amp *= e[6];
    }
    return out;
  };
  // Octave j (coarsest first): basis((x + offset_x) * s * 2^(j - octaves)) * 2^octaves * p^j.
  EVAL.varpersist = function (nd, a, n, alloc) {
    var e = nd.extra, oct = e[2], out = alloc();
    var xs = arr(a[0], n), ys = arr(a[1], n), p = a[2];
    out.fill(0);
    var w = new Float32Array(n);
    for (var j = 0; j < oct; j++) {
      var amp;
      if (typeof p === 'number') amp = Math.pow(2, oct) * Math.pow(p, j) * e[4];
      else { for (var i = 0; i < n; i++) w[i] = Math.pow(2, oct) * Math.pow(p[i], j) * e[4]; amp = w; }
      basisAdd(out, xs, ys, n, e[0], e[1], e[5], e[3] * Math.pow(2, j - oct), 0, amp);
    }
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
  function compile(defs, mgs, outputs) {
    var b = new Builder(defs, mgs);
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
    Taus88: Taus88, crc32str: crc32str, tables: tables, basisAdd: basisAdd,
    parse: parse, compile: compile, Builder: Builder, Scope: Scope, Program: Program,
    EVAL: EVAL, FOLD: FOLD, BUILTIN_EXT: BUILTIN_EXT,
  };
});
