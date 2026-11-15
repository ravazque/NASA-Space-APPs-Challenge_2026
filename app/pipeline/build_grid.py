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

from aoi import (
    CACHE,
    CELL_M,
    COLS,
    CRS_WKT,
    LAT_MAX,
    LAT_MIN,
    LEFT,
    LON_MAX,
    LON_MIN,
    RAW,
    ROOT,
    ROWS,
    SITES,
    TOP,
    WEB_DATA,
    lonlat_to_cell,
    to_m,
)
from fetch_data import TREK_DIR, trek_tile

GRID_TF = from_origin(LEFT, TOP, CELL_M, CELL_M)
HORIZON_KM = 1.0
AZIMUTHS = 16
ANTENNA_H_M = 3.0
ASTRONAUT_H_M = 2.0
TRAVERSE_CONFIDENCE_RADIUS_M = 60.0
SCIENCE_SITE_SIGMA_M = 100.0
DEFAULT_WEIGHTS = {"energy": 1, "risk": 1, "comms": 0.5, "radiation": 0.5, "science": 1}
HIRISE_Z = 15
HIRISE_PX_PER_CELL = 15
TILE_PX = 256
NODATA_BELOW = -1e5
TI_MIN = 150
TI_MAX = 600
LAYER_DP = {
    "elevation_m": 1,
    "slope_deg": 1,
    "thermal_inertia": 2,
    "thermal_inertia_si": 0,
    "science": 2,
    "svf": 2,
    "viewshed": 0,
    "viewshed_relay": 0,
    "confidence": 2,
    "geo_unit": 0,
}

GEO_UNITS = [
    (
        "Njf", "#8c7b6b", "Suelo del cráter", "Crater floor",
        "Llanura del fondo del cráter, con cráteres y grietas.",
        "Plain of the crater floor, cratered and fractured.",
    ),
    (
        "NHjf2", "#7a5c8e", "Delta de Jezero", "Jezero delta",
        "Abanico de sedimentos depositado por el agua donde el río antiguo entraba en el cráter.",
        "Fan of sediments laid down by water where the ancient river entered the crater.",
    ),
    (
        "Nue", "#b5835a", "Roca grabada del borde", "Etched rim rock",
        "Roca dura y rugosa del borde norte, de ceniza volcánica o sedimento.",
        "Hard, rugged rock on the northern rim, volcanic ash or sediment.",
    ),
    (
        "cr", "#5f6b73", "Borde del cráter", "Crater rim",
        "Escarpes altos de roca levantada por el impacto.",
        "High scarps of rock uplifted by the impact.",
    ),
    (
        "Aeb", "#c9a66b", "Dunas y arena", "Dunes and sand",
        "Ondulaciones y dunas de arena suelta: riesgo de hundirse y gastar más energía.",
        "Ridges and dunes of loose sand: risk of sinking and higher energy cost.",
    ),
    (
        "Nnp1", "#4a6670", "Corteza antigua", "Ancient crust",
        "La roca más antigua de la zona, en afloramientos rugosos.",
        "The oldest rock in the area, in rugged outcrops.",
    ),
    (
        "su", "#a69aa8", "Ladera suave", "Smooth slope",
        "Material liso acumulado en las laderas del cráter.",
        "Smooth material that has built up on crater slopes.",
    ),
]

NODE_ROUTE = """
import { readFileSync } from "node:fs";
const { energyGrid, planningGrid, dijkstra, shortestPath } = await import(process.argv[1]);
const g = JSON.parse(readFileSync(0, "utf8"));
const layers = Object.fromEntries(
  Object.entries(g.layers).map(([name, values]) => [name, Float32Array.from(values)])
);
const energy = energyGrid(layers, g.cell_m, g.cfg);
const route = shortestPath(
  planningGrid(energy, layers, g.weights), g.rows, g.cols, g.start, g.goal
);
const fromStart = dijkstra(energy, g.rows, g.cols, g.start).dist;
const fromGoal = dijkstra(energy, g.rows, g.cols, g.goal).dist;
// A relay site is usable only if start -> site -> goal still passes the app's safe rule:
// (budget - out) * (1 - margin) >= return(goal -> start)
const maxOut = g.cfg.eva_energy_budget_j - fromGoal[g.start] / (1 - g.cfg.return_margin);
const reach = [];
fromStart.forEach((d, i) => {
  if (d + fromGoal[i] <= maxOut) reach.push(i);
});
console.log(JSON.stringify({ route, reach }));
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
        reproject(
            rasterio.band(src, band),
            out,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
            dst_transform=transform,
            dst_crs=CRS_WKT,
            resampling=resampling,
        )
    return out


def fill_nan(a: np.ndarray) -> np.ndarray:
    return np.where(np.isnan(a), np.nanmedian(a), a)


def dtm_layers() -> tuple[np.ndarray, np.ndarray]:
    dtm_path = RAW / "dtm_aoi_1m.tif"
    slope_path = RAW / "slope_1m.tif"

    with rasterio.open(dtm_path) as src:
        z = src.read(1, masked=True).filled(np.nan).astype("float32")
        z[z < NODATA_BELOW] = np.nan
        dy, dx = np.gradient(z, src.res[1], src.res[0])
        slope_1m = np.degrees(np.arctan(np.hypot(dx, dy))).astype("float32")
        profile = src.profile | {"dtype": "float32", "nodata": np.nan, "count": 1}

    with rasterio.open(slope_path, "w", **profile) as dst:
        dst.write(slope_1m, 1)

    elevation = to_grid(dtm_path, Resampling.average)
    slope = to_grid(slope_path, Resampling.q3)
    return fill_nan(elevation), fill_nan(slope)


def sky_view_factor(elevation: np.ndarray) -> np.ndarray:
    steps = int(HORIZON_KM * 1000 / CELL_M)
    padded = np.pad(elevation, steps, constant_values=-np.inf)
    sin_sum = np.zeros_like(elevation)
    for k in range(AZIMUTHS):
        azimuth = 2 * math.pi * k / AZIMUTHS
        max_tangent = np.zeros_like(elevation)
        for step in range(1, steps + 1):
            d_row = round(-step * math.cos(azimuth))
            d_col = round(step * math.sin(azimuth))
            distance = math.hypot(d_row, d_col) * CELL_M
            if distance == 0:
                continue
            row_start = steps + d_row
            col_start = steps + d_col
            shifted = padded[row_start:row_start + ROWS, col_start:col_start + COLS]
            max_tangent = np.maximum(max_tangent, (shifted - elevation) / distance)
        sin_sum += np.sin(np.arctan(max_tangent))
    return np.clip(1 - sin_sum / AZIMUTHS, 0, 1)


def visible(elevation: np.ndarray, r0: int, c0: int, r: int, c: int) -> bool:
    n = max(abs(r - r0), abs(c - c0))
    if n <= 1:
        return True
    antenna_z = elevation[r0, c0] + ANTENNA_H_M
    t = np.arange(1, n) / n
    rows = np.rint(r0 + t * (r - r0)).astype(int)
    cols = np.rint(c0 + t * (c - c0)).astype(int)
    target_tangent = (elevation[r, c] + ASTRONAUT_H_M - antenna_z) / n
    blocking_tangent = np.max((elevation[rows, cols] - antenna_z) / (t * n))
    return bool(target_tangent >= blocking_tangent)


def viewshed(elevation: np.ndarray, observer: tuple[int, int]) -> np.ndarray:
    result = np.zeros((ROWS, COLS), dtype="float32")
    for r in range(ROWS):
        for c in range(COLS):
            result[r, c] = visible(elevation, *observer, r, c)
    return result


def thermal_inertia() -> tuple[np.ndarray, np.ndarray]:
    raw = fill_nan(to_grid(RAW / "themis_ti_aoi_100m.tif", Resampling.bilinear))
    normalized = np.clip((raw - TI_MIN) / (TI_MAX - TI_MIN), 0, 1)
    return normalized, raw


def crism_science() -> tuple[np.ndarray, np.ndarray]:
    crism_path = RAW / "crism_jezero_minerals.tif"
    bands = [to_grid(crism_path, Resampling.nearest, band=band) for band in (1, 2, 3)]
    rgb = np.stack(bands, -1)
    covered = ~np.isnan(rgb).any(-1)
    score = np.zeros((ROWS, COLS), dtype="float32")
    for high_color, medium_color, value in CRISM_CLASSES.values():
        score[(rgb == high_color).all(-1)] = value
        score[(rgb == medium_color).all(-1)] = value * MEDIUM_CONFIDENCE_FACTOR
    return score, covered


def site_boost(score: np.ndarray) -> np.ndarray:
    rows, cols = np.mgrid[0:ROWS, 0:COLS]
    boosted = score.copy()
    for site in SITES.values():
        site_row, site_col = lonlat_to_cell(site["lon"], site["lat"])
        dist_sq_m = ((rows - site_row) ** 2 + (cols - site_col) ** 2) * CELL_M**2
        bump = np.exp(-dist_sq_m / (2 * SCIENCE_SITE_SIGMA_M**2))
        boosted = np.maximum(boosted, bump)
    return boosted


def traverse_cells() -> list[list[int]]:
    features = json.loads((RAW / "M20_traverse.json").read_text())["features"]
    cells: list[list[int]] = []
    for feature in features:
        geometry = feature["geometry"]
        if geometry["type"] == "MultiLineString":
            lines = geometry["coordinates"]
        else:
            lines = [geometry["coordinates"]]
        for line in lines:
            for lon, lat, *_ in line:
                r, c = lonlat_to_cell(lon, lat)
                if not (0 <= r < ROWS and 0 <= c < COLS):
                    continue
                if cells and cells[-1] == [r, c]:
                    continue
                cells.append([r, c])
    return cells


def confidence(traverse: list[list[int]], crism_covered: np.ndarray) -> np.ndarray:
    conf = np.where(crism_covered, 0.5, 0.3).astype("float32")
    near_traverse = np.zeros((ROWS, COLS), dtype=bool)
    radius = int(TRAVERSE_CONFIDENCE_RADIUS_M // CELL_M)
    for r, c in traverse:
        near_traverse[max(0, r - radius):r + radius + 1, max(0, c - radius):c + radius + 1] = True
    conf[near_traverse] = 1.0
    return conf


def hirise_background() -> None:
    row_min, col_min = trek_tile(HIRISE_Z, LON_MIN, LAT_MAX)
    row_max, col_max = trek_tile(HIRISE_Z, LON_MAX, LAT_MIN)
    width = (col_max - col_min + 1) * TILE_PX
    height = (row_max - row_min + 1) * TILE_PX
    mosaic = Image.new("L", (width, height))
    for row in range(row_min, row_max + 1):
        for col in range(col_min, col_max + 1):
            tile = Image.open(TREK_DIR / str(HIRISE_Z) / str(row) / f"{col}.png").convert("L")
            mosaic.paste(tile, ((col - col_min) * TILE_PX, (row - row_min) * TILE_PX))

    px_per_degree = TILE_PX * 2**HIRISE_Z / 180
    origin_x = col_min * TILE_PX
    origin_y = row_min * TILE_PX
    crop_box = (
        (LON_MIN + 180) * px_per_degree - origin_x,
        (90 - LAT_MAX) * px_per_degree - origin_y,
        (LON_MAX + 180) * px_per_degree - origin_x,
        (90 - LAT_MIN) * px_per_degree - origin_y,
    )
    size = (COLS * HIRISE_PX_PER_CELL, ROWS * HIRISE_PX_PER_CELL)
    cropped = mosaic.resize(size, Image.LANCZOS, box=crop_box)
    cropped.save(WEB_DATA / "hirise_aoi.webp", quality=72, method=6)


def geo_unit_layer() -> np.ndarray:
    unit_code = {unit[0]: i + 1 for i, unit in enumerate(GEO_UNITS)}
    units = json.loads((CACHE / "sim3464_units.geojson").read_text())
    shapes = []
    for feature in units["features"]:
        rings = []
        for ring in feature["geometry"]["coordinates"]:
            rings.append([(to_m(x), to_m(y)) for x, y in ring])
        polygon = {"type": "Polygon", "coordinates": rings}
        shapes.append((polygon, unit_code[feature["properties"]["symbol"]]))
    raster = rasterize(shapes, out_shape=(ROWS, COLS), transform=GRID_TF, fill=0, dtype="uint8")
    return raster.astype("float32")


def geounits_json() -> None:
    units = []
    for i, (symbol, _color, name_es, name_en, plain_es, plain_en) in enumerate(GEO_UNITS):
        units.append({
            "id": i + 1,
            "symbol": symbol,
            "name_es": name_es,
            "name_en": name_en,
            "plain_es": plain_es,
            "plain_en": plain_en,
        })
    text = json.dumps(units, ensure_ascii=False, separators=(",", ":"))
    (WEB_DATA / "geounits.json").write_text(text)


def default_route(
    layers: dict[str, np.ndarray], cfg: dict, start: int, goal: int
) -> tuple[list[int], np.ndarray]:
    payload = {
        "layers": {name: values.ravel().tolist() for name, values in layers.items()},
        "cfg": cfg,
        "cell_m": CELL_M,
        "rows": ROWS,
        "cols": COLS,
        "start": start,
        "goal": goal,
        "weights": DEFAULT_WEIGHTS,
    }
    pathfind_url = (ROOT / "web" / "pathfind.js").as_uri()
    command = ["node", "--input-type=module", "-e", NODE_ROUTE, pathfind_url]
    result = subprocess.run(
        command, input=json.dumps(payload), capture_output=True, text=True, check=True
    )
    parsed = json.loads(result.stdout)
    return parsed["route"], np.array(parsed["reach"])


def place_relay(
    elevation: np.ndarray, route: list[int], reach: np.ndarray, base_viewshed: np.ndarray
) -> tuple[int, int]:
    hidden_route_cells = []
    for index in route:
        r, c = index // COLS, index % COLS
        if not base_viewshed[r, c]:
            hidden_route_cells.append((r, c))
    walkable = set(map(int, reach))

    def covered_cells(site: tuple[int, int]) -> int:
        return sum(visible(elevation, *site, r, c) for r, c in hidden_route_cells)

    coarse_sites = []
    for index in walkable:
        r, c = index // COLS, index % COLS
        if r % 2 == 0 and c % 2 == 0:
            coarse_sites.append((r, c))
    best_r, best_c = max(coarse_sites, key=covered_cells)

    nearby_sites = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            r, c = best_r + dr, best_c + dc
            if 0 <= r < ROWS and 0 <= c < COLS and r * COLS + c in walkable:
                nearby_sites.append((r, c))
    return max(nearby_sites, key=covered_cells)


def validation(slope: np.ndarray, traverse: list[list[int]], cfg: dict) -> dict:
    pairs = []
    waypoints = json.loads((RAW / "M20_waypoints.json").read_text())["features"]
    for feature in waypoints:
        props = feature["properties"]
        r, c = lonlat_to_cell(props["lon"], props["lat"])
        if 0 <= r < ROWS and 0 <= c < COLS and props.get("tilt") is not None:
            pairs.append([round(float(slope[r, c]), 1), round(float(props["tilt"]), 1)])
    model, rover = np.array(pairs).T
    traversable = sum(slope[r, c] <= cfg["max_slope_deg"] for r, c in traverse)
    return {
        "n": len(pairs),
        "r": round(float(np.corrcoef(model, rover)[0, 1]), 2),
        "pairs": pairs,
        "model": "slope_deg of the 20 m grid (75th percentile of 1 m slopes per cell)",
        "rover": "tilt of the Perseverance IMU at the end of each drive (M20_waypoints)",
        "traversable_pct": round(100 * traversable / len(traverse), 1),
        "traverse_cells": len(traverse),
        "max_slope_deg": cfg["max_slope_deg"],
    }


def pack(values: np.ndarray, decimals: int) -> list:
    rounded = np.round(values.astype("float64"), decimals).ravel().tolist()
    return [int(x) if x.is_integer() else x for x in rounded]


def credits() -> dict:
    nasa_trek = "https://trek.nasa.gov/mars/"
    usgs = "NASA/JPL-Caltech/USGS Astrogeology Science Center"
    items = [
        {
            "id": "hirise",
            "what": "Map background: HiRISE 25 cm orthomosaic, greyscale crop of Mars Trek "
                    "z15 tiles",
            "files": ["hirise_aoi.webp"],
            "credit": "NASA/JPL-Caltech/UArizona/USGS Astrogeology, via NASA Mars Trek",
            "url": nasa_trek,
            "doi": "10.5066/P9QJDP48",
        },
        {
            "id": "dtm",
            "what": "Elevation, slope, sky view factor, viewsheds, roughness, a large-rock proxy "
                    "and closed depressions derived from the HiRISE 1 m DTM",
            "files": [
                "jezero_cost_grid.json: elevation_m, slope_deg, svf, viewshed, viewshed_relay",
                "terrain_extra.json: rough_m, rocks (proxy), craters "
                "(closed depressions; build_terrain.py)",
            ],
            "credit": f"{usgs} (Fergason et al. 2020, Mars 2020 TRN HiRISE DTM mosaic)",
            "url": "https://doi.org/10.5066/P9REJ9JN",
            "doi": "10.5066/P9REJ9JN",
        },
        {
            "id": "themis",
            "what": "Thermal inertia (sand vs bedrock)",
            "files": ["jezero_cost_grid.json: thermal_inertia, thermal_inertia_si"],
            "credit": "NASA/JPL-Caltech/ASU, Mars Odyssey THEMIS global thermal inertia mosaic, "
                      "USGS Astropedia",
            "url": "https://asc-astropedia.s3.us-west-2.amazonaws.com/Mars/Odyssey/"
                   "THEMIS-Global-Thermal-Inertia-Mosaic/",
        },
        {
            "id": "crism",
            "what": "Mineral map used as the science score",
            "files": ["jezero_cost_grid.json: science"],
            "credit": "Parente, Saranathan, Itoh, Tarnas, Seelos, Mustard et al. (2021), "
                      "Map of the dominant mineralogy over and around the Mars2020 landing "
                      "ellipse with correspondent spectral signatures",
            "url": "https://doi.org/10.5281/zenodo.5575824",
            "doi": "10.5281/zenodo.5575824",
        },
        {
            "id": "geology",
            "what": "Geologic units (7 in the AOI), rasterised",
            "files": ["jezero_cost_grid.json: geo_unit", "geounits.json"],
            "credit": "Sun & Stack (2020), Geologic map of Jezero crater and the Nili Planum "
                      "region, Mars, USGS SIM 3464",
            "url": "https://pubs.usgs.gov/sim/3464/",
            "doi": "10.3133/sim3464",
        },
        {
            "id": "m20",
            "what": "Perseverance traverse and waypoints (validation, confidence). "
                    "Three Forks start: approximate, ±50 m (depot centre estimated from sol "
                    "681/693 waypoints; NASA publishes no depot coordinates). Validation: "
                    "n = 357 waypoints (not independent), traverse cells = 1272 line vertices "
                    "incl. revisits",
            "files": [
                "traverse_cells.json",
                "validation.json",
                "jezero_cost_grid.json: confidence",
            ],
            "credit": "NASA/JPL-Caltech, Mars 2020 MMGIS",
            "url": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json",
        },
        {
            "id": "donki",
            "what": "CME arrivals at Mars, May 2024 (WSA-ENLIL). Rows are simulation runs, "
                    "several repeat the same CME: cite only the arrival used, sim 30979, "
                    "2024-05-20T07:52Z",
            "files": ["donki_mars_2024-05.json"],
            "credit": "NASA GSFC Community Coordinated Modeling Center, DONKI",
            "url": "https://ccmc.gsfc.nasa.gov/tools/DONKI/",
        },
        {
            "id": "rad",
            "what": "Dose of the 20 May 2024 solar storm measured by Curiosity RAD at Gale "
                    "(8,100 µGy)",
            "files": ["mission_config.json: radiation"],
            "credit": "NASA/JPL-Caltech, Curiosity Radiation Assessment Detector",
            "url": "https://www.nasa.gov/solar-system/planets/mars/"
                   "nasa-watches-mars-light-up-during-epic-solar-storm",
        },
        {
            "id": "meda",
            "what": "Air temperature and EVA window, sol 1210",
            "files": ["meda_sol1210.json"],
            "credit": "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU",
            "url": "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/"
                   "data_derived_env/sol_1140_1259/sol_1210/",
        },
        {
            "id": "science",
            "what": "Destination science summary and citation",
            "files": ["science.json"],
            "credit": "Hurowitz et al. (2025), Nature 645, 332-340",
            "url": "https://doi.org/10.1038/s41586-025-09413-0",
            "doi": "10.1038/s41586-025-09413-0",
        },
        {
            "id": "pov",
            "what": "Perseverance photographs",
            "files": ["pov/*.webp"],
            "credit": "NASA/JPL-Caltech (MSSS, ASU where noted); exact credit, date and source "
                      "per photo in pov/pov.json",
            "url": "https://photojournal.jpl.nasa.gov/",
        },
    ]
    return {
        "note": "Data credit only; no NASA insignia. Derived layers are computed by Ariadne.",
        "items": items,
    }


def write_json(name: str, data, **dump_args) -> None:
    (WEB_DATA / name).write_text(json.dumps(data, **dump_args))


def relay_coverage(layer: np.ndarray, route: list[int]) -> float:
    visible_cells = [layer[index // COLS, index % COLS] > 0 for index in route]
    return round(100 * float(np.mean(visible_cells)), 1)


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((WEB_DATA / "mission_config.json").read_text())

    elevation, slope = dtm_layers()
    print("dtm ok")
    ti_normalized, ti_raw = thermal_inertia()
    science, crism_covered = crism_science()
    traverse = traverse_cells()

    sites = {}
    for key, site in SITES.items():
        sites[key] = {**site, "cell": lonlat_to_cell(site["lon"], site["lat"])}
    habitat = sites["three_forks"]["cell"]
    goal = sites["cheyava_falls"]["cell"]

    svf = sky_view_factor(elevation)
    print("svf ok")
    habitat_viewshed = viewshed(elevation, habitat)
    print("viewshed ok")

    layers = {
        "elevation_m": elevation,
        "slope_deg": slope,
        "thermal_inertia": ti_normalized,
        "thermal_inertia_si": ti_raw,
        "science": site_boost(science),
        "svf": svf,
        "viewshed": habitat_viewshed,
        "confidence": confidence(traverse, crism_covered),
        "geo_unit": geo_unit_layer(),
    }
    rounded = {
        name: np.round(layer.astype("float64"), LAYER_DP[name])
        for name, layer in layers.items()
    }

    start_index = habitat[0] * COLS + habitat[1]
    goal_index = goal[0] * COLS + goal[1]
    no_relay = {**rounded, "viewshed_relay": np.zeros((ROWS, COLS))}
    route, reach = default_route(no_relay, cfg, start_index, goal_index)
    assert route, "no default route"

    relay = place_relay(elevation, route, reach, habitat_viewshed)
    rounded["viewshed_relay"] = viewshed(elevation, relay)
    both_viewsheds = np.maximum(rounded["viewshed"], rounded["viewshed_relay"])
    relay_meta = {
        "cell": list(relay),
        "coverage_before_pct": relay_coverage(rounded["viewshed"], route),
        "coverage_after_pct": relay_coverage(both_viewsheds, route),
        "route_cells": len(route),
        "antenna_m": ANTENNA_H_M,
    }
    print("relay", relay_meta)

    payload = {
        "meta": {
            "rows": ROWS,
            "cols": COLS,
            "cell_m": CELL_M,
            "source": "HiRISE DTM · THEMIS TI · CRISM · USGS SIM 3464 · M20",
            "order": "row-major, row 0 = north",
            "crs": "Mars 2000 sphere, equirectangular lon0 latTs0",
            "origin_m": [LEFT, TOP],
            "sites": sites,
            "relay": relay_meta,
        },
        "layers": {name: pack(layer, LAYER_DP[name]) for name, layer in rounded.items()},
    }
    write_json("jezero_cost_grid.json", payload, separators=(",", ":"))
    write_json("traverse_cells.json", traverse, separators=(",", ":"))
    write_json(
        "validation.json", validation(rounded["slope_deg"], traverse, cfg), separators=(",", ":")
    )
    geounits_json()
    write_json("credits.json", credits(), ensure_ascii=False, indent=1)
    hirise_background()

    (WEB_DATA / "ctx_aoi.png").unlink(missing_ok=True)
    (WEB_DATA / "donki_sep_2024-05.json").unlink(missing_ok=True)
    shutil.copy(CACHE / "donki_mars_2024-05.json", WEB_DATA / "donki_mars_2024-05.json")

    for name, values in rounded.items():
        print(
            f"  {name:20s} min {np.nanmin(values):9.2f}  max {np.nanmax(values):9.2f}"
            f"  mean {np.nanmean(values):9.2f}"
        )
    print(f"grid {ROWS}×{COLS} · traverse cells {len(traverse)} · sites {sites}")


if __name__ == "__main__":
    main()
