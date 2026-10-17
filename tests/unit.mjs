import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { encodeGIF } from '../src/lib/gif.js';
import { encodeBMP } from '../src/lib/bmp.js';
import { createZip } from '../src/lib/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'tests', 'out');
const verifyScript = path.join(root, 'tests', 'verify_image.py');
const verifyZipScript = path.join(root, 'tests', 'verify_zip.py');

fs.mkdirSync(outputDir, { recursive: true });

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error.message}`);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const color = paint(x, y);
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color.length > 3 ? color[3] : 255;
    }
  }
  return { width, height, data };
}

function writeRaw(image, name) {
  const target = path.join(outputDir, name);
  fs.writeFileSync(target, Buffer.from(image.data.buffer));
  return target;
}

function verify(imagePath, rawPath) {
  const result = spawnSync(
    'python',
    ['-I', verifyScript, imagePath, rawPath || '-'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Pillow verification failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

function encodeAndVerify(image, bytes, fileName, { dither } = {}) {
  const encodedPath = path.join(outputDir, fileName);
  fs.writeFileSync(encodedPath, Buffer.from(bytes));
  const rawPath = writeRaw(image, `${fileName}.rgba`);
  check(bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46, 'missing GIF header');
  const result = verify(encodedPath, rawPath);
  check(result.format === 'GIF', `decoded as ${result.format}`);
  check(result.width === image.width && result.height === image.height, 'dimension mismatch');
  check(result.frames === 1, `expected a single frame, got ${result.frames}`);
  return result;
}

console.log('\nGIF encoder');

test('reproduces a low-color image exactly', () => {
  const palette = [
    [12, 22, 32],
    [240, 12, 80],
    [0, 200, 150],
    [250, 250, 250],
  ];
  const image = makeImage(37, 29, (x, y) => palette[((x >> 2) + (y >> 2)) % palette.length]);
  const result = encodeAndVerify(
    image,
    encodeGIF(image, { dither: false }),
    'exact.gif',
    { dither: false },
  );
  check(result.mae === 0, `expected exact colors, MAE=${result.mae}`);
  check(result.alpha_mismatch === 0, 'unexpected alpha mismatch');
});

test('preserves binary transparency', () => {
  const colors = [
    [255, 40, 90],
    [0, 170, 120],
    [20, 60, 200],
    [245, 225, 30],
  ];
  const image = makeImage(64, 48, (x, y) => (
    x < 32
      ? [255, 0, 255, 100] // below the alpha threshold: transparent
      : [...colors[((x >> 3) + (y >> 3)) % colors.length], 200]
  ));
  const result = encodeAndVerify(
    image,
    encodeGIF(image, { dither: false }),
    'transparent.gif',
  );
  check(result.alpha_mismatch === 0, `alpha mismatch on ${result.alpha_mismatch} pixels`);
  check(result.mae === 0, `expected exact opaque colors, MAE=${result.mae}`);
});

test('quantizes a photographic gradient without dithering', () => {
  const image = makeImage(320, 200, (x, y) => [
    Math.round((x / 319) * 255),
    Math.round((y / 199) * 255),
    Math.round(((x + y) / 519) * 255),
  ]);
  const result = encodeAndVerify(
    image,
    encodeGIF(image, { dither: false }),
    'gradient-flat.gif',
  );
  check(result.alpha_mismatch === 0, 'unexpected alpha mismatch');
  check(result.mae < 14, `MAE too high: ${result.mae}`);
  check(result.block_mae < 6, `block MAE too high: ${result.block_mae}`);
  console.log(`      flat: mae ${result.mae.toFixed(2)}, block ${result.block_mae.toFixed(2)}`);
});

test('dithering smooths the same gradient', () => {
  const image = makeImage(320, 200, (x, y) => [
    Math.round((x / 319) * 255),
    Math.round((y / 199) * 255),
    Math.round(((x + y) / 519) * 255),
  ]);
  const flat = encodeAndVerify(
    image,
    encodeGIF(image, { dither: false }),
    'gradient-cmp-flat.gif',
  );
  const dithered = encodeAndVerify(
    image,
    encodeGIF(image, { dither: true }),
    'gradient-dither.gif',
  );
  check(dithered.alpha_mismatch === 0, 'unexpected alpha mismatch');
  check(dithered.mae < 22, `dithered MAE too high: ${dithered.mae}`);
  check(
    dithered.block_mae <= flat.block_mae * 1.15,
    `dithering made block error worse: ${dithered.block_mae} vs ${flat.block_mae}`,
  );
  console.log(`      dithered: mae ${dithered.mae.toFixed(2)}, block ${dithered.block_mae.toFixed(2)}`);
});

test('survives LZW dictionary growth and resets', () => {
  let seed = 0x12345678;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  }
  const image = makeImage(640, 420, () => [
    random() & 255,
    random() & 255,
    random() & 255,
  ]);
  const result = encodeAndVerify(
    image,
    encodeGIF(image, { dither: false }),
    'stress.gif',
  );
  check(result.alpha_mismatch === 0, 'unexpected alpha mismatch');
  check(result.mae < 80, `stress MAE unexpectedly high: ${result.mae}`);
});

test('handles a 1x1 image', () => {
  const image = makeImage(1, 1, () => [30, 144, 255]);
  const result = encodeAndVerify(image, encodeGIF(image, { dither: false }), 'one.gif');
  check(result.mae === 0, `expected exact color, got ${result.mae}`);
});

test('handles a fully transparent image', () => {
  const image = makeImage(32, 16, () => [0, 0, 0, 0]);
  const result = encodeAndVerify(image, encodeGIF(image, { dither: false }), 'empty.gif');
  check(result.alpha_mismatch === 0, `alpha mismatch: ${result.alpha_mismatch}`);
});

console.log('\nBMP encoder');

test('writes a 24-bit bottom-up BMP with row padding', () => {
  const image = makeImage(37, 29, (x, y) => [
    (x * 7) % 256,
    (y * 11) % 256,
    (x * y) % 256,
  ]);
  const bytes = encodeBMP(image);
  check(bytes[0] === 0x42 && bytes[1] === 0x4d, 'missing BM header');
  const bmpPath = path.join(outputDir, 'result.bmp');
  fs.writeFileSync(bmpPath, Buffer.from(bytes));
  const rawPath = writeRaw(image, 'result.bmp.rgba');
  const result = verify(bmpPath, rawPath);
  check(result.format === 'BMP', `decoded as ${result.format}`);
  check(result.width === 37 && result.height === 29, 'dimension mismatch');
  check(result.mae === 0, `BMP should be lossless, MAE=${result.mae}`);
  check(result.alpha_mismatch === 0, 'unexpected alpha mismatch');
});

console.log('\nZIP writer');

test('creates a readable store-only archive with UTF-8 names', () => {
  const entries = [
    { name: 'photo (1).webp', data: Buffer.from('webp-data-here') },
    { name: '照片 转换.png', data: Buffer.from('png-data') },
    { name: 'empty.bmp', data: Buffer.alloc(0) },
    { name: 'binary.gif', data: Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 255)) },
  ];
  const zipBytes = createZip(entries);
  const zipPath = path.join(outputDir, 'archive.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipBytes));

  const result = spawnSync('python', ['-I', verifyZipScript, zipPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`zip verification failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout.trim());
  check(parsed.names.length === entries.length, 'entry count mismatch');
  for (const entry of entries) {
    const actual = parsed.entries[entry.name];
    check(actual, `missing entry ${entry.name}`);
    check(actual.hex === Buffer.from(entry.data).toString('hex'), `content mismatch for ${entry.name}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
