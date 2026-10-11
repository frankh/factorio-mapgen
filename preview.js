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
    // Other planets' surfaces get their own seed: the map seed plus the CRC
    // of the planet's name (Nauvis, the starting surface, keeps the map's).
    if (planet !== 'nauvis') out.seed = ((out.seed || 0) + N.crc32str(planet)) >>> 0;
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
      var kind = e.type === 'resource' ? 'resource' : e.type === 'tree' ? 'tree' : e.type === 'fish' ? 'fish'
        : e.type === 'unit-spawner' || e.type === 'turret' || e.autoplace.force === 'enemy' ? 'enemy' : 'solid';
      out.push({ name: n, kind: kind, def: e });
    });
    out.sort(function (a, b) {
      var oa = a.def.autoplace.order || '', ob = b.def.autoplace.order || '';
      return oa < ob ? -1 : oa > ob ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
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

    var ents = previewEntities(data, ps).filter(function (e) {
      return controlSize(ps.mgs, e.def.autoplace.control) > 0;
    });
    var tileSets = tiles.map(function (t) { return new Set(data.tile[t].layers || []); });
    var outs = [];
    ents.forEach(function (e) {
      var a = e.def.autoplace;
      e.p = outs.length; outs.push({ src: a.probability_expression, def: a });
      e.r = outs.length; outs.push({ src: a.richness_expression === undefined ? 0 : a.richness_expression, def: a });
      e.density = a.placement_density || 1;
      e.offgrid = !!e.def.offgrid;
      var b = e.def.box || [[0, 0], [0, 0]];
      // Collision box in 1/256 tiles, inclusive of its far edge's tile.
      e.box = [Math.round(b[0][0] * 256), Math.round(b[0][1] * 256), Math.round(b[1][0] * 256) - 1, Math.round(b[1][1] * 256) - 1];
      var layers = e.def.layers || [];
      var allowed = a.tile_restriction ? new Set(a.tile_restriction.filter(function (x) { return typeof x === 'string'; })) : null;
      e.blockedBy = tiles.map(function (t, i) {
        if (allowed && !allowed.has(t)) return true;
        return layers.some(function (l) { return tileSets[i].has(l); });
      });
      e.color = e.kind === 'tree' ? null : e.kind === 'enemy' ? null : e.def.color;
    });
    // Groups of equal autoplace order, in order.
    var groups = [];
    ents.forEach(function (e) {
      var last = groups[groups.length - 1];
      if (last && (last[0].def.autoplace.order || '') === (e.def.autoplace.order || '')) last.push(e);
      else groups.push([e]);
    });
    var entProg = outs.length ? N.compile(data, ps.mgs, outs) : null;
    var tree = (data.chart && data.chart.tree) || [48, 99, 48, 102];
    var enemy = (data.chart && data.chart.enemy) || [255, 25, 25, 255];
    ents.forEach(function (e) { if (e.kind === 'tree') e.color = tree; else if (e.kind === 'enemy') e.color = enemy; });

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

    // The preview's blend: opaque colours replace the pixel; translucent
    // ones move it by (colour - pixel) * alpha / 256, rounded down.
    function blend(px, k, c, a) {
      var o = k * 4;
      if (a >= 255) { px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; return; }
      px[o] += ((c[0] - px[o]) * a) >> 8;
      px[o + 1] += ((c[1] - px[o + 1]) * a) >> 8;
      px[o + 2] += ((c[2] - px[o + 2]) * a) >> 8;
    }

    // As MapPreviewGenerator::Worker::computeEntities: the map generator's
    // own entity placement for the chunk (EntityMapGenerationTask), drawn as
    // the preview draws it.
    //
    // Placement: entities go in groups of equal autoplace order. Within a
    // group each tile takes the entity with the highest probability there
    // (richness breaks ties), among those whose collision mask the tile
    // allows. Then, tiles last to first, each gets placement_density draws
    // from the chunk's taus88 stream (seeded from the chunk position); a
    // draw under the probability places the entity: ore at the tile centre
    // if its richness is positive, off-grid entities at a random 1/16 tile
    // offset (two more draws), others at the tile centre, as long as no
    // tile under its box blocks it. This matches the game's entity list
    // exactly; the preview draws that list without the collision checks a
    // real map does when building it.
    //
    // Drawing: ore first, on a 2x2-tile checkerboard; then the rest in
    // placement order over every pixel their collision box touches: trees as
    // a translucent tint, enemies in red, rocks and the like in their map
    // colour.
    function entities(cx, cy, px) {
      px = px.slice();
      if (!entProg) return px;
      var p = positions(cx, cy), n = CHUNK * CHUNK;
      var r = entProg.run(p[0], p[1]);
      var tl = tileLayers(cx, cy);
      var seed = (Math.imul(cx, 7919) + Math.imul(cy, 7907) + 0x3fbe2c) >>> 0;
      var rng = new N.Taus88(seed < 342 ? 341 : seed);
      var placed = [];
      var bp = new Float32Array(n), br = new Float32Array(n), be = new Int32Array(n);
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        bp.fill(-Infinity); be.fill(-1);
        for (var q = 0; q < grp.length; q++) {
          var e = grp[q], pr = r[e.p], rr = r[e.r];
          for (var k = n - 1; k >= 0; k--) {
            if (tl.blocks(e, k)) continue;
            var v = pr[k], rv = rr[k];
            if (v > bp[k] || (v === bp[k] && rv > br[k])) { bp[k] = v; br[k] = rv; be[k] = q; }
          }
        }
        for (k = n - 1; k >= 0; k--) {
          if (be[k] < 0) continue;
          e = grp[be[k]];
          var tx = cx * CHUNK + (k % CHUNK), ty = cy * CHUNK + ((k / CHUNK) | 0);
          for (var a = 0; a < e.density; a++) {
            if (!(bp[k] > rng.next() * 2.3283064365386963e-10)) continue;
            var fx = tx * 256, fy = ty * 256;
            if (e.kind === 'resource') {
              if (!(br[k] > 0)) continue;
              fx += 128; fy += 128;
            } else if (e.offgrid) {
              fx = (fx + Math.trunc(rng.next() * 2.3283064365386963e-10 * 256)) & ~15;
              fy = (fy + Math.trunc(rng.next() * 2.3283064365386963e-10 * 256)) & ~15;
            } else { fx += 128; fy += 128; }
            if (tl.boxBlocked(e, fx, fy)) continue;
            placed.push([e, fx / 256, fy / 256]);
          }
        }
      }
      var x0 = cx * CHUNK, y0 = cy * CHUNK;
      placed.forEach(function (pl) {
        if (pl[0].kind !== 'resource') return;
        var x = Math.floor(pl[1]), y = Math.floor(pl[2]);
        if ((((x >> 1) ^ (y >> 1)) & 1) === 0) return;
        blend(px, (y - y0) * CHUNK + (x - x0), pl[0].def.color, 255);
      });
      // Trees under everything else.
      placed.sort(function (a, b) { return (a[0].kind === 'tree' ? 0 : 1) - (b[0].kind === 'tree' ? 0 : 1); });
      placed.forEach(function (pl) {
        var e = pl[0];
        if (e.kind === 'resource' || e.kind === 'fish' || !e.color) return;
        // Enemies show as small marks, not their whole footprint. (The game
        // also thins enemy bases in a way not reproduced here yet.)
        var b = e.kind === 'enemy' ? [[0, 0], [0.01, 0.01]] : e.def.box || [[0, 0], [0, 0]];
        var xa = Math.max(x0, Math.floor(pl[1] + b[0][0])), xb = Math.min(x0 + CHUNK, Math.ceil(pl[1] + b[1][0]));
        var ya = Math.max(y0, Math.floor(pl[2] + b[0][1])), yb = Math.min(y0 + CHUNK, Math.ceil(pl[2] + b[1][1]));
        for (var y = ya; y < yb; y++) for (var x = xa; x < xb; x++) {
          blend(px, (y - y0) * CHUNK + (x - x0), e.color, e.color[3] === undefined ? 255 : e.color[3]);
        }
      });
      return px;
    }

    // The tiles under and around a chunk, for collision masks. Entity boxes
    // can reach a couple of tiles into the next chunk.
    var B = 2, W = CHUNK + 2 * B;
    function tileLayers(cx, cy) {
      var xs = new Float32Array(W * W), ys = new Float32Array(W * W);
      for (var j = 0; j < W; j++) for (var i = 0; i < W; i++) { xs[j * W + i] = cx * CHUNK + i - B; ys[j * W + i] = cy * CHUNK + j - B; }
      var r = tileProg.run(xs, ys), id = new Int16Array(W * W);
      for (var k = 0; k < W * W; k++) {
        var best = -Infinity, bi = 0;
        for (var t = 0; t < r.length; t++) if (r[t][k] > best) { best = r[t][k]; bi = t; }
        id[k] = bi;
      }
      var at = function (tx, ty) {
        var i = tx - cx * CHUNK + B, j = ty - cy * CHUNK + B;
        return i < 0 || j < 0 || i >= W || j >= W ? -1 : id[j * W + i];
      };
      return {
        blocks: function (e, k) { return e.blockedBy[id[(((k / CHUNK) | 0) + B) * W + (k % CHUNK) + B]]; },
        boxBlocked: function (e, fx, fy) {
          var b = e.box;
          var xa = (fx + b[0]) >> 8, xb = (fx + b[2]) >> 8, ya = (fy + b[1]) >> 8, yb = (fy + b[3]) >> 8;
          for (var ty = ya; ty <= yb; ty++) for (var tx = xa; tx <= xb; tx++) {
            var t = at(tx, ty);
            if (t >= 0 && e.blockedBy[t]) return true;
          }
          return false;
        },
      };
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
