"""Generate deterministic test images in every supported source format."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)


def gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            t = (x / max(1, width - 1) * 0.55) + (y / max(1, height - 1) * 0.45)
            red = round(top[0] * (1 - t) + bottom[0] * t)
            green = round(top[1] * (1 - t) + bottom[1] * t)
            blue = round(top[2] * (1 - t) + bottom[2] * t)
            pixels[x, y] = (red, green, blue)
    return image


def add_shapes(image):
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    draw.ellipse(
        (width * 0.12, height * 0.18, width * 0.44, height * 0.7),
        fill=(255, 236, 120, 210),
    )
    draw.rectangle(
        (width * 0.56, height * 0.12, width * 0.86, height * 0.5),
        fill=(20, 20, 18, 180),
    )
    draw.line(
        [(width * 0.08, height * 0.85), (width * 0.92, height * 0.62)],
        fill=(255, 255, 255, 220),
        width=max(3, width // 130),
    )
    return image


def make_photo():
    image = add_shapes(gradient((900, 600), (28, 61, 114), (224, 111, 63)))
    image.save(FIXTURES / "photo.jpg", quality=90, optimize=True)


def make_alpha():
    image = Image.new("RGBA", (480, 360), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((40, 40, 440, 320), radius=36, fill=(38, 64, 232, 255))
    draw.ellipse((130, 100, 350, 300), fill=(255, 210, 70, 255))
    draw.ellipse((205, 150, 275, 230), fill=(20, 20, 18, 255))
    draw.rectangle((60, 60, 130, 120), fill=(255, 255, 255, 255))
    image.save(FIXTURES / "alpha.png", optimize=True)


def make_webp():
    image = add_shapes(gradient((640, 420), (248, 248, 242), (40, 122, 94)))
    image.save(FIXTURES / "roll.webp", quality=82)


def make_gif():
    frames = []
    colors = [(202, 55, 52), (34, 112, 196), (24, 24, 20)]
    for index, color in enumerate(colors):
        frame = Image.new("RGB", (320, 240), color)
        draw = ImageDraw.Draw(frame)
        x = 40 + index * 90
        draw.rectangle((x, 70, x + 100, 170), fill=(245, 240, 230))
        draw.text((24, 20), f"frame {index + 1}", fill=(245, 240, 230))
        frames.append(frame)
    frames[0].save(
        FIXTURES / "motion.gif",
        save_all=True,
        append_images=frames[1:],
        duration=180,
        loop=0,
    )


def make_bmp():
    image = add_shapes(gradient((400, 300), (58, 40, 120), (230, 170, 60)))
    image.save(FIXTURES / "legacy.bmp")


def make_rotated():
    image = Image.new("RGB", (300, 200), (42, 52, 64))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 149, 99), fill=(250, 20, 20))
    exif = Image.Exif()
    exif[274] = 6  # Rotate 90° clockwise for display.
    image.save(FIXTURES / "rotated.jpg", quality=92, exif=exif)


def main():
    make_photo()
    make_alpha()
    make_webp()
    make_gif()
    make_bmp()
    make_rotated()
    (FIXTURES / "not-an-image.txt").write_text("this is not an image", encoding="utf-8")
    for path in sorted(FIXTURES.iterdir()):
        print(f"{path.name:20s} {path.stat().st_size:>8,d} bytes")


if __name__ == "__main__":
    main()
