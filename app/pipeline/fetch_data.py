import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds

from aoi import BOTTOM, CACHE, LAT_MAX, LAT_MIN, LEFT, LON_MAX, LON_MIN, RAW, RIGHT, ROOT, TOP

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
    RAW / "themis_ti_aoi_100m.tif": THEMIS,
}

DONKI_MARS = ("https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate=2024-05-01&endDate=2024-05-31&api_key={key}",
              CACHE / "donki_mars_2024-05.json")

SIM3464 = ("https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Jezero_FeatureServiceFromPro/"
           "FeatureServer/8/query")
SIM3464_DEST = CACHE / "sim3464_units.geojson"

TREK = ("https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/"
        "1.0.0/default/default028mm/{z}/{row}/{col}.png")
TREK_DIR = RAW / "trek"
UA = {"User-Agent": "ariadne-pipeline/1.0 (offline data build)"}

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


def get_json(url: str, retries: int = 3):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def fetch_donki() -> None:
    key = None
    for url, dest in (DONKI_MARS,):
        if dest.exists():
            print(f"= {dest.name} (cached)")
            continue
        print(f"↓ {dest.name}")
        key = key or nasa_api_key()
        data = get_json(url.format(key=key))
        if not isinstance(data, list):
            raise ValueError(f"unexpected DONKI response: {str(data)[:200]}")
        if dest == DONKI_MARS[1]:
            data = [
                {"simulationID": s["simulationID"], "cmeStartTime": c["cmeStartTime"], "speed": c["speed"],
                 "halfAngle": c["halfAngle"], "arrivalTime": i["arrivalTime"],
                 "isGlancingBlow": i["isGlancingBlow"], "link": s["link"]}
                for s in data for c in s.get("cmeInputs", [])[:1] if c["isMostAccurate"]
                for i in s.get("impactList") or [] if i["location"] == "Mars"
            ]
            data.sort(key=lambda e: e["arrivalTime"])
        dest.write_text(json.dumps(data, indent=1))


def fetch_geounits() -> None:
    if SIM3464_DEST.exists():
        print(f"= {SIM3464_DEST.name} (cached)")
        return
    print(f"↓ {SIM3464_DEST.name}")
    q = {"geometry": f"{LON_MIN},{LAT_MIN},{LON_MAX},{LAT_MAX}", "geometryType": "esriGeometryEnvelope",
         "inSR": 4326, "outSR": 4326, "maxAllowableOffset": 0.0002,
         "outFields": "name,symbol,Unit_Description,Unit_Interpretation", "f": "geojson"}
    gj = get_json(f"{SIM3464}?{urllib.parse.urlencode(q)}")
    if not gj.get("features"):
        raise ValueError(f"SIM 3464: no features: {str(gj)[:200]}")
    SIM3464_DEST.write_text(json.dumps(gj, separators=(",", ":")))


def trek_tile(z: int, lon: float, lat: float) -> tuple[int, int]:
    return math.floor((90 - lat) / 180 * 2**z), math.floor((lon + 180) / 360 * 2 * 2**z)


def fetch_trek(z: int, bbox: tuple[float, float, float, float], dest: Path = TREK_DIR) -> tuple[int, int]:
    r0, c0 = trek_tile(z, bbox[0], bbox[3])
    r1, c1 = trek_tile(z, bbox[2], bbox[1])
    todo = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)
            if not (dest / str(z) / str(r) / f"{c}.png").exists()]

    def one(rc):
        r, c = rc
        out = dest / str(z) / str(r) / f"{c}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        for i in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(TREK.format(z=z, row=r, col=c), headers=UA),
                                            timeout=60) as resp:
                    tmp = out.with_suffix(".part")
                    tmp.write_bytes(resp.read())
                    tmp.rename(out)
                return True
            except Exception:
                time.sleep(2 * (i + 1))
        return False

    total = (r1 - r0 + 1) * (c1 - c0 + 1)
    print(f"↓ trek z{z}: {len(todo)}/{total} tiles to fetch")
    with ThreadPoolExecutor(8) as ex:
        missing = sum(not ok for ok in ex.map(one, todo))
    return total, missing


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
    for name, fn in (("DONKI", fetch_donki), ("SIM3464", fetch_geounits)):
        try:
            fn()
        except Exception as e:
            failed.append(f"{name}: {e}")
    for z, bbox in [(15, (LON_MIN, LAT_MIN, LON_MAX, LAT_MAX))]:
        try:
            total, missing = fetch_trek(z, bbox)
            if missing:
                failed.append(f"Trek z{z}: {missing}/{total} tiles missing (re-run to retry)")
        except Exception as e:
            failed.append(f"Trek z{z}: {e}")
    for f in failed:
        print(f"✗ {f}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
