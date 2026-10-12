// The map preview's picture of a planet, computed from the game's own noise
// expressions (noise.js) and prototype data (noisedata.js).
//
// Pass 0 paints each pixel with the colour of the tile whose autoplace
// probability is highest there. Pass 1 lays cliffs and entities over it: ore
// in its map colour, trees as a green tint, rocks, and enemy bases in red.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./noise.js'));
  else root.FactorioPreview = factory(root.FactorioNoise);
})(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';

  var CHUNK = 32;
  // The furthest out (tiles per pixel) the overview still shows ore.
  var ORE_SCALE = 16;
  var BLACK = [0, 0, 0];

  // CliffOrientation, in the game's order.
  var ORIENTATIONS = ['west_to_east', 'north_to_south', 'east_to_west', 'south_to_north', 'west_to_north', 'north_to_east',
    'east_to_south', 'south_to_west', 'west_to_south', 'north_to_west', 'east_to_north', 'south_to_east', 'west_to_none',
    'none_to_east', 'east_to_none', 'none_to_west', 'north_to_none', 'none_to_south', 'south_to_none', 'none_to_north'];
  // Cell crossing pattern -> orientation (from the game's jump tables).
  var PLACE = { 1: 17, 3: 18, 4: 16, 5: 1, 12: 19, 15: 3, 16: 14, 17: 6, 28: 10, 48: 13, 51: 11, 52: 5, 64: 15, 67: 7, 68: 9, 80: 2,
    0xc0: 12, 0xc1: 8, 0xcc: 4, 0xf0: 0 };
  var PLACE_FIRST_ROW = Object.assign({}, PLACE);
  delete PLACE_FIRST_ROW[12];
  // Axis-aligned bounds of a (possibly rotated) bounding box.
  function aabb(b) {
    var x0 = b[0][0], y0 = b[0][1], x1 = b[1][0], y1 = b[1][1], rot = b[2] || 0;
    if (!rot) return [x0, y0, x1, y1];
    var a = rot * 2 * Math.PI, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
    var ex = hw * c + hh * s, ey = hw * s + hh * c;
    return [cx - ex, cy - ey, cx + ex, cy + ey];
  }

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
    // Whatever the planet says about cliffs wins over the map's settings.
    out.cliff_settings = Object.assign({}, out.cliff_settings || {}, p.cliff_settings || {});
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
    // A planet can swap in its own expression for any autoplace property,
    // by naming it in property_expression_names ("entity:coal:probability").
    var pen = ps.mgs.property_expression_names;
    function prop(kind, name, what, a, src) {
      var o = pen[kind + ':' + name + ':' + what];
      return typeof o === 'string' ? { src: o } : o !== undefined ? { src: o } : { src: src, def: a };
    }
    var tileOuts = tiles.map(function (t) {
      var a = data.tile[t].autoplace;
      return prop('tile', t, 'probability', a, a.probability_expression);
    });
    var colors = tiles.map(function (t) { return data.tile[t].color; });
    // A map of limited width or height: past its edges every tile is
    // out-of-map, black and blocking everything (OOM, after the real tiles).
    var OOM = tiles.length, NT = tiles.length + 1;
    colors.push(BLACK);
    var lim = function (n) { return n > 0 ? [-Math.floor(n / 2), n - Math.floor(n / 2)] : null; };
    var limX = lim(ps.mgs.width), limY = lim(ps.mgs.height);
    function offMap(tx, ty) {
      return (limX && (tx < limX[0] || tx >= limX[1])) || (limY && (ty < limY[0] || ty >= limY[1]));
    }

    // Zoomed out (each pixel scale tiles apart) the preview is an overview:
    // tiles and ore at sample points, no other entities and no cliffs.
    // Further out than ORE_SCALE, a patch would be a pixel or less, and the
    // spot noise behind ore would cost far more than the tiles: tiles only.
    var overview = scale > 1;
    var ents = previewEntities(data, ps).filter(function (e) {
      return controlSize(ps.mgs, e.def.autoplace.control) > 0 && (!overview || (e.kind === 'resource' && scale <= ORE_SCALE));
    });
    var tileSets = tiles.map(function (t) { return new Set(data.tile[t].layers || []); });
    var outs = [], patterns = new Map();
    ents.forEach(function (e, i) {
      var a = e.def.autoplace;
      e.index = i;
      e.p = outs.length; outs.push(prop('entity', e.name, 'probability', a, a.probability_expression));
      e.r = outs.length; outs.push(prop('entity', e.name, 'richness', a, a.richness_expression === undefined ? 0 : a.richness_expression));
      e.density = a.placement_density || 1;
      e.offgrid = !!e.def.offgrid;
      // Map generation tests the tiles under map_generator_bounding_box (the
      // collision box unless given), in 1/256 tiles, inclusive of its far
      // edge's tile.
      var b = e.def.genbox || e.def.box || [[0, 0], [0, 0]];
      e.box = [Math.round(b[0][0] * 256), Math.round(b[0][1] * 256), Math.round(b[1][0] * 256) - 1, Math.round(b[1][1] * 256) - 1];
      // Spawners and worms also keep that box clear of each other.
      e.spaced = e.def.type === 'unit-spawner' || e.def.type === 'turret';
      var layers = e.def.layers || [];
      var allowed = a.tile_restriction ? new Set(a.tile_restriction.filter(function (x) { return typeof x === 'string'; })) : null;
      e.blockedBy = Uint8Array.from(tiles.concat(['']), function (t, i) {
        if (i === OOM) return 1;
        if (allowed && !allowed.has(t)) return 1;
        return layers.some(function (l) { return tileSets[i].has(l); }) ? 1 : 0;
      });
      // Entities blocked by the same tiles share a pattern.
      var pk = e.blockedBy.join('');
      if (!patterns.has(pk)) patterns.set(pk, patterns.size);
      e.pattern = patterns.get(pk);
      e.landing = e.kind === 'resource' ? 1 : e.offgrid ? 2 : 0;
      e.color = e.kind === 'tree' ? null : e.kind === 'enemy' ? null : e.def.color;
    });
    // Groups of equal autoplace order, in order.
    var groups = [];
    ents.forEach(function (e) {
      var last = groups[groups.length - 1];
      if (last && (last[0].def.autoplace.order || '') === (e.def.autoplace.order || '')) last.push(e);
      else groups.push([e]);
    });
    // Pass 0 works out tiles and entity probabilities together (they share
    // much of their noise); entity outputs come after the tiles'. Tiles
    // alone (for those around the chunks done) are the same program's first
    // outputs.
    var chunkProg = N.compile(data, ps.mgs, tileOuts.concat(outs));
    var tileProg = outs.length ? new N.Program(chunkProg.builder, chunkProg.outputs.slice(0, tiles.length)) : chunkProg;
    var entities0 = outs.length ? tiles.length : -1;
    var cliffs = overview ? null : cliffPlacer(data, planet, ps);
    var tree = (data.chart && data.chart.tree) || [48, 99, 48, 102];
    var enemy = (data.chart && data.chart.enemy) || [255, 25, 25, 255];
    ents.forEach(function (e) { if (e.kind === 'tree') e.color = tree; else if (e.kind === 'enemy') e.color = enemy; });
    // At most this many draws a chunk: each tile one entity a group, with
    // its placement density's draws.
    var maxDraws = groups.reduce(function (s, g) {
      return s + CHUNK * CHUNK * Math.max.apply(null, g.map(function (e) { return Math.ceil(e.density); }));
    }, 0);

    // The module's versions of the per-chunk loops below (noise.c's
    // chunk_tiles and chunk_draws), with their memory: set up again after
    // each resetHeap, null without the module (or memory).
    var K = null;
    function kernels() {
      var M = N.module();
      if (!M) return null;
      if (K && K.epoch === M.epoch()) return K;
      K = null;
      var n = CHUNK * CHUNK, nt = NT, np = Math.max(1, patterns.size);
      var size = { outs: tiles.length * 4, ids: n * 4, best: n * 4, colours: nt * 4, px: n * 4, tables: np * nt,
        mask: np * n * 4, groups: (groups.length + 6 * ents.length) * 4, bp: n * 4, br: n * 4, be: n * 4, draws: maxDraws * 12 };
      var at = {};
      for (var k in size) if (!(at[k] = M.alloc(size[k]))) return null;
      var made = {
        M: M, epoch: M.epoch(), at: at,
        outs: new Int32Array(M.buf, at.outs, tiles.length), ids: new Int32Array(M.buf, at.ids, n),
        px: new Uint8ClampedArray(M.buf, at.px, n * 4), groups: new Int32Array(M.buf, at.groups, size.groups / 4),
        draws: new Int32Array(M.buf, at.draws, maxDraws * 3),
      };
      var col = new Uint8Array(M.buf, at.colours, nt * 4), tab = new Uint8Array(M.buf, at.tables, np * nt);
      colors.forEach(function (c, t) { col.set([c[0], c[1], c[2], 255], t * 4); });
      ents.forEach(function (e) { tab.set(e.blockedBy, e.pattern * nt); });
      return (K = made);
    }
    function inModule(k, r, from, to) {
      for (var i = from; i < to; i++) if (r[i].buffer !== k.M.buf) return false;
      return true;
    }

    function positions(cx, cy) {
      var n = CHUNK * CHUNK, xs = new Float32Array(n), ys = new Float32Array(n);
      for (var j = 0; j < CHUNK; j++) for (var i = 0; i < CHUNK; i++) {
        xs[j * CHUNK + i] = Math.floor((cx * CHUNK + i) * scale);
        ys[j * CHUNK + i] = Math.floor((cy * CHUNK + j) * scale);
      }
      return [xs, ys];
    }

    // Each chunk's tiles from pass 0, kept for pass 1's collision checks
    // there and in the chunks around it; and its entity draws (see place).
    var chunkTiles = new Map(), chunkDraws = new Map();
    // The game evaluates a chunk as a grid, which its noise has a path for
    // (positions() lays it out in rows).
    function chunkGrid(cx, cy) { return scale === 1 ? { x0: cx * CHUNK, y0: cy * CHUNK, w: CHUNK } : null; }
    // Points from several chunks: each with its own chunk's corner.
    function pointsGrid(xs, ys) {
      if (scale !== 1) return null;
      var n = xs.length, x0 = new Float32Array(n), y0 = new Float32Array(n);
      for (var i = 0; i < n; i++) { x0[i] = Math.floor(xs[i] / CHUNK) * CHUNK; y0[i] = Math.floor(ys[i] / CHUNK) * CHUNK; }
      return { x0: x0, y0: y0 };
    }

    function terrain(cx, cy) {
      var p = positions(cx, cy), n = CHUNK * CHUNK, key = cx + ',' + cy;
      var r = chunkProg.run(p[0], p[1], chunkGrid(cx, cy)), K = kernels(), px, ids;
      if (K && inModule(K, r, 0, tiles.length)) {
        for (var t = 0; t < tiles.length; t++) K.outs[t] = r[t].byteOffset;
        K.M.ex.chunk_tiles(n, tiles.length, K.at.outs, K.at.ids, K.at.best, K.at.colours, K.at.px);
        px = K.px.slice(); ids = new Int16Array(K.ids);
      } else {
        px = new Uint8ClampedArray(n * 4); ids = new Int16Array(n).fill(-1);
        var best = new Float32Array(n).fill(-Infinity), k;
        // The highest probability (the first of equals) at each tile.
        for (t = 0; t < tiles.length; t++) {
          var rt = r[t];
          for (k = 0; k < n; k++) if (rt[k] > best[k]) { best[k] = rt[k]; ids[k] = t; }
        }
        for (k = 0; k < n; k++) {
          var c = ids[k] >= 0 ? colors[ids[k]] : BLACK;
          px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = 255;
        }
      }
      if (limX || limY) {
        for (k = 0; k < n; k++) {
          if (!offMap(cx * CHUNK + (k % CHUNK), cy * CHUNK + ((k / CHUNK) | 0))) continue;
          ids[k] = OOM; px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = 0;
        }
      }
      if (entities0 >= 0 || cliffs) {
        // For collision checks a tile with no autoplace counts as the first.
        var kept = new Int16Array(n);
        for (k = 0; k < n; k++) kept[k] = ids[k] < 0 ? 0 : ids[k];
        chunkTiles.set(key, kept);
      }
      if (cliffs) cliffs.note(cx, cy);
      if (entities0 >= 0) chunkDraws.set(key, place(cx, cy, r, ids));
      return px;
    }

    // The preview's blend: opaque colours replace the pixel; translucent
    // ones move it by (colour - pixel) * alpha / 256, rounded down.
    // SubChart::drawRectangle: every pixel the box touches, clipped to the
    // chunk, in 1/256 tile fixed point.
    function rect(px, x0, y0, b, x, y, c, a) {
      var fx = Math.trunc(x * 256), fy = Math.trunc(y * 256);
      var xa = Math.max(x0, (Math.round(b[0][0] * 256) + fx) >> 8), xb = Math.min(x0 + CHUNK, (Math.round(b[1][0] * 256) + fx + 255) >> 8);
      var ya = Math.max(y0, (Math.round(b[0][1] * 256) + fy) >> 8), yb = Math.min(y0 + CHUNK, (Math.round(b[1][1] * 256) + fy + 255) >> 8);
      for (var ty = ya; ty < yb; ty++) for (var tx = xa; tx < xb; tx++) blend(px, (ty - y0) * CHUNK + (tx - x0), c, a);
    }

    // SubChart::drawRectangle's mix: alpha 0-255 becomes a weight of 0-256.
    function blend(px, k, c, a) {
      var o = k * 4, w = a + (a >> 7), v = 256 - w;
      px[o] = (px[o] * v + c[0] * w) >> 8;
      px[o + 1] = (px[o + 1] * v + c[1] * w) >> 8;
      px[o + 2] = (px[o + 2] * v + c[2] * w) >> 8;
    }

    // The chunk's entity draws, in placement order, as (entity index, x, y)
    // triples (x and y in 1/256 tiles): the map generator's own list
    // (EntityMapGenerationTask::generateEntities) before its collision
    // checks against the tiles under each one's box, which need the chunks
    // around and wait for pass 1 (they draw nothing from the stream).
    //
    // Entities go in groups of equal autoplace order. Within a group each
    // tile takes the entity with the highest probability there (richness
    // breaks ties), among those whose collision mask and tile_restriction the
    // tile allows. Then, tiles last to first, each gets placement_density
    // draws from the chunk's taus88 stream (seeded from the chunk position);
    // a draw under the probability places the entity: ore at the tile centre
    // if its richness is positive, off-grid entities at a random 1/16 tile
    // offset (two more draws), others at the tile centre, as long as no tile
    // under its map_generator_bounding_box blocks it. r: chunkProg's
    // outputs; ids: the chunk's tiles.
    function place(cx, cy, r, ids) {
      var n = CHUNK * CHUNK, seed = (Math.imul(cx, 7919) + Math.imul(cy, 7907) + 0x3fbe2c) >>> 0;
      seed = seed < 342 ? 341 : seed;
      var K = kernels();
      if (K && inModule(K, r, entities0, r.length)) {
        var d = K.groups, at = 0;
        groups.forEach(function (grp) {
          d[at++] = grp.length;
          grp.forEach(function (e) {
            d[at++] = e.index; d[at++] = r[entities0 + e.p].byteOffset; d[at++] = r[entities0 + e.r].byteOffset;
            d[at++] = e.pattern; d[at++] = Math.ceil(e.density); d[at++] = e.landing;
          });
        });
        K.ids.set(ids);
        var a = K.at, cnt = K.M.ex.chunk_draws(n, CHUNK, cx * CHUNK, cy * CHUNK, seed, a.ids, NT,
          Math.max(1, patterns.size), a.tables, a.mask, groups.length, a.groups, a.bp, a.br, a.be, a.draws);
        return K.draws.slice(0, 3 * cnt);
      }
      var rng = new N.Taus88(seed);
      var placed = [];
      var bp = new Float32Array(n), br = new Float32Array(n), be = new Int32Array(n);
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        bp.fill(-Infinity); be.fill(-1);
        for (var q = 0; q < grp.length; q++) {
          var e = grp[q], pr = r[entities0 + e.p], rr = r[entities0 + e.r], blk = e.blockedBy;
          for (var k = n - 1; k >= 0; k--) {
            if (blk[ids[k] < 0 ? 0 : ids[k]]) continue;
            var v = pr[k];
            if (v > bp[k] || (v === bp[k] && rr[k] > br[k])) { bp[k] = v; br[k] = rr[k]; be[k] = q; }
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
            placed.push(e.index, fx, fy);
          }
        }
      }
      return Int32Array.from(placed);
    }

    // The chunk's entities as [entity, x, y]: its draws (from pass 0, or
    // worked out now) that no tile under the box blocks.
    function placedAt(cx, cy, tl) {
      var key = cx + ',' + cy, draws = chunkDraws.get(key);
      if (draws) chunkDraws.delete(key);
      else {
        var p = positions(cx, cy), r = chunkProg.run(p[0], p[1], chunkGrid(cx, cy));
        draws = place(cx, cy, r, tl.inner);
      }
      var out = [];
      for (var i = 0; i < draws.length; i += 3) {
        var e = ents[draws[i]];
        if (!tl.boxBlocked(e, draws[i + 1], draws[i + 2])) out.push([e, draws[i + 1] / 256, draws[i + 2] / 256]);
      }
      return out;
    }

    // Pass 1, as MapPreviewGenerator::Worker::computeEntities: cliffs, then
    // the chunk's entities over every pixel their collision box touches.
    function entities(cx, cy, px) {
      px = px.slice();
      if (entities0 < 0 && !cliffs) return px;
      var tl = tileLayers(cx, cy);
      // Cliffs go down first: everything else is drawn over them.
      if (cliffs) drawCliffs(px, cx, cy, cliffs.place(cx, cy, tl));
      if (entities0 < 0) return px;
      var placed = placedAt(cx, cy, tl);
      var x0 = cx * CHUNK, y0 = cy * CHUNK;
      // Last placed first, as MapPreviewGenerator::Worker::computeEntities
      // draws them. Spawners and worms that would overlap one already drawn
      // are left out, which is what thins out enemy bases.
      var kept = [], enemies = [];
      for (var i = placed.length - 1; i >= 0; i--) {
        var e = placed[i][0], x = placed[i][1], y = placed[i][2];
        if (e.spaced) {
          var fx = Math.trunc(x * 256), fy = Math.trunc(y * 256);
          var bx = [fx + e.box[0], fy + e.box[1], fx + e.box[2] + 1, fy + e.box[3] + 1];
          var clash = false;
          for (var q = 0; q < kept.length && !clash; q++) {
            var o = kept[q];
            clash = !(o[0] > bx[2] || o[1] > bx[3] || o[2] < bx[0] || o[3] < bx[1]);
          }
          if (clash) continue;
          kept.push(bx);
        }
        var box = e.def.box || [[0, 0], [0, 0]];
        // Enemies wait until everything else is down.
        if (e.kind === 'enemy') { enemies.push([box, x, y]); continue; }
        if (e.kind === 'resource') {
          // Ores (map_grid) show only on alternate 2x2 squares.
          var tx = Math.floor(x), ty = Math.floor(y);
          if (!e.def.nogrid && (((tx >> 1) ^ (ty >> 1)) & 1) === 0) continue;
          rect(px, x0, y0, box, x, y, e.def.color, 255);
        } else if (e.color && e.kind !== 'fish') {
          rect(px, x0, y0, box, x, y, e.color, e.color[3] === undefined ? 255 : e.color[3]);
        }
      }
      enemies.forEach(function (en) { rect(px, x0, y0, en[0], en[1], en[2], enemy, 255); });
      return px;
    }

    // Cliffs, as EntityMapGenerationTask::computeInternal places them. The
    // chunk is cut into grid_size cells; at each cell corner the planet's
    // cliff_elevation and cliffiness are evaluated. A cell edge "crosses"
    // when its ends lie either side of a contour (cliff_elevation_0 plus a
    // multiple of the interval) and the ends' mean cliffiness is over 0.5.
    // Cells left with an impossible pattern lose edges (never the chunk's
    // outer ones) until every cell has none, one or two, and each such cell
    // becomes a cliff piece whose orientation follows its crossings.
    function cliffPlacer(data, planet, ps) {
      if (!data.cliff) return null;
      var cs = ps.mgs.cliff_settings || {};
      var proto = cs.name && data.cliff[cs.name];
      if (!proto) return null;
      var ctl = (ps.mgs.autoplace_controls || {})[cs.control] || {};
      if (ctl.size === 0) return null;
      var e0 = Math.fround(cs.cliff_elevation_0 === undefined ? 10 : cs.cliff_elevation_0);
      var iv = cs.cliff_elevation_interval === undefined ? 40 : cs.cliff_elevation_interval;
      // Planets that want sharp cliffs say cliff_smoothing = 0; left out, it is 1.
      var smooth = Math.fround(cs.cliff_smoothing === undefined ? 1 : cs.cliff_smoothing);
      var freq = ctl.frequency === undefined ? 1 : ctl.frequency;
      var interval = Math.fround(Math.fround(iv) / Math.fround(freq));
      var gx = proto.grid_size[0], gy = proto.grid_size[1];
      var nx = CHUNK / gx, ny = CHUNK / gy;
      // multisample offsets count lattice points here, so a grid_size apart.
      var prog = N.compile(data, ps.mgs, ['cliff_elevation', 'cliffiness'], { spacing: [gx, gy] });
      var layers = new Set(proto.layers || []);
      var blockedBy = tiles.map(function (t, i) { return (data.tile[t].layers || []).some(function (l) { return layers.has(l); }); }).concat([true]);
      var boxes = ORIENTATIONS.map(function (o) { return proto.orientations[o]; });
      var VALID = new Set([0, 1, 3, 4, 5, 0xc, 0xf, 0x10, 0x11, 0x1c, 0x30, 0x33, 0x34, 0x40, 0x43, 0x44, 0x50, 0xc0, 0xc1, 0xcc, 0xf0]);

      function edge(eA, eB, c) {
        if (eA < 0 || eB < 0) return 0;
        var level = Math.fround(Math.fround(Math.floor(Math.fround(Math.fround(Math.max(eA, eB) - e0) / interval)) * interval) + e0);
        if (e0 > level) return 0;
        var dA = Math.fround(eA - level), dB = Math.fround(eB - level);
        if (!(c > 0.5)) return 0;
        if (dA < 0 && dB > 0) return 1;
        if (dA > 0 && dB < 0) return 3;
        return 0;
      }

      // Each chunk's lattice values, worked out for many chunks at once (a
      // point's values don't depend on the others it goes with): those
      // pass 0 has been through, up to BATCH at a time.
      var w = nx + 1, hgt = ny + 1, m = w * hgt, BATCH = 48;
      var pending = new Map(), lattice = new Map();
      function latticeAt(cx, cy) {
        var key = cx + ',' + cy, got = lattice.get(key);
        if (got) { lattice.delete(key); return got; }
        var batch = [[cx, cy]];
        pending.delete(key);
        var it = pending.values(), next;
        while (batch.length < BATCH && !(next = it.next()).done) batch.push(next.value);
        var xs = new Float32Array(m * batch.length), ys = new Float32Array(m * batch.length);
        batch.forEach(function (c, b) {
          for (var j = 0; j < hgt; j++) for (var i = 0; i < w; i++) {
            xs[b * m + j * w + i] = c[0] * CHUNK + i * gx; ys[b * m + j * w + i] = c[1] * CHUNK + j * gy;
          }
        });
        var r = prog.run(xs, ys);
        batch.forEach(function (c, b) {
          var k = c[0] + ',' + c[1], v = [r[0].slice(b * m, b * m + m), r[1].slice(b * m, b * m + m)];
          if (b === 0) got = v; else { pending.delete(k); lattice.set(k, v); }
        });
        return got;
      }

      return {
        // Pass 0 has been through the chunk.
        note: function (cx, cy) { pending.set(cx + ',' + cy, [cx, cy]); },
        trim: function (max) { trim(pending, max); trim(lattice, max); },
        place: function (cx, cy, tl) {
          var r = latticeAt(cx, cy), el = r[0], cl = r[1], i, j;
          if (smooth !== 0) el = smoothed(el, w, hgt, smooth);
          // h: edges along x (ny + 1 rows of nx); v: edges along y (ny rows of nx + 1).
          var h = new Uint8Array(nx * hgt), v = new Uint8Array(w * ny);
          for (j = 0; j < hgt; j++) for (i = 0; i < nx; i++) {
            var a = j * w + i;
            h[j * nx + i] = edge(el[a], el[a + 1], Math.fround(Math.fround(cl[a] + cl[a + 1]) * 0.5));
          }
          for (j = 0; j < ny; j++) for (i = 0; i < w; i++) {
            a = j * w + i;
            v[j * w + i] = edge(el[a], el[a + w], Math.fround(Math.fround(cl[a] + cl[a + w]) * 0.5));
          }
          var code = function (i, j) {
            return ((v[j * w + i] & 3) << 6) | ((v[j * w + i + 1] & 3) << 4) | ((h[j * nx + i] & 3) << 2) | (h[(j + 1) * nx + i] & 3);
          };
          for (var pass = 0; pass < 2; pass++) {
            var stuck = false;
            for (j = 0; j < ny && !stuck; j++) for (i = 0; i < nx && !stuck; i++) {
              for (;;) {
                var L = v[j * w + i], R = v[j * w + i + 1], T = h[j * nx + i], Bt = h[(j + 1) * nx + i];
                var cnt = (L ? 1 : 0) + (R ? 1 : 0) + (T ? 1 : 0) + (Bt ? 1 : 0);
                if (cnt <= 2 && VALID.has(code(i, j))) break;
                if (j > 0 && T) { h[j * nx + i] = 0; continue; }
                if (R && i < nx - 1) { v[j * w + i + 1] = 0; continue; }
                if (Bt && j < ny - 1) { h[(j + 1) * nx + i] = 0; continue; }
                stuck = true; break;
              }
            }
            if (!stuck) break;
            // Clear the edges at the chunk's corners and start again.
            h[0] = 0; v[0] = 0; h[nx - 1] = 0; v[nx] = 0;
            h[ny * nx] = 0; v[w * (ny - 1)] = 0; h[ny * nx + nx - 1] = 0; v[w * (ny - 1) + nx] = 0;
          }
          var out = [];
          for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
            var c = code(i, j), o = j === 0 ? PLACE_FIRST_ROW[c] : PLACE[c];
            if (o === undefined) continue;
            var px = cx * CHUNK + i * gx + (gx >> 1) + proto.grid_offset[0];
            var py = cy * CHUNK + j * gy + (gy >> 1) + proto.grid_offset[1];
            var box = boxes[o];
            if (box && tl && collides(box, px, py, tl)) continue;
            out.push({ o: o, x: px, y: py, box: box, color: proto.color });
          }
          return out;
        },
      };

      // EntityMapGenerationTask::wouldCollide, as tryToAddCliff calls it for
      // the preview: every tile under the orientation's box as written, its
      // rotation ignored, in 1/256 tile fixed point.
      function collides(box, px, py, tl) {
        var fx = px * 256, fy = py * 256;
        var xa = (Math.round(box[0][0] * 256) + fx) >> 8, xb = (Math.round(box[1][0] * 256) + fx) >> 8;
        var ya = (Math.round(box[0][1] * 256) + fy) >> 8, yb = (Math.round(box[1][1] * 256) + fy) >> 8;
        for (var ty = ya; ty <= yb; ty++) for (var tx = xa; tx <= xb; tx++) {
          var t = tl.at(tx, ty);
          if (t >= 0 && blockedBy[t]) return true;
        }
        return false;
      }
    }

    // cliff_smoothing pulls each corner towards a bilinear blend over blocks
    // of four cells. The blocks end at the last cell's near corner, as the
    // game's do, so the last block is three cells and the far edge stands
    // alone.
    function smoothed(el, w, hgt, s) {
      var out = new Float32Array(el.length), f = Math.fround, ks = f(1 - s);
      var span = function (k, cells) {
        var a = k & ~3, b = Math.min(a + 4, cells - 1);
        return [a, b, b === a || b < a ? 0 : f((k & 3) / (b - a))];
      };
      for (var j = 0; j < hgt; j++) {
        var Y = span(j, hgt - 1), ty = Y[2], uy = f(1 - ty), r0 = Y[0] * w, r1 = Y[1] * w;
        for (var i = 0; i < w; i++) {
          var X = span(i, w - 1), tx = X[2], ux = f(1 - tx);
          var v = f(f(f(tx * uy) * el[r0 + X[1]]) + f(f(ux * uy) * el[r0 + X[0]]));
          v = f(f(f(ux * ty) * el[r1 + X[0]]) + v);
          v = f(f(f(tx * ty) * el[r1 + X[1]]) + v);
          out[j * w + i] = f(f(el[j * w + i] * ks) + f(v * s));
        }
      }
      return out;
    }

    function drawCliffs(px, cx, cy, list) {
      var x0 = cx * CHUNK, y0 = cy * CHUNK;
      list.forEach(function (c) {
        if (!c.box) return;
        var bb = aabb(c.box);
        var xa = Math.max(x0, Math.floor(c.x + bb[0])), xb = Math.min(x0 + CHUNK, Math.ceil(c.x + bb[2]));
        var ya = Math.max(y0, Math.floor(c.y + bb[1])), yb = Math.min(y0 + CHUNK, Math.ceil(c.y + bb[3]));
        for (var y = ya; y < yb; y++) for (var x = xa; x < xb; x++) blend(px, (y - y0) * CHUNK + (x - x0), c.color, 255);
      });
    }

    // The tiles under and around a chunk, for collision masks. Entity boxes
    // can reach a couple of tiles into the next chunk.
    var B = 4, W = CHUNK + 2 * B;
    function argmax(r, k) {
      var best = -Infinity, bi = 0;
      for (var t = 0; t < r.length; t++) if (r[t][k] > best) { best = r[t][k]; bi = t; }
      return bi;
    }
    function tileLayers(cx, cy) {
      // From pass 0 where it has been (the chunk and its neighbours), the
      // rest evaluated here, each tile on its own chunk's grid as pass 0
      // would have.
      var id = new Int16Array(W * W), xs = [], ys = [], at = [], i, j, k;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var ncx = cx + dx, ncy = cy + dy, done = chunkTiles.get(ncx + ',' + ncy);
        var ia = Math.max(0, dx * CHUNK + B), ib = Math.min(W, (dx + 1) * CHUNK + B);
        var ja = Math.max(0, dy * CHUNK + B), jb = Math.min(W, (dy + 1) * CHUNK + B);
        for (j = ja; j < jb; j++) {
          var ty = cy * CHUNK + j - B, from = (ty - ncy * CHUNK) * CHUNK + cx * CHUNK - B - ncx * CHUNK;
          if (done) { id.set(done.subarray(from + ia, from + ib), j * W + ia); continue; }
          for (i = ia; i < ib; i++) { xs.push(cx * CHUNK + i - B); ys.push(ty); at.push(j * W + i); }
        }
      }
      if (at.length) {
        var fx = new Float32Array(xs), fy = new Float32Array(ys), r = tileProg.run(fx, fy, pointsGrid(fx, fy));
        for (k = 0; k < at.length; k++) id[at[k]] = offMap(xs[k], ys[k]) ? OOM : argmax(r, k);
      }
      var tileAt = function (tx, ty) {
        var i = tx - cx * CHUNK + B, j = ty - cy * CHUNK + B;
        return i < 0 || j < 0 || i >= W || j >= W ? -1 : id[j * W + i];
      };
      // The chunk's own tiles, in position order.
      var inner = new Int16Array(CHUNK * CHUNK);
      for (j = 0; j < CHUNK; j++) inner.set(id.subarray((j + B) * W + B, (j + B) * W + B + CHUNK), j * CHUNK);
      return {
        at: tileAt,
        inner: inner,
        boxBlocked: function (e, fx, fy) {
          var b = e.box;
          var xa = (fx + b[0]) >> 8, xb = (fx + b[2]) >> 8, ya = (fy + b[1]) >> 8, yb = (fy + b[3]) >> 8;
          for (var ty = ya; ty <= yb; ty++) for (var tx = xa; tx <= xb; tx++) {
            var t = tileAt(tx, ty);
            if (t >= 0 && e.blockedBy[t]) return true;
          }
          return false;
        },
      };
    }

    // The overview's chunk: each pixel the tile at its sample point, and
    // where a resource would very likely be placed there (the most probable
    // of each group, as place() picks, with a probability of at least a
    // half and positive richness) its map colour. (The full preview draws
    // ore on alternate 2x2 squares; here a patch is only a few pixels.)
    // Pass 0 is the tiles alone, which are quick; pass 1 adds the ore.
    function overviewChunk(cx, cy, ore) {
      var p = positions(cx, cy), n = CHUNK * CHUNK;
      var r = (ore ? chunkProg : tileProg).run(p[0], p[1], null), px = new Uint8ClampedArray(n * 4), ids = new Int16Array(n).fill(-1);
      var best = new Float32Array(n).fill(-Infinity), k, t;
      for (t = 0; t < tiles.length; t++) {
        var rt = r[t];
        for (k = 0; k < n; k++) if (rt[k] > best[k]) { best[k] = rt[k]; ids[k] = t; }
      }
      for (k = 0; k < n; k++) {
        var c = ids[k] >= 0 ? colors[ids[k]] : BLACK;
        px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = 255;
      }
      for (var g = 0; ore && g < groups.length; g++) {
        var grp = groups[g];
        for (k = 0; k < n; k++) {
          var tile = ids[k] < 0 ? 0 : ids[k], bp = -Infinity, br = 0, be = null;
          for (var q = 0; q < grp.length; q++) {
            var e = grp[q];
            if (e.blockedBy[tile]) continue;
            var v = r[entities0 + e.p][k], rv = r[entities0 + e.r][k];
            if (v > bp || (v === bp && rv > br)) { bp = v; br = rv; be = e; }
          }
          if (!be || !(bp >= 0.5) || !(br > 0)) continue;
          blend(px, k, be.def.color, 255);
        }
      }
      return px;
    }

    // Long sessions of panning visit unbounded numbers of chunks: keep only
    // the most recent of what pass 0 leaves for pass 1.
    function trim(map, max) {
      if (map.size <= max) return;
      var it = map.keys();
      for (var d = map.size - max; d > 0; d--) map.delete(it.next().value);
    }

    if (overview) {
      return { passes: groups.length ? 2 : 1, overview: true, render: function (pass, cx, cy) { return overviewChunk(cx, cy, pass > 0); }, trim: function () {} };
    }
    return {
      passes: entities0 >= 0 || cliffs ? 2 : 1,
      render: function (pass, cx, cy, prev) { return pass === 0 ? terrain(cx, cy) : entities(cx, cy, prev); },
      trim: function (max) { trim(chunkTiles, max); trim(chunkDraws, max); if (cliffs) cliffs.trim(max); },
      _cliffs: function (cx, cy) { return cliffs ? cliffs.place(cx, cy, tileLayers(cx, cy)) : []; },
      _tiles: function (cx, cy) { return tileLayers(cx, cy); },
      _placed: function (cx, cy) { return entities0 >= 0 ? placedAt(cx, cy, tileLayers(cx, cy)) : []; },
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
