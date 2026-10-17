"""Decode an encoded image with Pillow and compare it to raw RGBA pixels."""
import json
import sys

import numpy as np
from PIL import Image


def main():
    image_path = sys.argv[1]
    raw_path = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None

    image = Image.open(image_path)
    image.load()
    frames = getattr(image, "n_frames", 1)
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    height, width = rgba.shape[:2]

    result = {
        "width": width,
        "height": height,
        "format": image.format,
        "frames": frames,
        "mode": image.mode,
        "mae": 0.0,
        "max_error": 0,
        "alpha_mismatch": 0,
        "block_mae": 0.0,
        "opaque_pixels": 0,
        "corner_rgba": [int(v) for v in rgba[0, 0]],
        "top_right_rgba": [int(v) for v in rgba[0, -1]],
        "alpha_min": int(rgba[:, :, 3].min()),
        "alpha_max": int(rgba[:, :, 3].max()),
    }

    if raw_path:
        raw = np.fromfile(raw_path, dtype=np.uint8)
        expected_size = width * height * 4
        if raw.size != expected_size:
            raise SystemExit(
                f"raw size {raw.size} does not match decoded size {expected_size}"
            )
        expected = raw.reshape(height, width, 4)
        expected_opaque = expected[:, :, 3] >= 128
        decoded_opaque = rgba[:, :, 3] >= 128

        result["alpha_mismatch"] = int(np.count_nonzero(expected_opaque != decoded_opaque))
        result["opaque_pixels"] = int(np.count_nonzero(expected_opaque))

        if expected_opaque.any():
            diff = np.abs(
                expected[:, :, :3].astype(np.int16) - rgba[:, :, :3].astype(np.int16)
            ).astype(np.float32)
            result["mae"] = float(diff[expected_opaque].mean())
            result["max_error"] = int(diff[expected_opaque].max())

            # Compare 8x8 block averages to judge gradient/dither smoothness.
            block_diff = []
            block_size = 8
            for top in range(0, height, block_size):
                for left in range(0, width, block_size):
                    mask = expected_opaque[top : top + block_size, left : left + block_size]
                    if not mask.any():
                        continue
                    a = expected[top : top + block_size, left : left + block_size, :3]
                    b = rgba[top : top + block_size, left : left + block_size, :3]
                    a_mean = a[mask].mean(axis=0)
                    b_mean = b[mask].mean(axis=0)
                    block_diff.append(np.abs(a_mean - b_mean).mean())
            if block_diff:
                result["block_mae"] = float(np.mean(block_diff))

    print(json.dumps(result))


if __name__ == "__main__":
    main()
