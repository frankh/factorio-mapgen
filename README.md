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

The Preview button posts the map gen settings to `POST /mapgen/preview`
(`internal/control/preview.go`). The control plane renders it with the real
headless game (`factorio --generate-map-preview`, about 3 to 5 seconds) and
caches the PNG. On first use it fetches the game from the
`factoriotools/factorio` image on Docker Hub, unpacking only `bin/` and
`data/`, and checks for a newer build of the tag every few hours
(`internal/mappreview`). That is why the image is Debian-based: the game needs
glibc.
