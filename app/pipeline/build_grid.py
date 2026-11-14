import json
import math
import shutil

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

from aoi import CACHE, CELL_M, COLS, CRS_WKT, LEFT, RAW, ROWS, SITES, TOP, WEB_DATA, lonlat_to_cell

GRID_TF = from_origin(LEFT, TOP, CELL_M, CELL_M)
HORIZON_KM = 1.0
AZIMUTHS = 16
ANTENNA_H_M, ASTRONAUT_H_M = 3.0, 2.0
TRAVERSE_CONFIDENCE_RADIUS_M = 60.0

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


def viewshed(elev: np.ndarray, obs: tuple[int, int]) -> np.ndarray:
    r0, c0 = obs
    h0 = elev[r0, c0] + ANTENNA_H_M
    vis = np.zeros_like(elev)
    for r in range(ROWS):
        for c in range(COLS):
            n = max(abs(r - r0), abs(c - c0))
            if n <= 1:
                vis[r, c] = 1
                continue
            t = np.arange(1, n) / n
            rr, cc = np.rint(r0 + t * (r - r0)).astype(int), np.rint(c0 + t * (c - c0)).astype(int)
            d = t * n
            target = (elev[r, c] + ASTRONAUT_H_M - h0) / n
            vis[r, c] = target >= np.max((elev[rr, cc] - h0) / d)
    return vis


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


def ctx_background() -> None:
    w, h = round(COLS * CELL_M / 6), round(ROWS * CELL_M / 6)
    img = to_grid(RAW / "ctx_aoi_6m.tif", Resampling.bilinear, shape=(h, w), transform=from_origin(LEFT, TOP, 6, 6))
    lo, hi = np.nanpercentile(img, [1, 99])
    img8 = (np.clip((fill_nan(img) - lo) / (hi - lo), 0, 1) * 255).astype("uint8")
    Image.fromarray(img8, "L").save(WEB_DATA / "ctx_aoi.png", optimize=True)


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    elev, slope = dtm_layers()
    print("dtm ok")
    ti_norm, ti_raw = thermal_inertia()
    science, crism_covered = crism_science()
    trav = traverse_cells()
    hab = lonlat_to_cell(SITES["three_forks"]["lon"], SITES["three_forks"]["lat"])
    svf = sky_view_factor(elev)
    print("svf ok")
    vis = viewshed(elev, hab)
    print("viewshed ok")
    layers = {
        "elevation_m": elev, "slope_deg": slope, "thermal_inertia": ti_norm, "thermal_inertia_si": ti_raw,
        "science": site_boost(science), "svf": svf, "viewshed": vis,
        "confidence": confidence(trav, crism_covered),
    }
    sites = {k: {**v, "cell": lonlat_to_cell(v["lon"], v["lat"])} for k, v in SITES.items()}
    payload = {
        "meta": {"rows": ROWS, "cols": COLS, "cell_m": CELL_M, "source": "HiRISE DTM · THEMIS TI · CRISM · M20",
                 "order": "row-major, row 0 = north", "crs": "Mars 2000 sphere, equirectangular lon0 latTs0",
                 "origin_m": [LEFT, TOP], "sites": sites},
        "layers": {k: np.round(v, 3).ravel().tolist() for k, v in layers.items()},
    }
    (WEB_DATA / "jezero_cost_grid.json").write_text(json.dumps(payload, separators=(",", ":")))
    (WEB_DATA / "traverse_cells.json").write_text(json.dumps(trav, separators=(",", ":")))
    ctx_background()
    for snap in CACHE.glob("donki_*.json"):
        shutil.copy(snap, WEB_DATA / snap.name)
    for k, v in layers.items():
        print(f"  {k:20s} min {np.nanmin(v):9.2f}  max {np.nanmax(v):9.2f}  mean {np.nanmean(v):9.2f}")
    print(f"grid {ROWS}×{COLS} · traverse cells {len(trav)} · sites {sites}")


if __name__ == "__main__":
    main()
