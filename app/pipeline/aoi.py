import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CACHE = ROOT / "data" / "cache"
WEB_DATA = ROOT / "web" / "data"

MARS_R = 3396190.0
LON_MIN, LON_MAX = 77.295, 77.415
LAT_MIN, LAT_MAX = 18.440, 18.505
CELL_M = 20.0

CRS_WKT = (
    'PROJCS["Equirectangular Mars 2000 Sphere IAU",GEOGCS["Mars 2000 Sphere",'
    'DATUM["Mars_2000_Sphere",SPHEROID["Mars_2000_Sphere_IAU",3396190,0]],'
    'PRIMEM["Reference_Meridian",0],UNIT["Degree",0.0174532925199433]],'
    'PROJECTION["Equirectangular"],PARAMETER["standard_parallel_1",0],'
    'PARAMETER["central_meridian",0],PARAMETER["false_easting",0],'
    'PARAMETER["false_northing",0],UNIT["metre",1]]'
)


def to_m(deg: float) -> float:
    return MARS_R * math.radians(deg)


LEFT, RIGHT = to_m(LON_MIN), to_m(LON_MAX)
BOTTOM, TOP = to_m(LAT_MIN), to_m(LAT_MAX)
COLS = round((RIGHT - LEFT) / CELL_M)
ROWS = round((TOP - BOTTOM) / CELL_M)


def lonlat_to_cell(lon: float, lat: float) -> tuple[int, int]:
    return int((TOP - to_m(lat)) // CELL_M), int((to_m(lon) - LEFT) // CELL_M)


SITES = {
    "three_forks": {"name": "Three Forks (depósito de muestras)", "sol": 632, "lon": 77.40126, "lat": 18.45133},
    "cheyava_falls": {"name": "Cheyava Falls (Bright Angel)", "sol": 1210, "lon": 77.30519, "lat": 18.49748},
}
