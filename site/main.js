(() => {
  const FORMATS = {
    jpg: {
      label: 'JPG',
      src: 'assets/specimen/specimen.jpg',
      note: '有损压缩，照片常用。透明区域会被纸色填平。',
      transparency: '透明：填平',
    },
    png: {
      label: 'PNG',
      src: 'assets/specimen/specimen.png',
      note: '无损保存，完整保留透明通道。适合截图、图标和线条图。',
      transparency: '透明：完整',
    },
    webp: {
      label: 'WEBP',
      src: 'assets/specimen/specimen.webp',
      note: '高压缩，支持透明。网页场景通常更省体积。',
      transparency: '透明：完整',
    },
    gif: {
      label: 'GIF',
      src: 'assets/specimen/specimen.gif',
      note: '最多 256 色，只剩二值透明。适合简单图形和表情。',
      transparency: '透明：二值',
    },
    bmp: {
      label: 'BMP',
      src: 'assets/specimen/specimen.bmp',
      note: '不压缩的位图，体积最大。用于兼容旧软件。',
      transparency: '透明：填平',
    },
  };

  const tabs = [...document.querySelectorAll('.format-tab')];
  const tabList = document.querySelector('.format-tabs');
  const image = document.getElementById('specimenImage');
  const imageWrap = document.querySelector('.specimen-image');
  const panel = document.getElementById('specimenPanel');
  const formatCode = document.getElementById('specimenFormat');
  const formatNote = document.getElementById('formatNote');
  const formatTransparency = document.getElementById('formatTransparency');
  const copyButton = document.getElementById('copySha');
  const hashStatus = document.getElementById('hashStatus');
  const zipSha = document.getElementById('zipSha');

  let activeFormat = null;
  let imageRequest = 0;
  let currentHash = '';
  let hashTimer = 0;

  init();

  function init() {
    selectFormat('png');

    for (const tab of tabs) {
      tab.addEventListener('click', () => selectFormat(tab.dataset.format));
    }

    tabList?.addEventListener('keydown', (event) => {
      const nextKeys = ['ArrowRight', 'ArrowDown'];
      const previousKeys = ['ArrowLeft', 'ArrowUp'];
      if (![...nextKeys, ...previousKeys, 'Home', 'End'].includes(event.key)) return;

      const currentIndex = tabs.indexOf(document.activeElement);
      if (currentIndex < 0) return;

      event.preventDefault();
      let nextIndex;
      if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabs.length - 1;
      } else {
        const direction = nextKeys.includes(event.key) ? 1 : -1;
        nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      }

      const nextTab = tabs[nextIndex];
      selectFormat(nextTab.dataset.format, true);
    });

    copyButton?.addEventListener('click', copyHash);
    loadSizes();
    loadDownloadInfo();
  }

  function selectFormat(key, focus = false) {
    const format = FORMATS[key];
    if (!format) return;

    const changed = key !== activeFormat;
    activeFormat = key;

    for (const tab of tabs) {
      const active = tab.dataset.format === key;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }

    const activeTab = tabs.find((tab) => tab.dataset.format === key);
    if (activeTab) panel.setAttribute('aria-labelledby', activeTab.id);

    formatCode.textContent = format.label;
    formatNote.textContent = format.note;
    formatTransparency.textContent = format.transparency;

    if (!changed && image.getAttribute('src')) return;

    image.alt = `${format.label} 编码的格式样本`;
    if (image.getAttribute('src') === format.src) return;

    const request = ++imageRequest;
    imageWrap.classList.add('is-loading');

    const finish = () => {
      if (request !== imageRequest) return;
      imageWrap.classList.remove('is-loading');
    };

    image.onload = finish;
    image.onerror = () => {
      finish();
      image.alt = `${format.label} 样本加载失败`;
    };
    image.src = format.src;
  }

  function loadSizes() {
    fetch('assets/specimen/sizes.json', { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('sizes unavailable');
        return response.json();
      })
      .then((data) => {
        if (!data?.formats) return;
        for (const [key, bytes] of Object.entries(data.formats)) {
          const sizeElement = document.querySelector(`[data-size-for="${key}"]`);
          if (!sizeElement) continue;
          sizeElement.textContent = formatBytes(bytes);
          sizeElement.title = `${key.toUpperCase()}：${Number(bytes).toLocaleString('zh-CN')} 字节`;
        }
      })
      .catch(() => {
        // The static fallback sizes are enough when this enhancement fails.
      });
  }

  function loadDownloadInfo() {
    fetch('downloads/latest.json', { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('download metadata unavailable');
        return response.json();
      })
      .then((info) => {
        if (!info || !info.file) return;

        const file = String(info.file);
        for (const link of document.querySelectorAll('.js-download')) {
          link.href = `downloads/${file}`;
          link.setAttribute('download', file);
        }

        setText('heroDownloadSize', formatBytes(info.size));
        setText('heroVersion', `v${info.version}`);
        setText('installSize', `${file} · ${formatBytes(info.size)}`);
        setText('zipSizeCard', formatBytes(info.size));
        setText('zipVersionLabel', `v${info.version}`);

        if (/^[0-9a-f]{64}$/i.test(info.sha256 || '')) {
          currentHash = info.sha256;
          zipSha.textContent = currentHash.match(/.{1,8}/g).join(' ');
          copyButton.disabled = false;
        } else {
          zipSha.textContent = '校验值格式异常';
        }
      })
      .catch(() => {
        zipSha.textContent = '校验值暂不可用';
        copyButton.disabled = true;
      });
  }

  async function copyHash() {
    if (!currentHash) return;
    try {
      await navigator.clipboard.writeText(currentHash);
      announceHash('校验值已复制');
    } catch {
      try {
        const helper = document.createElement('textarea');
        helper.value = currentHash;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
        announceHash('校验值已复制');
      } catch {
        announceHash('复制失败，请手动选择校验值');
      }
    }
  }

  function announceHash(message) {
    clearTimeout(hashTimer);
    hashStatus.textContent = message;
    hashTimer = setTimeout(() => {
      hashStatus.textContent = '';
    }, 2400);
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
    return `${amount >= 10 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
  }

  function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }
})();
