// The map preview's picture of a planet, computed from the game's own noise
// expressions (noise.js) and prototype data (noisedata.js).
//
// Pass 0 paints each pixel with the colour of the tile whose autoplace
// probability is highest there. Pass 1 lays entities over it: ore in its map
// colour, trees as a green tint that deepens with their density, rocks, and
// enemy bases in red.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./noise.js'));
  else root.FactorioPreview = factory(root.FactorioNoise);
})(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';

  var CHUNK = 32;

  function planetSettings(data, planet, mgs) {
    var p = data.planet[planet];
    if (!p) throw new Error('unknown planet ' + planet);
    var auto = p.autoplace_settings || {};
    var out = JSON.parse(JSON.stringify(mgs || {}));
    // The planet's own property expressions, under the map's overrides.
    out.property_expression_names = Object.assign({}, p.property_expression_names || {}, out.property_expression_names || {});
    var cs = p.cliff_settings || {};
    out.cliff_settings = Object.assign({ name: cs.name, control: cs.control, cliff_elevation_0: cs.cliff_elevation_0, cliff_elevation_interval: cs.cliff_elevation_interval }, out.cliff_settings || {});
    return {
      mgs: out,
      tiles: Object.keys((auto.tile && auto.tile.settings) || {}),
      entities: Object.keys((auto.entity && auto.entity.settings) || {}),
      controls: Object.keys(p.autoplace_controls || {}),
    };
  }

  // Entities the preview draws: those the planet places outright, plus those
  // placed through one of its autoplace controls (trees, rocks, enemies).
  function previewEntities(data, ps) {
    var names = new Set(ps.entities);
    Object.keys(data.entity).forEach(function (n) {
      var a = data.entity[n].autoplace;
      if (a && a.control && ps.controls.indexOf(a.control) >= 0) names.add(n);
    });
    var out = [];
    names.forEach(function (n) {
      var e = data.entity[n];
      if (!e || !e.autoplace || !e.autoplace.probability_expression && e.autoplace.probability_expression !== 0) return;
      var kind = e.type === 'resource' ? 'resource' : e.type === 'tree' ? 'tree'
        : e.type === 'unit-spawner' || e.type === 'turret' ? 'enemy'
        : e.color ? 'solid' : null;
      if (kind) out.push({ name: n, kind: kind, def: e });
    });
    out.sort(function (a, b) { return (a.def.autoplace.order || '') < (b.def.autoplace.order || '') ? -1 : 1; });
    return out;
  }

  function controlSize(mgs, control) {
    var c = control && (mgs.autoplace_controls || {})[control];
    return c && c.size !== undefined ? c.size : 1;
  }

  function renderer(data, planet, mgs, scale) {
    scale = scale || 1;
    var ps = planetSettings(data, planet, mgs);
    var tiles = ps.tiles.filter(function (t) { return data.tile[t]; });
    var tileProg = N.compile(data, ps.mgs, tiles.map(function (t) {
      var a = data.tile[t].autoplace;
      return { src: a.probability_expression, def: a };
    }));
    var colors = tiles.map(function (t) { return data.tile[t].color; });
    // Water tiles, by colour, so land entities stay off them.
    var waterColors = new Set(tiles.filter(function (t) { return /water|ocean|lava|ammoniacal/.test(t); })
      .map(function (t) { return data.tile[t].color.join(','); }));

    var ents = previewEntities(data, ps).filter(function (e) {
      return controlSize(ps.mgs, e.def.autoplace.control) > 0;
    });
    var outs = [];
    ents.forEach(function (e) {
      var a = e.def.autoplace;
      e.p = outs.length; outs.push({ src: a.probability_expression, def: a });
      if (e.kind === 'resource') { e.r = outs.length; outs.push({ src: a.richness_expression === undefined ? 1 : a.richness_expression, def: a }); }
    });
    var entProg = outs.length ? N.compile(data, ps.mgs, outs) : null;
    var tree = (data.chart && data.chart.tree) || [48, 99, 48, 102];
    var enemy = (data.chart && data.chart.enemy) || [255, 25, 25, 255];

    function positions(cx, cy) {
      var n = CHUNK * CHUNK, xs = new Float32Array(n), ys = new Float32Array(n);
      for (var j = 0; j < CHUNK; j++) for (var i = 0; i < CHUNK; i++) {
        xs[j * CHUNK + i] = Math.floor((cx * CHUNK + i) * scale);
        ys[j * CHUNK + i] = Math.floor((cy * CHUNK + j) * scale);
      }
      return [xs, ys];
    }

    function terrain(cx, cy) {
      var p = positions(cx, cy), n = CHUNK * CHUNK;
      var r = tileProg.run(p[0], p[1]);
      var px = new Uint8ClampedArray(n * 4);
      for (var k = 0; k < n; k++) {
        var best = -Infinity, bi = -1;
        for (var t = 0; t < r.length; t++) if (r[t][k] > best) { best = r[t][k]; bi = t; }
        var c = bi >= 0 ? colors[bi] : [0, 0, 0];
        px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = 255;
      }
      return px;
    }

    function blend(px, k, c, a) {
      px[k * 4] = px[k * 4] * (1 - a) + c[0] * a;
      px[k * 4 + 1] = px[k * 4 + 1] * (1 - a) + c[1] * a;
      px[k * 4 + 2] = px[k * 4 + 2] * (1 - a) + c[2] * a;
    }

    // As MapPreviewGenerator::Worker::computeEntities: the map generator's
    // own entity placement for the chunk (EntityMapGenerationTask), then each
    // placed entity drawn as the map chart draws it. Each tile takes the
    // entity with the highest probability there (richness breaks ties); it
    // is placed if a draw from the chunk's taus88 stream, seeded from the
    // chunk position, falls under that probability. Tiles are visited last
    // to first. Not yet modelled: tile restrictions, collision between
    // entities and the extra placement attempts.
    function entities(cx, cy, px) {
      px = px.slice();
      if (!entProg) return px;
      var p = positions(cx, cy), n = CHUNK * CHUNK;
      var r = entProg.run(p[0], p[1]);
      var water = waterMask(px);
      var best = new Int16Array(n).fill(-1), bestP = new Float32Array(n).fill(-Infinity), bestR = new Float32Array(n);
      for (var i = 0; i < ents.length; i++) {
        var e = ents[i], pr = r[e.p], rr = e.r !== undefined ? r[e.r] : null;
        var onWater = e.def.type === 'fish';
        for (var k = n - 1; k >= 0; k--) {
          if (water[k] !== onWater) continue;
          var v = pr[k], rv = rr ? rr[k] : 0;
          if (v > bestP[k] || (v === bestP[k] && rv > bestR[k])) { bestP[k] = v; best[k] = i; bestR[k] = rv; }
        }
      }
      var seed = (Math.imul(cx, 7919) + Math.imul(cy, 7907) + 0x3fbe2c) >>> 0;
      var rng = new N.Taus88(seed < 342 ? 341 : seed);
      var treeA = tree[3] / 255;
      for (k = n - 1; k >= 0; k--) {
        if (best[k] < 0) continue;
        e = ents[best[k]];
        if (!(bestP[k] > rng.next() * 2.3283064365386963e-10)) continue;
        var x = k % CHUNK, y = (k / CHUNK) | 0;
        if (e.kind === 'tree') blend(px, k, tree, treeA);
        else if (e.kind === 'resource') { if (((x + y) & 1) === 0) blend(px, k, e.def.color, 1); }
        else if (e.kind === 'enemy') blend(px, k, enemy, 1);
        else if (e.kind === 'solid') {
          var b = e.def.box || [[-0.5, -0.5], [0.5, 0.5]];
          for (var yy = Math.max(0, y + Math.round(b[0][1])); yy < Math.min(CHUNK, y + Math.round(b[1][1]) + 1); yy++)
            for (var xx = Math.max(0, x + Math.round(b[0][0])); xx < Math.min(CHUNK, x + Math.round(b[1][0]) + 1); xx++)
              blend(px, yy * CHUNK + xx, e.def.color, 1);
        }
      }
      return px;
    }

    function waterMask(px) {
      var n = CHUNK * CHUNK, m = new Array(n);
      for (var k = 0; k < n; k++) m[k] = waterColors.has(px[k * 4] + ',' + px[k * 4 + 1] + ',' + px[k * 4 + 2]);
      return m;
    }

    return {
      passes: entProg ? 2 : 1,
      render: function (pass, cx, cy, prev) { return pass === 0 ? terrain(cx, cy) : entities(cx, cy, prev); },
    };
  }

  // Chunks of a size x size map, centred on 0,0, nearest the middle first.
  function spiral(size) {
    var half = size / CHUNK / 2, out = [];
    for (var cy = -half; cy < half; cy++) for (var cx = -half; cx < half; cx++) out.push([cx, cy]);
    out.sort(function (a, b) {
      var da = Math.max(Math.abs(a[0] + 0.5), Math.abs(a[1] + 0.5)), db = Math.max(Math.abs(b[0] + 0.5), Math.abs(b[1] + 0.5));
      if (da !== db) return da - db;
      return Math.atan2(a[1] + 0.5, a[0] + 0.5) - Math.atan2(b[1] + 0.5, b[0] + 0.5);
    });
    return out;
  }

  return { CHUNK: CHUNK, renderer: renderer, spiral: spiral, planetSettings: planetSettings };
});
