#!/usr/bin/env python3
"""Extract what the map generator page needs from a Factorio install.

Runs the (headless) game once per mod set with a small dump mod, reads the
English locale files, and writes web/static/mapgen/gamedata.js:

  python3 tools/mapgen/extract.py /path/to/factorio [out.js] [--icons DIR]

The path is the directory holding bin/ and data/, e.g. /opt/factorio in the
factoriotools/factorio image. Only the headless build is needed for the data.

--icons DIR also copies the resource and planet icons the page shows, as
DIR/<type>/<name>.png (64x64, the first mipmap). The headless build has no
graphics, so this needs a full game install (e.g. your Steam copy). The page
ships these in web/static/mapgen/icons/ already; use this to refresh them.
Needs Pillow.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MODSETS = {
    "vanilla": ["base"],
    "space-age": ["base", "elevated-rails", "quality", "space-age"],
}
DATA_MODS = ["base", "elevated-rails", "quality", "space-age"]

# Icon file paths only exist at the data stage.
DATA_LUA = r"""
local out = {}
local function add(kind, p)
  if p.icon then out[#out + 1] = {kind, p.name, p.icon, p.icon_size or 64}
  elseif p.icons and p.icons[1] then out[#out + 1] = {kind, p.name, p.icons[1].icon, p.icons[1].icon_size or 64} end
end
for _, p in pairs(data.raw["resource"] or {}) do add("entity", p) end
-- The map generator shows planets by their starmap icons.
for _, p in pairs(data.raw["planet"] or {}) do
  if p.starmap_icon then out[#out + 1] = {"planet", p.name, p.starmap_icon, p.starmap_icon_size or 64} else add("planet", p) end
end
log("MAPGEN-ICONS:" .. serpent.line(out, {comment = false}))
"""

DUMP_LUA = r"""
script.on_init(function()
  local ok, err = pcall(function()
    local t = {controls = {}, presets = {}, planets = {}, elevation = {}}
    for name, c in pairs(prototypes.autoplace_control) do
      t.controls[name] = {order = c.order, category = c.category, richness = c.richness,
        can_be_disabled = c.can_be_disabled, localised_name = c.localised_name,
        localised_description = c.localised_description}
    end
    for name, p in pairs(prototypes.map_gen_preset) do
      t.presets[name] = {order = p.order, default = p.default or false,
        basic_settings = p.basic_settings, advanced_settings = p.advanced_settings}
    end
    for name, p in pairs(prototypes.space_location) do
      if p.type == "planet" and p.map_gen_settings then
        local controls = {}
        for c in pairs(p.map_gen_settings.autoplace_controls or {}) do controls[#controls + 1] = c end
        t.planets[name] = {order = p.order, controls = controls, localised_name = p.localised_name}
      end
    end
    for name, e in pairs(prototypes.named_noise_expression) do
      if e.intended_property == "elevation" then
        t.elevation[name] = {order = e.order, localised_name = e.localised_name}
      end
    end
    t.exchange_string = game.get_map_exchange_string()
    t.version = script.active_mods.base
    log("MAPGEN-DUMP:" .. helpers.table_to_json(t))
  end)
  if not ok then log("MAPGEN-DUMP-ERROR:" .. tostring(err)) end
end)
"""


def run_game(root, mods):
    version = subprocess.run([f"{root}/bin/x64/factorio", "--version"], capture_output=True, text=True).stdout
    major_minor = re.search(r"Version: (\d+\.\d+)", version).group(1)
    d = tempfile.mkdtemp(prefix="mapgen-extract-")
    try:
        mod = f"{d}/mods/mapgen-dump_1.0.0"
        os.makedirs(mod)
        os.makedirs(f"{d}/out")
        json.dump({"name": "mapgen-dump", "version": "1.0.0", "title": "mapgen-dump", "author": "idlewild",
                   "factorio_version": major_minor, "dependencies": ["base"]}, open(f"{mod}/info.json", "w"))
        open(f"{mod}/control.lua", "w").write(DUMP_LUA)
        open(f"{mod}/data-final-fixes.lua", "w").write(DATA_LUA)
        mod_list = [{"name": m, "enabled": m in mods} for m in DATA_MODS] + [{"name": "mapgen-dump", "enabled": True}]
        json.dump({"mods": mod_list}, open(f"{d}/mods/mod-list.json", "w"))
        open(f"{d}/config.ini", "w").write(f"[path]\nread-data={root}/data\nwrite-data={d}/out\n")
        p = subprocess.run([f"{root}/bin/x64/factorio", "-c", f"{d}/config.ini", "--mod-directory", f"{d}/mods",
                            "--create", f"{d}/out/x.zip"], capture_output=True, text=True, timeout=600)
        log = open(f"{d}/out/factorio-current.log").read()
        m = re.search(r"MAPGEN-DUMP:(.*)", log)
        if not m:
            raise SystemExit("dump failed:\n" + log[-3000:] + p.stdout[-2000:])
        dump = json.loads(m.group(1))
        icons = re.search(r"MAPGEN-ICONS:(.*)", log)
        # serpent.line output: {{"entity", "coal", "__base__/graphics/icons/coal.png", 64}, ...}
        dump["icons"] = re.findall(r'\{"([^"]+)", "([^"]+)", "([^"]+)", (\d+)\}', icons.group(1)) if icons else []
        return dump
    finally:
        shutil.rmtree(d)


def read_locale(root):
    """All English locale strings as {section: {key: text}}."""
    out = {}
    for mod in ["core"] + DATA_MODS:
        for f in sorted(glob.glob(f"{root}/data/{mod}/locale/en/*.cfg")):
            section = ""
            for line in open(f, encoding="utf-8"):
                line = line.rstrip("\r\n")
                if not line or line[0] in ";#":
                    continue
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1]
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    out.setdefault(section, {})[k] = v.replace("\\n", "\n")
    return out


def resolve(loc, ls):
    """Resolve a LocalisedString the way the game does for plain text."""
    if isinstance(ls, str):
        return ls
    if not ls:
        return ""
    if isinstance(ls, dict):  # table_to_json turns {"a","b"} into a list, but be safe
        ls = [ls[k] for k in sorted(ls, key=int)] if all(k.isdigit() for k in ls) else list(ls.values())
    key, params = ls[0], [resolve(loc, p) or "" for p in ls[1:]]
    if key == "":
        return "".join(params)
    if key == "?":
        return params[0] if params else ""
    section, _, name = key.partition(".")
    text = loc.get(section, {}).get(name)
    if text is None:
        return None
    for i, p in enumerate(params, 1):
        text = text.replace("__%d__" % i, p)
    # References like __ENTITY__iron-ore__ inside strings.
    text = re.sub(r"__(ENTITY|ITEM|TILE|FLUID|SPACE_LOCATION)__([^_]+(?:_[^_]+)*?)__",
                  lambda m: loc.get(m.group(1).lower().replace("_", "-") + "-name", {}).get(m.group(2), m.group(2)), text)
    return text


def copy_icons(root, icons, dest):
    from PIL import Image  # pip install Pillow
    copied = 0
    for kind, name, path, size in icons:
        m = re.match(r"__([^_]+(?:[-_][^_]+)*)__/(.*)", path)
        src = os.path.join(root, "data", m.group(1), m.group(2)) if m else None
        if not src or not os.path.exists(src):
            continue
        os.makedirs(os.path.join(dest, kind), exist_ok=True)
        size = int(size)
        icon = Image.open(src).crop((0, 0, size, size))
        if size != 64:
            icon = icon.resize((64, 64), Image.LANCZOS)
        icon.save(os.path.join(dest, kind, name + ".png"))
        copied += 1
    print("copied %d of %d icons to %s" % (copied, len(icons), dest))


def zero_seed(exchange_string):
    """The game picks a random seed; pin it so the output is reproducible."""
    codec = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "web", "static", "mapgen", "mapexchange.js")
    js = ("const M=require(process.argv[1]);const d=M.decode(process.argv[2]);"
          "d.map_gen_settings.seed=0;process.stdout.write(M.encode(d));")
    return subprocess.run(["node", "-e", js, codec, exchange_string], capture_output=True, text=True, check=True).stdout


def main():
    args = sys.argv[1:]
    icons_dir = None
    if "--icons" in args:
        i = args.index("--icons")
        icons_dir = args[i + 1]
        del args[i:i + 2]
    root = os.path.abspath(args[0])
    out_path = args[1] if len(args) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "..", "web", "static", "mapgen", "gamedata.js")
    all_icons = {}
    loc = read_locale(root)
    result = {"modsets": {}}
    for modset, mods in MODSETS.items():
        dump = run_game(root, mods)
        result["version"] = dump["version"]
        for kind, name, path, size in dump["icons"]:
            all_icons[(kind, name)] = (kind, name, path, size)
        controls = []
        for name, c in dump["controls"].items():
            planets = sorted((p for p, pl in dump["planets"].items() if name in pl["controls"]),
                             key=lambda p: dump["planets"][p]["order"])
            controls.append({
                "name": name, "category": c["category"], "order": c["order"], "richness": c["richness"],
                "can_be_disabled": c["can_be_disabled"], "label": resolve(loc, c["localised_name"]),
                "description": resolve(loc, c.get("localised_description")) or "",
                "planets": planets,
            })
        planets = [{"name": n, "order": p["order"], "label": resolve(loc, p["localised_name"])}
                   for n, p in dump["planets"].items()]
        presets = []
        for name, p in dump["presets"].items():
            presets.append({
                "name": name, "order": p["order"], "default": p["default"],
                "label": loc.get("map-gen-preset-name", {}).get(name, name),
                "description": loc.get("map-gen-preset-description", {}).get(name, ""),
                "basic_settings": p.get("basic_settings") or {}, "advanced_settings": p.get("advanced_settings") or {},
            })
        # The map type dropdown labels come from [noise-expression], e.g.
        # "Nauvis elevation (Default)".
        elevation = [{"name": n, "order": e["order"],
                      "label": loc.get("noise-expression", {}).get(n) or resolve(loc, e["localised_name"]) or n}
                     for n, e in dump["elevation"].items()]
        result["modsets"][modset] = {
            "controls": sorted(controls, key=lambda c: (c["order"], c["name"])),
            "planets": sorted(planets, key=lambda p: (p["order"], p["name"])),
            "presets": sorted(presets, key=lambda p: (p["order"], p["name"])),
            "elevation": sorted(elevation, key=lambda e: (e["order"], e["name"])),
            "default_exchange_string": zero_seed(dump["exchange_string"]),
        }
    # The page only needs a handful of locale sections.
    keep = ["gui-map-generator", "gui", "gui-menu", "gui-new-game"]
    result["locale"] = {s: loc[s] for s in keep if s in loc}
    with open(out_path, "w") as f:
        f.write("// Generated by tools/mapgen/extract.py from Factorio %s. Do not edit.\n" % result["version"])
        f.write("(function (root) {\n  const data = ")
        json.dump(result, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write(";\n  if (typeof module === 'object' && module.exports) module.exports = data;\n"
                "  else (root.FactorioMapGenData = root.FactorioMapGenData || {})[data.version] = data;\n"
                "})(typeof self !== 'undefined' ? self : this);\n")
    print("wrote", out_path)
    if icons_dir:
        copy_icons(root, all_icons.values(), icons_dir)


if __name__ == "__main__":
    main()
