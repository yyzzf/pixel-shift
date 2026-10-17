import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = path.join(root, 'site');
const outputDir = path.join(root, 'tests', 'out', 'site');
const verifyZipScript = path.join(root, 'tests', 'verify_zip.py');
const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

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
      const timer = setTimeout(() => reject(new Error('WebSocket timed out')), 8000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket failed'));
      }, { once: true });
    });
    this.ws.addEventListener('message', async (event) => {
      let text = '';
      if (typeof event.data === 'string') text = event.data;
      else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString('utf8');
      else if (ArrayBuffer.isView(event.data)) text = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8');
      else text = await event.data.text();

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
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) || []) {
        try {
          handler(message.params);
        } catch {
          // Ignore handler errors.
        }
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error('CDP closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
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
  const browser = await launchChrome();
  let cdp;

  try {
    const base = `http://127.0.0.1:${port}`;
    const target = await openTarget(browser.port, `${base}/`);
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();

    const pageErrors = [];
    const failedRequests = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      pageErrors.push(exceptionDetails.text || 'exception');
      console.error('[page exception]', exceptionDetails.text);
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type !== 'error') return;
      const text = args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (text) console.error('[page console]', text);
    });
    cdp.on('Network.loadingFailed', (event) => {
      if (event.errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`${event.errorText} ${event.type}`);
    });
    cdp.on('Network.responseReceived', (event) => {
      if (event.response.status >= 400) {
        failedRequests.push(`${event.response.status} ${event.response.url}`);
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');

    const evaluate = async (expression, { awaitPromise = true } = {}) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`Evaluation failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
      }
      return result.result.value;
    };

    const waitFor = async (expression, timeout = 20_000, interval = 100) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };

    const setViewport = async (width, height, mobile = false, deviceScaleFactor = 1) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
      });
      await sleep(160);
    };

    const screenshot = async (name) => {
      const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outputDir, name), Buffer.from(result.data, 'base64'));
      console.log(`  screenshot tests/out/site/${name}`);
    };

    console.log('Loading landing page');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('.format-tab')`);
    await evaluate('document.fonts.ready.then(() => true)');
    await waitFor(`!document.getElementById('copySha').disabled`, 10_000);
    await waitFor(`document.querySelector('[data-size-for="png"]').title !== ''`, 10_000);

    const title = await evaluate('document.title');
    check(title.includes('换格式'), `unexpected title: ${title}`);
    const h1 = await evaluate(`document.querySelector('h1').innerText.replace(/\\s+/g, ' ')`);
    check(h1.includes('不必离开浏览器'), `unexpected h1: ${h1}`);
    console.log(`  title: ${title}`);

    console.log('Checking download metadata and archive');
    const metadata = JSON.parse(fs.readFileSync(path.join(siteRoot, 'downloads', 'latest.json'), 'utf8'));
    const downloadLinks = await evaluate(`[...document.querySelectorAll('.js-download')].map((link) => link.getAttribute('href'))`);
    check(downloadLinks.length >= 4, `expected multiple download links, found ${downloadLinks.length}`);
    check(
      downloadLinks.every((href) => href === `downloads/${metadata.file}`),
      `download links are not pointing at ${metadata.file}: ${downloadLinks.join(', ')}`,
    );
    const shownHash = (await evaluate(`document.getElementById('zipSha').textContent`)).replace(/\s+/g, '');
    check(shownHash === metadata.sha256, 'displayed SHA-256 does not match latest.json');
    const shownSize = await evaluate(`document.getElementById('heroDownloadSize').textContent`);
    check(/KB|MB/.test(shownSize), `download size is missing: ${shownSize}`);

    const zipResponse = await fetch(`${base}/downloads/${metadata.file}`);
    check(zipResponse.ok, `ZIP request failed: ${zipResponse.status}`);
    const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
    check(zipBytes.length === metadata.size, `ZIP size ${zipBytes.length} != ${metadata.size}`);
    const zipHash = crypto.createHash('sha256').update(zipBytes).digest('hex');
    check(zipHash === metadata.sha256, 'served ZIP hash does not match latest.json');
    const zipPath = path.join(outputDir, metadata.file);
    fs.writeFileSync(zipPath, zipBytes);
    const zipCheck = spawnSync('python', ['-I', verifyZipScript, zipPath, '--summary'], { encoding: 'utf8' });
    check(zipCheck.status === 0, `ZIP verification failed: ${zipCheck.stderr || zipCheck.stdout}`);
    const zipInfo = JSON.parse(zipCheck.stdout.trim());
    check(zipInfo.names.includes('manifest.json'), 'ZIP does not contain manifest.json');
    console.log(`  ZIP ${metadata.size} bytes, ${zipInfo.names.length} files, SHA-256 verified`);

    console.log('Checking format tabs');
    const formats = ['jpg', 'png', 'webp', 'gif', 'bmp'];
    for (const format of formats) {
      await evaluate(`document.getElementById('tab-${format}').click(); true`);
      await waitFor(`document.getElementById('tab-${format}').getAttribute('aria-selected') === 'true'`);
      await waitFor(`!document.querySelector('.specimen-image').classList.contains('is-loading')`);
      const state = await evaluate(`({
        badge: document.getElementById('specimenFormat').textContent,
        src: document.getElementById('specimenImage').getAttribute('src'),
        note: document.getElementById('formatNote').textContent,
        transparency: document.getElementById('formatTransparency').textContent,
        tabSize: document.querySelector('[data-size-for="${format}"]').textContent,
        labelledBy: document.getElementById('specimenPanel').getAttribute('aria-labelledby')
      })`);
      check(state.badge.toUpperCase() === format.toUpperCase(), `badge is ${state.badge} for ${format}`);
      check(state.src.includes(`specimen.${format}`), `image src is ${state.src} for ${format}`);
      check(state.note.length > 8, `missing note for ${format}`);
      check(state.labelledBy === `tab-${format}`, `panel labelled by ${state.labelledBy}`);
      const expectedSize = JSON.parse(fs.readFileSync(path.join(siteRoot, 'assets', 'specimen', 'sizes.json'), 'utf8')).formats[format];
      check(state.tabSize.length > 2, `missing size for ${format}`);
      if (expectedSize >= 1024) check(/KB|MB/.test(state.tabSize), `bad size for ${format}: ${state.tabSize}`);
    }

    await evaluate(`document.getElementById('tab-png').focus(); true`);
    await evaluate(`document.getElementById('tab-png').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
    await waitFor(`document.getElementById('tab-webp').getAttribute('aria-selected') === 'true'`);
    check(await evaluate(`document.activeElement.id`) === 'tab-webp', 'keyboard focus did not move to WebP');
    await evaluate(`document.getElementById('tab-webp').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); true`);
    await waitFor(`document.getElementById('tab-bmp').getAttribute('aria-selected') === 'true'`);
    await evaluate(`document.getElementById('tab-bmp').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); true`);
    await waitFor(`document.getElementById('tab-jpg').getAttribute('aria-selected') === 'true'`);
    console.log('  mouse and keyboard tab selection work');

    await evaluate(`document.getElementById('tab-png').click(); true`);
    await waitFor(`document.getElementById('tab-png').getAttribute('aria-selected') === 'true'`);
    await waitFor(`!document.querySelector('.specimen-image').classList.contains('is-loading')`);
    await evaluate(`(() => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
      document.querySelector('.hero-copy h1').click();
      return true;
    })()`);

    console.log('Capturing desktop screenshots');
    await setViewport(1440, 1100);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('desktop-hero.png');

    await evaluate(`window.scrollTo(0, document.getElementById('workbench').offsetTop - 90)`);
    await sleep(500);
    await screenshot('desktop-workbench.png');

    await evaluate(`window.scrollTo(0, document.getElementById('formats').offsetTop - 90)`);
    await sleep(300);
    await screenshot('desktop-formats.png');

    await evaluate(`window.scrollTo(0, document.getElementById('local').offsetTop - 90)`);
    await sleep(300);
    await screenshot('desktop-local.png');

    await evaluate(`window.scrollTo(0, document.getElementById('install').offsetTop - 90)`);
    await sleep(300);
    await screenshot('desktop-install.png');

    await evaluate(`window.scrollTo(0, document.getElementById('faq').offsetTop - 90)`);
    await sleep(300);
    await screenshot('desktop-faq.png');

    const desktopOverflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    check(desktopOverflow <= 0, `desktop has ${desktopOverflow}px horizontal overflow`);

    console.log('Capturing tablet screenshots');
    await setViewport(1024, 1000);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('tablet-hero.png');
    const tabletOverflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    check(tabletOverflow <= 0, `tablet has ${tabletOverflow}px horizontal overflow`);

    await setViewport(768, 1000);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('small-hero.png');
    const smallOverflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    check(smallOverflow <= 0, `small layout has ${smallOverflow}px horizontal overflow`);

    console.log('Capturing mobile screenshots');
    await setViewport(390, 844, true, 2);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('mobile-hero.png');
    await evaluate(`window.scrollTo(0, document.getElementById('formats').offsetTop - 70)`);
    await sleep(250);
    await screenshot('mobile-formats.png');
    await evaluate(`window.scrollTo(0, document.getElementById('install').offsetTop - 70)`);
    await sleep(250);
    await screenshot('mobile-install.png');

    const mobileOverflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    check(mobileOverflow <= 0, `mobile has ${mobileOverflow}px horizontal overflow`);
    const mobileTabsFit = await evaluate(`(() => {
      const tabs = document.querySelector('.format-tabs');
      return tabs.scrollWidth <= tabs.clientWidth + 1;
    })()`);
    check(mobileTabsFit, 'format tabs overflow on mobile');

    check(failedRequests.length === 0, `failed requests: ${failedRequests.join('; ')}`);
    check(pageErrors.length === 0, `page exceptions: ${pageErrors.join('; ')}`);

    console.log('\nLanding page test passed.\n');
  } finally {
    cdp?.close();
    try {
      browser.process.kill();
    } catch {
      // Ignore.
    }
    await sleep(350);
    try {
      fs.rmSync(browser.profile, { recursive: true, force: true });
    } catch {
      // Profile deletion is best-effort.
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

async function startServer() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.zip': 'application/zip',
  };

  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.normalize(path.join(siteRoot, relative));
      if (!filePath.startsWith(`${siteRoot}${path.sep}`) || !fs.statSync(filePath).isFile()) {
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-shift-site-'));
  const process = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--window-size=1440,1100',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  process.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (fs.existsSync(portFile)) {
      port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (port) break;
    }
    if (process.exitCode !== null) throw new Error(`Chrome exited during startup:\n${stderr}`);
    await sleep(100);
  }
  if (!port) throw new Error(`Chrome did not expose a debugging port:\n${stderr}`);
  return { process, profile, port };
}

async function openTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`Could not create Chrome target: ${response.status}`);
  return response.json();
}

main().catch((error) => {
  console.error('\nSite test failed:', error.stack || error.message);
  process.exitCode = 1;
});
