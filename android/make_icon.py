from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

RES = Path(__file__).parent / "app/src/main/res"
BG, INK, YEL = (242, 241, 236, 255), (26, 26, 26, 255), (242, 177, 0, 255)
FONT = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
M = 1080


def mark(bg):
    im = Image.new("RGBA", (M, M), bg)
    d = ImageDraw.Draw(im)
    w = int(M * 0.58)
    size = 100
    while ImageFont.truetype(FONT, size + 2).getlength("ARIADNE") <= w:
        size += 2
    f = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), "ARIADNE", font=f)
    x, y = (M - (r - l)) // 2 - l, M // 2 - (b - t) // 2 - t - 40
    d.text((x, y), "ARIADNE", font=f, fill=INK)
    bar_y = y + b + 40
    d.rectangle([(M - (r - l)) // 2, bar_y, (M + (r - l)) // 2, bar_y + 60], fill=YEL)
    return im


fg, full = mark((0, 0, 0, 0)), mark(BG)
for dens, px in dict(mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192).items():
    d = RES / f"mipmap-{dens}"
    sq = full.resize((px, px), Image.LANCZOS)
    sq.save(d / "ic_launcher.png")
    mask = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, px * 4 - 1, px * 4 - 1], fill=255)
    rd = sq.copy()
    rd.putalpha(mask.resize((px, px), Image.LANCZOS))
    rd.save(d / "ic_launcher_round.png")
    fg.resize((px * 9 // 4, px * 9 // 4), Image.LANCZOS).save(d / "ic_launcher_foreground.png")
(RES / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#F2F1EC</color>\n</resources>\n')
