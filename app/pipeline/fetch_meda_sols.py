import csv, hashlib, io, json, math, os, re, tempfile, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from aoi import WEB_DATA

B = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
SOLS = [658, 719, 784, 851, 915, 975, 1030, 1080, 1127, 1173, 1210, 1271, 200, 313]
LON_E = 77.4508


CACHE = Path(os.environ.get("ARIADNE_CACHE", Path(tempfile.gettempdir()) / "ariadne_meda_cache"))
CACHE.mkdir(parents=True, exist_ok=True)


def get(url):
    f = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if f.exists(): return f.read_text()
    for i in range(3):
        try: txt = urllib.request.urlopen(url, timeout=120).read().decode(); break
        except Exception as e:
            if i == 2: raise
            print("  retry", url.rsplit("/", 1)[1], e)
    f.write_text(txt)
    return txt


def ls_of(sol):
    msd = 52304 + sol + 0.5 - LON_E / 360
    dt = (msd + 0.0009626 - 44796.0) * 1.0274912517 + 4.5
    M = 19.3871 + 0.52402073 * dt
    pbs = sum(A * math.cos(math.radians(0.985626 * dt / tau + phi)) for A, tau, phi in
              [(0.0071, 2.2353, 49.409), (0.0057, 2.7543, 168.173), (0.0039, 1.1177, 191.837), (0.0037, 15.7866, 21.736),
               (0.0021, 2.1354, 15.704), (0.0020, 2.4694, 95.528), (0.0018, 32.8493, 49.095)])
    s = lambda k: math.sin(math.radians(k * M))
    nu_m = (10.691 + 3e-7 * dt) * s(1) + 0.623 * s(2) + 0.050 * s(3) + 0.005 * s(4) + 0.0005 * s(5) + pbs
    ls = (270.3871 + 0.524038496 * dt + nu_m) % 360
    date = datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=dt - 0.0008 - 69.184 / 86400)
    return ls, date.strftime("%Y-%m-%d")


_listings = {}
def listing(kind, sol):
    if kind not in _listings: _listings[kind] = re.findall(r"sol_(\d+)_(\d+)/", get(f"{B}/{kind}/"))
    lo_hi = next(((a, b) for a, b in _listings[kind] if int(a) <= sol <= int(b)), None)
    if not lo_hi: return {}
    d = f"{B}/{kind}/sol_{lo_hi[0]}_{lo_hi[1]}/sol_{sol:04d}/"
    try: html = get(d)
    except Exception: return {}
    return {f"{m[1]}_{m[2]}": d + m[0] for m in re.finditer(r"WE__\d{4}_+(DER|CAL)_([A-Z]+)_+P\d\d\.CSV", html)}


def products(sol):
    found = listing("data_derived_env", sol) | listing("data_calibrated_env", sol)
    p = {k: found.get(k) for k in ("DER_PS", "DER_ANCILLARY", "CAL_ATS", "CAL_TIRS", "DER_RHS", "DER_WS")}
    return p if all(p[k] for k in ("DER_PS", "DER_ANCILLARY", "CAL_ATS", "CAL_TIRS")) else None


VALID = {"PRESSURE": (300, 1200), "ATS_LOCAL_TEMP2": (100, 330), "GROUND_TEMP": (100, 350), "LOCAL_RELATIVE_HUMIDITY": (0, 100),
         "SOLAR_ZENITHAL_ANGLE": (0, 180), "HORIZONTAL_WIND_SPEED": (0, 60), "WIND_DIRECTION": (0, 360)}


def hourly(url, cols, sol, f=lambda v: v):
    rows = csv.DictReader(io.StringIO(get(url)))
    acc = [defaultdict(list) for _ in cols]
    for r in rows:
        day, t = r["LTST"].split()
        if int(day) != sol: continue
        for a, c in zip(acc, cols):
            if r[c] in ("", None): continue
            v = float(r[c]); lo, hi = VALID[c]
            if lo <= v <= hi: a[int(t[:2])].append(v)
    return [[None if h not in a else a[h] for h in range(24)] for a in acc]


mean = lambda xs, d=2: None if xs is None else round(sum(xs) / len(xs), d)
def series(url, col, sol, f=lambda v: v, d=2):
    return [mean(None if v is None else [f(x) for x in v], d) for v in hourly(url, [col], sol)[0]]


def wind_dir(vs):
    if vs is None: return None
    return round(math.degrees(math.atan2(sum(math.sin(math.radians(v)) for v in vs), sum(math.cos(math.radians(v)) for v in vs))) % 360)


nn = lambda a: [v for v in a if v is not None]
RANGES = (("p_pa", 400, 1100), ("t_air_c", -110, 30), ("t_ground_c", -130, 60), ("sza_deg", -1, 181))
usable = lambda o: all(len(nn(o[k])) >= 20 and all(lo < v < hi for v in nn(o[k])) for k, lo, hi in RANGES)


def read_sol(sol, p):
    ls, date = ls_of(sol)
    o = {"sol": sol, "ls": round(ls, 1), "date_utc": date, "src": {n.lower(): u for n, u in p.items() if u}}
    o["p_pa"] = series(p["DER_PS"], "PRESSURE", sol, d=1)
    o["t_air_c"] = series(p["CAL_ATS"], "ATS_LOCAL_TEMP2", sol, lambda k_: k_ - 273.15, 1)
    o["t_ground_c"] = series(p["CAL_TIRS"], "GROUND_TEMP", sol, lambda k_: k_ - 273.15, 1)
    o["rh_pct"] = series(p["DER_RHS"], "LOCAL_RELATIVE_HUMIDITY", sol, d=1) if p["DER_RHS"] else [None] * 24
    if p["DER_WS"]:
        sp, di = hourly(p["DER_WS"], ["HORIZONTAL_WIND_SPEED", "WIND_DIRECTION"], sol)
        o["wind_ms"], o["wind_dir_deg"] = [mean(v, 1) for v in sp], [wind_dir(v) for v in di]
    else: o["wind_ms"] = o["wind_dir_deg"] = None
    o["sza_deg"] = series(p["DER_ANCILLARY"], "SOLAR_ZENITHAL_ANGLE", sol, d=1)
    return o


def build(target):
    for k in sorted(range(-3, 4), key=lambda k: (abs(k), k)):
        p = products(target + k)
        if not p: continue
        o = read_sol(target + k, p)
        if usable(o): break
        print(f"sol {target + k}: too few valid hours, trying the next", flush=True)
    else: raise SystemExit(f"sol {target}: no usable sol within 3")
    if k: o["substitutedFor"] = target
    print(f"sol {o['sol']}" + (f" (substitutes {target})" if k else ""), f"Ls {o['ls']}", o["date_utc"], flush=True)
    return o


out = {"credit": "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU. Hourly means by LTST hour, by Ariadne.",
       "base": B, "binning": "hourly mean by LTST hour 0-23 of the sol; null = no valid sample in that hour",
       "air_sensor": "ATS_LOCAL_TEMP2 (RSM mast unit at 155 deg), as meda_sol1210.json",
       "ground_sensor": "CAL_TIRS GROUND_TEMP (IR radiometer, K -> C)",
       "ls": "Mars24 (Allison & McEwen 2000) at LTST 12; not the MEDA SOLAR_LONGITUDE_ANGLE column",
       "sols": list(ThreadPoolExecutor(4).map(build, SOLS))}
out["sols"].sort(key=lambda s: s["ls"])
ref = json.loads((WEB_DATA / "meda_sol1210.json").read_text())["t_air_c"]
mine = next(s for s in out["sols"] if s["sol"] == 1210)["t_air_c"]
assert all(a is None or b is None or abs(a - b) <= 0.05 for a, b in zip(ref, mine)), "sol 1210 differs from meda_sol1210.json"
(WEB_DATA / "env").mkdir(exist_ok=True)
(WEB_DATA / "env" / "meda_sols.json").write_text(json.dumps(out, separators=(",", ":")))
print("sols:", [(s["sol"], s["ls"], s["wind_ms"] is not None) for s in out["sols"]])
