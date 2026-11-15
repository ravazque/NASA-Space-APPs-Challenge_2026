from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RES = Path(__file__).parent / "app/src/main/res"
BACKGROUND = (242, 241, 236, 255)
INK = (26, 26, 26, 255)
YELLOW = (242, 177, 0, 255)
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
TEXT = "ARIADNE"
MASTER_SIZE = 1080
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#F2F1EC</color>
</resources>
"""


def fit_font(max_width):
    size = 100
    while ImageFont.truetype(FONT_PATH, size + 2).getlength(TEXT) <= max_width:
        size += 2
    return ImageFont.truetype(FONT_PATH, size)


def draw_mark(background):
    image = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), background)
    draw = ImageDraw.Draw(image)
    font = fit_font(int(MASTER_SIZE * 0.58))
    left, top, right, bottom = draw.textbbox((0, 0), TEXT, font=font)
    text_width = right - left
    x = (MASTER_SIZE - text_width) // 2 - left
    y = MASTER_SIZE // 2 - (bottom - top) // 2 - top - 40
    draw.text((x, y), TEXT, font=font, fill=INK)
    bar_top = y + bottom + 40
    bar_left = (MASTER_SIZE - text_width) // 2
    bar_right = (MASTER_SIZE + text_width) // 2
    draw.rectangle([bar_left, bar_top, bar_right, bar_top + 60], fill=YELLOW)
    return image


def round_icon(square, px):
    mask = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, px * 4 - 1, px * 4 - 1], fill=255)
    rounded = square.copy()
    rounded.putalpha(mask.resize((px, px), Image.LANCZOS))
    return rounded


foreground = draw_mark((0, 0, 0, 0))
full = draw_mark(BACKGROUND)
for density, px in DENSITIES.items():
    folder = RES / f"mipmap-{density}"
    square = full.resize((px, px), Image.LANCZOS)
    square.save(folder / "ic_launcher.png")
    round_icon(square, px).save(folder / "ic_launcher_round.png")
    foreground_px = px * 9 // 4
    foreground.resize((foreground_px, foreground_px), Image.LANCZOS).save(
        folder / "ic_launcher_foreground.png"
    )
(RES / "values/ic_launcher_background.xml").write_text(BACKGROUND_XML)
