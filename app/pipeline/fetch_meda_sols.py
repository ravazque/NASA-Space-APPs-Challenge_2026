import csv
import hashlib
import io
import json
import math
import os
import re
import tempfile
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aoi import WEB_DATA

BASE = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
SOLS = [658, 719, 784, 851, 915, 975, 1030, 1080, 1127, 1173, 1210, 1271, 200, 313]
JEZERO_LON_E = 77.4508
NEIGHBOUR_SOLS = 3

DEFAULT_CACHE = Path(tempfile.gettempdir()) / "ariadne_meda_cache"
CACHE = Path(os.environ.get("ARIADNE_CACHE", DEFAULT_CACHE))
CACHE.mkdir(parents=True, exist_ok=True)

# Mars24 (Allison & McEwen 2000) planetary perturbers: amplitude, period, phase
PERTURBERS = [
    (0.0071, 2.2353, 49.409),
    (0.0057, 2.7543, 168.173),
    (0.0039, 1.1177, 191.837),
    (0.0037, 15.7866, 21.736),
    (0.0021, 2.1354, 15.704),
    (0.0020, 2.4694, 95.528),
    (0.0018, 32.8493, 49.095),
]

VALID_RANGE = {
    "PRESSURE": (300, 1200),
    "ATS_LOCAL_TEMP2": (100, 330),
    "GROUND_TEMP": (100, 350),
    "LOCAL_RELATIVE_HUMIDITY": (0, 100),
    "SOLAR_ZENITHAL_ANGLE": (0, 180),
    "HORIZONTAL_WIND_SPEED": (0, 60),
    "WIND_DIRECTION": (0, 360),
}
USABLE_RANGES = (
    ("p_pa", 400, 1100),
    ("t_air_c", -110, 30),
    ("t_ground_c", -130, 60),
    ("sza_deg", -1, 181),
)
REQUIRED_PRODUCTS = ("DER_PS", "DER_ANCILLARY", "CAL_ATS", "CAL_TIRS")
ALL_PRODUCTS = REQUIRED_PRODUCTS + ("DER_RHS", "DER_WS")


def get(url):
    cached = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if cached.exists():
        return cached.read_text()
    for attempt in range(3):
        try:
            text = urllib.request.urlopen(url, timeout=120).read().decode()
            break
        except Exception as e:
            if attempt == 2:
                raise
            print("  retry", url.rsplit("/", 1)[1], e)
    cached.write_text(text)
    return text


def sin_degrees(multiple, angle):
    return math.sin(math.radians(multiple * angle))


def solar_longitude(sol):
    msd = 52304 + sol + 0.5 - JEZERO_LON_E / 360
    days_since_epoch = (msd + 0.0009626 - 44796.0) * 1.0274912517 + 4.5
    mean_anomaly = 19.3871 + 0.52402073 * days_since_epoch
    perturbation = sum(
        amplitude * math.cos(math.radians(0.985626 * days_since_epoch / period + phase))
        for amplitude, period, phase in PERTURBERS
    )

    equation_of_center = (
        (10.691 + 3e-7 * days_since_epoch) * sin_degrees(1, mean_anomaly)
        + 0.623 * sin_degrees(2, mean_anomaly)
        + 0.050 * sin_degrees(3, mean_anomaly)
        + 0.005 * sin_degrees(4, mean_anomaly)
        + 0.0005 * sin_degrees(5, mean_anomaly)
        + perturbation
    )
    ls = (270.3871 + 0.524038496 * days_since_epoch + equation_of_center) % 360
    epoch = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
    date = epoch + timedelta(days=days_since_epoch - 0.0008 - 69.184 / 86400)
    return ls, date.strftime("%Y-%m-%d")


_sol_ranges = {}


def sol_ranges(kind):
    if kind not in _sol_ranges:
        _sol_ranges[kind] = re.findall(r"sol_(\d+)_(\d+)/", get(f"{BASE}/{kind}/"))
    return _sol_ranges[kind]


def list_products(kind, sol):
    bounds = next(((lo, hi) for lo, hi in sol_ranges(kind) if int(lo) <= sol <= int(hi)), None)
    if not bounds:
        return {}
    folder = f"{BASE}/{kind}/sol_{bounds[0]}_{bounds[1]}/sol_{sol:04d}/"
    try:
        html = get(folder)
    except Exception:
        return {}
    pattern = r"WE__\d{4}_+(DER|CAL)_([A-Z]+)_+P\d\d\.CSV"
    return {f"{m[1]}_{m[2]}": folder + m[0] for m in re.finditer(pattern, html)}


def find_products(sol):
    found = list_products("data_derived_env", sol) | list_products("data_calibrated_env", sol)
    products = {name: found.get(name) for name in ALL_PRODUCTS}
    if all(products[name] for name in REQUIRED_PRODUCTS):
        return products
    return None


def hourly(url, columns, sol):
    rows = csv.DictReader(io.StringIO(get(url)))
    samples = [defaultdict(list) for _ in columns]
    for row in rows:
        day, time_of_day = row["LTST"].split()
        if int(day) != sol:
            continue
        for by_hour, column in zip(samples, columns):
            if row[column] in ("", None):
                continue
            value = float(row[column])
            low, high = VALID_RANGE[column]
            if low <= value <= high:
                by_hour[int(time_of_day[:2])].append(value)
    return [[by_hour.get(h) for h in range(24)] for by_hour in samples]


def mean(values, digits=2):
    if values is None:
        return None
    return round(sum(values) / len(values), digits)


def series(url, column, sol, convert=lambda v: v, digits=2):
    result = []
    for values in hourly(url, [column], sol)[0]:
        converted = None if values is None else [convert(v) for v in values]
        result.append(mean(converted, digits))
    return result


def wind_direction(degrees):
    if degrees is None:
        return None
    radians = [math.radians(d) for d in degrees]
    east = sum(math.sin(r) for r in radians)
    north = sum(math.cos(r) for r in radians)
    return round(math.degrees(math.atan2(east, north)) % 360)


def present(values):
    return [v for v in values if v is not None]


def is_usable(record):
    for key, low, high in USABLE_RANGES:
        values = present(record[key])
        if len(values) < 20 or not all(low < v < high for v in values):
            return False
    return True


def kelvin_to_celsius(kelvin):
    return kelvin - 273.15


def read_sol(sol, products):
    ls, date = solar_longitude(sol)
    record = {
        "sol": sol,
        "ls": round(ls, 1),
        "date_utc": date,
        "src": {name.lower(): url for name, url in products.items() if url},
    }
    record["p_pa"] = series(products["DER_PS"], "PRESSURE", sol, digits=1)
    record["t_air_c"] = series(
        products["CAL_ATS"], "ATS_LOCAL_TEMP2", sol, kelvin_to_celsius, 1
    )
    record["t_ground_c"] = series(
        products["CAL_TIRS"], "GROUND_TEMP", sol, kelvin_to_celsius, 1
    )
    if products["DER_RHS"]:
        record["rh_pct"] = series(
            products["DER_RHS"], "LOCAL_RELATIVE_HUMIDITY", sol, digits=1
        )
    else:
        record["rh_pct"] = [None] * 24
    if products["DER_WS"]:
        speed, direction = hourly(
            products["DER_WS"], ["HORIZONTAL_WIND_SPEED", "WIND_DIRECTION"], sol
        )
        record["wind_ms"] = [mean(v, 1) for v in speed]
        record["wind_dir_deg"] = [wind_direction(v) for v in direction]
    else:
        record["wind_ms"] = None
        record["wind_dir_deg"] = None
    record["sza_deg"] = series(
        products["DER_ANCILLARY"], "SOLAR_ZENITHAL_ANGLE", sol, digits=1
    )
    return record


def build(target):
    offsets = sorted(range(-NEIGHBOUR_SOLS, NEIGHBOUR_SOLS + 1), key=lambda k: (abs(k), k))
    for offset in offsets:
        sol = target + offset
        products = find_products(sol)
        if not products:
            continue
        record = read_sol(sol, products)
        if not is_usable(record):
            print(f"sol {sol}: too few valid hours, trying the next", flush=True)
            continue
        if offset:
            record["substitutedFor"] = target
        note = f" (substitutes {target})" if offset else ""
        print(
            f"sol {record['sol']}{note}", f"Ls {record['ls']}", record["date_utc"], flush=True
        )
        return record
    raise SystemExit(f"sol {target}: no usable sol within {NEIGHBOUR_SOLS}")


out = {
    "credit": (
        "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU. "
        "Hourly means by LTST hour, by Ariadne."
    ),
    "base": BASE,
    "binning": "hourly mean by LTST hour 0-23 of the sol; null = no valid sample in that hour",
    "air_sensor": "ATS_LOCAL_TEMP2 (RSM mast unit at 155 deg), as meda_sol1210.json",
    "ground_sensor": "CAL_TIRS GROUND_TEMP (IR radiometer, K -> C)",
    "ls": (
        "Mars24 (Allison & McEwen 2000) at LTST 12; "
        "not the MEDA SOLAR_LONGITUDE_ANGLE column"
    ),
    "sols": list(ThreadPoolExecutor(4).map(build, SOLS)),
}
out["sols"].sort(key=lambda sol_record: sol_record["ls"])

reference = json.loads((WEB_DATA / "meda_sol1210.json").read_text())["t_air_c"]
computed = next(s for s in out["sols"] if s["sol"] == 1210)["t_air_c"]
assert all(
    a is None or b is None or abs(a - b) <= 0.05 for a, b in zip(reference, computed)
), "sol 1210 differs from meda_sol1210.json"

(WEB_DATA / "env").mkdir(exist_ok=True)
(WEB_DATA / "env" / "meda_sols.json").write_text(json.dumps(out, separators=(",", ":")))
print("sols:", [(s["sol"], s["ls"], s["wind_ms"] is not None) for s in out["sols"]])
