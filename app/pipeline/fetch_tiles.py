import argparse
import contextlib
import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from aoi import CELL_M, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, MARS_R, SITES, WEB_DATA
from fetch_data import TREK_DIR, fetch_trek, trek_tile

OUT = WEB_DATA.parent / "tiles"
PAD = 0.005
CORRIDOR_M = 300
BBOX = (LON_MIN - PAD, LAT_MIN - PAD, LON_MAX + PAD, LAT_MAX + PAD)
DEG_M = math.pi * MARS_R / 180


def tiles_in(z, bbox=BBOX):
    row0, col0 = trek_tile(z, bbox[0], bbox[3])
    row1, col1 = trek_tile(z, bbox[2], bbox[1])
    tiles = []
    for row in range(row0, row1 + 1):
        for col in range(col0, col1 + 1):
            tiles.append((row, col))
    return tiles


def corridor_tiles(z=17):
    grid = json.loads((WEB_DATA / "jezero_cost_grid.json").read_text())["meta"]
    x0, y0 = grid["origin_m"]
    traverse_cells = json.loads((WEB_DATA / "traverse_cells.json").read_text())
    points = []
    for r, c in traverse_cells:
        lon = (x0 + (c + .5) * CELL_M) / DEG_M
        lat = (y0 - (r + .5) * CELL_M) / DEG_M
        points.append((lon, lat))

    start, end = SITES["three_forks"], SITES["cheyava_falls"]
    steps = 200
    for i in range(steps + 1):
        lon = start["lon"] + (end["lon"] - start["lon"]) * i / steps
        lat = start["lat"] + (end["lat"] - start["lat"]) * i / steps
        points.append((lon, lat))

    margin = CORRIDOR_M / DEG_M
    tiles = set()
    for lon, lat in points:
        tiles.update(tiles_in(z, (lon - margin, lat - margin, lon + margin, lat + margin)))
    return sorted(tiles)


def webp_path(z, row, col):
    return OUT / str(z) / str(row) / f"{col}.webp"


def to_webp(z, tile):
    row, col = tile
    src = TREK_DIR / str(z) / str(row) / f"{col}.png"
    dst = webp_path(z, row, col)
    if dst.exists() or not src.exists():
        return dst.exists()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    with Image.open(src) as image:
        image.convert("L").save(tmp, "WEBP", quality=60, method=6)
    tmp.rename(dst)
    return True


def column_runs(cols):
    runs = []
    for col in sorted(cols):
        if runs and col == runs[-1][1] + 1:
            runs[-1][1] = col
        else:
            runs.append([col, col])
    return runs


def tile_lon(z, col):
    return (col + .5) / (2 * 2**z) * 360 - 180


def fetch_set(z, tiles):
    todo = []
    for row, col in tiles:
        if not webp_path(z, row, col).exists():
            todo.append((row, col))
    cols_by_row = {}
    for row, col in todo:
        cols_by_row.setdefault(row, []).append(col)

    downloaded = 0
    for row, cols in sorted(cols_by_row.items()):
        lat = 90 - (row + .5) / 2**z * 180
        for first_col, last_col in column_runs(cols):
            bbox = (tile_lon(z, first_col), lat, tile_lon(z, last_col), lat)
            with contextlib.redirect_stdout(io.StringIO()):
                fetch_trek(z, bbox)
            time.sleep(0.05)
        downloaded += len(cols)
        print(f"\r  z{z}: {downloaded}/{len(todo)} tiles downloaded", end="", flush=True)
    if todo:
        print()

    with ThreadPoolExecutor(4) as pool:
        converted = list(pool.map(lambda tile: to_webp(z, tile), tiles))
    missing = converted.count(False)
    folder = OUT.relative_to(OUT.parent.parent)
    message = f"  z{z}: {len(tiles) - missing}/{len(tiles)} tiles in {folder}"
    if missing:
        message += f" ({missing} MISSING: re-run)"
    print(message)
    return missing


def size_mb(zooms):
    if not OUT.exists():
        return 0
    total = sum(f.stat().st_size for z in zooms for f in (OUT / str(z)).rglob("*.webp"))
    return total / 1e6


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget-mb", type=float, default=40)
    parser.add_argument("--no-z17", action="store_true")
    args = parser.parse_args()
    budget = args.budget_mb
    all_zooms = [13, 14, 15, 16, 17]

    missing = 0
    for z in (13, 14, 15, 16):
        missing += fetch_set(z, tiles_in(z))

    if not args.no_z17:
        corridor = corridor_tiles()
        full = tiles_in(17)
        print(f"z17 corridor: {len(corridor)} tiles (+-{CORRIDOR_M} m)")
        missing += fetch_set(17, corridor)
        have = sum(1 for row, col in full if webp_path(17, row, col).exists())
        per_tile = size_mb([17]) / max(have, 1)
        estimate = size_mb(all_zooms) + per_tile * (len(full) - have)
        print(
            f"z17 full AOI is {len(full)} tiles; "
            f"estimated total {estimate:.1f} MB (budget {budget} MB)"
        )
        if estimate <= budget * 0.9:
            missing += fetch_set(17, full)

    total = size_mb(all_zooms)
    by_zoom = {z: round(size_mb([z]), 1) for z in all_zooms if (OUT / str(z)).exists()}
    print(f"tiles total {total:.1f} MB (budget {budget} MB) by zoom: {by_zoom}")
    if total > budget:
        sys.exit(f"over budget: {total:.1f} MB > {budget} MB")
    if missing:
        sys.exit(f"{missing} tiles missing: run again")


if __name__ == "__main__":
    main()
