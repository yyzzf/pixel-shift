import { encodeGIF } from './gif.js';
import { encodeBMP } from './bmp.js';

export const MAX_PIXELS = 48_000_000;

export const TARGETS = {
  jpeg: {
    ext: 'jpg',
    mime: 'image/jpeg',
    label: 'JPG',
    description: '照片 · 体积小',
    lossy: true,
    alpha: false,
  },
  png: {
    ext: 'png',
    mime: 'image/png',
    label: 'PNG',
    description: '无损 · 支持透明',
    lossy: false,
    alpha: true,
  },
  webp: {
    ext: 'webp',
    mime: 'image/webp',
    label: 'WEBP',
    description: '高压缩 · 支持透明',
    lossy: true,
    alpha: true,
  },
  gif: {
    ext: 'gif',
    mime: 'image/gif',
    label: 'GIF',
    description: '256 色 · 支持透明',
    lossy: false,
    alpha: true,
  },
  bmp: {
    ext: 'bmp',
    mime: 'image/bmp',
    label: 'BMP',
    description: '无压缩 · 兼容性好',
    lossy: false,
    alpha: false,
  },
};

const INPUT_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const INPUT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
]);

export function isSupportedFile(file) {
  const extension = getExtension(file.name);
  if (INPUT_EXTENSIONS.has(extension)) return true;
  return INPUT_TYPES.has((file.type || '').toLowerCase());
}

export function getExtension(name) {
  const match = /\.([^.\\/]+)$/.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

export async function convertImage(file, target, options = {}) {
  const format = TARGETS[target];
  if (!format) throw new Error('未知的目标格式');

  const quality = clamp(options.quality ?? 0.9, 0.1, 1);
  const background = options.background || '#ffffff';
  const flatten = !format.alpha;
  const needsPixels = target === 'gif' || target === 'bmp';

  const source = await loadSource(file);
  try {
    const { width, height } = source;
    if (!width || !height) throw new Error('无法读取图片尺寸');
    if (width * height > MAX_PIXELS) {
      throw new Error('图片超过 4800 万像素，浏览器无法安全处理');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {
      alpha: !flatten,
      willReadFrequently: needsPixels,
    });
    if (!context) throw new Error('无法创建画布');

    if (flatten) {
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(source.element, 0, 0, width, height);

    let blob;
    if (target === 'gif') {
      const imageData = context.getImageData(0, 0, width, height);
      const bytes = encodeGIF(imageData, {
        dither: options.dither !== false,
        background: hexToRgb(background),
      });
      blob = new Blob([bytes], { type: 'image/gif' });
    } else if (target === 'bmp') {
      const imageData = context.getImageData(0, 0, width, height);
      const bytes = encodeBMP(imageData);
      blob = new Blob([bytes], { type: 'image/bmp' });
    } else {
      blob = await canvasToBlob(canvas, format.mime, format.lossy ? quality : undefined);
      if (blob.type && blob.type !== format.mime) {
        throw new Error(`当前浏览器无法编码 ${format.label}`);
      }
    }

    canvas.width = 0;
    canvas.height = 0;

    return { blob, width, height, format };
  } finally {
    source.close();
  }
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('浏览器无法生成该格式，图片可能过大'));
    }, mime, quality);
  });
}

async function loadSource(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      element: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('无法读取该图片，文件可能已损坏或格式不受支持');
    }
    return {
      element: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  }
}

export function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '').trim();
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(value)) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }
  return [255, 255, 255];
}

export function outputFileName(inputName, target, usedNames = new Set()) {
  const format = TARGETS[target];
  const cleaned = (inputName || 'image')
    .replace(/\.[^.\\/]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  const base = [...cleaned].slice(0, 100).join('') || 'image';

  let name = `${base}.${format.ext}`;
  let counter = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${counter}).${format.ext}`;
    counter++;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
