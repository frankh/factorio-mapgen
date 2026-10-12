// Factorio 2.0 map exchange strings: decode and encode, byte for byte.
//
// A string is ">>>" + base64(zlib level 9(payload + crc32(payload))) + "<<<".
// The payload is the game version, the map generation settings and the map
// settings, in the layout below. It was worked out against the 2.0.77
// headless server (game.get_map_exchange_string / --map-gen-settings) and
// every field is checked by test/mapexchange.test.js.
//
// The decoded object uses the same shape and names as the game's own
// helpers.parse_map_exchange_string, i.e. the --map-gen-settings and
// --map-settings JSON files, plus a "_raw" object holding the few bytes that
// have no settings counterpart, so decode then encode returns the same string.
//
// Works in the browser (needs vendor/pako.min.js loaded first) and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/pako.min.js'));
  else root.FactorioMapExchange = factory(root.pako);
})(typeof self !== 'undefined' ? self : this, function (pako) {
  'use strict';

  // Map settings, in serialisation order. Every value but the ones marked
  // bare is preceded by a presence byte, as the game stores them optionally.
  const D = 'f64', U = 'u32', B = 'bool';
  const POLLUTION = ['pollution', [
    ['enabled', B], ['diffusion_ratio', D], ['min_to_diffuse', D], ['ageing', D],
    ['expected_max_per_chunk', D], ['min_to_show_per_chunk', D], ['min_pollution_to_damage_trees', D],
    ['pollution_with_max_forest_damage', D], ['pollution_per_tree_damage', D],
    ['pollution_restored_per_tree_damage', D], ['max_pollution_to_restore_trees', D],
    ['enemy_attack_pollution_consumption_modifier', D]]];
  const STEERING = ['steering', [
    ['default', [['radius', D], ['separation_factor', D], ['separation_force', D], ['force_unit_fuzzy_goto_behavior', B]]],
    ['moving', [['radius', D], ['separation_factor', D], ['separation_force', D], ['force_unit_fuzzy_goto_behavior', B]]]]];
  const EVOLUTION = ['enemy_evolution', [['enabled', B], ['time_factor', D], ['destroy_factor', D], ['pollution_factor', D]]];
  const EXPANSION_2_0 = ['enemy_expansion', [
    ['enabled', B], ['max_expansion_distance', U], ['friendly_base_influence_radius', U],
    ['enemy_building_influence_radius', U], ['building_coefficient', D], ['other_base_coefficient', D],
    ['neighbouring_chunk_coefficient', D], ['neighbouring_base_chunk_coefficient', D],
    ['max_colliding_tiles_coefficient', D], ['settler_group_min_size', U], ['settler_group_max_size', U],
    ['min_expansion_cooldown', U], ['max_expansion_cooldown', U]]];
  const EXPANSION_2_1 = ['enemy_expansion', [
    ['enabled', B], ['max_expansion_distance', U], ['min_expansion_distance', U], ['friendly_base_influence_radius', U],
    ['enemy_building_influence_radius', U], ['building_coefficient', D], ['other_base_coefficient', D],
    ['neighbouring_chunk_coefficient', D], ['neighbouring_base_chunk_coefficient', D],
    ['max_colliding_tiles_coefficient', D], ['settler_group_min_size', U], ['settler_group_max_size', U],
    ['evolution_group_size_factor', D], ['min_expansion_cooldown', U], ['max_expansion_cooldown', U]]];
  const REST = [
    ['unit_group', [
      ['min_group_gathering_time', U], ['max_group_gathering_time', U], ['max_wait_time_for_late_members', U],
      ['max_group_radius', D], ['min_group_radius', D], ['max_member_speedup_when_behind', D],
      ['max_member_slowdown_when_ahead', D], ['max_group_slowdown_factor', D],
      ['max_group_member_fallback_factor', D], ['member_disown_distance', D],
      ['tick_tolerance_when_member_arrives', U], ['max_gathering_unit_groups', U], ['max_unit_group_size', U]]],
    ['path_finder', [
      ['fwd2bwd_ratio', U], ['goal_pressure_ratio', D], ['use_path_cache', B], ['max_steps_worked_per_tick', D],
      ['max_work_done_per_tick', U], ['short_cache_size', U], ['long_cache_size', U],
      ['short_cache_min_cacheable_distance', D], ['short_cache_min_algo_steps_to_cache', U],
      ['long_cache_min_cacheable_distance', D], ['cache_max_connect_to_cache_steps_multiplier', U],
      ['cache_accept_path_start_distance_ratio', D], ['cache_accept_path_end_distance_ratio', D],
      ['negative_cache_accept_path_start_distance_ratio', D], ['negative_cache_accept_path_end_distance_ratio', D],
      ['cache_path_start_distance_rating_multiplier', D], ['cache_path_end_distance_rating_multiplier', D],
      ['stale_enemy_with_same_destination_collision_penalty', D], ['ignore_moving_enemy_collision_distance', D],
      ['enemy_with_different_destination_collision_penalty', D], ['general_entity_collision_penalty', D],
      ['general_entity_subsequent_collision_penalty', D], ['extended_collision_penalty', D],
      ['max_clients_to_accept_any_new_request', U], ['max_clients_to_accept_short_new_request', U],
      ['direct_distance_to_consider_short_request', U], ['short_request_max_steps', U], ['short_request_ratio', D],
      ['min_steps_to_check_path_find_termination', U], ['start_to_goal_cost_multiplier_to_terminate_path_find', D],
      ['overload_levels', 'u32[]'], ['overload_multipliers', 'f64[]'], ['negative_path_cache_delay_interval', U]]],
    ['max_failed_behavior_count', 'bare:u32'],
    ['difficulty_settings', [['technology_price_multiplier', 'bare:f64'], ['spoil_time_modifier', 'bare:f64']]],
    ['asteroids', [['spawning_rate', D], ['max_ray_portals_expanded_per_tick', U]]],
  ];
  // 1.1 has 2.0's layout up to max_failed_behavior_count, then its own
  // difficulty settings and no asteroids.
  const MAP_SETTINGS_1_1 = [POLLUTION, STEERING, EVOLUTION, EXPANSION_2_0, ...REST.slice(0, 3),
    ['difficulty_settings', [['recipe_difficulty', 'bare:u8'], ['technology_difficulty', 'bare:u8'],
      ['technology_price_multiplier', 'bare:f64'], ['research_queue_setting', 'bare:u8']]]];
  // 2.1 dropped unit steering and reworked expansion; the rest is unchanged.
  const MAP_SETTINGS_2_0 = [POLLUTION, STEERING, EVOLUTION, EXPANSION_2_0, ...REST];
  const MAP_SETTINGS_2_1 = [POLLUTION, EVOLUTION, EXPANSION_2_1, ...REST];
  const is21 = (version) => version[0] > 2 || (version[0] === 2 && version[1] >= 1);
  const layoutFor = (version) => (is21(version) ? MAP_SETTINGS_2_1 : MAP_SETTINGS_2_0);

  // ---- byte reading and writing ----

  class Reader {
    constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; this.lastPos = { x: 0, y: 0 }; }
    need(n) { if (this.p + n > this.b.length) throw new Error('Map exchange string is truncated'); }
    u8() { this.need(1); return this.b[this.p++]; }
    bool() { const v = this.u8(); if (v > 1) throw new Error('Invalid map exchange string (bad boolean)'); return v === 1; }
    u16() { this.need(2); const v = this.v.getUint16(this.p, true); this.p += 2; return v; }
    i16() { this.need(2); const v = this.v.getInt16(this.p, true); this.p += 2; return v; }
    u32() { this.need(4); const v = this.v.getUint32(this.p, true); this.p += 4; return v; }
    i32() { this.need(4); const v = this.v.getInt32(this.p, true); this.p += 4; return v; }
    f32() { this.need(4); const v = this.v.getFloat32(this.p, true); this.p += 4; return v; }
    f64() { this.need(8); const v = this.v.getFloat64(this.p, true); this.p += 8; return v; }
    count() { const v = this.u8(); return v === 255 ? this.u32() : v; }
    str() { const n = this.count(); this.need(n); const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
    bytes(n) { this.need(n); const s = Array.from(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
    // Positions are 1/256 tile fixed point, written as a 16-bit delta from the
    // previous position in the stream, or 0x7fff then the absolute 32-bit pair.
    pos() {
      const dx = this.i16();
      let x, y;
      if (dx === 0x7fff) { x = this.i32(); y = this.i32(); }
      else { x = this.lastPos.x + dx; y = this.lastPos.y + this.i16(); }
      this.lastPos = { x, y };
      return { x: x / 256, y: y / 256 };
    }
  }

  class Writer {
    constructor() { this.buf = new Uint8Array(1024); this.v = new DataView(this.buf.buffer); this.p = 0; this.lastPos = { x: 0, y: 0 }; }
    grow(n) {
      if (this.p + n <= this.buf.length) return;
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.p + n)); nb.set(this.buf); this.buf = nb; this.v = new DataView(nb.buffer);
    }
    u8(x) { this.grow(1); this.buf[this.p++] = x; }
    bool(x) { this.u8(x ? 1 : 0); }
    u16(x) { this.grow(2); this.v.setUint16(this.p, x, true); this.p += 2; }
    i16(x) { this.grow(2); this.v.setInt16(this.p, x, true); this.p += 2; }
    u32(x) { this.grow(4); this.v.setUint32(this.p, x >>> 0, true); this.p += 4; }
    i32(x) { this.grow(4); this.v.setInt32(this.p, x | 0, true); this.p += 4; }
    f32(x) { this.grow(4); this.v.setFloat32(this.p, x, true); this.p += 4; }
    f64(x) { this.grow(8); this.v.setFloat64(this.p, x, true); this.p += 8; }
    count(n) { if (n < 255) this.u8(n); else { this.u8(255); this.u32(n); } }
    str(s) { const e = new TextEncoder().encode(String(s)); this.count(e.length); this.grow(e.length); this.buf.set(e, this.p); this.p += e.length; }
    bytes(a) { for (const x of a) this.u8(x); }
    pos(p) {
      const x = Math.round(p.x * 256), y = Math.round(p.y * 256);
      const dx = x - this.lastPos.x, dy = y - this.lastPos.y;
      if (Math.abs(dx) < 0x7fff && Math.abs(dy) < 0x7fff) { this.i16(dx); this.i16(dy); }
      else { this.i16(0x7fff); this.i32(x); this.i32(y); }
      this.lastPos = { x, y };
    }
    result() { return this.buf.slice(0, this.p); }
  }

  // ---- checksum and text framing ----

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- map gen settings ----

  function readFreqSizeRich(r) { return { frequency: r.f32(), size: r.f32(), richness: r.f32() }; }
  function writeFreqSizeRich(w, c) {
    w.f32(c.frequency ?? 1); w.f32(c.size ?? 1); w.f32(c.richness ?? 1);
  }
  // Maps are written sorted by key, as std::map orders them (bytewise).
  function sortedKeys(o) {
    const enc = new TextEncoder();
    return Object.keys(o || {}).sort((a, b) => {
      const x = enc.encode(a), y = enc.encode(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    });
  }

  function readMapGenSettings(r, raw) {
    const m = {};
    m.autoplace_controls = {};
    for (let n = r.count(); n > 0; n--) { const k = r.str(); m.autoplace_controls[k] = readFreqSizeRich(r); }
    m.autoplace_settings = {};
    for (let n = r.count(); n > 0; n--) {
      const kind = r.str(), s = { treat_missing_as_default: r.bool(), settings: {} };
      for (let c = r.count(); c > 0; c--) { const k = r.str(); s.settings[k] = readFreqSizeRich(r); }
      m.autoplace_settings[kind] = s;
    }
    m.default_enable_all_autoplace_controls = r.bool();
    m.seed = r.u32();
    m.width = r.u32();
    m.height = r.u32();
    raw.area_to_generate_at_start = { left_top: r.pos(), right_bottom: r.pos() };
    raw.area_extra = r.bytes(4);
    m.starting_area = r.f32();
    m.peaceful_mode = r.bool();
    m.no_enemies_mode = r.bool();
    m.starting_points = [];
    for (let n = r.count(); n > 0; n--) m.starting_points.push(r.pos());
    m.property_expression_names = {};
    for (let n = r.count(); n > 0; n--) { const k = r.str(); m.property_expression_names[k] = r.str(); }
    m.cliff_settings = {
      name: r.str(), control: r.str(), cliff_elevation_0: r.f32(), cliff_elevation_interval: r.f32(),
      cliff_smoothing: r.f32(), richness: r.f32(),
    };
    const units = r.count();
    if (units > 0) {
      const t = { units: [] };
      for (let n = units; n > 0; n--) t.units.push(r.str());
      t.territory_index_expression = r.str();
      t.territory_variation_expression = r.str();
      t.minimum_territory_size = r.u32();
      m.territory_settings = t;
    }
    return m;
  }

  // Factorio 1.1's MapGenSettings: water had its own two sliders, there was
  // no no-enemies flag, and cliffs had no control or smoothing.
  function readMapGenSettings11(r) {
    const m = { terrain_segmentation: r.f32(), water: r.f32() };
    m.autoplace_controls = {};
    for (let n = r.count(); n > 0; n--) { const k = r.str(); m.autoplace_controls[k] = readFreqSizeRich(r); }
    m.autoplace_settings = {};
    for (let n = r.count(); n > 0; n--) {
      const kind = r.str(), s = { treat_missing_as_default: r.bool(), settings: {} };
      for (let c = r.count(); c > 0; c--) { const k = r.str(); s.settings[k] = readFreqSizeRich(r); }
      m.autoplace_settings[kind] = s;
    }
    m.default_enable_all_autoplace_controls = r.bool();
    m.seed = r.u32();
    m.width = r.u32();
    m.height = r.u32();
    r.pos(); r.pos(); r.bytes(4);
    m.starting_area = r.f32();
    m.peaceful_mode = r.bool();
    m.starting_points = [];
    for (let n = r.count(); n > 0; n--) m.starting_points.push(r.pos());
    m.property_expression_names = {};
    for (let n = r.count(); n > 0; n--) { const k = r.str(); m.property_expression_names[k] = r.str(); }
    m.cliff_settings = { name: r.str(), cliff_elevation_0: r.f32(), cliff_elevation_interval: r.f32(), richness: r.f32() };
    return m;
  }

  function writeMapGenSettings(w, m, raw) {
    const apc = m.autoplace_controls || {};
    w.count(Object.keys(apc).length);
    for (const k of sortedKeys(apc)) { w.str(k); writeFreqSizeRich(w, apc[k]); }
    const aps = m.autoplace_settings || {};
    w.count(Object.keys(aps).length);
    for (const kind of sortedKeys(aps)) {
      const s = aps[kind] || {}, set = s.settings || {};
      w.str(kind); w.bool(s.treat_missing_as_default ?? false);
      w.count(Object.keys(set).length);
      for (const k of sortedKeys(set)) { w.str(k); writeFreqSizeRich(w, set[k]); }
    }
    w.bool(m.default_enable_all_autoplace_controls ?? true);
    w.u32(m.seed ?? 0);
    w.u32(m.width || 2000000);
    w.u32(m.height || 2000000);
    const area = raw.area_to_generate_at_start || DEFAULT_RAW.area_to_generate_at_start;
    w.pos(area.left_top); w.pos(area.right_bottom);
    w.bytes(raw.area_extra || DEFAULT_RAW.area_extra);
    w.f32(m.starting_area ?? 1);
    w.bool(m.peaceful_mode); w.bool(m.no_enemies_mode);
    const sp = m.starting_points || [{ x: 0, y: 0 }];
    w.count(sp.length);
    for (const p of sp) w.pos(p);
    const pen = m.property_expression_names || {};
    w.count(Object.keys(pen).length);
    for (const k of sortedKeys(pen)) { w.str(k); w.str(pen[k]); }
    const c = m.cliff_settings || {};
    w.str(c.name ?? 'cliff'); w.str(c.control ?? '');
    w.f32(c.cliff_elevation_0 ?? 10); w.f32(c.cliff_elevation_interval ?? 40);
    w.f32(c.cliff_smoothing ?? 1); w.f32(c.richness ?? 1);
    const t = m.territory_settings;
    if (t && t.units && t.units.length) {
      w.count(t.units.length);
      for (const u of t.units) w.str(u);
      w.str(t.territory_index_expression ?? ''); w.str(t.territory_variation_expression ?? '');
      w.u32(t.minimum_territory_size ?? 0);
    } else w.count(0);
  }

  // ---- map settings ----

  function readValue(r, type) {
    switch (type) {
      case D: return r.f64();
      case U: return r.u32();
      case B: return r.bool();
      case 'u8': return r.u8();
      case 'u32[]': { const a = []; for (let n = r.count(); n > 0; n--) a.push(r.u32()); return a; }
      case 'f64[]': { const a = []; for (let n = r.count(); n > 0; n--) a.push(r.f64()); return a; }
    }
    throw new Error('unknown type ' + type);
  }
  function writeValue(w, type, v) {
    switch (type) {
      case D: return w.f64(v);
      case U: return w.u32(v);
      case B: return w.bool(v);
      case 'u32[]': w.count(v.length); return v.forEach((x) => w.u32(x));
      case 'f64[]': w.count(v.length); return v.forEach((x) => w.f64(x));
    }
    throw new Error('unknown type ' + type);
  }
  function readFields(r, spec, out) {
    for (const [name, type] of spec) {
      if (Array.isArray(type)) { out[name] = {}; readFields(r, type, out[name]); }
      else if (type.startsWith('bare:')) out[name] = readValue(r, type.slice(5));
      else if (r.bool()) out[name] = readValue(r, type);
    }
    return out;
  }
  function writeFields(w, spec, obj, def) {
    obj = obj || {};
    for (const [name, type] of spec) {
      if (Array.isArray(type)) { writeFields(w, type, obj[name], def && def[name]); continue; }
      let v = obj[name];
      if (type.startsWith('bare:')) { writeValue(w, type.slice(5), v ?? (def && def[name])); continue; }
      w.bool(v !== undefined && v !== null);
      if (v !== undefined && v !== null) writeValue(w, type, v);
    }
  }

  // ---- defaults ----

  // The bytes with no settings counterpart, as the game writes them.
  const DEFAULT_RAW = {
    version: [2, 0, 77, 0],
    version_extra: 0,
    area_to_generate_at_start: { left_top: { x: -224, y: -224 }, right_bottom: { x: 224, y: 224 } },
    area_extra: [0x00, 0x00, 0x01, 0x80],
  };

  const DEFAULT_MAP_SETTINGS = {
    pollution: {
      enabled: true, diffusion_ratio: 0.02, min_to_diffuse: 15, ageing: 1, expected_max_per_chunk: 150,
      min_to_show_per_chunk: 50, min_pollution_to_damage_trees: 60, pollution_with_max_forest_damage: 150,
      pollution_per_tree_damage: 50, pollution_restored_per_tree_damage: 10, max_pollution_to_restore_trees: 20,
      enemy_attack_pollution_consumption_modifier: 1,
    },
    steering: {
      default: { radius: 1.2, separation_factor: 1.2, separation_force: 0.005, force_unit_fuzzy_goto_behavior: false },
      moving: { radius: 3, separation_factor: 3, separation_force: 0.01, force_unit_fuzzy_goto_behavior: false },
    },
    enemy_evolution: { enabled: true, time_factor: 0.000004, destroy_factor: 0.002, pollution_factor: 0.0000009 },
    enemy_expansion: {
      enabled: true, max_expansion_distance: 7, friendly_base_influence_radius: 2, enemy_building_influence_radius: 2,
      building_coefficient: 0.1, other_base_coefficient: 2, neighbouring_chunk_coefficient: 0.5,
      neighbouring_base_chunk_coefficient: 0.4, max_colliding_tiles_coefficient: 0.9, settler_group_min_size: 5,
      settler_group_max_size: 20, min_expansion_cooldown: 14400, max_expansion_cooldown: 216000,
    },
    unit_group: {
      min_group_gathering_time: 3600, max_group_gathering_time: 36000, max_wait_time_for_late_members: 7200,
      max_group_radius: 30, min_group_radius: 5, max_member_speedup_when_behind: 1.4,
      max_member_slowdown_when_ahead: 0.6, max_group_slowdown_factor: 0.3, max_group_member_fallback_factor: 3,
      member_disown_distance: 10, tick_tolerance_when_member_arrives: 60, max_gathering_unit_groups: 30,
      max_unit_group_size: 200,
    },
    path_finder: {
      fwd2bwd_ratio: 5, goal_pressure_ratio: 2, use_path_cache: true, max_steps_worked_per_tick: 1000,
      max_work_done_per_tick: 8000, short_cache_size: 5, long_cache_size: 25, short_cache_min_cacheable_distance: 10,
      short_cache_min_algo_steps_to_cache: 50, long_cache_min_cacheable_distance: 30,
      cache_max_connect_to_cache_steps_multiplier: 100, cache_accept_path_start_distance_ratio: 0.2,
      cache_accept_path_end_distance_ratio: 0.15, negative_cache_accept_path_start_distance_ratio: 0.3,
      negative_cache_accept_path_end_distance_ratio: 0.3, cache_path_start_distance_rating_multiplier: 10,
      cache_path_end_distance_rating_multiplier: 20, stale_enemy_with_same_destination_collision_penalty: 30,
      ignore_moving_enemy_collision_distance: 5, enemy_with_different_destination_collision_penalty: 30,
      general_entity_collision_penalty: 10, general_entity_subsequent_collision_penalty: 3,
      extended_collision_penalty: 3, max_clients_to_accept_any_new_request: 10,
      max_clients_to_accept_short_new_request: 100, direct_distance_to_consider_short_request: 100,
      short_request_max_steps: 1000, short_request_ratio: 0.5, min_steps_to_check_path_find_termination: 2000,
      start_to_goal_cost_multiplier_to_terminate_path_find: 2000, overload_levels: [0, 100, 500],
      overload_multipliers: [2, 3, 4], negative_path_cache_delay_interval: 20,
    },
    max_failed_behavior_count: 3,
    difficulty_settings: { technology_price_multiplier: 1, spoil_time_modifier: 1 },
    asteroids: { spawning_rate: 1, max_ray_portals_expanded_per_tick: 100 },
  };

  // 2.1 changed the expansion defaults and has no steering.
  function defaultMapSettings(version) {
    const m = JSON.parse(JSON.stringify(DEFAULT_MAP_SETTINGS));
    if (!is21(version || DEFAULT_RAW.version)) return m;
    delete m.steering;
    m.enemy_expansion = {
      enabled: true, max_expansion_distance: 5, min_expansion_distance: 3, friendly_base_influence_radius: 6,
      enemy_building_influence_radius: 3, building_coefficient: 0.5, other_base_coefficient: 3,
      neighbouring_chunk_coefficient: 0.5, neighbouring_base_chunk_coefficient: 0.5,
      max_colliding_tiles_coefficient: 0.8, settler_group_min_size: 5, settler_group_max_size: 20,
      evolution_group_size_factor: 4, min_expansion_cooldown: 14400, max_expansion_cooldown: 216000,
    };
    return m;
  }

  // ---- public API ----

  function decodeBytes(payload) {
    const r = new Reader(payload);
    const raw = { version: [r.u16(), r.u16(), r.u16(), r.u16()], version_extra: r.u8() };
    if (raw.version[0] < 2) return decode11(r, raw.version);
    const map_gen_settings = readMapGenSettings(r, raw);
    const map_settings = readFields(r, layoutFor(raw.version), {});
    if (r.p !== payload.length) throw new Error('Invalid map exchange string (' + (payload.length - r.p) + ' unread bytes)');
    return { map_gen_settings, map_settings, _raw: raw };
  }

  // A 1.1 string, read as 1.1 and then converted the way 2.0's
  // helpers.parse_map_exchange_string converts it. The result is a 2.0
  // object (with 2.0 raw bytes), so it re-exports as a 2.0 string, as the
  // game does; imported_from says where it came from.
  function decode11(r, version) {
    if (version[0] !== 1 || version[1] !== 1) {
      throw new Error('Map exchange strings from Factorio ' + version.slice(0, 3).join('.') + ' can\'t be imported; use one from 1.1 or later.');
    }
    const old = readMapGenSettings11(r);
    const oldms = readFields(r, MAP_SETTINGS_1_1, {});
    if (r.p !== r.b.length) throw new Error('Invalid map exchange string (' + (r.b.length - r.p) + ' unread bytes)');
    return Object.assign(migrate11(old, oldms), { _raw: JSON.parse(JSON.stringify(DEFAULT_RAW)), imported_from: version });
  }

  function migrate11(old, oldms) {
    const m = { autoplace_controls: {} };
    for (const k of sortedKeys(old.autoplace_controls)) {
      m.autoplace_controls[k] = migrateControl(old.autoplace_controls[k]);
    }
    // Water scale and coverage became the water control's frequency and size.
    m.autoplace_controls.water = { frequency: old.terrain_segmentation, size: old.water, richness: 1 };
    m.autoplace_settings = {};
    for (const kind of Object.keys(old.autoplace_settings)) {
      const s = old.autoplace_settings[kind], set = {};
      for (const k of Object.keys(s.settings)) set[k] = migrateControl(s.settings[k]);
      m.autoplace_settings[kind] = { treat_missing_as_default: s.treat_missing_as_default, settings: set };
    }
    m.default_enable_all_autoplace_controls = old.default_enable_all_autoplace_controls;
    m.seed = old.seed;
    m.width = old.width;
    m.height = old.height;
    m.starting_area = old.starting_area;
    m.peaceful_mode = old.peaceful_mode;
    m.no_enemies_mode = false;
    m.starting_points = old.starting_points;
    m.property_expression_names = {};
    for (const k of Object.keys(old.property_expression_names)) {
      const v = old.property_expression_names[k];
      m.property_expression_names[PROPERTY_NAMES_1_1[k] || k] = k === 'elevation' ? (ELEVATIONS_1_1[v] || v) : v;
    }
    // 1.1's default terrain is 2.0's "Lakes" map type.
    if (!('elevation' in m.property_expression_names)) m.property_expression_names.elevation = 'elevation_lakes';
    // The game keeps the cliff rows but resets continuity, even when 0 had
    // turned cliffs off.
    const c = old.cliff_settings;
    m.cliff_settings = {
      name: c.name, control: '', cliff_elevation_0: c.cliff_elevation_0, cliff_elevation_interval: c.cliff_elevation_interval,
      cliff_smoothing: 1, richness: 1,
    };

    const ms = defaultMapSettings([2, 0]);
    for (const k of Object.keys(oldms)) {
      if (k === 'difficulty_settings') ms.difficulty_settings.technology_price_multiplier = oldms.difficulty_settings.technology_price_multiplier;
      else if (typeof oldms[k] === 'object') mergeInto(ms[k], oldms[k]);
      else ms[k] = oldms[k];
    }
    return { map_gen_settings: m, map_settings: ms };
  }
  const PROPERTY_NAMES_1_1 = {
    'control-setting:moisture:frequency:multiplier': 'control:moisture:frequency',
    'control-setting:moisture:bias': 'control:moisture:bias',
    'control-setting:aux:frequency:multiplier': 'control:aux:frequency',
    'control-setting:aux:bias': 'control:aux:bias',
  };
  const ELEVATIONS_1_1 = { '0_17-island': 'elevation_island' };
  // A frequency of 0 turned a resource off in 1.1; 2.0 uses size 0 for that.
  function migrateControl(c) {
    return c.frequency === 0 ? { frequency: 1, size: 0, richness: c.richness } : { frequency: c.frequency, size: c.size, richness: c.richness };
  }
  function mergeInto(dst, src) {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) mergeInto(dst[k], src[k]);
      else dst[k] = src[k];
    }
  }

  function encodeBytes(obj) {
    const raw = Object.assign({}, DEFAULT_RAW, obj._raw || {});
    const w = new Writer();
    for (const v of raw.version) w.u16(v);
    w.u8(raw.version_extra);
    writeMapGenSettings(w, obj.map_gen_settings || {}, raw);
    const def = defaultMapSettings(raw.version);
    writeFields(w, layoutFor(raw.version), obj.map_settings || def, def);
    return w.result();
  }

  // Strip the >>> <<< frame and any whitespace a chat client added.
  function unframe(str) {
    let s = String(str).replace(/\s+/g, '');
    const a = s.indexOf('>>>'), b = s.lastIndexOf('<<<');
    if (a < 0 || b < a) throw new Error('A map exchange string starts with >>> and ends with <<<');
    return s.slice(a + 3, b);
  }

  function decode(str) {
    let data;
    try { data = pako.inflate(fromBase64(unframe(str))); }
    catch (e) { if (/>>>/.test(e.message)) throw e; throw new Error('Failed to import map exchange string.'); }
    if (data.length < 13) throw new Error('Failed to import map exchange string.');
    const body = data.subarray(0, data.length - 4);
    const want = new DataView(data.buffer, data.byteOffset + data.length - 4, 4).getUint32(0, true);
    if (crc32(body) !== want) throw new Error('Map exchange string checksum mismatch');
    return decodeBytes(body);
  }

  function encode(obj) {
    const body = encodeBytes(obj);
    const all = new Uint8Array(body.length + 4);
    all.set(body);
    new DataView(all.buffer).setUint32(body.length, crc32(body), true);
    return '>>>' + toBase64(pako.deflate(all, { level: 9 })) + '<<<';
  }

  // The JSON files the headless server takes on --create:
  // factorio --create save.zip --map-gen-settings mgs.json --map-settings ms.json
  function toServerFiles(obj) {
    const mgs = JSON.parse(JSON.stringify(obj.map_gen_settings));
    return { 'map-gen-settings.json': mgs, 'map-settings.json': JSON.parse(JSON.stringify(obj.map_settings)) };
  }

  return {
    decode, encode, decodeBytes, encodeBytes, crc32, toServerFiles,
    DEFAULT_MAP_SETTINGS, DEFAULT_RAW, defaultMapSettings, layoutFor,
  };
});
