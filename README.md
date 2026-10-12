# factorio-mapgen

Factorio's map generator window, in the browser. Pick a preset, change the
settings, see a preview of the map, and get a map exchange string.

Demo: https://frankh.github.io/factorio-mapgen/

- Imports and exports map exchange strings. Exports match the game's exactly.
  Imports 1.1, 2.0 and 2.1 strings.
- Gives you the `map-gen-settings.json` and `map-settings.json` a headless
  server needs to create the same map.
- Draws the map preview in the browser, for Nauvis and the Space Age planets.
  Drag to move around the map without limit; scroll or pinch to zoom from 8
  pixels a tile out to 64 tiles a pixel. Zoomed out it shows tiles and ore
  (tiles only past 16 tiles a pixel).

Plain JavaScript, no build step.

## Running it

Serve this directory and open `index.html`:

    python3 -m http.server

## Using it in your own page

```html
<link rel="stylesheet" href="mapgen.css">
<script src="vendor/pako.min.js"></script>
<script src="mapexchange.js"></script>
<script src="gamedata.js"></script>
<script src="mapgen-ui.js"></script>
```

```js
const gen = FactorioMapGen.mount(document.getElementById('app'), {
  data: Object.values(FactorioMapGenData)[0],
  modset: 'space-age',          // or 'vanilla'
  exchangeString: '>>>…<<<',    // optional
  onPlay(r) {
    // r.exchangeString, r.mapGenSettings, r.mapSettings
  },
  onBack() {},
});
```

`demo.js` is a full example.

## Tests

    node --test test/*.test.js

## Updating for a new Factorio version

Point the extract scripts at a Factorio install (the headless server is
enough):

    python3 tools/extract.py /path/to/factorio
    python3 tools/extract_noise.py /path/to/factorio

## License

The code is MIT. The game data (`gamedata.js`, `noisedata.js`), the icons and
the test fixtures come from Factorio and are © Wube Software. This project is
not affiliated with Wube Software.
