"""Render the Pixel Shift extension icons with Pillow (source of truth for the mark)."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "assets" / "icons"
OUTPUT.mkdir(parents=True, exist_ok=True)

SCALE = 8
SIZE = 1024
INK = (22, 22, 18, 255)
PAPER = (241, 240, 234, 255)
BLUE = (109, 130, 255, 255)


def render() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=150, fill=INK)

    stroke = 96
    top = 380
    bottom = 660
    left = 235
    right = 790
    head = 165

    # Top arrow, pointing right.
    draw.line([(left, top), (right - stroke // 2, top)], fill=PAPER, width=stroke)
    draw.line([(right - head, top - head), (right, top)], fill=PAPER, width=stroke)
    draw.line([(right - head, top + head), (right, top)], fill=PAPER, width=stroke)

    # Bottom arrow, pointing left.
    draw.line([(right, bottom), (left + stroke // 2, bottom)], fill=BLUE, width=stroke)
    draw.line([(left + head, bottom - head), (left, bottom)], fill=BLUE, width=stroke)
    draw.line([(left + head, bottom + head), (left, bottom)], fill=BLUE, width=stroke)

    return canvas


def main() -> None:
    master = render()
    for size in (16, 32, 48, 128):
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(OUTPUT / f"icon{size}.png", optimize=True)

    preview = Image.new("RGBA", (512, 128), (241, 240, 234, 255))
    icons = [
        Image.open(OUTPUT / f"icon{size}.png").convert("RGBA")
        for size in (16, 32, 48, 128)
    ]
    x = 16
    for icon in icons:
        y = (128 - icon.height) // 2
        preview.alpha_composite(icon, (x, y))
        x += icon.width + 24
    preview.save(OUTPUT / "preview.png", optimize=True)
    print(f"Wrote icons to {OUTPUT}")


if __name__ == "__main__":
    main()
