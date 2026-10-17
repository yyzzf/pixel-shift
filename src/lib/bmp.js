/**
 * 24-bit uncompressed BMP encoder (BITMAPINFOHEADER, bottom-up rows).
 * BMP has no usable alpha for this purpose, so callers should flatten
 * transparency onto a background color before reading pixels.
 */
export function encodeBMP(imageData) {
  const { width, height, data } = imageData;
  if (!width || !height) throw new Error('图片尺寸无效');

  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;
  const output = new Uint8Array(fileSize);
  const view = new DataView(output.buffer);

  output[0] = 0x42; // B
  output[1] = 0x4d; // M
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true); // pixel data offset
  view.setUint32(14, 40, true); // BITMAPINFOHEADER size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive height = bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // 72 DPI
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4;
    let destination = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 4;
      output[destination++] = data[source + 2];
      output[destination++] = data[source + 1];
      output[destination++] = data[source];
    }
    // Row padding is already zero-filled.
  }

  return output;
}
