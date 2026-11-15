import heapq
import json
import warnings

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

from aoi import CELL_M, COLS, CRS_WKT, LEFT, RAW, ROWS, TOP, WEB_DATA

ROCK_SLOPE_DEG = 30.0
ROCK_PERCENTILE = 95
CRATER_RES_M = 5
CRATER_MIN_DEPTH_M = 1.0
CRATER_MIN_DIAM_M = 40.0
CRATER_MAX_ASPECT = 2.0
DEPRESSION_EPS_M = 0.2
B = int(CELL_M)


def to_1m(path) -> np.ndarray:
    out = np.full((ROWS * B, COLS * B), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, 1), out, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=from_origin(LEFT, TOP, 1.0, 1.0), dst_crs=CRS_WKT, resampling=Resampling.nearest)
    out[out < -1e5] = np.nan
    return out


def blocks(a: np.ndarray, k: int) -> np.ndarray:
    r, c = a.shape[0] // k, a.shape[1] // k
    return a.reshape(r, k, c, k).transpose(0, 2, 1, 3)


def roughness(z: np.ndarray) -> np.ndarray:
    zb = blocks(z, B).reshape(ROWS, COLS, B * B)
    y, x = np.divmod(np.arange(B * B), B)
    X = np.stack([np.ones(B * B), x - (B - 1) / 2, y - (B - 1) / 2], -1)
    w = (~np.isnan(zb)).astype("float64")
    zf = np.nan_to_num(zb.astype("float64"))
    A = np.einsum("rcn,ni,nj->rcij", w, X, X)
    bvec = np.einsum("rcn,ni,rcn->rci", w, X, zf)
    n = w.sum(-1)
    ok = n >= B * B / 2
    A[~ok] = np.eye(3)
    coef = np.linalg.solve(A, bvec[..., None])[..., 0]
    res = zf - np.einsum("ni,rci->rcn", X, coef)
    sd = np.sqrt(np.einsum("rcn,rcn->rc", w, res * res) / np.maximum(n, 1))
    sd[~ok] = np.nan
    return sd


def rock_mask(slope1m: np.ndarray) -> np.ndarray:
    p = np.nanpercentile(blocks(slope1m, B).reshape(ROWS, COLS, B * B), ROCK_PERCENTILE, axis=-1)
    return (np.nan_to_num(p) > ROCK_SLOPE_DEG).astype("uint8")


def rle(mask: np.ndarray) -> list[int]:
    m = np.concatenate([[0], mask.ravel().astype("int8"), [0]])
    d = np.flatnonzero(np.diff(m))
    return [int(v) for s, e in zip(d[::2], d[1::2]) for v in (s, e - s)]


def fill_sinks(z: np.ndarray) -> np.ndarray:
    r, c = z.shape
    filled = z.copy()
    nan = np.isnan(z)
    seen = np.zeros((r, c), dtype=bool)
    heap = []
    edge = np.zeros((r, c), dtype=bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    for i, j in zip(*np.nonzero(edge | nan)):
        seen[i, j] = True
        heap.append((-np.inf if nan[i, j] else float(z[i, j]), int(i), int(j)))
    heapq.heapify(heap)
    nb = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    zl, fl, sl, nl = z.tolist(), filled.tolist(), seen.tolist(), nan.tolist()
    while heap:
        h, i, j = heapq.heappop(heap)
        for di, dj in nb:
            a, b = i + di, j + dj
            if 0 <= a < r and 0 <= b < c and not sl[a][b]:
                sl[a][b] = True
                if nl[a][b]:
                    heapq.heappush(heap, (-np.inf, a, b))
                    continue
                v = zl[a][b]
                if v < h:
                    v_f = h
                else:
                    v_f = v
                fl[a][b] = v_f
                heapq.heappush(heap, (v_f, a, b))
    return np.array(fl, dtype="float32")


def craters(z1m: np.ndarray) -> list[dict]:
    k = CRATER_RES_M
    zb = blocks(z1m, k).reshape(ROWS * B // k, COLS * B // k, k * k)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        z = np.nanmean(zb, axis=-1)
    depth = fill_sinks(z) - z
    depth[np.isnan(depth)] = 0
    mask = depth > DEPRESSION_EPS_M
    rr, cc = depth.shape
    lab = np.zeros((rr, cc), dtype="int32")
    out, n = [], 0
    for s in zip(*np.nonzero(mask)):
        if lab[s]:
            continue
        n += 1
        lab[s] = n
        stack, cells = [s], []
        while stack:
            i, j = stack.pop()
            cells.append((i, j))
            for a, b in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)):
                if 0 <= a < rr and 0 <= b < cc and mask[a, b] and not lab[a, b]:
                    lab[a, b] = n
                    stack.append((a, b))
        ii, jj = np.array(cells).T
        area = len(cells) * k * k
        diam = 2 * np.sqrt(area / np.pi)
        h, w = (ii.max() - ii.min() + 1) * k, (jj.max() - jj.min() + 1) * k
        dmax = float(depth[ii, jj].max())
        if diam < CRATER_MIN_DIAM_M or dmax < CRATER_MIN_DEPTH_M or max(h, w) / min(h, w) > CRATER_MAX_ASPECT:
            continue
        ci, cj = ii.mean() * k / B, jj.mean() * k / B
        out.append({"cell": int(min(ROWS - 1, ci)) * COLS + int(min(COLS - 1, cj)), "diam_m": int(round(diam)), "depth_m": round(dmax, 1)})
    return sorted(out, key=lambda d: -d["diam_m"])


def main() -> None:
    z, s = to_1m(RAW / "dtm_aoi_1m.tif"), to_1m(RAW / "slope_1m.tif")
    rough = roughness(z)
    edge_nan = int(np.isnan(rough).sum())
    rough = np.where(np.isnan(rough), np.nanmedian(rough), rough)
    rocks = rock_mask(s)
    cr = craters(z)
    q = lambda p: float(np.nanpercentile(rough, p))
    payload = {
        "meta": {"rows": ROWS, "cols": COLS, "cell_m": CELL_M, "src": "HiRISE 1 m DTM (Fergason et al. 2020, USGS)",
                 "method": {"rough_m": "std. dev. of the 1 m DTM residual after a least-squares plane, per 20 m cell",
                            "rocks": f"1 where the {ROCK_PERCENTILE}th percentile of the 1 m slope is above {ROCK_SLOPE_DEG:.0f} deg; run-length [start, length, ...] over row-major cells. PROXY: boulders under ~1.5 m are not resolved",
                            "craters": f"closed depressions of the {CRATER_RES_M} m DTM (priority-flood fill), depth >= {CRATER_MIN_DEPTH_M} m, equivalent diameter >= {CRATER_MIN_DIAM_M:.0f} m, bbox aspect <= {CRATER_MAX_ASPECT}; not the Robbins catalogue"},
                 "rough_pct": {"p50": round(q(50), 2), "p75": round(q(75), 2), "p90": round(q(90), 2)}},
        "layers": {"rough_m": [round(float(v), 2) for v in rough.ravel()], "rocks": rle(rocks)},
        "craters": cr,
    }
    assert edge_nan < 0.02 * ROWS * COLS, "too many cells without DTM"
    assert 0 < sum(payload["layers"]["rocks"][1::2]) < 0.3 * ROWS * COLS, "rock proxy out of range"
    assert len(cr) > 0, "no craters found"
    assert 0 < q(50) < 5, "roughness out of range"
    path = WEB_DATA / "terrain_extra.json"
    path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"rough p50/p75/p90 {q(50):.2f}/{q(75):.2f}/{q(90):.2f} m · rock cells {sum(payload['layers']['rocks'][1::2])} · craters {len(cr)} · {path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
