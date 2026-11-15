import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CACHE = ROOT / "data" / "cache"
WEB_DATA = ROOT / "web" / "data"

MARS_R = 3396190.0
LON_MIN = 77.295
LON_MAX = 77.415
LAT_MIN = 18.440
LAT_MAX = 18.505
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


LEFT = to_m(LON_MIN)
RIGHT = to_m(LON_MAX)
BOTTOM = to_m(LAT_MIN)
TOP = to_m(LAT_MAX)
COLS = round((RIGHT - LEFT) / CELL_M)
ROWS = round((TOP - BOTTOM) / CELL_M)


def lonlat_to_cell(lon: float, lat: float) -> tuple[int, int]:
    row = int((TOP - to_m(lat)) // CELL_M)
    col = int((to_m(lon) - LEFT) // CELL_M)
    return row, col


SITES = {
    "three_forks": {
        "name": "Three Forks (depósito de muestras)",
        "sol": 693,
        "lon": 77.40821,
        "lat": 18.45296,
    },
    "cheyava_falls": {
        "name": "Cheyava Falls (Sapphire Canyon)",
        "sol": 1210,
        "work_sols": [1215, 1219],
        "lon": 77.30519,
        "lat": 18.49748,
    },
}
