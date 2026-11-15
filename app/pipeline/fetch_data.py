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
THEMIS = (
    "https://asc-astropedia.s3.us-west-2.amazonaws.com/Mars/Odyssey/"
    "THEMIS-Global-Thermal-Inertia-Mosaic/Quantitative-32-Bit/"
    "THEMIS_TI_Mosaic_Quant_00N060E_100mpp.cub"
)
HIRISE_DTM = (
    f"{USGS}/HiRISE/"
    "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
)

FILES = {
    RAW / "M20_waypoints.json": f"{MMGIS}/M20_waypoints.json",
    RAW / "M20_traverse.json": f"{MMGIS}/M20_traverse.json",
    RAW / "crism_jezero_minerals.tif": f"{ZENODO}/jezeroFinal.tif/content",
    RAW / "crism_jezero_readme.pdf": f"{ZENODO}/Jezero_readme.pdf/content",
}

RASTER_CROPS = {
    RAW / "dtm_aoi_1m.tif": HIRISE_DTM,
    RAW / "themis_ti_aoi_100m.tif": THEMIS,
}

DONKI_URL = (
    "https://api.nasa.gov/DONKI/WSAEnlilSimulations"
    "?startDate=2024-05-01&endDate=2024-05-31&api_key={key}"
)
DONKI_DEST = CACHE / "donki_mars_2024-05.json"

SIM3464 = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Jezero_FeatureServiceFromPro/FeatureServer/8/query"
)
SIM3464_DEST = CACHE / "sim3464_units.geojson"

TREK = (
    "https://trek.nasa.gov/tiles/Mars/EQ/"
    "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/"
    "1.0.0/default/default028mm/{z}/{row}/{col}.png"
)
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
    env_file = ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
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
    with urllib.request.urlopen(url, timeout=120) as response, open(tmp, "wb") as f:
        while chunk := response.read(1 << 20):
            f.write(chunk)
    tmp.rename(dest)


def crop_remote(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"= {dest.name} (cached)")
        return
    print(f"↓ {dest.name} (AOI window only)")
    with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as src:
        window = from_bounds(LEFT, BOTTOM, RIGHT, TOP, src.transform)
        window = window.round_offsets().round_lengths()
        window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        data = src.read(window=window)
        profile = src.profile | {
            "driver": "GTiff",
            "width": window.width,
            "height": window.height,
            "transform": src.window_transform(window),
            "compress": "deflate",
            "tiled": True,
            "blockxsize": 256,
            "blockysize": 256,
        }
        tmp = dest.with_suffix(".part.tif")
        with rasterio.open(tmp, "w", **profile) as dst:
            dst.write(data)
    tmp.rename(dest)


def get_json(url: str, retries: int = 3):
    request = urllib.request.Request(url, headers=UA)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def mars_impacts(simulations: list) -> list:
    events = []
    for simulation in simulations:
        for cme in simulation.get("cmeInputs", [])[:1]:
            if not cme["isMostAccurate"]:
                continue
            for impact in simulation.get("impactList") or []:
                if impact["location"] != "Mars":
                    continue
                events.append({
                    "simulationID": simulation["simulationID"],
                    "cmeStartTime": cme["cmeStartTime"],
                    "speed": cme["speed"],
                    "halfAngle": cme["halfAngle"],
                    "arrivalTime": impact["arrivalTime"],
                    "isGlancingBlow": impact["isGlancingBlow"],
                    "link": simulation["link"],
                })
    events.sort(key=lambda event: event["arrivalTime"])
    return events


def fetch_donki() -> None:
    if DONKI_DEST.exists():
        print(f"= {DONKI_DEST.name} (cached)")
        return
    print(f"↓ {DONKI_DEST.name}")
    data = get_json(DONKI_URL.format(key=nasa_api_key()))
    if not isinstance(data, list):
        raise ValueError(f"unexpected DONKI response: {str(data)[:200]}")
    DONKI_DEST.write_text(json.dumps(mars_impacts(data), indent=1))


def fetch_geounits() -> None:
    if SIM3464_DEST.exists():
        print(f"= {SIM3464_DEST.name} (cached)")
        return
    print(f"↓ {SIM3464_DEST.name}")
    query = {
        "geometry": f"{LON_MIN},{LAT_MIN},{LON_MAX},{LAT_MAX}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "outSR": 4326,
        "maxAllowableOffset": 0.0002,
        "outFields": "name,symbol,Unit_Description,Unit_Interpretation",
        "f": "geojson",
    }
    geojson = get_json(f"{SIM3464}?{urllib.parse.urlencode(query)}")
    if not geojson.get("features"):
        raise ValueError(f"SIM 3464: no features: {str(geojson)[:200]}")
    SIM3464_DEST.write_text(json.dumps(geojson, separators=(",", ":")))


def trek_tile(z: int, lon: float, lat: float) -> tuple[int, int]:
    row = math.floor((90 - lat) / 180 * 2**z)
    col = math.floor((lon + 180) / 360 * 2 * 2**z)
    return row, col


def download_trek_tile(z: int, row: int, col: int, dest: Path) -> bool:
    out = dest / str(z) / str(row) / f"{col}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(TREK.format(z=z, row=row, col=col), headers=UA)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                tmp = out.with_suffix(".part")
                tmp.write_bytes(response.read())
                tmp.rename(out)
            return True
        except Exception:
            time.sleep(2 * (attempt + 1))
    return False


def fetch_trek(
    z: int, bbox: tuple[float, float, float, float], dest: Path = TREK_DIR
) -> tuple[int, int]:
    row0, col0 = trek_tile(z, bbox[0], bbox[3])
    row1, col1 = trek_tile(z, bbox[2], bbox[1])
    todo = []
    for row in range(row0, row1 + 1):
        for col in range(col0, col1 + 1):
            if not (dest / str(z) / str(row) / f"{col}.png").exists():
                todo.append((row, col))

    total = (row1 - row0 + 1) * (col1 - col0 + 1)
    print(f"↓ trek z{z}: {len(todo)}/{total} tiles to fetch")
    with ThreadPoolExecutor(8) as pool:
        results = pool.map(lambda tile: download_trek_tile(z, *tile, dest), todo)
        missing = sum(not ok for ok in results)
    return total, missing


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    failed = []

    jobs = [(download, url, dest) for dest, url in FILES.items()]
    jobs += [(crop_remote, url, dest) for dest, url in RASTER_CROPS.items()]
    for job, url, dest in jobs:
        try:
            job(url, dest)
        except Exception as e:
            failed.append(f"{dest.name}: {e}")

    for name, fetch in (("DONKI", fetch_donki), ("SIM3464", fetch_geounits)):
        try:
            fetch()
        except Exception as e:
            failed.append(f"{name}: {e}")

    z = 15
    try:
        total, missing = fetch_trek(z, (LON_MIN, LAT_MIN, LON_MAX, LAT_MAX))
        if missing:
            failed.append(f"Trek z{z}: {missing}/{total} tiles missing (re-run to retry)")
    except Exception as e:
        failed.append(f"Trek z{z}: {e}")

    for message in failed:
        print(f"✗ {message}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
