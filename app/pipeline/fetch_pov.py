import io
import json
import time
import urllib.request

import numpy as np
from PIL import Image

from aoi import CACHE, ROOT

OUT = ROOT / "web" / "data" / "pov"
WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
NIA = "https://images-assets.nasa.gov/image/{0}/{0}~{1}.jpg"
NIA_API = "https://images-api.nasa.gov/search?nasa_id="


def get(url):
    time.sleep(1)
    request = urllib.request.Request(url, headers={"User-Agent": "ariadne-pipeline"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def jget(url):
    return json.loads(get(url))


def save(img, name, width, quality=80):
    if img.width > width:
        height = round(img.height * width / img.width)
        img = img.resize((width, height), Image.LANCZOS)
    img.convert("RGB").save(OUT / name, "WEBP", quality=quality, method=6)


def load_waypoints():
    waypoints_file = CACHE / "M20_waypoints.json"
    if not waypoints_file.exists():
        waypoints_file.write_bytes(get(WAYPOINTS_URL))
    waypoints = {}
    for feature in json.loads(waypoints_file.read_text())["features"]:
        props = feature["properties"]
        key = (props["site"], str(props["drive"]), props["sol"])
        waypoints[key] = (props["lon"], props["lat"])
    return waypoints


def crop_black_bottom(img):
    brightness = np.asarray(img.convert("L"))
    rows = np.where(brightness.mean(axis=1) > 8)[0]
    return img.crop((0, 0, img.width, rows.max() + 1))


def check_waypoints(waypoints):
    by_site_drive = {key[:2]: position for key, position in waypoints.items()}
    by_sol = {}
    for (_site, _drive, sol), position in waypoints.items():
        by_sol.setdefault(sol, position)
    by_sol[1177]
    by_site_drive[(56, "0")]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    check_waypoints(load_waypoints())

    pictures = [
        dict(
            id="PIA26369",
            size="orig",
            role="destination-pano",
            name="pano_bright_angel.webp",
            width=4096,
            sol=1178,
            instrument="Mastcam-Z (346 frames, enhanced colour)",
            caption_es=(
                "Panorámica de 360° de Bright Angel, color realzado, sol 1178. "
                "Cheyava Falls queda algo a la derecha del centro, a unos 110 m."
            ),
            caption_en=(
                "360° panorama of Bright Angel, enhanced colour, sol 1178. "
                "Cheyava Falls is slightly right of centre, about 110 m away."
            ),
        ),
        dict(
            id="PIA26401",
            size="large",
            role="destination-rock",
            name="cheyava_workspace.webp",
            width=1024,
            sol=1217,
            instrument="Mastcam-Z",
            caption_es=(
                "Zona de trabajo de Cheyava Falls, sol 1217: orificio de perforación (izquierda) "
                "y parche de abrasión de Steamboat Mountain."
            ),
            caption_en=(
                "Cheyava Falls workspace, sol 1217: drill hole (left) and the Steamboat Mountain "
                "abrasion patch."
            ),
        ),
        dict(
            id="PIA26370",
            size="medium",
            role="science",
            name="leopard_spots_drill.webp",
            width=1024,
            sol=1215,
            instrument="Mastcam-Z",
            caption_es=(
                "Manchas de leopardo en la broca, sol 1215: "
                "biofirma potencial (no confirmada)."
            ),
            caption_en=(
                "Leopard spots in the drill bit, sol 1215: "
                "potential biosignature (unconfirmed)."
            ),
        ),
        dict(
            id="PIA26368",
            size="medium",
            role="science",
            name="leopard_spots_watson.webp",
            width=1024,
            sol=1212,
            instrument="WATSON (SHERLOC)",
            caption_es=(
                "Cheyava Falls visto por WATSON, sol 1212: vetas de sulfato de calcio "
                "y manchas con halo oscuro."
            ),
            caption_en=(
                "Cheyava Falls seen by WATSON, sol 1212: calcium sulfate veins "
                "and dark-rimmed spots."
            ),
        ),
    ]
    pia_dates = {
        "PIA26369": "2024-06-12",
        "PIA26401": "2024-07-23",
        "PIA26370": "2024-07-21",
        "PIA26368": "2024-07-18",
    }

    items = []
    for picture in pictures:
        pid = picture["id"]
        meta = jget(NIA_API + pid)["collection"]["items"][0]["data"][0]
        assert meta["nasa_id"] == pid
        img = Image.open(io.BytesIO(get(NIA.format(pid, picture["size"]))))
        is_pano = picture["role"] == "destination-pano"
        if is_pano:
            img = crop_black_bottom(img)
        save(img, picture["name"], picture["width"], 82 if is_pano else 80)
        items.append(dict(
            file=picture["name"],
            sol=picture["sol"],
            date_utc=pia_dates[pid],
            instrument=picture["instrument"],
            credit=meta["secondary_creator"],
            source_url=f"https://photojournal.jpl.nasa.gov/catalog/{pid}",
            caption_es=picture["caption_es"],
            caption_en=picture["caption_en"],
        ))

    (OUT / "pov.json").write_text(json.dumps(items, indent=1, ensure_ascii=False))
    total_bytes = sum(f.stat().st_size for f in OUT.glob("*.webp"))
    print(f"{len(items)} items, {total_bytes/1e6:.2f} MB")


if __name__ == "__main__":
    main()
