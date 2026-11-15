from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs/brand/ariadne-logo.jpeg"
RES = ROOT / "android/app/src/main/res"
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
CORNER = 0.237
INSET = 0.08
ADAPTIVE_ART = 64 / 108
VIEWPORT = 72 / 108
SUPERSAMPLE = 4
BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#000000</color>
</resources>
"""


def art_mask(rgb):
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    return (high < 170) | (high - low > 60)


def load_tile():
    rgb = np.asarray(Image.open(SOURCE).convert("RGB")).astype(int)
    mask = art_mask(rgb)
    ys, xs = np.nonzero(mask)
    x0, y0 = xs.min(), ys.min()
    side = min(xs.max() - x0, ys.max() - y0) + 1
    inset = round(side * INSET)
    inner = mask[y0 + inset:y0 + side - inset, x0 + inset:x0 + side - inset]
    assert inner[[0, 0, -1, -1], [0, -1, 0, -1]].all(), "inset crop still reaches a rounded corner"
    return rgb[y0:y0 + side, x0:x0 + side].astype(np.uint8), inset


def masked(image, px, radius_share):
    big = px * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * radius_share, fill=255)
    icon = image.resize((px, px), Image.LANCZOS).convert("RGBA")
    icon.putalpha(mask.resize((px, px), Image.LANCZOS))
    return icon


def full_bleed(inner):
    pad = round(inner.shape[0] * (1 / ADAPTIVE_ART - 1) / 2)
    return Image.fromarray(np.pad(inner, ((pad, pad), (pad, pad), (0, 0)), mode="edge"))


def main():
    tile, inset = load_tile()
    inner = tile[inset:-inset, inset:-inset]
    legacy, foreground = Image.fromarray(tile), full_bleed(inner)
    margin = round(foreground.width * (1 - VIEWPORT) / 2)
    round_source = foreground.crop((margin, margin, foreground.width - margin, foreground.width - margin))
    for density, px in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        masked(legacy, px, CORNER).save(folder / "ic_launcher.png", optimize=True)
        masked(round_source, px, 0.5).save(folder / "ic_launcher_round.png", optimize=True)
        layer_px = px * 9 // 4
        foreground.resize((layer_px, layer_px), Image.LANCZOS).save(
            folder / "ic_launcher_foreground.png", optimize=True
        )
    (RES / "values/ic_launcher_background.xml").write_text(BACKGROUND_XML)


if __name__ == "__main__":
    main()
