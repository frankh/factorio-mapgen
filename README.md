# Map generator

`web/static/mapgen/` is a plain-JS copy of Factorio's **Map generator** window
(Single player → New game). It produces the same map exchange strings as the
game, imports them, and hands back the `--map-gen-settings` / `--map-settings`
files a headless server needs to create that map. The "Start a server" page
uses it (`newserver.js`); `index.html` is a standalone version.

| File | What it is |
| --- | --- |
| `mapexchange.js` | Exchange string codec (decode/encode, byte for byte), 2.0 and 2.1 layouts |
| `gamedata.js` | Presets, autoplace controls, planets, map types and English text, extracted from the game |
| `mapgen-ui.js`, `mapgen.css` | The window: preset, seed, Resources / Terrain / Enemy / Advanced tabs, import/export |
| `vendor/pako.min.js` | zlib (pako 2.1.0, MIT/Zlib). At level 9 it gives the game's exact deflate output |
| `fonts/` | Titillium Web, the game's UI font (SIL OFL) |

## Exchange string format (2.0.77)

`>>>` + base64(zlib level 9(payload + crc32(payload) as u32 LE)) + `<<<`.

The payload starts with the version as four u16s (2, 0, 77, 0) and a zero byte.
Next comes MapGenSettings:

- autoplace controls (count, then name, frequency, size and richness as f32), sorted bytewise by name
- autoplace settings
- `default_enable_all_autoplace_controls`, seed (u32), width and height (u32; 0 is written as 2000000)
- an unused starting box: two positions and 4 bytes
- `starting_area` (f32), peaceful and no-enemies flags
- starting points
- property expression names (string → string)
- cliff settings: name, control, then elevation 0, interval, smoothing and richness as f32
- territory settings, written only when there are units

MapSettings follow. Each value is a presence byte, then f64, u32 or bool, in the
order given in `mapexchange.js`. `max_failed_behavior_count` and the two
difficulty values have no presence byte.

Two encodings need care:

- Counts are one byte, or 0xFF followed by a u32.
- Positions are 1/256-tile fixed point. Each is a 16-bit delta from the previous position in the stream. If either delta reaches ±32767, the encoder writes 0x7fff and then the absolute i32 pair.

2.1 has the same layout, minus `steering`. Its `enemy_expansion` gains
`min_expansion_distance` and `evolution_group_size_factor`.

## How it was checked

All of this was checked against the real game: the 2.0.77 and 2.1.9 headless servers from the `factoriotools/factorio` image.

- **Strings the game made** (`game.get_map_exchange_string()` after `--create` with fuzzed settings) decode and re-encode byte for byte. The suite holds 108 2.0 strings and 81 2.1 strings.
- **Decoded values** match `helpers.parse_map_exchange_string`.
- **Encoding the same settings** reproduces the game's string.
- **Each preset in the page**, vanilla and Space Age, gives settings that, passed to `factorio --create --map-gen-settings … --map-settings …`, make the game report the identical string. This is what lets a server be launched from a string.
- **Against strings exported from the game's own GUI (2.1.9)**, captured by a third-party project, so not committed here, the page is byte-identical for:
  - all 9 presets
  - moisture and terrain scale/bias sliders at several positions
  - cliffs unticked
  - peaceful mode and no enemies
  - a typed seed

  Picking a preset in the GUI has two non-obvious effects, both copied here: it blanks the cliff name, and it snaps size words such as `small` to the nearest slider notch (0.75 rather than 0.707).

`test/fixtures.json` holds the game-made data. Run the suite with:

    node --test tools/mapgen/test/*.test.js

## Updating for a new Factorio version

    python3 tools/mapgen/extract.py /path/to/factorio            # writes web/static/mapgen/gamedata.js

`/path/to/factorio` is the directory holding `bin/` and `data/`; the headless
build is enough. If the version header or map settings changed, the codec's
layouts need updating too. Diff the `map-settings.example.json` files and
re-run the tests against strings from the new version.

## Looking like the game

Layout, sizes, colours, text and fonts follow the game (`core/prototypes/style.lua`,
the locale files, and in-game screenshots compared at 150% and 175% UI
scale). The icons are the game's own:

- `icons/entity/` and `icons/planet/` are the resource icons and the starmap
  planet icons the map generator shows (64x64, first mipmap).
- `icons/*.png` are the GUI glyphs (reset, shuffle, import, export, warning,
  check mark, info), cut from a 4K in-game screenshot at 175% UI scale and
  used as masks so CSS can colour them per state.

`extract.py --icons DIR` refreshes the resource and planet icons from a full
game install. The headless build has no graphics.

The slider-plus-number rows on the Enemy and Advanced tabs use ranges chosen
here, as the game's aren't in its data files; typed values are stored exactly.

## Preview

The preview is drawn in the browser, the way the game draws its own: Web
Workers (`mapgen-worker.js`) render 32x32-tile chunks from the middle
outwards, terrain first and entities second, one pixel per tile, into a
canvas the player can drag around.

| File | What it is |
| --- | --- |
| `noise.js` | The game's noise builtins, and a compiler from its noise expression strings to vectorised programs |
| `preview.js` | Tile choice, entity placement and the preview's colours |
| `noisedata.js` | Noise expressions and functions, tile and entity autoplace data, planets, chart colours (`extract_noise.py`) |

Against `factorio --generate-map-preview` at 1024x1024 (seed 987654), the
share of pixels that match exactly:

| Nauvis | Vulcanus | Gleba | Fulgora | Aquilo |
| --- | --- | --- | --- | --- |
| 99.9% | 99.3% | 99.7% | 99.8% | 99.97% |

Terrain is exact; what differs is mostly a few cliffs and entities where the
noise is off in its last bits.

### How the game does it

Worked out from the 2.0.77 headless binary (it keeps its symbols) and checked
against values the game computes (`LuaSurface.calculate_tile_properties`) and
maps it generates. `test/noise.test.js` holds a sample of those values.

- **basis_noise**: gradient noise on a unit lattice, kernel `(g·d)(1-|d|²)³`
  within radius 1, gradients of length 4.2 at one of 256 angles. The angle
  comes from four permutation tables, shuffled with taus88 (as
  `LuaRandomGenerator`, seeds below 341 count as 341) seeded with
  `seed0 + 7 * (seed1 >> 8)`; `seed1 & 255` picks the row. A string seed1
  is its CRC-32.
- **multioctave_noise**: octave k (finest first) samples
  `basis(x s / 2^k + 17.17 k, y s / 2^k)` weighted `p^(n-1-k)`, divided by the
  root of the summed squared weights.
- **quick_multioctave_noise**: octave k samples `(x + offset_x) s m_in^k`
  with seed0 `+ k * octave_seed0_shift`, weighted `m_out^k`.
- **variable_persistence_multioctave_noise**: octave j (coarsest first)
  samples `(x + offset_x) s 2^(j-n)`, weighted `2^n p^j`.
- **spot_noise**: regions of `region_size` centred on its multiples, each
  with candidate points from taus88 seeded
  `(7919 rx + 7907 ry + 7927 seed1 + 0x3fbe2c) ^ seed0`; cones of volume
  `quantity` placed by favorability until the region's target is met. See
  the comment in `noise.js`.
- **random_penalty**: one taus88 stream per evaluated batch, seeded from its
  first position, walked backwards.
- **voronoi_***: one point per cell from Bob Jenkins' integer hash of the
  cell and `seed0 + seed1`.
- `^`, `sin` and `cos` use the game's own fast approximations
  (fastapprox's `fastpow`; a polynomial sine).
- Tiles: the highest probability wins. Planets other than Nauvis use the map
  seed plus the CRC-32 of the planet's name.
- Entities (`EntityMapGenerationTask::generateEntities`): groups of equal
  autoplace order; per tile the most probable entity of the group whose
  collision mask and `tile_restriction` the tile allows; then, last tile
  first, `placement_density` draws from the chunk's taus88 stream (seeded
  `7919 cx + 7907 cy + 0x3fbe2c`) under its probability place it: resources
  (with positive richness) at the tile centre, off-grid entities at a random
  1/16-tile offset, as long as no tile under `map_generator_bounding_box`
  blocks it. A planet's `property_expression_names` can swap in its own
  `entity:<name>:probability` (and `richness`, and `tile:...`).
  `multisample` offsets count sample points, so on the cliff lattice they are
  a grid cell apart.
- Cliffs (`computeInternal`): on each chunk's lattice of `grid_size` cells,
  `cliff_elevation` (pulled towards a bilinear blend over blocks of four
  cells by `cliff_smoothing`, which is 1 unless the planet says otherwise)
  and `cliffiness`. A cell edge crosses where its ends sit either side of a
  contour (`cliff_elevation_0` plus multiples of the interval over the
  control's frequency) and their mean cliffiness is over 0.5; impossible
  cells lose edges; the rest become pieces whose orientation follows the
  crossings, kept unless a tile under the orientation's unrotated box
  collides.
- Drawing (`MapPreviewGenerator::Worker::computeEntities`): cliffs first,
  over the rotated box's bounds; then the entities, last placed first, over
  every pixel their collision box touches, mixed by `alpha + (alpha >> 7)`
  out of 256: ore on alternate 2x2 squares (unless `map_grid` is off, as for
  oil), trees as a translucent tint, rocks in their map colour. Spawners and
  worms whose `map_generator_bounding_box` meets one already drawn are left
  out, and enemies go on top of everything in the enemy colour.

### Server fallback

When the browser can't render something it posts the map gen settings to
`POST /mapgen/preview` (`internal/control/preview.go`). The control plane
renders it with the real headless game (`factorio --generate-map-preview`,
about 3 to 5 seconds) and caches the PNG. On first use it fetches the game
from the `factoriotools/factorio` image on Docker Hub, unpacking only `bin/`
and `data/`, and checks for a newer build of the tag every few hours
(`internal/mappreview`). That is why the image is Debian-based: the game needs
glibc.

`extract_noise.py /path/to/factorio` refreshes `noisedata.js`.
