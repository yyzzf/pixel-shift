"""Generate the landing-page specimen and copy shared assets into site/."""
from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
ASSETS = SITE / "assets"
SPECIMEN = ASSETS / "specimen"
DOWNLOADS = SITE / "downloads"

INK = (22, 22, 18, 255)
PAPER = (241, 240, 234, 255)
BLUE = (46, 75, 255, 255)
BLUE_DARK = (26, 44, 176, 255)
YELLOW = (246, 211, 75, 255)
ORANGE = (240, 100, 52, 255)
MUTED = (160, 160, 150, 255)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_BLACK = "C:/Windows/Fonts/seguibl.ttf"
FONT_SEMI = "C:/Windows/Fonts/seguisb.ttf"
FONT_CN = "C:/Windows/Fonts/msyhbd.ttc"


def font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        for x in range(width):
            pixels[x, y] = color
    return image


def build_artwork(size=(1200, 900)) -> Image.Image:
    width, height = size
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))

    inset = 64
    radius = 48
    poster_size = (width - inset * 2, height - inset * 2)
    poster = vertical_gradient(poster_size, (10, 16, 43), (13, 13, 12)).convert("RGBA")
    draw = ImageDraw.Draw(poster, "RGBA")

    # Technical grid.
    grid = 54
    for x in range(0, poster_size[0], grid):
        draw.line((x, 0, x, poster_size[1]), fill=(255, 255, 250, 14), width=1)
    for y in range(0, poster_size[1], grid):
        draw.line((0, y, poster_size[0], y), fill=(255, 255, 250, 14), width=1)

    # Large overlapping discs.
    draw.ellipse((poster_size[0] - 660, 20, poster_size[0] + 120, 710), fill=BLUE)
    draw.ellipse((240, 185, 700, 645), fill=YELLOW)
    draw.ellipse((poster_size[0] - 500, 290, poster_size[0] - 60, 730), fill=(27, 27, 24, 255))

    # A diagonal signal line.
    draw.line((-80, poster_size[1] - 70, poster_size[0] + 80, 150), fill=(240, 100, 52, 220), width=16)
    draw.line((-80, poster_size[1] - 40, poster_size[0] + 80, 180), fill=(241, 240, 234, 90), width=3)

    # Registration marks.
    for left, top, right, bottom in (
        (26, 26, 66, 26),
        (26, 26, 26, 66),
        (poster_size[0] - 66, 26, poster_size[0] - 26, 26),
        (poster_size[0] - 26, 26, poster_size[0] - 26, 66),
        (26, poster_size[1] - 26, 66, poster_size[1] - 26),
        (26, poster_size[1] - 66, 26, poster_size[1] - 26),
        (poster_size[0] - 66, poster_size[1] - 26, poster_size[0] - 26, poster_size[1] - 26),
        (poster_size[0] - 26, poster_size[1] - 66, poster_size[0] - 26, poster_size[1] - 26),
    ):
        draw.line((left, top, right, bottom), fill=(241, 240, 234, 190), width=2)

    # Type: top-left identity.
    draw.text((74, 66), "PIXEL SHIFT", font=font(FONT_BOLD, 38), fill=PAPER)
    draw.text((78, 118), "格式样本 / SPECIMEN 001", font=font(FONT_CN, 22), fill=(190, 188, 176, 255))
    draw.text(
        (78, 152),
        "同一张图，五种编码。",
        font=font(FONT_CN, 22),
        fill=(190, 188, 176, 255),
    )

    # A solid index strip keeps every format label legible.
    strip_y = poster_size[1] - 180
    draw.rectangle((0, strip_y, poster_size[0], poster_size[1]), fill=(13, 13, 12, 246))
    draw.line((0, strip_y, poster_size[0], strip_y), fill=(241, 240, 234, 70), width=1)
    draw.text((74, strip_y + 30), "FIVE FORMATS", font=font(FONT_BLACK, 42), fill=PAPER)
    draw.text(
        (78, strip_y + 89),
        "同一张图，五种编码。",
        font=font(FONT_CN, 19),
        fill=(185, 183, 171, 255),
    )
    draw.text(
        (78, strip_y + 122),
        "不上传 / 本地处理",
        font=font(FONT_CN, 16),
        fill=(140, 138, 128, 255),
    )

    labels = [
        ("JPG", (232, 154, 60, 255)),
        ("PNG", (52, 195, 143, 255)),
        ("WEBP", (109, 130, 255, 255)),
        ("GIF", (215, 107, 223, 255)),
        ("BMP", (169, 169, 160, 255)),
    ]
    x = poster_size[0] - 310
    y = strip_y + 31
    draw.text(
        (x, y - 6),
        "05 / FORMAT INDEX",
        font=font(FONT_SEMI, 13),
        fill=(140, 138, 128, 255),
    )
    y += 26
    for label, color in labels:
        draw.rectangle((x, y, x + 12, y + 12), fill=color)
        draw.text((x + 22, y - 6), label, font=font(FONT_SEMI, 19), fill=PAPER)
        y += 25

    # Rounded mask with transparent corners.
    mask = Image.new("L", poster_size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, poster_size[0] - 1, poster_size[1] - 1), radius=radius, fill=255)
    canvas.paste(poster, (inset, inset), mask)
    return canvas


def flatten(image: Image.Image, background=PAPER) -> Image.Image:
    base = Image.new("RGB", image.size, background[:3])
    base.paste(image, mask=image.getchannel("A"))
    return base


def gif_with_transparency(image: Image.Image, path: Path) -> None:
    alpha = image.getchannel("A")
    quantized = image.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()
    if palette is None:
        palette = []
    palette = (palette + [0, 0, 0] * 256)[: 768]
    quantized.putpalette(palette)
    transparent_mask = alpha.point(lambda value: 255 if value < 128 else 0)
    quantized.paste(255, mask=transparent_mask)
    quantized.info["transparency"] = 255
    quantized.save(path, format="GIF", transparency=255, optimize=True, disposal=2)


def build_og_image() -> Image.Image:
    canvas = Image.new("RGB", (1200, 630), (241, 240, 234))
    draw = ImageDraw.Draw(canvas)

    icon = Image.open(ROOT / "assets" / "icons" / "icon128.png").convert("RGBA")
    icon = icon.resize((58, 58), Image.Resampling.LANCZOS)
    canvas.paste(icon, (72, 64), icon)

    draw.text((144, 68), "换格式", font=font(FONT_CN, 30), fill=INK)
    draw.text((146, 108), "PIXEL SHIFT", font=font(FONT_BOLD, 11), fill=(102, 100, 90, 255))

    draw.text((72, 178), "图片换个格式，", font=font(FONT_CN, 64), fill=INK)
    draw.text((72, 258), "不必离开浏览器。", font=font(FONT_CN, 64), fill=INK)

    draw.text(
        (76, 370),
        "JPG / PNG / WEBP / GIF / BMP",
        font=font(FONT_SEMI, 22),
        fill=(81, 80, 71, 255),
    )
    draw.text(
        (76, 408),
        "Chrome / Edge 浏览器扩展 · 完全本地处理",
        font=font(FONT_CN, 19),
        fill=(102, 100, 90, 255),
    )

    draw.rectangle((72, 500, 246, 554), fill=BLUE)
    draw.text((94, 517), "下载扩展 ZIP", font=font(FONT_CN, 18), fill=(255, 255, 255, 255))
    draw.text((76, 577), "yyzzf.github.io", font=font(FONT_SEMI, 17), fill=(102, 100, 90, 255))

    specimen = Image.open(SPECIMEN / "specimen.png").convert("RGBA")
    panel_width = 420
    panel_height = round(panel_width * specimen.height / specimen.width)
    specimen = specimen.resize((panel_width, panel_height), Image.Resampling.LANCZOS)
    panel = Image.new("RGB", (panel_width + 2, panel_height + 2), (22, 22, 18))
    paper_panel = Image.new("RGB", (panel_width, panel_height), (251, 250, 245))
    paper_panel.paste(specimen, (0, 0), specimen)
    panel.paste(paper_panel, (1, 1))
    canvas.paste(panel, (704, 105))

    return canvas


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    SPECIMEN.mkdir(parents=True, exist_ok=True)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    (SITE / "assets" / "font").mkdir(parents=True, exist_ok=True)

    artwork = build_artwork()
    jpg = flatten(artwork)
    jpg.save(SPECIMEN / "specimen.jpg", quality=88, optimize=True)
    artwork.save(SPECIMEN / "specimen.png", optimize=True)
    artwork.save(SPECIMEN / "specimen.webp", quality=82, method=6)
    gif_with_transparency(artwork, SPECIMEN / "specimen.gif")
    jpg.save(SPECIMEN / "specimen.bmp")

    sizes = {
        "width": artwork.width,
        "height": artwork.height,
        "formats": {
            "jpg": (SPECIMEN / "specimen.jpg").stat().st_size,
            "png": (SPECIMEN / "specimen.png").stat().st_size,
            "webp": (SPECIMEN / "specimen.webp").stat().st_size,
            "gif": (SPECIMEN / "specimen.gif").stat().st_size,
            "bmp": (SPECIMEN / "specimen.bmp").stat().st_size,
        },
    }
    (SPECIMEN / "sizes.json").write_text(json.dumps(sizes, indent=2) + "\n", encoding="utf-8")

    # Shared brand assets.
    shutil.copy2(ROOT / "assets" / "screenshot.png", ASSETS / "app-shot.png")
    shutil.copy2(ROOT / "assets" / "icons" / "icon16.png", ASSETS / "icon16.png")
    shutil.copy2(ROOT / "assets" / "icons" / "icon32.png", ASSETS / "icon32.png")
    shutil.copy2(ROOT / "assets" / "icons" / "icon48.png", ASSETS / "icon48.png")
    shutil.copy2(ROOT / "assets" / "icons" / "icon128.png", ASSETS / "icon128.png")
    shutil.copy2(ROOT / "assets" / "fonts" / "archivo-latin.woff2", ASSETS / "font" / "archivo-latin.woff2")
    shutil.copy2(ROOT / "assets" / "fonts" / "OFL.txt", ASSETS / "font" / "OFL.txt")

    build_og_image().save(ASSETS / "og.png", optimize=True)

    # Package and publish metadata.
    dist_zip = ROOT / "dist" / "pixel-shift-1.0.0.zip"
    if not dist_zip.exists():
        raise SystemExit("dist/pixel-shift-1.0.0.zip is missing; run npm run package first")
    target_zip = DOWNLOADS / dist_zip.name
    shutil.copy2(dist_zip, target_zip)
    data = target_zip.read_bytes()
    download = {
        "version": "1.0.0",
        "file": dist_zip.name,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    (DOWNLOADS / "latest.json").write_text(json.dumps(download, indent=2) + "\n", encoding="utf-8")

    # The published site must serve the ZIP rather than treat it as source.
    with zipfile.ZipFile(target_zip) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Packaged ZIP failed its CRC check")

    print("specimen sizes:", json.dumps(sizes["formats"], indent=2))
    print("download:", json.dumps(download, indent=2))


if __name__ == "__main__":
    main()
