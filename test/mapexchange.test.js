// Checks web/static/mapgen/mapexchange.js against strings and settings the
// real game produced (see fixtures.json). Run: node --test tools/mapgen/test/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const MX = require(path.join(__dirname, '../../../web/static/mapgen/mapexchange.js'));
const fx = require('./fixtures.json');

// The game's parser fills in absent autoplace controls with 1/1/1 and widens
// floats to doubles, so compare with that in mind.
function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = b[k];
      if (a[k] === undefined && d && d.frequency === 1 && d.size === 1 && d.richness === 1) continue;
      if (!same(a[k], b[k])) return false;
    }
    return true;
  }
  return a === b;
}

test('decode then encode gives back the game\'s 2.0 strings byte for byte', () => {
  for (const s of fx.roundtrip_2_0) assert.strictEqual(MX.encode(MX.decode(s)), s);
});

test('decode then encode gives back the game\'s 2.1 strings byte for byte', () => {
  for (const s of fx.roundtrip_2_1) assert.strictEqual(MX.encode(MX.decode(s)), s);
});

test('decoded values match helpers.parse_map_exchange_string', () => {
  for (const { string, parsed } of fx.game_parse_2_0) {
    const d = MX.decode(string);
    assert.ok(same({ map_gen_settings: d.map_gen_settings, map_settings: d.map_settings }, parsed), string.slice(0, 40));
  }
});

test('encoding settings gives the string the game makes from the same settings', () => {
  for (const { map_gen_settings, map_settings, string } of fx.encode_from_settings_2_0) {
    assert.strictEqual(MX.encode({ map_gen_settings, map_settings }), string);
  }
});

test('the map generator page\'s settings recreate its string on a server', () => {
  // Each string came from the page; the game was then started with
  // --create --map-gen-settings/--map-settings from the same object and
  // reported the identical string.
  for (const f of fx.server_created_from_ui_2_0) {
    const files = MX.toServerFiles(MX.decode(f.string));
    assert.ok(same(files['map-gen-settings.json'], f.map_gen_settings), f.preset);
    assert.ok(same(files['map-settings.json'], f.map_settings), f.preset);
  }
});

test('bad input is rejected with a readable error', () => {
  assert.throws(() => MX.decode('hello'), />>>/);
  assert.throws(() => MX.decode('>>>abc<<<'));
  const s = fx.roundtrip_2_0[0];
  const broken = s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);
  assert.throws(() => MX.decode(broken));
});

test('whitespace and line breaks pasted into a string are ignored', () => {
  const s = fx.roundtrip_2_0[0];
  const wrapped = s.replace(/(.{60})/g, '$1\n  ');
  assert.strictEqual(MX.encode(MX.decode(wrapped)), s);
});
