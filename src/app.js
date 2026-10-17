import {
  TARGETS,
  convertImage,
  isSupportedFile,
  outputFileName,
} from './lib/image.js';
import { createZip } from './lib/zip.js';

const STORAGE_KEY = 'pixel-shift:settings:v1';

const TIPS = {
  jpeg: '适合照片和分享。没有透明通道，透明部分会被填平。',
  png: '无损压缩，适合截图、图标和需要透明的图片。',
  webp: '通常比 JPG 更小，也支持透明，适合网页使用。',
  gif: '最多 256 色，适合简单图形。动画只输出第一帧。',
  bmp: '不压缩，适合需要兼容旧软件的场合。透明部分会被填平。',
};

const els = {
  workbench: document.getElementById('workbench'),
  dropZone: document.getElementById('dropZone'),
  dropTitle: document.getElementById('dropTitle'),
  dropDescription: document.getElementById('dropDescription'),
  chooseButton: document.getElementById('chooseButton'),
  fileInput: document.getElementById('fileInput'),
  stamp: document.querySelector('.drop-stamp'),
  targetStamp: document.getElementById('targetStamp'),
  stampDesc: document.getElementById('stampDesc'),
  formatList: document.querySelector('.format-list'),
  formatButtons: [...document.querySelectorAll('.format-option')],
  formatTip: document.getElementById('formatTip'),
  quality: document.getElementById('quality'),
  qualityValue: document.getElementById('qualityValue'),
  qualitySetting: document.getElementById('qualitySetting'),
  backgroundSetting: document.getElementById('backgroundSetting'),
  gifSetting: document.getElementById('gifSetting'),
  plainSetting: document.getElementById('plainSetting'),
  dither: document.getElementById('dither'),
  presetSwatches: [...document.querySelectorAll('.swatch[data-bg]')],
  customSwatch: document.querySelector('.swatch-custom'),
  customBackground: document.getElementById('customBackground'),
  queueSection: document.getElementById('queueSection'),
  queue: document.getElementById('queue'),
  queueSummary: document.getElementById('queueSummary'),
  clearButton: document.getElementById('clearButton'),
  statusLine: document.getElementById('statusLine'),
  actionNote: document.getElementById('actionNote'),
  convertButton: document.getElementById('convertButton'),
  zipButton: document.getElementById('zipButton'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  toast: document.getElementById('toast'),
  rowTemplate: document.getElementById('rowTemplate'),
};

const state = {
  rows: [],
  target: 'webp',
  quality: 90,
  background: '#ffffff',
  dither: true,
  converting: false,
  zipping: false,
  sequence: 0,
  progress: { current: 0, total: 0 },
  dragDepth: 0,
  toastTimer: 0,
  progressTimer: 0,
};

init();

function init() {
  loadSettings();
  bindEvents();
  syncTargetUI({ animate: false });
  updateQualityDisplay();
  syncSwatches();
  updateDropCopy();
  updateQueueSummary();
  updateActionBar();
  setStatus('');
}

function bindEvents() {
  els.chooseButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openFilePicker();
  });

  els.dropZone.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, label, kbd')) return;
    openFilePicker();
  });

  els.fileInput.addEventListener('change', () => {
    const files = [...els.fileInput.files];
    els.fileInput.value = '';
    addFiles(files);
  });

  els.formatList.addEventListener('click', (event) => {
    const button = event.target.closest('.format-option');
    if (button) selectTarget(button.dataset.format);
  });

  els.formatList.addEventListener('keydown', (event) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = els.formatButtons;
    const current = document.activeElement?.closest?.('.format-option');
    let index = buttons.indexOf(current);
    if (index < 0) return;

    event.preventDefault();
    if (event.key === 'Home') {
      index = 0;
    } else if (event.key === 'End') {
      index = buttons.length - 1;
    } else {
      const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      index = (index + direction + buttons.length) % buttons.length;
    }
    buttons[index].focus();
    selectTarget(buttons[index].dataset.format);
  });

  els.quality.addEventListener('input', () => {
    state.quality = Number(els.quality.value);
    updateQualityDisplay();
  });

  els.quality.addEventListener('change', () => {
    state.quality = Number(els.quality.value);
    saveSettings();
    if (TARGETS[state.target].lossy) {
      invalidateOutputs('质量设置已改变，需要重新转换。');
    }
  });

  for (const button of els.presetSwatches) {
    button.addEventListener('click', () => {
      if (state.converting) return;
      setBackground(button.dataset.bg, false);
    });
  }

  els.customBackground.addEventListener('input', () => {
    if (state.converting) return;
    setBackground(els.customBackground.value, true);
  });

  els.dither.addEventListener('change', () => {
    state.dither = els.dither.checked;
    saveSettings();
    if (state.target === 'gif') {
      invalidateOutputs('GIF 设置已改变，需要重新转换。');
    }
  });

  els.convertButton.addEventListener('click', () => {
    handleConvert();
  });

  els.zipButton.addEventListener('click', () => {
    handleZip();
  });

  els.clearButton.addEventListener('click', () => {
    clearAll();
  });

  els.queue.addEventListener('click', (event) => {
    const removeButton = event.target.closest('.remove-button');
    if (!removeButton) return;
    const item = removeButton.closest('.queue-item');
    if (!item) return;
    const row = state.rows.find((candidate) => String(candidate.id) === item.dataset.id);
    if (row) removeRow(row);
  });

  els.workbench.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event) || state.converting) return;
    event.preventDefault();
    state.dragDepth++;
    els.workbench.classList.add('is-dragging');
  });

  els.workbench.addEventListener('dragover', (event) => {
    if (!isFileDrag(event) || state.converting) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  els.workbench.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) els.workbench.classList.remove('is-dragging');
  });

  els.workbench.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    resetDragState();
    if (state.converting) {
      showToast('正在转换，请稍候再添加图片。');
      return;
    }
    addFiles(event.dataTransfer.files);
  });

  window.addEventListener('dragover', (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });

  window.addEventListener('drop', (event) => {
    if (isFileDrag(event)) event.preventDefault();
    resetDragState();
  });

  window.addEventListener('dragend', resetDragState);

  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) resetDragState();
  });

  document.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const files = items
      .filter((item) => item.kind === 'file' && (item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  window.addEventListener('beforeunload', () => {
    for (const row of state.rows) revokeRowUrls(row);
  });
}

function openFilePicker() {
  if (state.converting) return;
  els.fileInput.click();
}

function selectTarget(target) {
  if (state.converting || !TARGETS[target] || state.target === target) return;
  state.target = target;
  syncTargetUI({ animate: true });
  saveSettings();
  invalidateOutputs('输出设置已改变，需要重新转换。');
  updateActionBar();
}

function setBackground(hex, custom) {
  state.background = String(hex).toLowerCase();
  syncSwatches(custom);
  saveSettings();
  if (state.target === 'jpeg' || state.target === 'bmp') {
    invalidateOutputs('填充颜色已改变，需要重新转换。');
  }
}

function syncTargetUI({ animate }) {
  const target = state.target;
  const format = TARGETS[target];
  const previousStamp = els.targetStamp.textContent;

  for (const button of els.formatButtons) {
    const active = button.dataset.format === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  }

  els.formatTip.textContent = TIPS[target];
  els.qualitySetting.hidden = !format.lossy;
  els.backgroundSetting.hidden = !(target === 'jpeg' || target === 'bmp');
  els.gifSetting.hidden = target !== 'gif';
  els.plainSetting.hidden = !(target === 'png' || target === 'bmp');

  els.targetStamp.textContent = format.label;
  els.stampDesc.textContent = format.description;

  if (animate && previousStamp !== format.label) {
    els.stamp.classList.remove('is-swapping');
    void els.stamp.offsetWidth;
    els.stamp.classList.add('is-swapping');
  }

  els.customSwatch.classList.toggle(
    'is-active',
    !els.presetSwatches.some((button) => button.dataset.bg.toLowerCase() === state.background),
  );

  for (const row of state.rows) updateRow(row);
}

function updateQualityDisplay() {
  const value = Number(els.quality.value);
  state.quality = value;
  els.qualityValue.textContent = String(value);
  const min = Number(els.quality.min);
  const max = Number(els.quality.max);
  const percentage = ((value - min) / (max - min)) * 100;
  els.quality.style.setProperty('--fill', `${percentage}%`);
}

function syncSwatches(forceCustom = false) {
  const value = state.background.toLowerCase();
  let matched = false;

  for (const button of els.presetSwatches) {
    const active = !forceCustom && button.dataset.bg.toLowerCase() === value;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
    matched = matched || active;
  }

  els.customSwatch.classList.toggle('is-active', forceCustom || !matched);
  els.customSwatch.style.setProperty('--custom-color', value);
  els.customBackground.value = value;
}

function addFiles(fileList) {
  if (state.converting) {
    showToast('正在转换，请稍候再添加图片。');
    return;
  }

  const files = [...(fileList || [])];
  if (!files.length) return;

  const supported = files.filter(isSupportedFile);
  const skipped = files.length - supported.length;
  if (skipped > 0) {
    showToast(`${skipped} 个文件不是支持的图片格式，已跳过。`);
  }
  if (!supported.length) {
    if (state.rows.length === 0) setStatus('');
    return;
  }

  for (const file of supported) addRow(file);

  updateDropCopy();
  updateQueueSummary();
  updateActionBar();
  setStatus('');
  els.queueSection.hidden = false;
}

function addRow(file) {
  const fragment = els.rowTemplate.content.cloneNode(true);
  const element = fragment.querySelector('.queue-item');
  const id = ++state.sequence;
  element.dataset.id = String(id);

  const row = {
    id,
    file,
    inputUrl: URL.createObjectURL(file),
    width: 0,
    height: 0,
    previewFailed: false,
    status: 'pending',
    outputBlob: null,
    outputUrl: null,
    outputName: '',
    error: '',
    element,
  };

  element.querySelector('.file-name').textContent = file.name || '未命名图片';
  element.querySelector('.file-name').title = file.name || '未命名图片';
  element.querySelector('.file-size').textContent = formatBytes(file.size);
  element.querySelector('.from-ext').textContent = inputLabel(file);

  const preview = element.querySelector('img');
  preview.addEventListener('load', () => {
    if (!state.rows.includes(row)) return;
    row.width = preview.naturalWidth;
    row.height = preview.naturalHeight;
    updateRow(row);
  }, { once: true });
  preview.addEventListener('error', () => {
    if (!state.rows.includes(row)) return;
    row.previewFailed = true;
    updateRow(row);
  }, { once: true });
  preview.src = row.inputUrl;

  state.rows.push(row);
  els.queue.appendChild(fragment);
  updateRow(row);
}

function updateRow(row) {
  const element = row.element;
  if (!element) return;

  for (const name of ['is-pending', 'is-working', 'is-done', 'is-error']) {
    element.classList.remove(name);
  }
  element.classList.add(`is-${row.status}`);

  const dimensions = row.width && row.height
    ? `${row.width} × ${row.height}`
    : row.previewFailed ? '尺寸未知' : '读取中…';
  element.querySelector('.file-dimensions').textContent = dimensions;
  element.querySelector('.to-ext').textContent = TARGETS[state.target].label;

  const stateElement = element.querySelector('.result-state');
  const sizeElement = element.querySelector('.result-size');
  const errorElement = element.querySelector('.file-error');
  const download = element.querySelector('.download-button');
  const remove = element.querySelector('.remove-button');

  errorElement.hidden = true;
  errorElement.textContent = '';
  errorElement.removeAttribute('title');
  download.hidden = true;
  download.removeAttribute('href');
  download.removeAttribute('download');
  remove.disabled = state.converting;
  stateElement.classList.remove('is-smaller', 'is-larger');

  if (row.status === 'working') {
    sizeElement.textContent = '';
    stateElement.textContent = '转换中…';
    stateElement.removeAttribute('title');
  } else if (row.status === 'done' && row.outputBlob && row.outputUrl) {
    sizeElement.textContent = formatBytes(row.outputBlob.size);
    const relative = relativeSize(row.outputBlob.size, row.file.size);
    stateElement.textContent = relative;
    stateElement.title = '相对原文件大小';
    stateElement.classList.add(row.outputBlob.size < row.file.size ? 'is-smaller' : 'is-larger');
    download.hidden = false;
    download.href = row.outputUrl;
    download.download = row.outputName;
    download.title = `下载 ${row.outputName}`;
    download.setAttribute('aria-label', `下载 ${row.outputName}`);
  } else if (row.status === 'error') {
    sizeElement.textContent = '';
    stateElement.textContent = '转换失败';
    stateElement.title = row.error || '转换失败';
    errorElement.textContent = row.error || '转换失败';
    errorElement.title = row.error || '转换失败';
    errorElement.hidden = false;
  } else {
    sizeElement.textContent = '';
    stateElement.textContent = '待转换';
    stateElement.removeAttribute('title');
  }
}

function updateDropCopy() {
  const hasFiles = state.rows.length > 0;
  els.dropTitle.textContent = hasFiles ? '继续添加图片' : '把图片拖进来';
  els.dropDescription.textContent = hasFiles
    ? '拖入更多图片，或点击选择文件。'
    : '支持 JPG、PNG、WebP、GIF、BMP。可一次添加多张，或直接粘贴。';
  els.workbench.classList.toggle('has-files', hasFiles);
}

function updateQueueSummary() {
  if (!state.rows.length) {
    els.queueSummary.textContent = '还没有图片';
    return;
  }

  const totalBytes = state.rows.reduce((sum, row) => sum + row.file.size, 0);
  const done = state.rows.filter((row) => row.status === 'done').length;
  const failed = state.rows.filter((row) => row.status === 'error').length;

  let text = `${state.rows.length} 张图片，共 ${formatBytes(totalBytes)}`;
  if (failed > 0) {
    text += `；${failed} 张失败`;
  } else if (done === state.rows.length) {
    text += '；全部完成';
  } else if (done > 0) {
    text += `；已转换 ${done} 张`;
  }
  els.queueSummary.textContent = `${text}。`;
}

function updateActionBar() {
  const count = state.rows.length;
  const done = state.rows.filter((row) => row.status === 'done').length;
  const failed = state.rows.filter((row) => row.status === 'error').length;
  const pending = state.rows.filter((row) => row.status === 'pending').length;
  const todo = count - done;

  const zipPrimary = !state.converting && done > 0 && todo === 0;
  setButtonVariant(els.zipButton, zipPrimary ? 'accent' : 'ghost');
  setButtonVariant(els.convertButton, zipPrimary ? 'ghost' : 'accent');

  els.zipButton.textContent = state.zipping ? '正在打包…' : '打包下载 ZIP';
  els.zipButton.disabled = state.converting || state.zipping || done === 0;
  els.convertButton.disabled = state.converting || state.zipping || count === 0;

  if (state.zipping) {
    els.convertButton.textContent = '开始转换';
    els.actionNote.textContent = '正在把转换结果打包。';
    return;
  }

  if (state.converting) {
    els.convertButton.textContent = `转换中 ${state.progress.current} / ${state.progress.total}`;
    els.actionNote.textContent = '正在本地处理，请勿关闭页面。';
    return;
  }

  if (count === 0) {
    els.convertButton.textContent = '开始转换';
    els.actionNote.textContent = '图片只在你的浏览器里处理。';
    return;
  }

  if (todo === 0) {
    els.convertButton.textContent = '重新转换全部';
    els.actionNote.textContent = '转换完成，可以逐张下载或全部打包。';
    return;
  }

  if (failed > 0 && pending === 0) {
    els.convertButton.textContent = `重试 ${failed} 张`;
  } else {
    els.convertButton.textContent = `转换 ${todo} 张`;
  }

  if (done > 0) {
    els.actionNote.textContent = '已完成的图片可以先下载。';
  } else {
    els.actionNote.textContent = '准备好后，点击开始转换。';
  }
}

function setButtonVariant(button, variant) {
  button.classList.toggle('button-accent', variant === 'accent');
  button.classList.toggle('button-ghost', variant === 'ghost');
}

async function handleConvert() {
  if (state.converting || state.zipping || !state.rows.length) return;

  state.quality = Number(els.quality.value);
  state.dither = els.dither.checked;

  let rows = state.rows.filter((row) => row.status !== 'done');
  if (!rows.length) {
    for (const row of state.rows) {
      revokeOutputUrl(row);
      row.outputBlob = null;
      row.outputUrl = null;
      row.outputName = '';
      row.error = '';
      row.status = 'pending';
      updateRow(row);
    }
    rows = [...state.rows];
  }

  await convertRows(rows);
}

async function convertRows(rows) {
  const usedNames = new Set(
    state.rows
      .filter((row) => row.status === 'done' && row.outputName)
      .map((row) => row.outputName.toLowerCase()),
  );

  state.converting = true;
  state.progress = { current: 0, total: rows.length };
  setBusy(true);
  beginProgress(rows.length);
  setStatus(`开始转换 ${rows.length} 张图片，输出为 ${TARGETS[state.target].label}。`);
  updateActionBar();

  let completed = 0;
  let failed = 0;

  try {
    for (const row of rows) {
      if (!state.rows.includes(row)) continue;
      row.status = 'working';
      row.error = '';
      updateRow(row);
      updateActionBar();

      // Let the browser paint the working state before heavy canvas work.
      await delay(24);

      try {
        const result = await convertImage(row.file, state.target, {
          quality: state.quality / 100,
          background: state.background,
          dither: state.dither,
        });

        revokeOutputUrl(row);
        row.outputBlob = result.blob;
        row.outputUrl = URL.createObjectURL(result.blob);
        row.outputName = outputFileName(row.file.name, state.target, usedNames);
        row.status = 'done';
      } catch (error) {
        row.status = 'error';
        row.error = cleanErrorMessage(error);
        failed++;
      }

      completed++;
      state.progress.current = completed;
      updateProgress(completed, rows.length);
      updateRow(row);
      updateQueueSummary();
      updateActionBar();
      await delay(16);
    }
  } finally {
    state.converting = false;
    setBusy(false);
    finishProgress();
    updateQueueSummary();
    updateActionBar();
    for (const row of state.rows) updateRow(row);
  }

  if (failed > 0) {
    setStatus(
      `${completed - failed} 张转换完成，${failed} 张失败。可以点击“重试”再试一次。`,
      'error',
    );
  } else {
    setStatus(`已转换 ${completed} 张图片。`, 'success');
  }

  window.dispatchEvent(new CustomEvent('pixelshift:converted', {
    detail: { count: completed, failed },
  }));
}

async function handleZip() {
  if (state.converting || state.zipping) return;
  const done = state.rows.filter((row) => row.status === 'done' && row.outputBlob);
  if (!done.length) return;

  state.zipping = true;
  updateActionBar();

  try {
    const entries = await Promise.all(done.map(async (row) => ({
      name: row.outputName,
      data: new Uint8Array(await row.outputBlob.arrayBuffer()),
      lastModified: row.file.lastModified,
    })));
    const zipBytes = createZip(entries);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    triggerDownload(blob, zipFileName());
    setStatus(`已打包 ${done.length} 张图片。`, 'success');
  } catch {
    setStatus('打包失败，请重试。', 'error');
    showToast('打包失败，请重试。');
  } finally {
    state.zipping = false;
    updateActionBar();
  }
}

function clearAll() {
  if (state.converting || state.zipping) return;
  for (const row of state.rows) revokeRowUrls(row);
  state.rows = [];
  els.queue.replaceChildren();
  els.queueSection.hidden = true;
  state.dragDepth = 0;
  els.workbench.classList.remove('is-dragging');
  updateDropCopy();
  updateQueueSummary();
  updateActionBar();
  setStatus('');
}

function removeRow(row) {
  if (state.converting || state.zipping) return;
  revokeRowUrls(row);
  state.rows = state.rows.filter((candidate) => candidate !== row);
  row.element.remove();
  if (!state.rows.length) els.queueSection.hidden = true;
  updateDropCopy();
  updateQueueSummary();
  updateActionBar();
  setStatus('');
}

function setBusy(busy) {
  state.converting = busy;
  document.body.classList.toggle('is-converting', busy);
  els.workbench.setAttribute('aria-busy', String(busy));

  for (const button of els.formatButtons) button.disabled = busy;
  for (const button of els.presetSwatches) button.disabled = busy;
  els.quality.disabled = busy;
  els.customBackground.disabled = busy;
  els.dither.disabled = busy;
  els.clearButton.disabled = busy;
  els.chooseButton.disabled = busy;
  els.fileInput.disabled = busy;
}

function beginProgress(total) {
  clearTimeout(state.progressTimer);
  els.progressTrack.hidden = false;
  els.progressFill.style.width = '0%';
  els.progressTrack.setAttribute('role', 'progressbar');
  els.progressTrack.setAttribute('aria-label', '转换进度');
  els.progressTrack.setAttribute('aria-valuemin', '0');
  els.progressTrack.setAttribute('aria-valuemax', String(total));
  els.progressTrack.setAttribute('aria-valuenow', '0');
}

function updateProgress(current, total) {
  const percentage = total > 0 ? (current / total) * 100 : 0;
  els.progressFill.style.width = `${percentage}%`;
  els.progressTrack.setAttribute('aria-valuenow', String(current));
}

function finishProgress() {
  els.progressFill.style.width = '100%';
  state.progressTimer = setTimeout(() => {
    if (!state.converting) {
      els.progressTrack.hidden = true;
      els.progressFill.style.width = '0%';
    }
  }, 650);
}

function invalidateOutputs(message) {
  if (state.converting) return;
  let changed = false;

  for (const row of state.rows) {
    if (row.outputUrl) {
      revokeOutputUrl(row);
      changed = true;
    }
    if (row.status === 'done' || row.status === 'error') {
      row.status = 'pending';
      row.error = '';
      row.outputBlob = null;
      row.outputUrl = null;
      row.outputName = '';
      changed = true;
    }
    updateRow(row);
  }

  if (changed) {
    setStatus(message);
    updateQueueSummary();
    updateActionBar();
  }
}

function setStatus(message, tone = '') {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle('is-success', tone === 'success');
  els.statusLine.classList.toggle('is-error', tone === 'error');
  els.statusLine.hidden = !message;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function revokeOutputUrl(row) {
  if (row.outputUrl) {
    URL.revokeObjectURL(row.outputUrl);
    row.outputUrl = null;
  }
}

function revokeRowUrls(row) {
  if (row.inputUrl) URL.revokeObjectURL(row.inputUrl);
  revokeOutputUrl(row);
}

function resetDragState() {
  state.dragDepth = 0;
  els.workbench.classList.remove('is-dragging');
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      target: state.target,
      quality: state.quality,
      background: state.background,
      dither: state.dither,
    }));
  } catch {
    // Settings persistence is a convenience; the converter still works without it.
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (TARGETS[saved.target]) state.target = saved.target;
    if (Number.isFinite(Number(saved.quality))) {
      state.quality = Math.min(100, Math.max(10, Math.round(Number(saved.quality))));
      els.quality.value = String(state.quality);
    }
    if (/^#[0-9a-f]{6}$/i.test(saved.background || '')) {
      state.background = saved.background.toLowerCase();
      els.customBackground.value = state.background;
    }
    if (typeof saved.dither === 'boolean') {
      state.dither = saved.dither;
      els.dither.checked = saved.dither;
    }
  } catch {
    // Ignore malformed or unavailable storage.
  }
}

function inputLabel(file) {
  const extension = /\.([^.\\/]+)$/.exec(file.name || '')?.[1]?.toLowerCase();
  if (extension) return extension === 'jpeg' ? 'JPG' : extension.toUpperCase();
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/webp') return 'WEBP';
  if (mime === 'image/gif') return 'GIF';
  if (mime === 'image/bmp' || mime === 'image/x-ms-bmp') return 'BMP';
  return 'IMG';
}

function relativeSize(outputBytes, inputBytes) {
  if (!inputBytes) return '';
  const change = (outputBytes / inputBytes - 1) * 100;
  if (Math.abs(change) < 0.5) return '大小相近';
  return `${change < 0 ? '−' : '+'}${Math.abs(Math.round(change))}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  const digits = amount >= 10 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

function zipFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `换格式-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

function cleanErrorMessage(error) {
  const message = error?.message || '转换失败，请重试。';
  return message.replace(/^Error:\s*/, '');
}

function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
