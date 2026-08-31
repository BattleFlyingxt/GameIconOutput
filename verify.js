// 自动化验证:启动真实应用,注入一张测试图走完整导出流程,核对落盘文件
// 运行:npx electron verify.js  (退出码 0 = 通过)
// 保存对话框被 monkey-patch 到临时目录,不弹真实窗口

const { app, dialog, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { encodeLosslessPng } = require('./compress');

// 最小 PNG 解码器(仅支持我们编码出的:bitdepth 8,colortype 2/3/6,interlace 0)
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not png');
  let off = 8, width = 0, height = 0, colorType = 0;
  const plte = [];
  let trns = [];
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('ascii', off, off + 4); off += 4;
    const data = buf.slice(off, off + len); off += len + 4; // +crc
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < len; i += 3) plte.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'tRNS') {
      trns = Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 3 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * bpp;
  let inOff = 0, prev = null;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = inflated[inOff++];
    const cur = inflated.slice(inOff, inOff + stride); inOff += stride;
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let val;
      if (filter === 0) val = cur[i];
      else if (filter === 1) val = cur[i] + left;
      else if (filter === 2) val = cur[i] + up;
      else if (filter === 3) val = cur[i] + ((left + up) >> 1);
      else val = cur[i] + paeth(left, up, upLeft);
      row[i] = val & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = row[x], p = plte[idx];
        rgba[o] = p[0]; rgba[o + 1] = p[1]; rgba[o + 2] = p[2];
        rgba[o + 3] = idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 2) {
        rgba[o] = row[x * 3]; rgba[o + 1] = row[x * 3 + 1]; rgba[o + 2] = row[x * 3 + 2]; rgba[o + 3] = 255;
      } else {
        rgba[o] = row[x * 4]; rgba[o + 1] = row[x * 4 + 1]; rgba[o + 2] = row[x * 4 + 2]; rgba[o + 3] = row[x * 4 + 3];
      }
    }
    prev = row;
  }
  return { width, height, rgba };
}

// 无损往返:编码 → 解码 → 逐字节比对,必须完全一致
function assertLosslessRoundTrip(label, w, h, makePixels) {
  const rgba = makePixels();
  const png = encodeLosslessPng(w, h, rgba);
  const dec = decodePng(png);
  let same = dec.width === w && dec.height === h && dec.rgba.length === rgba.length;
  if (same) {
    for (let i = 0; i < rgba.length; i++) {
      if (dec.rgba[i] !== rgba[i]) { same = false; break; }
    }
  }
  check(same, label + ' 无损往返一致(' + Math.round(png.length / 1024) + 'KB)');
}

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eic-test-'));

// 让真实应用(main.js)的保存对话框直接指向测试目录
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [testDir] });

require('./main.js'); // 启动真实应用

let failures = [];
function check(cond, label) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label);
  if (!cond) failures.push(label);
}

app.whenReady().then(async () => {
  try {
    // ---- 无损往返单元测试(三条编码路径:调色板 / RGB真彩 / RGBA透明)----
    assertLosslessRoundTrip('调色板路径', 24, 24, () => {
      const w = 24, h = 24, rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4, x = i % w, y = (i / w) | 0;
        if ((x + y) % 3 === 0) { rgba[o] = 255; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 255; }
        else if ((x + y) % 3 === 1) { rgba[o] = 0; rgba[o + 1] = 128; rgba[o + 2] = 255; rgba[o + 3] = 255; }
        else { rgba[o + 3] = 0; }
      }
      return rgba;
    });
    assertLosslessRoundTrip('RGB真彩路径', 200, 200, () => {
      const w = 200, h = 200, rgba = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = x; rgba[o + 1] = y; rgba[o + 2] = (x + y) & 0xff; rgba[o + 3] = 255;
      }
      return rgba;
    });
    assertLosslessRoundTrip('RGBA透明路径', 120, 120, () => {
      const w = 120, h = 120, rgba = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = x; rgba[o + 1] = y; rgba[o + 2] = 255 - x; rgba[o + 3] = x;
      }
      return rgba;
    });

    // 等窗口与页面加载完成
    await new Promise((r) => setTimeout(r, 1800));
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('窗口未创建');

    // 收集渲染层报错
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) console.log('  [renderer console] ' + message);
    });

    // 注入自检:构造测试图 → 走渲染层的导出(会触发被 patch 的保存对话框)
    const pageResult = await win.webContents.executeJavaScript(`(async () => {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const cx = c.getContext('2d');
      const grad = cx.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, '#ff5f5f');
      grad.addColorStop(1, '#3b82f6');
      cx.fillStyle = grad; cx.fillRect(0, 0, 512, 512);
      cx.fillStyle = '#ffffff';
      cx.beginPath(); cx.arc(256, 256, 140, 0, Math.PI * 2); cx.fill();
      cx.fillStyle = '#111111';
      cx.font = 'bold 60px sans-serif'; cx.textAlign = 'center';
      cx.fillText('测试图', 256, 280);

      window.imageData = c.toDataURL('image/png');
      document.getElementById('gameName').value = '测试游戏';
      document.getElementById('exportBtn').click();

      // 轮询直到导出完成(status 出现「已保存」)
      let statusText = '';
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const st = document.getElementById('status');
        if (st && !st.hidden && /已保存/.test(st.textContent)) { statusText = st.textContent; break; }
      }
      const names = Array.from(document.querySelectorAll('.result-item .name')).map((n) => n.textContent);
      return { statusText, names };
    })()`);

    check(pageResult.statusText && /已保存/.test(pageResult.statusText),
      '导出完成并提示保存: ' + (pageResult.statusText || '(无)'));
    check(pageResult.names.length === 6, '结果卡片渲染 6 张');

    // 核对落盘文件
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.png')).sort();
    check(files.length === 6, '落盘 6 个 PNG(实际 ' + files.length + ')');

    const expectNames = ['测试游戏-216 直角.png', '测试游戏-256 直角.png', '测试游戏-258 直角.png',
      '测试游戏-320 直角.png', '测试游戏-512 直角.png', '测试游戏-222 圆角.png'].sort();
    check(JSON.stringify(files) === JSON.stringify(expectNames),
      '命名规则正确: ' + files.join(' / '));

    for (const [type, size] of [['直角', 216], ['直角', 256], ['直角', 258], ['直角', 320], ['直角', 512], ['圆角', 222]]) {
      const file = '测试游戏-' + size + ' ' + type + '.png';
      const p = path.join(testDir, file);
      if (!fs.existsSync(p)) { check(false, file + ' 不存在'); continue; }
      const img = nativeImage.createFromPath(p);
      const sz = img.getSize();
      check(sz.width === size && sz.height === size, file + ' 尺寸 ' + sz.width + 'x' + sz.height);

      const byteLen = fs.statSync(p).size;
      console.log('    ' + file + ' ' + (byteLen / 1024).toFixed(1) + 'KB(无损)');

      if (type === '圆角') {
        const bmp = img.toBitmap(); // BGRA
        const alphaTL = bmp[3];
        const center = ((sz.height >> 1) * sz.width + (sz.width >> 1)) * 4 + 3;
        const alphaC = bmp[center];
        check(alphaTL === 0, file + ' 左上角透明(alpha=' + alphaTL + ')');
        check(alphaC > 200, file + ' 中心不透明(alpha=' + alphaC + ')');
      } else {
        const bmp = img.toBitmap();
        check(bmp[3] === 255, file + ' 左上角不透明');
      }
    }

    const total = fs.readdirSync(testDir).reduce((s, f) => s + fs.statSync(path.join(testDir, f)).size, 0);
    console.log('  落盘总字节: ' + total);
  } catch (err) {
    console.log('  ERROR ' + (err && err.stack || err));
    failures.push(String(err && err.message || err));
  }

  if (failures.length) {
    console.log('\n== 验证失败: ' + failures.length + ' 项 ==');
    app.exit(1);
  } else {
    console.log('\n== 全部通过 ✅ ==');
    app.exit(0);
  }
});
