import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/lib/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
const zipName = `pixel-shift-${manifest.version}.zip`;

const files = [
  'manifest.json',
  'README.md',
  'assets/screenshot.png',
  'assets/fonts/OFL.txt',
  'assets/fonts/archivo-latin.woff2',
  'assets/icons/icon16.png',
  'assets/icons/icon32.png',
  'assets/icons/icon48.png',
  'assets/icons/icon128.png',
  'src/background.js',
  'src/converter.html',
  'src/styles.css',
  'src/app.js',
  'src/lib/image.js',
  'src/lib/gif.js',
  'src/lib/bmp.js',
  'src/lib/zip.js',
];

for (const relativePath of files) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing file for package: ${relativePath}`);
  }
}

const entries = files.map((relativePath) => {
  const filePath = path.join(root, relativePath);
  return {
    name: relativePath.split(path.sep).join('/'),
    data: fs.readFileSync(filePath),
    lastModified: fs.statSync(filePath).mtime,
  };
});

const zipBytes = createZip(entries);
fs.mkdirSync(dist, { recursive: true });
const zipPath = path.join(dist, zipName);
fs.writeFileSync(zipPath, Buffer.from(zipBytes));

console.log(`Wrote ${path.relative(root, zipPath)} (${(zipBytes.length / 1024).toFixed(1)} KB, ${entries.length} files)`);
for (const entry of entries) {
  console.log(`  ${entry.name}`);
}
