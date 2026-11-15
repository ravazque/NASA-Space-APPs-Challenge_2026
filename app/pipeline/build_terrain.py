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
NODATA_BELOW = -1e5
BLOCK = int(CELL_M)
NEIGHBORS_8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
NEIGHBORS_4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def to_1m(path) -> np.ndarray:
    out = np.full((ROWS * BLOCK, COLS * BLOCK), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(
            rasterio.band(src, 1),
            out,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
            dst_transform=from_origin(LEFT, TOP, 1.0, 1.0),
            dst_crs=CRS_WKT,
            resampling=Resampling.nearest,
        )
    out[out < NODATA_BELOW] = np.nan
    return out


def blocks(a: np.ndarray, size: int) -> np.ndarray:
    n_rows = a.shape[0] // size
    n_cols = a.shape[1] // size
    return a.reshape(n_rows, size, n_cols, size).transpose(0, 2, 1, 3)


def roughness(z: np.ndarray) -> np.ndarray:
    n_px = BLOCK * BLOCK
    z_blocks = blocks(z, BLOCK).reshape(ROWS, COLS, n_px)

    # Plane z = a + b*x + c*y, least squares per block, NaN ignored
    y, x = np.divmod(np.arange(n_px), BLOCK)
    design = np.stack([np.ones(n_px), x - (BLOCK - 1) / 2, y - (BLOCK - 1) / 2], -1)
    valid = (~np.isnan(z_blocks)).astype("float64")
    z_filled = np.nan_to_num(z_blocks.astype("float64"))

    normal_matrix = np.einsum("rcn,ni,nj->rcij", valid, design, design)
    rhs = np.einsum("rcn,ni,rcn->rci", valid, design, z_filled)
    n_valid = valid.sum(-1)
    enough_data = n_valid >= n_px / 2
    normal_matrix[~enough_data] = np.eye(3)

    coef = np.linalg.solve(normal_matrix, rhs[..., None])[..., 0]
    residual = z_filled - np.einsum("ni,rci->rcn", design, coef)
    variance = np.einsum("rcn,rcn->rc", valid, residual * residual) / np.maximum(n_valid, 1)
    std_dev = np.sqrt(variance)
    std_dev[~enough_data] = np.nan
    return std_dev


def rock_mask(slope_1m: np.ndarray) -> np.ndarray:
    slope_blocks = blocks(slope_1m, BLOCK).reshape(ROWS, COLS, BLOCK * BLOCK)
    percentile = np.nanpercentile(slope_blocks, ROCK_PERCENTILE, axis=-1)
    return (np.nan_to_num(percentile) > ROCK_SLOPE_DEG).astype("uint8")


def rle(mask: np.ndarray) -> list[int]:
    padded = np.concatenate([[0], mask.ravel().astype("int8"), [0]])
    changes = np.flatnonzero(np.diff(padded))
    runs = []
    for start, end in zip(changes[::2], changes[1::2]):
        runs.append(int(start))
        runs.append(int(end - start))
    return runs


def fill_sinks(z: np.ndarray) -> np.ndarray:
    n_rows, n_cols = z.shape
    is_nan = np.isnan(z)
    on_edge = np.zeros((n_rows, n_cols), dtype=bool)
    on_edge[0, :] = True
    on_edge[-1, :] = True
    on_edge[:, 0] = True
    on_edge[:, -1] = True

    seen = np.zeros((n_rows, n_cols), dtype=bool)
    heap = []
    for i, j in zip(*np.nonzero(on_edge | is_nan)):
        seen[i, j] = True
        level = -np.inf if is_nan[i, j] else float(z[i, j])
        heap.append((level, int(i), int(j)))
    heapq.heapify(heap)

    z_rows = z.tolist()
    filled_rows = z.copy().tolist()
    seen_rows = seen.tolist()
    nan_rows = is_nan.tolist()

    while heap:
        level, i, j = heapq.heappop(heap)
        for di, dj in NEIGHBORS_8:
            neighbor_row = i + di
            neighbor_col = j + dj
            inside = 0 <= neighbor_row < n_rows and 0 <= neighbor_col < n_cols
            if not inside or seen_rows[neighbor_row][neighbor_col]:
                continue
            seen_rows[neighbor_row][neighbor_col] = True
            if nan_rows[neighbor_row][neighbor_col]:
                heapq.heappush(heap, (-np.inf, neighbor_row, neighbor_col))
                continue
            new_level = max(z_rows[neighbor_row][neighbor_col], level)
            filled_rows[neighbor_row][neighbor_col] = new_level
            heapq.heappush(heap, (new_level, neighbor_row, neighbor_col))
    return np.array(filled_rows, dtype="float32")


def label_depressions(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    n_rows, n_cols = mask.shape
    labels = np.zeros((n_rows, n_cols), dtype="int32")
    regions = []
    for seed in zip(*np.nonzero(mask)):
        if labels[seed]:
            continue
        label = len(regions) + 1
        labels[seed] = label
        stack = [seed]
        cells = []
        while stack:
            i, j = stack.pop()
            cells.append((i, j))
            for di, dj in NEIGHBORS_4:
                neighbor_row = i + di
                neighbor_col = j + dj
                inside = 0 <= neighbor_row < n_rows and 0 <= neighbor_col < n_cols
                if not inside:
                    continue
                if mask[neighbor_row, neighbor_col] and not labels[neighbor_row, neighbor_col]:
                    labels[neighbor_row, neighbor_col] = label
                    stack.append((neighbor_row, neighbor_col))
        regions.append(cells)
    return regions


def craters(z_1m: np.ndarray) -> list[dict]:
    res = CRATER_RES_M
    z_blocks = blocks(z_1m, res).reshape(ROWS * BLOCK // res, COLS * BLOCK // res, res * res)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        z = np.nanmean(z_blocks, axis=-1)
    depth = fill_sinks(z) - z
    depth[np.isnan(depth)] = 0

    found = []
    for cells in label_depressions(depth > DEPRESSION_EPS_M):
        rows, cols = np.array(cells).T
        area = len(cells) * res * res
        diameter = 2 * np.sqrt(area / np.pi)
        height = (rows.max() - rows.min() + 1) * res
        width = (cols.max() - cols.min() + 1) * res
        max_depth = float(depth[rows, cols].max())
        aspect = max(height, width) / min(height, width)
        if diameter < CRATER_MIN_DIAM_M or max_depth < CRATER_MIN_DEPTH_M:
            continue
        if aspect > CRATER_MAX_ASPECT:
            continue
        center_row = rows.mean() * res / BLOCK
        center_col = cols.mean() * res / BLOCK
        cell_row = int(min(ROWS - 1, center_row))
        cell_col = int(min(COLS - 1, center_col))
        found.append({
            "cell": cell_row * COLS + cell_col,
            "diam_m": int(round(diameter)),
            "depth_m": round(max_depth, 1),
        })
    return sorted(found, key=lambda crater: -crater["diam_m"])


def build_meta(rough: np.ndarray) -> dict:
    def percentile(p: int) -> float:
        return float(np.nanpercentile(rough, p))

    return {
        "rows": ROWS,
        "cols": COLS,
        "cell_m": CELL_M,
        "src": "HiRISE 1 m DTM (Fergason et al. 2020, USGS)",
        "method": {
            "rough_m": "std. dev. of the 1 m DTM residual after a least-squares plane, "
                       "per 20 m cell",
            "rocks": f"1 where the {ROCK_PERCENTILE}th percentile of the 1 m slope is above "
                     f"{ROCK_SLOPE_DEG:.0f} deg; run-length [start, length, ...] over row-major "
                     "cells. PROXY: boulders under ~1.5 m are not resolved",
            "craters": f"closed depressions of the {CRATER_RES_M} m DTM (priority-flood fill), "
                       f"depth >= {CRATER_MIN_DEPTH_M} m, equivalent diameter >= "
                       f"{CRATER_MIN_DIAM_M:.0f} m, bbox aspect <= {CRATER_MAX_ASPECT}; "
                       "not the Robbins catalogue",
        },
        "rough_pct": {
            "p50": round(percentile(50), 2),
            "p75": round(percentile(75), 2),
            "p90": round(percentile(90), 2),
        },
    }


def main() -> None:
    z = to_1m(RAW / "dtm_aoi_1m.tif")
    slope_1m = to_1m(RAW / "slope_1m.tif")

    rough = roughness(z)
    cells_without_dtm = int(np.isnan(rough).sum())
    rough = np.where(np.isnan(rough), np.nanmedian(rough), rough)
    rocks_rle = rle(rock_mask(slope_1m))
    crater_list = craters(z)

    payload = {
        "meta": build_meta(rough),
        "layers": {
            "rough_m": [round(float(value), 2) for value in rough.ravel()],
            "rocks": rocks_rle,
        },
        "craters": crater_list,
    }

    rock_cells = sum(rocks_rle[1::2])
    median_rough = float(np.nanpercentile(rough, 50))
    assert cells_without_dtm < 0.02 * ROWS * COLS, "too many cells without DTM"
    assert 0 < rock_cells < 0.3 * ROWS * COLS, "rock proxy out of range"
    assert len(crater_list) > 0, "no craters found"
    assert 0 < median_rough < 5, "roughness out of range"

    path = WEB_DATA / "terrain_extra.json"
    path.write_text(json.dumps(payload, separators=(",", ":")))

    pct = payload["meta"]["rough_pct"]
    print(
        f"rough p50/p75/p90 {pct['p50']:.2f}/{pct['p75']:.2f}/{pct['p90']:.2f} m"
        f" · rock cells {rock_cells} · craters {len(crater_list)}"
        f" · {path.stat().st_size / 1024:.0f} kB"
    )


if __name__ == "__main__":
    main()
