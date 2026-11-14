import io
import json
import time
import urllib.request

import numpy as np
from PIL import Image

from aoi import CACHE, ROOT

OUT = ROOT / "web" / "data" / "pov"
WP = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
NIA = "https://images-assets.nasa.gov/image/{0}/{0}~{1}.jpg"
NIA_API = "https://images-api.nasa.gov/search?nasa_id="


def get(url):
    time.sleep(1)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ariadne-pipeline"}), timeout=120) as r:
        return r.read()


def jget(url):
    return json.loads(get(url))


def save(img, name, width, q=80):
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.convert("RGB").save(OUT / name, "WEBP", quality=q, method=6)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    wpf = CACHE / "M20_waypoints.json"
    if not wpf.exists():
        wpf.write_bytes(get(WP))
    wps = {}
    for f in json.loads(wpf.read_text())["features"]:
        p = f["properties"]
        wps[(p["site"], str(p["drive"]), p["sol"])] = (p["lon"], p["lat"])
    by_sd = {k[:2]: v for k, v in wps.items()}
    by_sol = {}
    for (s, d, sol), v in wps.items():
        by_sol.setdefault(sol, v)

    items = []

    pj = [
        ("PIA26369", "orig", "destination-pano", "pano_bright_angel.webp", 4096, 1178, by_sol[1177],
         "Mastcam-Z (346 frames, enhanced colour)",
         "Panorámica de 360° de Bright Angel, color realzado, sol 1178. Cheyava Falls queda algo a la derecha del centro, a unos 110 m.",
         "360° panorama of Bright Angel, enhanced colour, sol 1178. Cheyava Falls is slightly right of centre, about 110 m away."),
        ("PIA26401", "large", "destination-rock", "cheyava_workspace.webp", 1024, 1217, by_sd[(56, "0")],
         "Mastcam-Z",
         "Zona de trabajo de Cheyava Falls, sol 1217: orificio de perforación (izquierda) y parche de abrasión de Steamboat Mountain.",
         "Cheyava Falls workspace, sol 1217: drill hole (left) and the Steamboat Mountain abrasion patch."),
        ("PIA26370", "medium", "science", "leopard_spots_drill.webp", 1024, 1215, by_sd[(56, "0")],
         "Mastcam-Z",
         "Manchas de leopardo en la broca, sol 1215: biofirma potencial (no confirmada).",
         "Leopard spots in the drill bit, sol 1215: potential biosignature (unconfirmed)."),
        ("PIA26368", "medium", "science", "leopard_spots_watson.webp", 1024, 1212, by_sd[(56, "0")],
         "WATSON (SHERLOC)",
         "Cheyava Falls visto por WATSON, sol 1212: vetas de sulfato de calcio y manchas con halo oscuro.",
         "Cheyava Falls seen by WATSON, sol 1212: calcium sulfate veins and dark-rimmed spots."),
    ]
    for pid, size, role, name, width, sol, (lon, lat), instr, es, en in pj:
        meta = jget(NIA_API + pid)["collection"]["items"][0]["data"][0]
        assert meta["nasa_id"] == pid
        img = Image.open(io.BytesIO(get(NIA.format(pid, size))))
        if role == "destination-pano":
            a = np.asarray(img.convert("L"))
            rows = np.where(a.mean(axis=1) > 8)[0]
            img = img.crop((0, 0, img.width, rows.max() + 1))
        save(img, name, width, 82 if role == "destination-pano" else 80)
        items.append(dict(file=name, role=role, sol=sol, date_utc=None, instrument=instr,
                          credit=meta["secondary_creator"], source_url=f"https://photojournal.jpl.nasa.gov/catalog/{pid}",
                          lon=lon, lat=lat, caption_es=es, caption_en=en, title=meta["title"]))

    pia_dates = {"PIA26369": "2024-06-12", "PIA26401": "2024-07-23", "PIA26370": "2024-07-21", "PIA26368": "2024-07-18"}
    for it in items:
        pid = it["source_url"].rsplit("/", 1)[-1]
        if pid in pia_dates:
            it["date_utc"] = pia_dates[pid]
    (OUT / "pov.json").write_text(json.dumps(items, indent=1, ensure_ascii=False))
    tot = sum(f.stat().st_size for f in OUT.glob("*.webp"))
    print(f"{len(items)} items, {tot/1e6:.2f} MB")


if __name__ == "__main__":
    main()
