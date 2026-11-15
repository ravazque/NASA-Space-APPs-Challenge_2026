import csv
import io
import json
import urllib.request
from collections import defaultdict

from aoi import WEB_DATA

SOL = 1210
BASE = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
DERIVED = f"{BASE}/data_derived_env/sol_1140_1259/sol_{SOL}/WE__{SOL}___________"
CALIBRATED = f"{BASE}/data_calibrated_env/sol_1140_1259/sol_{SOL}/WE__{SOL}___________"
FILES = {
    "ps": DERIVED + "DER_PS__________________P01.CSV",
    "anc": DERIVED + "DER_ANCILLARY___________P01.CSV",
    "ats": CALIBRATED + "CAL_ATS_________________P01.CSV",
}
SENSOR = "ATS_LOCAL_TEMP2"
MIN_ELEVATION = 20
WINDOW_HOURS = 4


def hourly(url, column, convert=lambda v: v):
    text = urllib.request.urlopen(url, timeout=60).read().decode()
    samples = defaultdict(list)
    for row in csv.DictReader(io.StringIO(text)):
        day, time_of_day = row["LTST"].split()
        if int(day) == SOL and row[column]:
            samples[int(time_of_day[:2])].append(convert(float(row[column])))
    assert len(samples) >= 23, f"{column}: {len(samples)} hours"
    return [
        round(sum(samples[h]) / len(samples[h]), 2) if h in samples else None
        for h in range(24)
    ]


def round1(value):
    return value if value is None else round(value, 1)


def present(values):
    return [v for v in values if v is not None]


def best_window_start(air_temp, elevation):
    candidates = []
    for start in range(24 - WINDOW_HOURS + 1):
        hours = range(start, start + WINDOW_HOURS)
        if all(elevation[h] is not None and elevation[h] >= MIN_ELEVATION for h in hours):
            candidates.append(start)
    return max(candidates, key=lambda s: sum(air_temp[s:s + WINDOW_HOURS]))


pressure = hourly(FILES["ps"], "PRESSURE")
air_temp = hourly(FILES["ats"], SENSOR, lambda kelvin: kelvin - 273.15)
elevation = hourly(FILES["anc"], "SOLAR_ZENITHAL_ANGLE", lambda zenith: 90 - zenith)
start = best_window_start(air_temp, elevation)

out = {
    "sol": SOL,
    "date_utc": "2024-07-15",
    "t_air_c": [round1(v) for v in air_temp],
    "eva_window": {
        "start_h": start,
        "end_h": start + WINDOW_HOURS,
        "rule": (
            f"{WINDOW_HOURS} consecutive LTST hours with sun elevation >= {MIN_ELEVATION} deg "
            f"and the warmest mean air temperature ({SENSOR})"
        ),
    },
    "src": {
        "pressure": FILES["ps"],
        "ancillary": FILES["anc"],
        "air_temp": FILES["ats"],
        "sensor": SENSOR,
        "binning": "hourly mean by LTST hour of sol 1210",
    },
    "credit": (
        "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU. "
        "Hourly means by Ariadne."
    ),
}
(WEB_DATA / "meda_sol1210.json").write_text(json.dumps(out, separators=(",", ":")))

assert all(700 < v < 800 for v in present(pressure))
assert all(-100 < v < 20 for v in present(air_temp))
assert max(present(elevation)) > 30 and min(present(elevation)) < -30
print(
    out["eva_window"],
    min(present(pressure)), max(present(pressure)),
    min(present(air_temp)), max(present(air_temp)),
    max(present(elevation)),
)
