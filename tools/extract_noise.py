#!/usr/bin/env python3
"""Extract what the in-browser map preview needs from a Factorio install.

    python3 tools/mapgen/extract_noise.py /path/to/factorio   # writes web/static/mapgen/noisedata.js

For each mod set (vanilla, Space Age) it dumps, at the data stage:
- every noise-expression and noise-function prototype
- tiles with an autoplace: map colour, probability expression, order
- entities with an autoplace: type, map colour, autoplace, collision box
- planets' map_gen_settings
- the chart colours the preview uses
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MODSETS = {"vanilla": ["base"], "space-age": ["base", "elevated-rails", "quality", "space-age"]}
ALL_MODS = ["base", "elevated-rails", "quality", "space-age"]

LUA = r"""
local function enc(v)
  local t = type(v)
  if t == "table" then
    local n = #v
    local arr = n > 0
    if arr then for k in pairs(v) do if type(k) ~= "number" then arr = false break end end end
    local parts = {}
    if arr then
      for i = 1, n do parts[#parts + 1] = enc(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k, x in pairs(v) do if type(x) ~= "function" then keys[#keys + 1] = tostring(k) end end
    table.sort(keys)
    for _, k in ipairs(keys) do
      local x = v[k]
      if x == nil then x = v[tonumber(k)] end
      parts[#parts + 1] = string.format("%q", k) .. ":" .. enc(x)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  elseif t == "string" then return (string.format("%q", v):gsub("\\\n", "\\n"))
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.17g", v)
  elseif t == "boolean" then return tostring(v)
  else return "null" end
end
local function expr(p)
  return {expression = p.expression, local_expressions = p.local_expressions, local_functions = p.local_functions,
    parameters = p.parameters}
end
local util = data.raw["utility-constants"]["default"]
local chart = util.chart
local out = {noise_expression = {}, noise_function = {}, tile = {}, entity = {}, planet = {},
  default_collision_masks = util.default_collision_masks,
  chart = {tree = chart.default_color_by_type and chart.default_color_by_type.tree,
    enemy = chart.default_enemy_color, enemy_territory = chart.default_enemy_territory_color}}
for n, p in pairs(data.raw["noise-expression"] or {}) do out.noise_expression[n] = expr(p) end
for n, p in pairs(data.raw["noise-function"] or {}) do out.noise_function[n] = expr(p) end
for n, p in pairs(data.raw["tile"]) do
  if p.autoplace then out.tile[n] = {order = p.order, map_color = p.map_color, autoplace = p.autoplace,
    collision_mask = p.collision_mask} end
end
for tname, list in pairs(data.raw) do
  if tname ~= "tile" and tname ~= "optimized-decorative" then
    for n, p in pairs(list) do
      if type(p) == "table" and p.autoplace then
        out.entity[n] = {type = tname, autoplace = p.autoplace, map_color = p.map_color,
          enemy_map_color = p.enemy_map_color, collision_box = p.collision_box, order = p.order,
          collision_mask = p.collision_mask, flags = p.flags}
      end
    end
  end
end
for n, p in pairs(data.raw["planet"] or {}) do out.planet[n] = {map_gen_settings = p.map_gen_settings, order = p.order} end
log("NOISEDATA:" .. enc(out))
"""


def dump(root, mods):
    version = subprocess.run([f"{root}/bin/x64/factorio", "--version"], capture_output=True, text=True).stdout
    major_minor = re.search(r"Version: (\d+\.\d+)", version).group(1)
    d = tempfile.mkdtemp(prefix="mapgen-noise-")
    try:
        mod = f"{d}/mods/noise-dump_1.0.0"
        os.makedirs(mod)
        os.makedirs(f"{d}/out")
        json.dump({"name": "noise-dump", "version": "1.0.0", "title": "noise-dump", "author": "idlewild",
                   "factorio_version": major_minor, "dependencies": ["base"]}, open(f"{mod}/info.json", "w"))
        open(f"{mod}/data-final-fixes.lua", "w").write(LUA)
        mod_list = [{"name": m, "enabled": m in mods} for m in ALL_MODS] + [{"name": "noise-dump", "enabled": True}]
        json.dump({"mods": mod_list}, open(f"{d}/mods/mod-list.json", "w"))
        open(f"{d}/config.ini", "w").write(f"[path]\nread-data={root}/data\nwrite-data={d}/out\n")
        subprocess.run([f"{root}/bin/x64/factorio", "-c", f"{d}/config.ini", "--mod-directory", f"{d}/mods",
                        "--dump-data"], capture_output=True, text=True, timeout=600)
        log = open(f"{d}/out/factorio-current.log").read()
        m = re.search(r"NOISEDATA:(.*)", log)
        if not m:
            raise SystemExit("dump failed:\n" + log[-3000:])
        return json.loads(m.group(1)), re.search(r"Version: (\S+)", version).group(1)
    finally:
        shutil.rmtree(d)


def colour(c):
    """Prototype colours come as {r,g,b} or [r,g,b], in 0-1 or 0-255."""
    if c is None:
        return None
    if isinstance(c, dict):
        c = [c.get("r", 0), c.get("g", 0), c.get("b", 0), c.get("a", 1)]
    c = list(c) + [1] * (4 - len(c))
    if max(c[:3]) > 1:
        # 0-255 colours with fractions: the game truncates them.
        return [int(c[0]), int(c[1]), int(c[2]), int(c[3] * 255) if c[3] <= 1 else int(c[3])]
    return [int(c[0] * 255), int(c[1] * 255), int(c[2] * 255), int(c[3] * 255)]


def slim(data):
    """Keep only what the preview reads."""
    out = {"noise_expression": {}, "noise_function": {}, "tile": {}, "entity": {}, "planet": {}}
    drop_none = lambda d: {k: v for k, v in d.items() if v not in (None, {}, [])}
    for n, e in data["noise_expression"].items():
        out["noise_expression"][n] = drop_none(e)
    for n, e in data["noise_function"].items():
        out["noise_function"][n] = drop_none(e)
    for n, t in data["tile"].items():
        a = t["autoplace"]
        layers = sorted(((t.get("collision_mask") or {}).get("layers") or {}).keys())
        out["tile"][n] = drop_none({"order": t.get("order"), "color": colour(t["map_color"])[:3], "layers": layers,
                                    "autoplace": drop_none({k: a.get(k) for k in ("probability_expression", "local_expressions", "local_functions")})})
    for n, e in data["entity"].items():
        a = e["autoplace"]
        mask = e.get("collision_mask") or (data.get("default_collision_masks") or {}).get(e["type"]) or {}
        out["entity"][n] = drop_none({
            "type": e["type"], "order": e.get("order"), "color": colour(e.get("map_color")),
            "box": e.get("collision_box"), "layers": sorted((mask.get("layers") or {}).keys()),
            "offgrid": "placeable-off-grid" in (e.get("flags") or []) or None,
            "autoplace": drop_none({k: a.get(k) for k in ("control", "order", "force", "probability_expression",
                                                           "richness_expression", "local_expressions", "local_functions", "tile_restriction",
                                                           "placement_density")}),
        })
    for n, p in data["planet"].items():
        m = p.get("map_gen_settings")
        if m:
            out["planet"][n] = drop_none({k: m.get(k) for k in ("property_expression_names", "autoplace_controls",
                                                                "autoplace_settings", "cliff_settings")})
    out["chart"] = {k: colour(v) for k, v in data["chart"].items() if v}
    return out


def main():
    root = os.path.abspath(sys.argv[1])
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(__file__), "..", "..", "web", "static", "mapgen", "noisedata.js")
    result = {}
    version = None
    for modset, mods in MODSETS.items():
        data, version = dump(root, mods)
        result[modset] = slim(data)
    with open(out_path, "w") as f:
        f.write("// Generated by tools/mapgen/extract_noise.py from Factorio %s. Do not edit.\n" % version)
        f.write("(function (root) {\n  const data = ")
        json.dump({"version": version, "modsets": result}, f, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n  if (typeof module === 'object' && module.exports) module.exports = data;\n"
                "  else root.FactorioNoiseData = data;\n"
                "})(typeof self !== 'undefined' ? self : this);\n")
    print("wrote", out_path, os.path.getsize(out_path))


if __name__ == "__main__":
    main()
