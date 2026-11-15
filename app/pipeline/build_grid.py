import json
import math
import shutil
import subprocess

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

from aoi import (CACHE, CELL_M, COLS, CRS_WKT, LAT_MAX, LAT_MIN, LEFT, LON_MAX, LON_MIN, RAW, ROOT, ROWS, SITES, TOP,
                 WEB_DATA, lonlat_to_cell, to_m)
from fetch_data import TREK_DIR, trek_tile

GRID_TF = from_origin(LEFT, TOP, CELL_M, CELL_M)
HORIZON_KM = 1.0
AZIMUTHS = 16
ANTENNA_H_M, ASTRONAUT_H_M = 3.0, 2.0
TRAVERSE_CONFIDENCE_RADIUS_M = 60.0
DEFAULT_WEIGHTS = {"energy": 1, "risk": 1, "comms": 0.5, "radiation": 0.5, "science": 1}
HIRISE_Z, HIRISE_PX_PER_CELL = 15, 15
LAYER_DP = {"elevation_m": 1, "slope_deg": 1, "thermal_inertia": 2, "thermal_inertia_si": 0, "science": 2, "svf": 2,
            "viewshed": 0, "viewshed_relay": 0, "confidence": 2, "geo_unit": 0}

GEO_UNITS = [
    ("Njf", "#8c7b6b", "Suelo del cráter", "Crater floor",
     "Llanura del fondo del cráter, con cráteres y grietas.", "Plain of the crater floor, cratered and fractured."),
    ("NHjf2", "#7a5c8e", "Delta de Jezero", "Jezero delta",
     "Abanico de sedimentos depositado por el agua donde el río antiguo entraba en el cráter.",
     "Fan of sediments laid down by water where the ancient river entered the crater."),
    ("Nue", "#b5835a", "Roca grabada del borde", "Etched rim rock",
     "Roca dura y rugosa del borde norte, de ceniza volcánica o sedimento.",
     "Hard, rugged rock on the northern rim, volcanic ash or sediment."),
    ("cr", "#5f6b73", "Borde del cráter", "Crater rim",
     "Escarpes altos de roca levantada por el impacto.", "High scarps of rock uplifted by the impact."),
    ("Aeb", "#c9a66b", "Dunas y arena", "Dunes and sand",
     "Ondulaciones y dunas de arena suelta: riesgo de hundirse y gastar más energía.",
     "Ridges and dunes of loose sand: risk of sinking and higher energy cost."),
    ("Nnp1", "#4a6670", "Corteza antigua", "Ancient crust",
     "La roca más antigua de la zona, en afloramientos rugosos.", "The oldest rock in the area, in rugged outcrops."),
    ("su", "#a69aa8", "Ladera suave", "Smooth slope",
     "Material liso acumulado en las laderas del cráter.", "Smooth material that has built up on crater slopes."),
]

NODE_ROUTE = """
import { readFileSync } from "node:fs";
const { energyGrid, planningGrid, dijkstra, shortestPath } = await import(process.argv[1]);
const g = JSON.parse(readFileSync(0, "utf8"));
const layers = Object.fromEntries(Object.entries(g.layers).map(([k, v]) => [k, Float32Array.from(v)]));
const energy = energyGrid(layers, g.cell_m, g.cfg);
const route = shortestPath(planningGrid(energy, layers, g.weights), g.rows, g.cols, g.start, g.goal);
const ds = dijkstra(energy, g.rows, g.cols, g.start).dist, dg = dijkstra(energy, g.rows, g.cols, g.goal).dist;
// A relay site is usable only if start -> site -> goal still passes the app's safe rule: (budget - out) * (1 - margin) >= return(goal -> start)
const maxOut = g.cfg.eva_energy_budget_j - dg[g.start] / (1 - g.cfg.return_margin);
console.log(JSON.stringify({ route, reach: [...ds].flatMap((d, i) => (d + dg[i] <= maxOut ? [i] : [])) }));
"""

CRISM_CLASSES = {
    "Mg-carbonate":      ((0, 255, 0), (0, 153, 0), 1.0),
    "Carbonate+2.2µm":   ((255, 215, 0), (153, 129, 0), 1.0),
    "Fe/Mg-smectite":    ((0, 255, 255), (0, 153, 153), 0.9),
    "Mg-smectite 2":     ((0, 0, 255), (0, 0, 153), 0.9),
    "Kaolinite":         ((139, 69, 19), (83, 41, 11), 0.8),
    "Olv.smect+2.2µm":   ((128, 128, 0), (77, 77, 0), 0.7),
    "Olivine+smectite":  ((255, 128, 114), (153, 77, 68), 0.6),
    "Olivine":           ((255, 0, 0), (153, 0, 0), 0.4),
    "High-Ca pyroxene":  ((255, 128, 0), (153, 77, 0), 0.2),
    "Low-Ca pyroxene":   ((218, 165, 32), (130, 99, 19), 0.2),
}
MEDIUM_CONFIDENCE_FACTOR = 0.6


def to_grid(src_path, resampling, band=1, shape=(ROWS, COLS), transform=GRID_TF) -> np.ndarray:
    out = np.full(shape, np.nan, dtype="float32")
    with rasterio.open(src_path) as src:
        reproject(rasterio.band(src, band), out, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=transform, dst_crs=CRS_WKT, resampling=resampling)
    return out


def fill_nan(a: np.ndarray) -> np.ndarray:
    return np.where(np.isnan(a), np.nanmedian(a), a)


def dtm_layers() -> tuple[np.ndarray, np.ndarray]:
    with rasterio.open(RAW / "dtm_aoi_1m.tif") as src:
        z = src.read(1, masked=True).filled(np.nan).astype("float32")
        z[z < -1e5] = np.nan
        dy, dx = np.gradient(z, src.res[1], src.res[0])
        slope1m = np.degrees(np.arctan(np.hypot(dx, dy))).astype("float32")
        profile = src.profile | {"dtype": "float32", "nodata": np.nan, "count": 1}
    slope_path = RAW / "slope_1m.tif"
    with rasterio.open(slope_path, "w", **profile) as dst:
        dst.write(slope1m, 1)
    elev = to_grid(RAW / "dtm_aoi_1m.tif", Resampling.average)
    slope = to_grid(slope_path, Resampling.q3)
    return fill_nan(elev), fill_nan(slope)


def sky_view_factor(elev: np.ndarray) -> np.ndarray:
    steps = int(HORIZON_KM * 1000 / CELL_M)
    pad = np.pad(elev, steps, constant_values=-np.inf)
    sin_sum = np.zeros_like(elev)
    for k in range(AZIMUTHS):
        az = 2 * math.pi * k / AZIMUTHS
        best = np.zeros_like(elev)
        for s in range(1, steps + 1):
            dr, dc = round(-s * math.cos(az)), round(s * math.sin(az))
            dist = math.hypot(dr, dc) * CELL_M
            if dist == 0:
                continue
            shifted = pad[steps + dr: steps + dr + ROWS, steps + dc: steps + dc + COLS]
            best = np.maximum(best, (shifted - elev) / dist)
        sin_sum += np.sin(np.arctan(best))
    return np.clip(1 - sin_sum / AZIMUTHS, 0, 1)


def visible(elev: np.ndarray, r0: int, c0: int, r: int, c: int) -> bool:
    n = max(abs(r - r0), abs(c - c0))
    if n <= 1:
        return True
    h0 = elev[r0, c0] + ANTENNA_H_M
    t = np.arange(1, n) / n
    rr, cc = np.rint(r0 + t * (r - r0)).astype(int), np.rint(c0 + t * (c - c0)).astype(int)
    return bool((elev[r, c] + ASTRONAUT_H_M - h0) / n >= np.max((elev[rr, cc] - h0) / (t * n)))


def viewshed(elev: np.ndarray, obs: tuple[int, int]) -> np.ndarray:
    return np.array([[visible(elev, *obs, r, c) for c in range(COLS)] for r in range(ROWS)], dtype="float32")


def thermal_inertia() -> np.ndarray:
    ti = fill_nan(to_grid(RAW / "themis_ti_aoi_100m.tif", Resampling.bilinear))
    return np.clip((ti - 150) / (600 - 150), 0, 1), ti


def crism_science() -> tuple[np.ndarray, np.ndarray]:
    rgb = np.stack([to_grid(RAW / "crism_jezero_minerals.tif", Resampling.nearest, band=b) for b in (1, 2, 3)], -1)
    score = np.zeros((ROWS, COLS), dtype="float32")
    covered = ~np.isnan(rgb).any(-1)
    for high, medium, value in CRISM_CLASSES.values():
        score[(rgb == high).all(-1)] = value
        score[(rgb == medium).all(-1)] = value * MEDIUM_CONFIDENCE_FACTOR
    return score, covered


def site_boost(score: np.ndarray) -> np.ndarray:
    rr, cc = np.mgrid[0:ROWS, 0:COLS]
    out = score.copy()
    for s in SITES.values():
        r, c = lonlat_to_cell(s["lon"], s["lat"])
        out = np.maximum(out, np.exp(-((rr - r) ** 2 + (cc - c) ** 2) * CELL_M**2 / (2 * 100.0**2)))
    return out


def traverse_cells() -> list[list[int]]:
    feats = json.loads((RAW / "M20_traverse.json").read_text())["features"]
    cells: list[list[int]] = []
    for f in feats:
        g = f["geometry"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for line in lines:
            for lon, lat, *_ in line:
                r, c = lonlat_to_cell(lon, lat)
                if 0 <= r < ROWS and 0 <= c < COLS and (not cells or cells[-1] != [r, c]):
                    cells.append([r, c])
    return cells


def confidence(trav: list[list[int]], crism_covered: np.ndarray) -> np.ndarray:
    conf = np.where(crism_covered, 0.5, 0.3).astype("float32")
    near = np.zeros((ROWS, COLS), dtype=bool)
    k = int(TRAVERSE_CONFIDENCE_RADIUS_M // CELL_M)
    for r, c in trav:
        near[max(0, r - k): r + k + 1, max(0, c - k): c + k + 1] = True
    conf[near] = 1.0
    return conf


def hirise_background() -> None:
    (r0, c0), (r1, c1) = trek_tile(HIRISE_Z, LON_MIN, LAT_MAX), trek_tile(HIRISE_Z, LON_MAX, LAT_MIN)
    mosaic = Image.new("L", ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            mosaic.paste(Image.open(TREK_DIR / str(HIRISE_Z) / str(r) / f"{c}.png").convert("L"), ((c - c0) * 256, (r - r0) * 256))
    ppd = 256 * 2**HIRISE_Z / 180
    box = ((LON_MIN + 180) * ppd - c0 * 256, (90 - LAT_MAX) * ppd - r0 * 256,
           (LON_MAX + 180) * ppd - c0 * 256, (90 - LAT_MIN) * ppd - r0 * 256)
    size = (COLS * HIRISE_PX_PER_CELL, ROWS * HIRISE_PX_PER_CELL)
    mosaic.resize(size, Image.LANCZOS, box=box).save(WEB_DATA / "hirise_aoi.webp", quality=72, method=6)


def geo_unit_layer() -> np.ndarray:
    code = {u[0]: i + 1 for i, u in enumerate(GEO_UNITS)}
    shapes = []
    for f in json.loads((CACHE / "sim3464_units.geojson").read_text())["features"]:
        poly = {"type": "Polygon", "coordinates": [[(to_m(x), to_m(y)) for x, y in ring] for ring in f["geometry"]["coordinates"]]}
        shapes.append((poly, code[f["properties"]["symbol"]]))
    return rasterize(shapes, out_shape=(ROWS, COLS), transform=GRID_TF, fill=0, dtype="uint8").astype("float32")


def geounits_json() -> None:
    out = [{"id": i + 1, "symbol": s, "name_es": ne, "name_en": nn, "plain_es": pe, "plain_en": pn}
           for i, (s, col, ne, nn, pe, pn) in enumerate(GEO_UNITS)]
    (WEB_DATA / "geounits.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))


def default_route(layers: dict[str, np.ndarray], cfg: dict, start: int, goal: int) -> tuple[list[int], np.ndarray]:
    payload = {"layers": {k: v.ravel().tolist() for k, v in layers.items()}, "cfg": cfg, "cell_m": CELL_M, "rows": ROWS,
               "cols": COLS, "start": start, "goal": goal, "weights": DEFAULT_WEIGHTS}
    out = subprocess.run(["node", "--input-type=module", "-e", NODE_ROUTE, (ROOT / "web" / "pathfind.js").as_uri()],
                         input=json.dumps(payload), capture_output=True, text=True, check=True).stdout
    res = json.loads(out)
    return res["route"], np.array(res["reach"])


def place_relay(elev: np.ndarray, route: list[int], reach: np.ndarray, base_vis: np.ndarray) -> tuple[int, int]:
    todo = [(i // COLS, i % COLS) for i in route if not base_vis[i // COLS, i % COLS]]
    walkable = set(map(int, reach))
    gain = lambda rc: sum(visible(elev, *rc, tr, tc) for tr, tc in todo)
    r, c = max(((i // COLS, i % COLS) for i in walkable if (i // COLS) % 2 == 0 and (i % COLS) % 2 == 0), key=gain)
    near = [(r + dr, c + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1)
            if 0 <= r + dr < ROWS and 0 <= c + dc < COLS and (r + dr) * COLS + c + dc in walkable]
    return max(near, key=gain)


def validation(slope: np.ndarray, trav: list[list[int]], cfg: dict) -> dict:
    pairs = []
    for f in json.loads((RAW / "M20_waypoints.json").read_text())["features"]:
        p = f["properties"]
        r, c = lonlat_to_cell(p["lon"], p["lat"])
        if 0 <= r < ROWS and 0 <= c < COLS and p.get("tilt") is not None:
            pairs.append([round(float(slope[r, c]), 1), round(float(p["tilt"]), 1)])
    model, rover = np.array(pairs).T
    ok = sum(slope[r, c] <= cfg["max_slope_deg"] for r, c in trav)
    return {"n": len(pairs), "r": round(float(np.corrcoef(model, rover)[0, 1]), 2), "pairs": pairs,
            "model": "slope_deg of the 20 m grid (75th percentile of 1 m slopes per cell)",
            "rover": "tilt of the Perseverance IMU at the end of each drive (M20_waypoints)",
            "traversable_pct": round(100 * ok / len(trav), 1), "traverse_cells": len(trav),
            "max_slope_deg": cfg["max_slope_deg"]}


def pack(v: np.ndarray, dp: int) -> list:
    return [int(x) if x.is_integer() else x for x in np.round(v.astype("float64"), dp).ravel().tolist()]


def credits() -> dict:
    nasa_trek = "https://trek.nasa.gov/mars/"
    usgs = "NASA/JPL-Caltech/USGS Astrogeology Science Center"
    items = [
        {"id": "hirise", "what": "Map background: HiRISE 25 cm orthomosaic, greyscale crop of Mars Trek z15 tiles",
         "files": ["hirise_aoi.webp"], "credit": "NASA/JPL-Caltech/UArizona/USGS Astrogeology, via NASA Mars Trek",
         "url": nasa_trek, "doi": "10.5066/P9QJDP48"},
        {"id": "dtm", "what": "Elevation, slope, sky view factor, viewsheds, roughness, a large-rock proxy and closed depressions derived from the HiRISE 1 m DTM",
         "files": ["jezero_cost_grid.json: elevation_m, slope_deg, svf, viewshed, viewshed_relay",
                   "terrain_extra.json: rough_m, rocks (proxy), craters (closed depressions; build_terrain.py)"],
         "credit": f"{usgs} (Fergason et al. 2020, Mars 2020 TRN HiRISE DTM mosaic)",
         "url": "https://doi.org/10.5066/P9REJ9JN", "doi": "10.5066/P9REJ9JN"},
        {"id": "themis", "what": "Thermal inertia (sand vs bedrock)", "files": ["jezero_cost_grid.json: thermal_inertia, thermal_inertia_si"],
         "credit": "NASA/JPL-Caltech/ASU, Mars Odyssey THEMIS global thermal inertia mosaic, USGS Astropedia",
         "url": "https://asc-astropedia.s3.us-west-2.amazonaws.com/Mars/Odyssey/THEMIS-Global-Thermal-Inertia-Mosaic/"},
        {"id": "crism", "what": "Mineral map used as the science score", "files": ["jezero_cost_grid.json: science"],
         "credit": "Parente, Saranathan, Itoh, Tarnas, Seelos, Mustard et al. (2021), Map of the dominant mineralogy over and around the Mars2020 landing ellipse with correspondent spectral signatures",
         "url": "https://doi.org/10.5281/zenodo.5575824", "doi": "10.5281/zenodo.5575824"},
        {"id": "geology", "what": "Geologic units (7 in the AOI), rasterised",
         "files": ["jezero_cost_grid.json: geo_unit", "geounits.json"],
         "credit": "Sun & Stack (2020), Geologic map of Jezero crater and the Nili Planum region, Mars, USGS SIM 3464",
         "url": "https://pubs.usgs.gov/sim/3464/", "doi": "10.3133/sim3464"},
        {"id": "m20", "what": "Perseverance traverse and waypoints (validation, confidence). Three Forks start: approximate, ±50 m (depot centre estimated from sol 681/693 waypoints; NASA publishes no depot coordinates). Validation: n = 357 waypoints (not independent), traverse cells = 1272 line vertices incl. revisits",
         "files": ["traverse_cells.json", "validation.json", "jezero_cost_grid.json: confidence"],
         "credit": "NASA/JPL-Caltech, Mars 2020 MMGIS",
         "url": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"},
        {"id": "donki", "what": "CME arrivals at Mars, May 2024 (WSA-ENLIL). Rows are simulation runs, several repeat the same CME: cite only the arrival used, sim 30979, 2024-05-20T07:52Z", "files": ["donki_mars_2024-05.json"],
         "credit": "NASA GSFC Community Coordinated Modeling Center, DONKI", "url": "https://ccmc.gsfc.nasa.gov/tools/DONKI/"},
        {"id": "rad", "what": "Dose of the 20 May 2024 solar storm measured by Curiosity RAD at Gale (8,100 µGy)",
         "files": ["mission_config.json: radiation"], "credit": "NASA/JPL-Caltech, Curiosity Radiation Assessment Detector",
         "url": "https://www.nasa.gov/solar-system/planets/mars/nasa-watches-mars-light-up-during-epic-solar-storm"},
        {"id": "meda", "what": "Air temperature and EVA window, sol 1210", "files": ["meda_sol1210.json"],
         "credit": "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU",
         "url": "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_derived_env/sol_1140_1259/sol_1210/"},
        {"id": "science", "what": "Destination science summary and citation", "files": ["science.json"],
         "credit": "Hurowitz et al. (2025), Nature 645, 332-340", "url": "https://doi.org/10.1038/s41586-025-09413-0",
         "doi": "10.1038/s41586-025-09413-0"},
        {"id": "pov", "what": "Perseverance photographs", "files": ["pov/*.webp"],
         "credit": "NASA/JPL-Caltech (MSSS, ASU where noted); exact credit, date and source per photo in pov/pov.json",
         "url": "https://photojournal.jpl.nasa.gov/"},
    ]
    return {"note": "Data credit only; no NASA insignia. Derived layers are computed by Ariadne.", "items": items}


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((WEB_DATA / "mission_config.json").read_text())
    elev, slope = dtm_layers()
    print("dtm ok")
    ti_norm, ti_raw = thermal_inertia()
    science, crism_covered = crism_science()
    trav = traverse_cells()
    sites = {k: {**v, "cell": lonlat_to_cell(v["lon"], v["lat"])} for k, v in SITES.items()}
    hab, goal = sites["three_forks"]["cell"], sites["cheyava_falls"]["cell"]
    svf = sky_view_factor(elev)
    print("svf ok")
    vis = viewshed(elev, hab)
    print("viewshed ok")
    layers = {
        "elevation_m": elev, "slope_deg": slope, "thermal_inertia": ti_norm, "thermal_inertia_si": ti_raw,
        "science": site_boost(science), "svf": svf, "viewshed": vis,
        "confidence": confidence(trav, crism_covered), "geo_unit": geo_unit_layer(),
    }
    rounded = {k: np.round(v.astype("float64"), LAYER_DP[k]) for k, v in layers.items()}
    route, reach = default_route({**rounded, "viewshed_relay": np.zeros((ROWS, COLS))}, cfg, hab[0] * COLS + hab[1], goal[0] * COLS + goal[1])
    assert route, "no default route"
    relay = place_relay(elev, route, reach, vis)
    rounded["viewshed_relay"] = viewshed(elev, relay)
    cov = lambda m: round(100 * float(np.mean([m[i // COLS, i % COLS] > 0 for i in route])), 1)
    union = np.maximum(rounded["viewshed"], rounded["viewshed_relay"])
    meta_relay = {"cell": list(relay), "coverage_before_pct": cov(rounded["viewshed"]), "coverage_after_pct": cov(union),
                  "route_cells": len(route), "antenna_m": ANTENNA_H_M}
    print("relay", meta_relay)
    payload = {
        "meta": {"rows": ROWS, "cols": COLS, "cell_m": CELL_M, "source": "HiRISE DTM · THEMIS TI · CRISM · USGS SIM 3464 · M20",
                 "order": "row-major, row 0 = north", "crs": "Mars 2000 sphere, equirectangular lon0 latTs0",
                 "origin_m": [LEFT, TOP], "sites": sites, "relay": meta_relay},
        "layers": {k: pack(v, LAYER_DP[k]) for k, v in rounded.items()},
    }
    (WEB_DATA / "jezero_cost_grid.json").write_text(json.dumps(payload, separators=(",", ":")))
    (WEB_DATA / "traverse_cells.json").write_text(json.dumps(trav, separators=(",", ":")))
    (WEB_DATA / "validation.json").write_text(json.dumps(validation(rounded["slope_deg"], trav, cfg), separators=(",", ":")))
    geounits_json()
    (WEB_DATA / "credits.json").write_text(json.dumps(credits(), ensure_ascii=False, indent=1))
    hirise_background()
    (WEB_DATA / "ctx_aoi.png").unlink(missing_ok=True)
    (WEB_DATA / "donki_sep_2024-05.json").unlink(missing_ok=True)
    shutil.copy(CACHE / "donki_mars_2024-05.json", WEB_DATA / "donki_mars_2024-05.json")
    for k, v in rounded.items():
        print(f"  {k:20s} min {np.nanmin(v):9.2f}  max {np.nanmax(v):9.2f}  mean {np.nanmean(v):9.2f}")
    print(f"grid {ROWS}×{COLS} · traverse cells {len(trav)} · sites {sites}")


if __name__ == "__main__":
    main()
