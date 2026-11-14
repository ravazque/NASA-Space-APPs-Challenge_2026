import json
import os
import sys
import urllib.request
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds

from aoi import BOTTOM, CACHE, LEFT, RAW, RIGHT, ROOT, TOP

MMGIS = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json"
ZENODO = "https://zenodo.org/api/records/5575824/files"
USGS = "https://planetarymaps.usgs.gov/mosaic/mars2020_trn"
THEMIS = ("https://asc-astropedia.s3.us-west-2.amazonaws.com/Mars/Odyssey/"
          "THEMIS-Global-Thermal-Inertia-Mosaic/Quantitative-32-Bit/THEMIS_TI_Mosaic_Quant_00N060E_100mpp.cub")

FILES = {
    RAW / "M20_waypoints.json": f"{MMGIS}/M20_waypoints.json",
    RAW / "M20_traverse.json": f"{MMGIS}/M20_traverse.json",
    RAW / "crism_jezero_minerals.tif": f"{ZENODO}/jezeroFinal.tif/content",
    RAW / "crism_jezero_readme.pdf": f"{ZENODO}/Jezero_readme.pdf/content",
}

RASTER_CROPS = {
    RAW / "dtm_aoi_1m.tif": f"{USGS}/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",
    RAW / "ctx_aoi_6m.tif": f"{USGS}/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif",
    RAW / "themis_ti_aoi_100m.tif": THEMIS,
}

DONKI_SEP = ("https://api.nasa.gov/DONKI/SEP?startDate=2024-05-01&endDate=2024-05-31&api_key={key}",
             CACHE / "donki_sep_2024-05.json")

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.cub",
    "CPL_VSIL_CURL_CHUNK_SIZE": str(10 * 1024 * 1024),
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "2",
}


def nasa_api_key() -> str:
    key = os.environ.get("NASA_API_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("NASA_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        print("! NASA_API_KEY not set (app/.env) — using DEMO_KEY (rate-limited)")
    return key or "DEMO_KEY"


def download(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"= {dest.name} (cached)")
        return
    print(f"↓ {dest.name}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.rename(dest)


def crop_remote(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"= {dest.name} (cached)")
        return
    print(f"↓ {dest.name} (AOI window only)")
    with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as src:
        win = from_bounds(LEFT, BOTTOM, RIGHT, TOP, src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        data = src.read(window=win)
        profile = src.profile | {
            "driver": "GTiff", "width": win.width, "height": win.height,
            "transform": src.window_transform(win), "compress": "deflate", "tiled": True,
            "blockxsize": 256, "blockysize": 256,
        }
        tmp = dest.with_suffix(".part.tif")
        with rasterio.open(tmp, "w", **profile) as dst:
            dst.write(data)
    tmp.rename(dest)


def fetch_donki() -> None:
    url, dest = DONKI_SEP
    if dest.exists():
        print(f"= {dest.name} (cached)")
        return
    print(f"↓ {dest.name}")
    with urllib.request.urlopen(url.format(key=nasa_api_key()), timeout=60) as r:
        events = json.load(r)
    if not isinstance(events, list):
        raise ValueError(f"unexpected DONKI response: {str(events)[:200]}")
    dest.write_text(json.dumps(events, indent=1))


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    failed = []
    jobs = [(download, u, d) for d, u in FILES.items()] + [(crop_remote, u, d) for d, u in RASTER_CROPS.items()]
    for fn, url, dest in jobs:
        try:
            fn(url, dest)
        except Exception as e:
            failed.append(f"{dest.name}: {e}")
    try:
        fetch_donki()
    except Exception as e:
        failed.append(f"DONKI: {e}")
    for f in failed:
        print(f"✗ {f}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
