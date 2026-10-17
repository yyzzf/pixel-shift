import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures');
const outputRoot = path.join(root, 'tests', 'out', 'e2e');
const verifyScript = path.join(root, 'tests', 'verify_image.py');
const verifyZipScript = path.join(root, 'tests', 'verify_zip.py');
const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SOURCES = [
  { file: 'photo.jpg', width: 900, height: 600 },
  { file: 'alpha.png', width: 480, height: 360 },
  { file: 'roll.webp', width: 640, height: 420 },
  { file: 'motion.gif', width: 320, height: 240 },
  { file: 'legacy.bmp', width: 400, height: 300 },
];

const TARGETS = {
  png: { ext: 'png', format: 'PNG' },
  webp: { ext: 'webp', format: 'WEBP' },
  jpeg: { ext: 'jpg', format: 'JPEG' },
  gif: { ext: 'gif', format: 'GIF' },
  bmp: { ext: 'bmp', format: 'BMP' },
};

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 8000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket connection failed'));
      }, { once: true });
    });

    this.ws.addEventListener('message', async (event) => {
      let text = '';
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        text = Buffer.from(event.data).toString('utf8');
      } else if (ArrayBuffer.isView(event.data)) {
        text = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8');
      } else if (event.data && typeof event.data.text === 'function') {
        text = await event.data.text();
      } else {
        text = String(event.data);
      }

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      const handlers = this.handlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch (error) {
            console.error('CDP handler error:', error);
          }
        }
      }
    });

    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeout = 120_000) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Ignore.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await launchChrome();
  let cdp;

  try {
    const pageUrl = `${baseUrl}/src/converter.html`;
    const wsUrl = await openTarget(browser.port, pageUrl);
    cdp = new CDP(wsUrl);
    await cdp.connect();

    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      pageErrors.push(exceptionDetails.text || 'page exception');
      console.error('[page exception]', exceptionDetails.text, exceptionDetails.exception?.description || '');
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type !== 'error') return;
      const text = args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (text) console.error('[page console]', text);
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') console.error('[page log]', entry.text);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Log.enable');

    const evaluate = async (expression, { awaitPromise = true, userGesture = false } = {}) => {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture,
      });
      if (response.exceptionDetails) {
        throw new Error(
          `Page evaluation failed: ${response.exceptionDetails.text} ${
            response.exceptionDetails.exception?.description || ''
          }`,
        );
      }
      return response.result.value;
    };

    const waitFor = async (expression, timeout = 15_000, interval = 100) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    };

    const setViewport = async (width, height, mobile = false, deviceScaleFactor = 1) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
      });
      await sleep(120);
    };

    const screenshot = async (name, clip = null) => {
      const params = { format: 'png', captureBeyondViewport: Boolean(clip) };
      if (clip) params.clip = clip;
      const result = await cdp.send('Page.captureScreenshot', params);
      const target = path.join(outputRoot, name);
      fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
      console.log(`  screenshot ${path.relative(root, target)}`);
    };

    const click = async (selector) => {
      const clicked = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`, { userGesture: true });
      check(clicked, `Missing element: ${selector}`);
    };

    const setFiles = async (fileNames) => {
      const documentNode = await cdp.send('DOM.getDocument', { depth: -1 });
      const input = await cdp.send('DOM.querySelector', {
        nodeId: documentNode.root.nodeId,
        selector: '#fileInput',
      });
      check(input.nodeId, 'file input not found');
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: input.nodeId,
        files: fileNames.map((name) => path.join(fixtures, name)),
      });
    };

    const convert = async () => {
      await evaluate(`window.__pixelShiftDone = new Promise((resolve) => {
        window.addEventListener('pixelshift:converted', (event) => resolve(event.detail), { once: true });
      }); true`);
      await waitFor(`!document.getElementById('convertButton').disabled`);
      await click('#convertButton');
      const detail = await evaluate('window.__pixelShiftDone');
      await waitFor(`!document.body.classList.contains('is-converting')`);
      return detail;
    };

    const getOutputs = async () => evaluate(`(async () => {
      const links = [...document.querySelectorAll('.download-button:not([hidden])')];
      const outputs = [];
      for (const link of links) {
        const response = await fetch(link.href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunk = 32_768;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        outputs.push({
          name: link.download,
          type: response.headers.get('content-type') || '',
          base64: btoa(binary),
        });
      }
      return outputs;
    })()`);

    const verifyImage = (filePath) => {
      const result = spawnSync('python', ['-I', verifyScript, filePath, '-'], {
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(`Pillow verification failed for ${filePath}: ${result.stderr || result.stdout}`);
      }
      return JSON.parse(result.stdout.trim());
    };

    console.log('Loading page');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('.format-option.is-active')`);
    await evaluate('document.fonts.ready.then(() => true)');

    await setViewport(1280, 1000);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('desktop-empty.png');

    await setViewport(390, 844, true, 2);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('mobile-empty.png');
    await setViewport(1280, 1000);
    await evaluate('window.scrollTo(0, 0)');

    console.log('Adding five source images');
    await setFiles(SOURCES.map((source) => source.file));
    await waitFor(`document.querySelectorAll('.queue-item').length === 5`);
    await waitFor(`[...document.querySelectorAll('.file-dimensions')].every((element) => !element.textContent.includes('读取中'))`);
    await screenshot('desktop-added.png');

    for (const [target, expected] of Object.entries(TARGETS)) {
      console.log(`Converting to ${target.toUpperCase()}`);
      await click(`.format-option[data-format="${target}"]`);
      await waitFor(`document.querySelector('.format-option[data-format="${target}"]').getAttribute('aria-checked') === 'true'`);
      await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 5`);
      const detail = await convert();
      check(detail.failed === 0, `${detail.failed} images failed converting to ${target}`);

      const dir = path.join(outputRoot, target);
      fs.mkdirSync(dir, { recursive: true });
      const outputs = await getOutputs();
      check(outputs.length === 5, `expected 5 outputs for ${target}, got ${outputs.length}`);

      for (let index = 0; index < outputs.length; index++) {
        const output = outputs[index];
        const source = SOURCES[index];
        const expectedName = `${source.file.replace(/\.[^.]+$/, '')}.${expected.ext}`;
        check(output.name === expectedName, `output name ${output.name}, expected ${expectedName}`);
        const filePath = path.join(dir, output.name);
        fs.writeFileSync(filePath, Buffer.from(output.base64, 'base64'));
        const info = verifyImage(filePath);

        check(info.format === expected.format, `${output.name}: format ${info.format}, expected ${expected.format}`);
        check(info.width === source.width && info.height === source.height, `${output.name}: wrong dimensions`);
        check(info.frames === 1, `${output.name}: expected a static image, got ${info.frames} frames`);

        if (target === 'png' || target === 'webp' || target === 'gif') {
          if (source.file === 'alpha.png') {
            check(info.corner_rgba[3] === 0, `${output.name}: transparency was lost`);
          }
        }

        if (target === 'jpeg' || target === 'bmp') {
          if (source.file === 'alpha.png') {
            check(info.corner_rgba[3] === 255, `${output.name}: flattened output has alpha`);
            check(
              info.corner_rgba.slice(0, 3).every((value) => value >= 243),
              `${output.name}: transparent corner ${info.corner_rgba} was not filled white`,
            );
          }
        }

        if (source.file === 'motion.gif') {
          const [red, green, blue] = info.corner_rgba;
          check(
            red > 150 && red > green + 60 && blue < 130,
            `${output.name}: expected the first animation frame, corner was ${info.corner_rgba}`,
          );
        }
      }

      console.log(`  verified ${outputs.length} ${expected.format} outputs`);

      if (target === 'jpeg') {
        console.log('  checking quality and background controls');
        const baselinePhotoSize = fs.statSync(path.join(dir, 'photo.jpg')).size;
        await click('.swatch-black');
        await evaluate(`(() => {
          const quality = document.getElementById('quality');
          quality.value = '20';
          quality.dispatchEvent(new Event('input', { bubbles: true }));
          quality.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 5`);
        const variantDetail = await convert();
        check(variantDetail.failed === 0, 'quality/background variant conversion failed');

        const variantDir = path.join(outputRoot, 'jpeg-low-black');
        fs.mkdirSync(variantDir, { recursive: true });
        const variantOutputs = await getOutputs();
        check(variantOutputs.length === 5, 'variant batch did not produce 5 outputs');
        let variantPhotoSize = 0;
        for (const output of variantOutputs) {
          const filePath = path.join(variantDir, output.name);
          fs.writeFileSync(filePath, Buffer.from(output.base64, 'base64'));
          const info = verifyImage(filePath);
          check(info.format === 'JPEG', `variant ${output.name} is not JPEG`);
          if (output.name === 'photo.jpg') variantPhotoSize = fs.statSync(filePath).size;
        }
        check(
          variantPhotoSize > 0 && variantPhotoSize < baselinePhotoSize,
          `quality 20 output (${variantPhotoSize}) is not smaller than quality 90 (${baselinePhotoSize})`,
        );
        const alphaVariant = verifyImage(path.join(variantDir, 'alpha.jpg'));
        check(
          alphaVariant.corner_rgba.slice(0, 3).every((value) => value < 20),
          `black background was not applied: ${alphaVariant.corner_rgba}`,
        );
        console.log(`  quality 20 photo: ${variantPhotoSize} bytes (was ${baselinePhotoSize}); black fill applied`);

        await evaluate(`(() => {
          const quality = document.getElementById('quality');
          quality.value = '90';
          quality.dispatchEvent(new Event('input', { bubbles: true }));
          quality.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await click('.swatch-white');
        await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 5`);
      }

      if (target === 'webp') {
        await setViewport(1280, 1180);
        await evaluate('window.scrollTo(0, 0)');
        await screenshot('desktop-done.png');
      }
    }

    console.log('Testing ZIP download');
    await click('.format-option[data-format="webp"]');
    await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 5`);
    await convert();
    await evaluate(`(() => {
      window.__zipCapture = null;
      window.__originalAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && this.download.endsWith('.zip')) {
          window.__zipCapture = { href: this.href, name: this.download };
          return;
        }
        return window.__originalAnchorClick.call(this);
      };
      return true;
    })()`);
    await click('#zipButton');
    await waitFor('window.__zipCapture !== null', 20_000);
    const zipData = await evaluate(`(async () => {
      const response = await fetch(window.__zipCapture.href);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunk = 32_768;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { name: window.__zipCapture.name, base64: btoa(binary) };
    })()`);
    await evaluate('HTMLAnchorElement.prototype.click = window.__originalAnchorClick; true');
    const zipPath = path.join(outputRoot, zipData.name);
    fs.writeFileSync(zipPath, Buffer.from(zipData.base64, 'base64'));
    const zipResult = spawnSync('python', ['-I', verifyZipScript, zipPath, '--summary'], {
      encoding: 'utf8',
    });
    check(zipResult.status === 0, `ZIP verification failed: ${zipResult.stderr || zipResult.stdout}`);
    const zipInfo = JSON.parse(zipResult.stdout.trim());
    check(zipInfo.names.length === 5, `ZIP has ${zipInfo.names.length} entries`);
    check(
      zipInfo.names.every((name) => name.endsWith('.webp')),
      `ZIP names look wrong: ${zipInfo.names.join(', ')}`,
    );
    console.log(`  verified ${zipInfo.names.length} ZIP entries`);

    console.log('Capturing mobile screenshots');
    await sleep(800);
    await setViewport(390, 844, true, 2);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('mobile-top.png');
    await evaluate(`window.scrollTo(0, document.getElementById('queueSection').offsetTop - 20)`);
    await sleep(250);
    await screenshot('mobile-queue.png');

    console.log('Testing EXIF orientation and clearing');
    await click('#clearButton');
    await waitFor(`document.querySelectorAll('.queue-item').length === 0`);
    await setFiles(['rotated.jpg']);
    await waitFor(`document.querySelectorAll('.queue-item').length === 1`);
    await click('.format-option[data-format="png"]');
    await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 1`);
    const orientationDetail = await convert();
    check(orientationDetail.failed === 0, 'orientation conversion failed');
    const orientationOutputs = await getOutputs();
    check(orientationOutputs.length === 1, 'orientation test did not produce one output');
    check(orientationOutputs[0].name === 'rotated.png', `orientation output name is ${orientationOutputs[0].name}`);
    const orientationDir = path.join(outputRoot, 'orientation');
    fs.mkdirSync(orientationDir, { recursive: true });
    const orientationPath = path.join(orientationDir, 'rotated.png');
    fs.writeFileSync(orientationPath, Buffer.from(orientationOutputs[0].base64, 'base64'));
    const orientationInfo = verifyImage(orientationPath);
    check(
      orientationInfo.width === 200 && orientationInfo.height === 300,
      `EXIF orientation was not applied: ${orientationInfo.width} x ${orientationInfo.height}`,
    );
    const [tr, tg, tb] = orientationInfo.top_right_rgba;
    check(tr > 180 && tr > tg + 80 && tr > tb + 80, 'rotated image marker is missing from the top-right');
    check(
      !(orientationInfo.corner_rgba[0] > 180 && orientationInfo.corner_rgba[1] < 100),
      'rotated image still has the marker at the top-left',
    );
    console.log('  EXIF orientation applied and queue cleared correctly');

    console.log('Testing unsupported file handling');
    const rowCountBefore = await evaluate(`document.querySelectorAll('.queue-item').length`);
    await setFiles(['not-an-image.txt']);
    await waitFor(`!document.getElementById('toast').hidden`);
    const toastText = await evaluate(`document.getElementById('toast').textContent`);
    check(toastText.includes('不是支持的图片格式'), `unexpected toast: ${toastText}`);
    const rowCountAfter = await evaluate(`document.querySelectorAll('.queue-item').length`);
    check(rowCountAfter === rowCountBefore, 'unsupported file was added to the queue');
    console.log('  unsupported file skipped correctly');

    await setViewport(1280, 1000);
    await evaluate('window.scrollTo(0, 0)');

    check(pageErrors.length === 0, `page produced ${pageErrors.length} uncaught exception(s)`);

    console.log('\nE2E passed: 5 formats, transparency, flattening, first-frame GIF, ZIP, validation.\n');
  } finally {
    cdp?.close();
    await stopChrome(browser);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function startServer() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };

  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? '/src/converter.html' : pathname;
      const filePath = path.normalize(path.join(root, relative));
      if (!filePath.startsWith(`${root}${path.sep}`) || !fs.statSync(filePath).isFile()) {
        throw new Error('not found');
      }
      response.writeHead(200, {
        'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return { server, port: server.address().port };
}

async function launchChrome() {
  check(fs.existsSync(chromePath), `Chrome not found at ${chromePath}; set CHROME_PATH`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-shift-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--metrics-recording-only',
    '--window-size=1280,1000',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const process = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  process.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (fs.existsSync(portFile)) {
      const contents = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      port = Number(contents[0]);
      if (port) break;
    }
    if (process.exitCode !== null) {
      throw new Error(`Chrome exited during startup:\n${stderr}`);
    }
    await sleep(100);
  }
  if (!port) throw new Error(`Chrome did not expose a debugging port:\n${stderr}`);

  return { process, profile, port };
}

async function openTarget(port, url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`Could not create a Chrome target: ${response.status}`);
  const target = await response.json();
  return target.webSocketDebuggerUrl;
}

async function stopChrome(browser) {
  if (!browser) return;
  try {
    browser.process.kill();
  } catch {
    // Ignore.
  }
  await sleep(400);
  try {
    fs.rmSync(browser.profile, { recursive: true, force: true });
  } catch {
    // The profile can be locked briefly; it is harmless.
  }
}

main().catch((error) => {
  console.error('\nE2E failed:', error.stack || error.message);
  process.exitCode = 1;
});
