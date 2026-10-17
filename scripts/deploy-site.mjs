import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');
const downloadsDir = path.join(siteDir, 'downloads');
const remote = process.env.PAGES_REMOTE || 'git@github.com:yyzzf/yyzzf.github.io.git';
const branch = process.env.PAGES_BRANCH || 'main';
const force = process.argv.includes('--force');
const liveUrl = 'https://yyzzf.github.io/';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  }).trim();
}

function fail(message) {
  throw new Error(message);
}

function requireSiteFile(relativePath) {
  const absolutePath = path.join(siteDir, relativePath);
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    fail(`Missing site file: site/${relativePath}. Run npm run site:assets first.`);
  }
}

function prepareDownload() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const zipName = `pixel-shift-${manifest.version}.zip`;
  const zipPath = path.join(root, 'dist', zipName);

  console.log(`Building extension package ${zipName}`);
  run('node', ['scripts/package.mjs']);

  if (!fs.statSync(zipPath, { throwIfNoEntry: false })?.isFile()) {
    fail(`Package was not created at ${zipPath}`);
  }

  fs.mkdirSync(downloadsDir, { recursive: true });
  for (const entry of fs.readdirSync(downloadsDir)) {
    if (entry.endsWith('.zip')) fs.rmSync(path.join(downloadsDir, entry), { force: true });
  }
  fs.copyFileSync(zipPath, path.join(downloadsDir, zipName));

  const data = fs.readFileSync(path.join(downloadsDir, zipName));
  const metadata = {
    version: manifest.version,
    file: zipName,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
  fs.writeFileSync(
    path.join(downloadsDir, 'latest.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );

  console.log(`Download: ${zipName} (${(metadata.size / 1024).toFixed(1)} KB)`);
  console.log(`SHA-256: ${metadata.sha256}`);
}

function deploy() {
  for (const file of [
    'index.html',
    'styles.css',
    'main.js',
    'robots.txt',
    'sitemap.xml',
    '.nojekyll',
    'assets/og.png',
    'assets/app-shot.png',
    'assets/specimen/specimen.bmp',
    'downloads/latest.json',
  ]) {
    requireSiteFile(file);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yyzzf-pages-'));
  let succeeded = false;

  try {
    console.log(`Cloning ${remote}`);
    try {
      execFileSync('git', ['clone', '--quiet', remote, temp], {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      fail(`Could not clone the Pages repository.\n${error.stderr || error.message}`);
    }

    const tracked = capture('git', ['-C', temp, 'ls-files']);
    if (tracked && !force) {
      fail(
        'The Pages repository already contains files. Re-run with --force to replace its contents:\n'
        + '  npm run site:deploy -- --force',
      );
    }
    if (tracked && force) {
      for (const entry of fs.readdirSync(temp)) {
        if (entry === '.git') continue;
        fs.rmSync(path.join(temp, entry), { recursive: true, force: true });
      }
    }

    fs.cpSync(siteDir, temp, { recursive: true, force: true });

    run('git', ['-C', temp, 'add', '-A']);
    const status = capture('git', ['-C', temp, 'status', '--porcelain']);
    if (!status) {
      console.log('No site changes to deploy.');
      succeeded = true;
      return;
    }

    run('git', ['-C', temp, 'commit', '-m', 'Update Pixel Shift landing page', '-m', 'Co-Authored-By: Claude Code <noreply@anthropic.com>']);
    run('git', ['-C', temp, 'push', 'origin', `HEAD:${branch}`]);
    succeeded = true;
    console.log(`\nPushed to ${remote} (${branch}).`);
    console.log(`GitHub Pages usually publishes within a minute: ${liveUrl}`);
  } finally {
    if (succeeded) {
      fs.rmSync(temp, { recursive: true, force: true });
    } else {
      console.error(`Deployment workspace kept for inspection: ${temp}`);
    }
  }
}

try {
  prepareDownload();
  deploy();
} catch (error) {
  console.error(`\nSite deployment failed: ${error.message}`);
  process.exitCode = 1;
}
