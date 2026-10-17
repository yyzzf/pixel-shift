/**
 * Small, dependency-free static GIF89a encoder.
 *
 * The browser can decode images but cannot encode GIF, so this module
 * quantizes an ImageData object to a maximum of 256 colors and writes a
 * single-frame GIF89a. Transparency is preserved as one binary transparent
 * palette index. Animated input is not handled here (callers encode one frame).
 */

const ALPHA_THRESHOLD = 128;
const BIN_COUNT = 32 * 32 * 32;
const MAX_PALETTE_SIZE = 256;

export function encodeGIF(imageData, options = {}) {
  const { width, height, data } = imageData;
  if (!width || !height) throw new Error('图片尺寸无效');
  if (width > 65535 || height > 65535) throw new Error('图片尺寸超出 GIF 限制');

  const dither = options.dither !== false;
  const background = normalizeColor(options.background, [255, 255, 255]);

  const { counts, hasAlpha } = buildHistogram(data);
  const maxColors = hasAlpha ? MAX_PALETTE_SIZE - 1 : MAX_PALETTE_SIZE;

  let palette = null;
  let binCount = 0;
  for (let i = 0; i < BIN_COUNT; i++) {
    if (counts[i] !== 0) binCount++;
  }

  if (binCount <= maxColors) {
    palette = collectExactPalette(data, maxColors);
  }
  if (!palette) {
    const bins = collectBins(counts);
    palette = bins.length <= maxColors
      ? bins.map((bin) => [bin.r, bin.g, bin.b])
      : medianCut(bins, maxColors);
    if (palette.length === 0) palette = [background.slice()];
  }

  // Reserve palette slot 0 for binary transparency when needed.
  if (hasAlpha) palette = [background.slice(), ...palette];
  while (palette.length < 2) palette.push([255, 255, 255]);
  if (palette.length > MAX_PALETTE_SIZE) palette.length = MAX_PALETTE_SIZE;

  const opaqueStart = hasAlpha ? 1 : 0;
  const lut = buildPaletteLut(palette, opaqueStart);
  const indices = new Uint8Array(width * height);

  if (dither) {
    ditherToIndices(data, width, height, palette, lut, hasAlpha ? 0 : -1, indices);
  } else {
    for (let p = 0, i = 0; p < data.length; p += 4, i++) {
      if (hasAlpha && data[p + 3] < ALPHA_THRESHOLD) {
        indices[i] = 0;
      } else {
        indices[i] = lut[binIndex(data[p], data[p + 1], data[p + 2])];
      }
    }
  }

  return assembleGif({
    width,
    height,
    indices,
    palette,
    hasAlpha,
    transparentIndex: hasAlpha ? 0 : -1,
    backgroundIndex: 0,
  });
}

function buildHistogram(data) {
  const counts = new Uint32Array(BIN_COUNT);
  let hasAlpha = false;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] < ALPHA_THRESHOLD) {
      hasAlpha = true;
      continue;
    }
    counts[binIndex(data[p], data[p + 1], data[p + 2])]++;
  }
  return { counts, hasAlpha };
}

function binIndex(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function expand5(v) {
  return (v << 3) | (v >> 2);
}

function collectBins(counts) {
  const bins = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    const count = counts[i];
    if (count === 0) continue;
    bins.push({
      r: expand5((i >> 10) & 31),
      g: expand5((i >> 5) & 31),
      b: expand5(i & 31),
      count,
    });
  }
  return bins;
}

function collectExactPalette(data, maxColors) {
  const colors = new Map();
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    const seen = colors.get(key);
    if (seen === undefined) {
      if (colors.size >= maxColors) return null;
      colors.set(key, 1);
    } else {
      colors.set(key, seen + 1);
    }
  }
  return [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => [(key >> 16) & 255, (key >> 8) & 255, key & 255]);
}

function medianCut(bins, maxColors) {
  const boxes = [makeBox(bins)];

  while (boxes.length < maxColors) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.bins.length < 2) continue;
      const score = box.count * (box.maxRange + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best === -1) break;

    const box = boxes[best];
    const channel = box.maxChannel;
    box.bins.sort((a, b) => a[channel] - b[channel]);

    let split = 0;
    let accumulated = 0;
    const half = box.count / 2;
    for (let i = 0; i < box.bins.length - 1; i++) {
      accumulated += box.bins[i].count;
      if (accumulated >= half) {
        split = i + 1;
        break;
      }
    }
    if (split === 0) split = Math.ceil(box.bins.length / 2);

    const left = makeBox(box.bins.slice(0, split));
    const right = makeBox(box.bins.slice(split));
    boxes.splice(best, 1, left, right);
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const bin of box.bins) {
      r += bin.r * bin.count;
      g += bin.g * bin.count;
      b += bin.b * bin.count;
      total += bin.count;
    }
    return [
      Math.round(r / total),
      Math.round(g / total),
      Math.round(b / total),
    ];
  });
}

function makeBox(bins) {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  let count = 0;

  for (const bin of bins) {
    if (bin.r < rMin) rMin = bin.r;
    if (bin.r > rMax) rMax = bin.r;
    if (bin.g < gMin) gMin = bin.g;
    if (bin.g > gMax) gMax = bin.g;
    if (bin.b < bMin) bMin = bin.b;
    if (bin.b > bMax) bMax = bin.b;
    count += bin.count;
  }

  const ranges = [rMax - rMin, gMax - gMin, bMax - bMin];
  const channelIndex = ranges[0] >= ranges[1] && ranges[0] >= ranges[2]
    ? 0
    : ranges[1] >= ranges[2] ? 1 : 2;
  const channels = ['r', 'g', 'b'];

  return {
    bins,
    count,
    maxChannel: channels[channelIndex],
    maxRange: ranges[channelIndex],
  };
}

function buildPaletteLut(palette, opaqueStart) {
  const lut = new Uint8Array(BIN_COUNT);
  const available = palette.length - opaqueStart;

  if (available <= 0) return lut;

  for (let i = 0; i < BIN_COUNT; i++) {
    const r = expand5((i >> 10) & 31);
    const g = expand5((i >> 5) & 31);
    const b = expand5(i & 31);
    let best = opaqueStart;
    let bestDistance = Infinity;

    for (let j = opaqueStart; j < palette.length; j++) {
      const color = palette[j];
      const dr = r - color[0];
      const dg = g - color[1];
      const db = b - color[2];
      // Green carries more perceived luminance, so weight it a little higher.
      const distance = dr * dr * 3 + dg * dg * 6 + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = j;
      }
    }
    lut[i] = best;
  }
  return lut;
}

function ditherToIndices(data, width, height, palette, lut, transparentIndex, indices) {
  const stride = (width + 2) * 3;
  let current = new Float32Array(stride);
  let next = new Float32Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const pixel = (rowStart + x) * 4;
      if (transparentIndex >= 0 && data[pixel + 3] < ALPHA_THRESHOLD) {
        indices[rowStart + x] = transparentIndex;
        continue;
      }

      const error = (x + 1) * 3;
      const r = clampByte(data[pixel] + current[error]);
      const g = clampByte(data[pixel + 1] + current[error + 1]);
      const b = clampByte(data[pixel + 2] + current[error + 2]);
      const index = lut[binIndex(r, g, b)];
      indices[rowStart + x] = index;

      const color = palette[index];
      const er = r - color[0];
      const eg = g - color[1];
      const eb = b - color[2];

      // Floyd–Steinberg error diffusion.
      distribute(current, error + 3, er, eg, eb, 7 / 16);
      distribute(next, error - 3, er, eg, eb, 3 / 16);
      distribute(next, error, er, eg, eb, 5 / 16);
      distribute(next, error + 3, er, eg, eb, 1 / 16);
    }

    const swap = current;
    current = next;
    next = swap;
    next.fill(0);
  }
}

function distribute(buffer, offset, r, g, b, factor) {
  buffer[offset] += r * factor;
  buffer[offset + 1] += g * factor;
  buffer[offset + 2] += b * factor;
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function normalizeColor(color, fallback) {
  if (Array.isArray(color) && color.length >= 3) {
    return [clampByte(color[0]), clampByte(color[1]), clampByte(color[2])];
  }
  return fallback.slice();
}

function assembleGif({ width, height, indices, palette, hasAlpha, transparentIndex, backgroundIndex }) {
  const tableSize = Math.max(2, nextPowerOfTwo(palette.length));
  const sizeField = Math.log2(tableSize) - 1;
  const minCodeSize = Math.max(2, Math.log2(tableSize));
  const out = new ByteSink();

  out.pushBytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  out.pushU16(width);
  out.pushU16(height);
  out.push(0x80 | 0x70 | sizeField); // global table, 8-bit color resolution
  out.push(backgroundIndex & 255);
  out.push(0); // pixel aspect ratio

  for (let i = 0; i < tableSize; i++) {
    const color = palette[i] || [0, 0, 0];
    out.push(color[0] & 255);
    out.push(color[1] & 255);
    out.push(color[2] & 255);
  }

  if (hasAlpha) {
    // Graphic control extension: transparency, disposal "do not dispose".
    out.pushBytes([0x21, 0xf9, 0x04, 0x05, 0x00, 0x00, transparentIndex & 255, 0x00]);
  }

  out.push(0x2c); // image descriptor
  out.pushU16(0);
  out.pushU16(0);
  out.pushU16(width);
  out.pushU16(height);
  out.push(0); // no local table, not interlaced

  out.push(minCodeSize);
  lzwEncode(indices, minCodeSize, out);
  out.push(0x3b); // trailer

  return out.finish();
}

function lzwEncode(indices, minCodeSize, sink) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let bitBuffer = 0;
  let bitCount = 0;
  const block = new Uint8Array(255);
  let blockLength = 0;

  function emitByte(byte) {
    block[blockLength++] = byte;
    if (blockLength === 255) {
      sink.push(255);
      sink.pushBytes(block);
      blockLength = 0;
    }
  }

  function writeCode(code, width) {
    bitBuffer |= code << bitCount;
    bitCount += width;
    while (bitCount >= 8) {
      emitByte(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  }

  let width = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();

  writeCode(clearCode, width);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const value = indices[i];
    const key = (prefix << 8) | value;
    const existing = dictionary.get(key);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    writeCode(prefix, width);

    if (nextCode < 4096) {
      if (nextCode === (1 << width) && width < 12) width++;
      dictionary.set(key, nextCode++);
    } else {
      writeCode(clearCode, width);
      dictionary = new Map();
      nextCode = endCode + 1;
      width = minCodeSize + 1;
    }

    prefix = value;
  }

  writeCode(prefix, width);
  writeCode(endCode, width);
  if (bitCount > 0) emitByte(bitBuffer & 0xff);

  if (blockLength > 0) {
    sink.push(blockLength);
    sink.pushBytes(block.subarray(0, blockLength));
  }
  sink.push(0); // block terminator
}

function nextPowerOfTwo(value) {
  let result = 2;
  while (result < value) result <<= 1;
  return result;
}

class ByteSink {
  constructor(capacity = 1 << 16) {
    this.data = new Uint8Array(capacity);
    this.length = 0;
  }

  ensure(extra) {
    const required = this.length + extra;
    if (required <= this.data.length) return;
    let capacity = this.data.length;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  push(byte) {
    this.ensure(1);
    this.data[this.length++] = byte;
  }

  pushU16(value) {
    this.push(value & 255);
    this.push((value >> 8) & 255);
  }

  pushBytes(bytes) {
    this.ensure(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }

  finish() {
    return this.data.slice(0, this.length);
  }
}

export const __test__ = {
  binIndex,
  medianCut,
  collectBins,
  buildPaletteLut,
  lzwEncode,
};
