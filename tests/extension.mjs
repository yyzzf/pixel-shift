import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : root;
const fixtures = path.join(root, 'tests', 'fixtures');
const outDir = path.join(root, 'tests', 'out', 'extension');
const verifyScript = path.join(root, 'tests', 'verify_image.py');
const browserPath = process.env.BROWSER_PATH
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

fs.mkdirSync(outDir, { recursive: true });

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
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
      const text = typeof event.data === 'string'
        ? event.data
        : event.data instanceof ArrayBuffer
          ? Buffer.from(event.data).toString('utf8')
          : ArrayBuffer.isView(event.data)
            ? Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8')
            : await event.data.text();
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
  }

  send(method, params = {}) {
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

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function extensionIdForPath(directory) {
  const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const hex = crypto.createHash('sha256').update(Buffer.from(directory, encoding)).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  check(fs.existsSync(browserPath), `Browser not found at ${browserPath}; set BROWSER_PATH`);
  check(fs.existsSync(path.join(extensionDir, 'manifest.json')), `No manifest.json in ${extensionDir}`);
  const id = extensionIdForPath(extensionDir);
  const browser = await launch(browserPath);
  const pageErrors = [];
  let cdp;

  try {
    const version = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((response) => response.json());
    console.log(`Browser: ${version.Browser}`);
    console.log(`Extension ID: ${id}`);

    const target = await newPage(browser.port, `chrome-extension://${id}/src/converter.html`);
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      pageErrors.push(exceptionDetails.text || 'exception');
      console.error('[extension page exception]', exceptionDetails.text);
    });

    const evaluate = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (response.exceptionDetails) {
        throw new Error(`Page evaluation failed: ${response.exceptionDetails.text}`);
      }
      return response.result.value;
    };

    const waitFor = async (expression, timeout = 15_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };

    await waitFor(`document.readyState === 'complete' && !!document.querySelector('.format-option.is-active')`);
    const runtimeId = await evaluate('typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : null');
    if (!runtimeId) {
      throw new Error(
        'The browser loaded the page but not as an extension. '
        + 'Recent branded Chrome builds ignore --load-extension; use Edge or Chrome for Testing.',
      );
    }
    check(runtimeId === id, `chrome.runtime.id is ${runtimeId}, expected ${id}`);
    console.log('Extension page loaded with chrome.runtime available.');

    const documentNode = await cdp.send('DOM.getDocument', { depth: -1 });
    const input = await cdp.send('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: '#fileInput',
    });
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: input.nodeId,
      files: [
        path.join(fixtures, 'photo.jpg'),
        path.join(fixtures, 'alpha.png'),
      ],
    });
    await waitFor(`document.querySelectorAll('.queue-item').length === 2`);

    await evaluate(`document.querySelector('.format-option[data-format="png"]').click(); true`);
    await waitFor(`document.querySelectorAll('.queue-item.is-pending').length === 2`);
    await evaluate(`window.__extDone = new Promise((resolve) => {
      window.addEventListener('pixelshift:converted', (event) => resolve(event.detail), { once: true });
    }); true`);
    await evaluate(`document.getElementById('convertButton').click(); true`);
    const detail = await evaluate('window.__extDone');
    check(detail.failed === 0, `${detail.failed} extension conversions failed`);
    await waitFor(`!document.body.classList.contains('is-converting')`);

    const outputs = await evaluate(`(async () => {
      const links = [...document.querySelectorAll('.download-button:not([hidden])')];
      const result = [];
      for (const link of links) {
        const response = await fetch(link.href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32_768) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32_768));
        }
        result.push({ name: link.download, base64: btoa(binary) });
      }
      return result;
    })()`);
    check(outputs.length === 2, `expected 2 outputs, got ${outputs.length}`);

    for (const output of outputs) {
      const filePath = path.join(outDir, output.name);
      fs.writeFileSync(filePath, Buffer.from(output.base64, 'base64'));
      const verification = spawnSync('python', ['-I', verifyScript, filePath, '-'], {
        encoding: 'utf8',
      });
      check(verification.status === 0, `Pillow failed on ${output.name}`);
      const info = JSON.parse(verification.stdout.trim());
      check(info.format === 'PNG', `${output.name} is ${info.format}`);
      if (output.name === 'alpha.png') {
        check(info.corner_rgba[3] === 0, 'extension output lost transparency');
      }
      console.log(`  verified ${output.name} (${info.width} x ${info.height})`);
    }

    console.log('Inspecting extension registration');
    const internalsTarget = await newPage(browser.port, 'chrome://extensions-internals/');
    const internals = new CDP(internalsTarget.webSocketDebuggerUrl);
    await internals.connect();
    await internals.send('Runtime.enable');
    await sleep(1000);
    const body = await internals.send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    internals.close();
    const records = JSON.parse(body.result.value);
    const record = records.find((entry) => entry.id === id);
    check(record, 'extension is not registered in chrome://extensions-internals');
    check(record.registry_status === 'ENABLED', `extension status is ${record.registry_status}`);
    console.log(`  registered: ${record.id} (${record.location}, ${record.registry_status})`);

    check(pageErrors.length === 0, `page raised ${pageErrors.length} exception(s)`);
    console.log('\nExtension smoke test passed.\n');
  } finally {
    cdp?.close();
    try {
      browser.process.kill();
    } catch {
      // Ignore.
    }
    await sleep(400);
    try {
      fs.rmSync(browser.profile, { recursive: true, force: true });
    } catch {
      // Profile deletion is best-effort.
    }
  }
}

async function launch(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-shift-ext-'));
  const process = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
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
    if (process.exitCode !== null) throw new Error(`Browser exited during startup:\n${stderr}`);
    await sleep(100);
  }
  if (!port) throw new Error(`Browser did not expose a debugging port:\n${stderr}`);
  return { process, profile, port };
}

async function newPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`Could not create page target: ${response.status}`);
  return response.json();
}

main().catch((error) => {
  console.error('\nExtension test failed:', error.stack || error.message);
  process.exitCode = 1;
});
