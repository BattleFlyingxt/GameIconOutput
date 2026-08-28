// 游戏图标导出 · 渲染层
// 移植自 Cindy 插件面板:拖入/选图、游戏名、规格勾选、Canvas 精确处理
// 去 Cindy 化:导出结果经 preload 的 iconApp.saveFiles 由主进程选目录批量写入

'use strict';

var VARIANTS = [
  { type: '直角', size: 216 },
  { type: '直角', size: 256 },
  { type: '直角', size: 258 },
  { type: '直角', size: 320 },
  { type: '直角', size: 512 },
  { type: '圆角', size: 222 }
];
var STRAIGHT_SIZES = [216, 256, 258, 320, 512];
var ROUND_SIZE = 222;

var dropzone = document.getElementById('dropzone');
var fileInput = document.getElementById('fileInput');
var preview = document.getElementById('preview');
var dropHint = document.getElementById('dropHint');
var gameNameInput = document.getElementById('gameName');
var variantsBox = document.getElementById('variants');
var exportBtn = document.getElementById('exportBtn');
var statusEl = document.getElementById('status');
var resultsEl = document.getElementById('results');

var imageData = null; // 源图 data URL
var lastSavedDir = null;

// ------------------------------------------------------------ 拖放(整窗可拖)

function isFileDrag(e) {
  var t = e.dataTransfer && e.dataTransfer.types;
  return !!(t && Array.prototype.indexOf.call(t, 'Files') !== -1);
}

document.addEventListener('dragover', function (e) {
  if (isFileDrag(e)) e.preventDefault();
});
document.addEventListener('drop', function (e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dropzone.classList.remove('dragging');
  var file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

dropzone.addEventListener('click', function () {
  fileInput.click();
});
dropzone.addEventListener('dragover', function (e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', function () {
  dropzone.classList.remove('dragging');
});
fileInput.addEventListener('change', function (e) {
  var file = e.target.files && e.target.files[0];
  if (file) loadFile(file);
  e.target.value = '';
});

function loadFile(file) {
  if (!/^image\//.test(file.type)) {
    setStatus('请选择图片文件');
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    imageData = reader.result;
    preview.src = imageData;
    preview.hidden = false;
    dropHint.textContent = file.name;
    statusEl.hidden = true;
  };
  reader.onerror = function () {
    setStatus('读取文件失败');
  };
  reader.readAsDataURL(file);
}

function collectVariants() {
  var out = [];
  variantsBox.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
    out.push(cb.dataset.size + ' ' + cb.dataset.type);
  });
  return out;
}

// ------------------------------------------------------- 核心处理(Canvas,PNG 无损)

function loadImage(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('无法读取图片,请确认是一张有效的图标图片。')); };
    img.src = src;
  });
}

function drawCover(ctx, img, w, h) {
  var scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  var sw = img.naturalWidth * scale;
  var sh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh);
}

function renderStraight(img, size) {
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  drawCover(ctx, img, size, size);
  return canvas;
}

function renderRound(img, size) {
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  drawCover(ctx, img, size, size);
  return canvas;
}

// 预览用图(缩略图 / 大图),压缩落盘交给主进程,这里只做展示
function canvasToPreviewDataUrl(canvas) {
  try {
    return canvas.toDataURL('image/png');
  } catch (err) {
    return null;
  }
}

function normalizeVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return VARIANTS.map(function (v) { return { type: v.type, size: v.size }; });
  }
  var out = [];
  for (var i = 0; i < variants.length; i++) {
    var raw = variants[i];
    var s = String(raw == null ? '' : raw);
    var m = s.match(/(216|256|258|320|512|222)/);
    var size = m ? Number(m[1]) : null;
    var type = s.indexOf('圆角') !== -1 ? '圆角' : s.indexOf('直角') !== -1 ? '直角' : null;
    if (type === null) type = size === ROUND_SIZE ? '圆角' : '直角';
    var valid =
      (type === '圆角' && size === ROUND_SIZE) ||
      (type === '直角' && STRAIGHT_SIZES.indexOf(size) !== -1);
    if (valid) out.push({ type: type, size: size });
  }
  return out.length ? out : VARIANTS.map(function (v) { return { type: v.type, size: v.size }; });
}

// ---------------------------------------------------------------- 导出流程

exportBtn.addEventListener('click', onExport);

async function onExport() {
  var gameName = gameNameInput.value.trim();
  if (!imageData) return setStatus('请先拖入或选择一张图标图片');
  if (!gameName) return setStatus('请填写游戏名称');
  var variants = normalizeVariants(collectVariants());
  if (!variants.length) return setStatus('请至少勾选一个导出规格');

  exportBtn.disabled = true;
  setStatus('正在导出…', false);
  try {
    var img = await loadImage(imageData);
    var items = [];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var canvas = v.type === '圆角' ? renderRound(img, v.size) : renderStraight(img, v.size);
      var ctx = canvas.getContext('2d');
      // 原始 RGBA 交给主进程做调色板量化压缩;预览用 PNG
      var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      items.push({
        name: gameName + '-' + v.size + ' ' + v.type + '.png',
        type: v.type,
        size: v.size,
        width: canvas.width,
        height: canvas.height,
        pixels: imgData.data,
        dataUrl: canvasToPreviewDataUrl(canvas),
        bytes: canvas.width * canvas.height * 4
      });
    }

    var res = await window.iconApp.saveFiles(items.map(function (it) {
      return { name: it.name, width: it.width, height: it.height, pixels: it.pixels };
    }));

    if (!res) throw new Error('无法调用保存功能,应用可能已损坏。');
    if (res.cancelled) {
      renderResults(items);
      setStatus('已取消保存,本次生成的图片未落盘。');
      return;
    }
    if (!res.ok) throw new Error(res.message || '保存失败,请重试。');

    lastSavedDir = res.dir;
    var savedByName = {};
    (res.saved || []).forEach(function (s) { savedByName[s.name] = s; });
    items.forEach(function (it) {
      var s = savedByName[it.name];
      it.savedPath = s ? s.path : null;
      if (s && s.size) it.bytes = s.size; // 用落盘后的真实字节数(压缩后)
    });

    renderResults(items);
    var msg = '已保存 ' + res.saved.length + ' 张 PNG 到 ' + res.dir;
    if (res.errors && res.errors.length) msg += ' · ' + res.errors.length + ' 张写入失败';
    setStatus(msg, false);
  } catch (err) {
    setStatus(err.message || '导出失败,请重试');
  } finally {
    exportBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- 结果渲染

function renderResults(items) {
  resultsEl.innerHTML = '';
  items.forEach(function (it) {
    var item = document.createElement('div');
    item.className = 'result-item';

    var thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.setAttribute('role', 'button');
    thumb.title = '点击查看大图';
    var img = document.createElement('img');
    img.src = it.dataUrl;
    img.alt = it.name;
    img.loading = 'lazy';
    thumb.appendChild(img);
    thumb.addEventListener('click', function () { openLightbox(it.dataUrl); });

    var nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = it.name;
    nameEl.title = it.name;

    var metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = it.type + ' ' + it.size + '×' + it.size + ' · ' + fmtBytes(it.bytes);

    item.appendChild(thumb);
    item.appendChild(nameEl);
    item.appendChild(metaEl);

    if (it.savedPath) {
      var openBtn = document.createElement('button');
      openBtn.className = 'open';
      openBtn.textContent = '打开所在目录';
      openBtn.addEventListener('click', function () {
        window.iconApp.showInFolder(it.savedPath);
      });
      item.appendChild(openBtn);
    }

    resultsEl.appendChild(item);
  });
}

var lightbox = null;
function openLightbox(src) {
  if (!lightbox) {
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = '<img alt="大图预览">';
    lightbox.addEventListener('click', function () { lightbox.style.display = 'none'; });
    document.body.appendChild(lightbox);
  }
  lightbox.querySelector('img').src = src;
  lightbox.style.display = 'flex';
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function setStatus(text, isError) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError !== false);
  statusEl.classList.toggle('ok', isError === false);
}
