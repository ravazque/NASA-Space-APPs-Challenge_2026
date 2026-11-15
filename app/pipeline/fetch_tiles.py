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
    r0, c0 = trek_tile(z, bbox[0], bbox[3])
    r1, c1 = trek_tile(z, bbox[2], bbox[1])
    return [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


def corridor_tiles(z=17):
    grid = json.loads((WEB_DATA / "jezero_cost_grid.json").read_text())["meta"]
    x0, y0 = grid["origin_m"]
    pts = [((x0 + (c + .5) * CELL_M) / DEG_M, (y0 - (r + .5) * CELL_M) / DEG_M)
           for r, c in json.loads((WEB_DATA / "traverse_cells.json").read_text())]
    a, b = SITES["three_forks"], SITES["cheyava_falls"]
    pts += [(a["lon"] + (b["lon"] - a["lon"]) * i / 200, a["lat"] + (b["lat"] - a["lat"]) * i / 200) for i in range(201)]
    dlat = CORRIDOR_M / DEG_M
    out = set()
    for lon, lat in pts:
        dlon = dlat
        out.update(tiles_in(z, (lon - dlon, lat - dlat, lon + dlon, lat + dlat)))
    return sorted(out)


def to_webp(z, rc):
    r, c = rc
    src, dst = TREK_DIR / str(z) / str(r) / f"{c}.png", OUT / str(z) / str(r) / f"{c}.webp"
    if dst.exists() or not src.exists():
        return dst.exists()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    with Image.open(src) as im:
        im.convert("L").save(tmp, "WEBP", quality=60, method=6)
    tmp.rename(dst)
    return True


def fetch_set(z, tiles):
    todo = [rc for rc in tiles if not (OUT / str(z) / str(rc[0]) / f"{rc[1]}.webp").exists()]
    by_row = {}
    for r, c in todo:
        by_row.setdefault(r, []).append(c)
    n = 0
    for r, cols in sorted(by_row.items()):
        runs, cols = [], sorted(cols)
        for c in cols:
            if runs and c == runs[-1][1] + 1: runs[-1][1] = c
            else: runs.append([c, c])
        for c0, c1 in runs:
            lon = lambda c: (c + .5) / (2 * 2**z) * 360 - 180
            lat = (90 - (r + .5) / 2**z * 180)
            with contextlib.redirect_stdout(io.StringIO()):
                fetch_trek(z, (lon(c0), lat, lon(c1), lat))
            time.sleep(0.05)
        n += len(cols)
        print(f"\r  z{z}: {n}/{len(todo)} tiles downloaded", end="", flush=True)
    if todo: print()
    with ThreadPoolExecutor(4) as ex:
        ok = list(ex.map(lambda rc: to_webp(z, rc), tiles))
    miss = ok.count(False)
    print(f"  z{z}: {len(tiles) - miss}/{len(tiles)} tiles in {OUT.relative_to(OUT.parent.parent)}" + (f" ({miss} MISSING: re-run)" if miss else ""))
    return miss


def size_mb(zs):
    return sum(f.stat().st_size for z in zs for f in (OUT / str(z)).rglob("*.webp")) / 1e6 if OUT.exists() else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget-mb", type=float, default=40)
    ap.add_argument("--no-z17", action="store_true")
    a = ap.parse_args()
    miss = 0
    for z in (13, 14, 15, 16):
        miss += fetch_set(z, tiles_in(z))
    if not a.no_z17:
        cor, full = corridor_tiles(), tiles_in(17)
        print(f"z17 corridor: {len(cor)} tiles (+-{CORRIDOR_M} m)")
        miss += fetch_set(17, cor)
        have = sum(1 for r, c in full if (OUT / "17" / str(r) / f"{c}.webp").exists())
        per = size_mb([17]) / max(have, 1)
        est = size_mb([13, 14, 15, 16, 17]) + per * (len(full) - have)
        print(f"z17 full AOI is {len(full)} tiles; estimated total {est:.1f} MB (budget {a.budget_mb} MB)")
        if est <= a.budget_mb * 0.9:
            miss += fetch_set(17, full)
    total = size_mb([13, 14, 15, 16, 17])
    by = {z: round(size_mb([z]), 1) for z in (13, 14, 15, 16, 17) if (OUT / str(z)).exists()}
    print(f"tiles total {total:.1f} MB (budget {a.budget_mb} MB) by zoom: {by}")
    if total > a.budget_mb:
        sys.exit(f"over budget: {total:.1f} MB > {a.budget_mb} MB")
    if miss:
        sys.exit(f"{miss} tiles missing: run again")


if __name__ == "__main__":
    main()
