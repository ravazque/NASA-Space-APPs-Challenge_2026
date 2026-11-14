import csv, io, json, urllib.request
from collections import defaultdict
from aoi import WEB_DATA

SOL = 1210
B = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
D = f"{B}/data_derived_env/sol_1140_1259/sol_{SOL}/WE__{SOL}___________"
C = f"{B}/data_calibrated_env/sol_1140_1259/sol_{SOL}/WE__{SOL}___________"
FILES = {"ps": D + "DER_PS__________________P01.CSV",
         "anc": D + "DER_ANCILLARY___________P01.CSV",
         "ats": C + "CAL_ATS_________________P01.CSV"}
SENSOR = "ATS_LOCAL_TEMP2"
MIN_ELEV, WIN_H = 20, 4


def hourly(url, col, f=lambda v: v):
    rows = csv.DictReader(io.StringIO(urllib.request.urlopen(url, timeout=60).read().decode()))
    acc = defaultdict(list)
    for r in rows:
        day, t = r["LTST"].split()
        if int(day) == SOL and r[col]:
            acc[int(t[:2])].append(f(float(r[col])))
    assert len(acc) >= 23, f"{col}: {len(acc)} hours"
    return [round(sum(acc[h]) / len(acc[h]), 2) if h in acc else None for h in range(24)]


p = hourly(FILES["ps"], "PRESSURE")
t = hourly(FILES["ats"], SENSOR, lambda k: k - 273.15)
r1 = lambda v: v if v is None else round(v, 1)
e = hourly(FILES["anc"], "SOLAR_ZENITHAL_ANGLE", lambda z: 90 - z)
ok = [s for s in range(24 - WIN_H + 1) if all(e[h] is not None and e[h] >= MIN_ELEV for h in range(s, s + WIN_H))]
s = max(ok, key=lambda s: sum(t[s:s + WIN_H]))
out = {"sol": SOL, "date_utc": "2024-07-15", "ltst_h": list(range(24)),
       "p_pa": p, "t_air_c": [r1(v) for v in t], "sun_elev_deg": [r1(v) for v in e],
       "eva_window": {"start_h": s, "end_h": s + WIN_H,
                      "rule": f"{WIN_H} consecutive LTST hours with sun elevation >= {MIN_ELEV} deg and the warmest mean air temperature ({SENSOR})"},
       "src": {"pressure": FILES["ps"], "ancillary": FILES["anc"], "air_temp": FILES["ats"],
               "sensor": SENSOR, "binning": "hourly mean by LTST hour of sol 1210"},
       "credit": "Mars 2020 Perseverance MEDA (CAB/CAB-IAA), PDS Atmospheres Node, NMSU. Hourly means by Ariadne."}
(WEB_DATA / "meda_sol1210.json").write_text(json.dumps(out, separators=(",", ":")))
ok_ = lambda a: [v for v in a if v is not None]
assert all(700 < v < 800 for v in ok_(p)) and all(-100 < v < 20 for v in ok_(t)) and max(ok_(e)) > 30 and min(ok_(e)) < -30
print(out["eva_window"], min(ok_(p)), max(ok_(p)), min(ok_(t)), max(ok_(t)), max(ok_(e)))
