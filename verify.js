// 自动化验证:启动真实应用,注入一张测试图走完整导出流程,核对落盘文件
// 运行:npx electron verify.js  (退出码 0 = 通过)
// 保存对话框被 monkey-patch 到临时目录,不弹真实窗口

const { app, dialog, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { encodeLosslessPng, encodeProgressivePng } = require('./compress');

// 最小 PNG 解码器(仅支持我们编码出的:colortype 2/3/6,bitdepth 1/2/4/8,interlace 0)
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
  let off = 8, width = 0, height = 0, colorType = 0, bitDepth = 8;
  const plte = [];
  let trns = [];
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('ascii', off, off + 4); off += 4;
    const data = buf.slice(off, off + len); off += len + 4; // +crc
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < len; i += 3) plte.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'tRNS') {
      trns = Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  // 过滤器的 bpp 按颜色类型定:调色板为 1(位深 <8 时过滤仍按字节进行)
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  // 调色板位深 <8 时,扫描线按位打包(每字节 8/bitDepth 个像素)
  const stride = colorType === 3
    ? Math.ceil((width * bitDepth) / 8)
    : (colorType === 2 ? width * 3 : width * 4);
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
        let idx;
        if (bitDepth === 8) idx = row[x];
        else {
          const pxPerByte = 8 / bitDepth;
          const bytePos = (x * bitDepth) >> 3;
          const shift = 8 - bitDepth - (x % pxPerByte) * bitDepth;
          idx = (row[bytePos] >> shift) & (bitDepth === 1 ? 1 : bitDepth === 2 ? 3 : 15);
        }
        const p = plte[idx];
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
// 隔离配置写入(目录记忆 / API key / 模式),避免污染真实 userData
app.setPath('userData', testDir);

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
    assertLosslessRoundTrip('2色位深1路径', 19, 7, () => {
      const w = 19, h = 7, rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if ((i & 1) === 0) { rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 255; }
        else { rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = 255; }
      }
      return rgba;
    });
    assertLosslessRoundTrip('8色位深4路径', 17, 5, () => {
      const w = 17, h = 5, rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const c = (i * 29) & 7;
        rgba[o] = c * 32; rgba[o + 1] = 255 - c * 32; rgba[o + 2] = (c * 16) & 255; rgba[o + 3] = 255;
      }
      return rgba;
    });

    // 渐进式:≤256 色的必须保持无损;>256 色的走 TinyPNG 式量化压到 ≤100KB
    // 且量化痕迹(与原图逐像素平均色差)必须小,否则就是肉眼可见的压缩痕迹
    function assertProgressive(label, w, h, makePixels, expectMode, maxAvgErr) {
      const rgba = makePixels();
      const enc = encodeProgressivePng(w, h, rgba);
      const okSize = enc.buf.length <= 100 * 1024;
      check(okSize, label + ' 体积 ≤100KB(实际 ' + (enc.buf.length / 1024).toFixed(1) + 'KB)');
      if (expectMode) check(enc.mode === expectMode, label + ' mode=' + enc.mode + '(期望 ' + expectMode + ')');
      if (enc.mode === 'quantized') {
        check(enc.colors <= 256, label + ' 量化色数 ≤256(实际 ' + enc.colors + ')');
      }
      if (maxAvgErr) {
        const dec = decodePng(enc.buf);
        let sum = 0, n = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i + 3] === 0) continue; // 只看可见像素
          sum += Math.abs(dec.rgba[i] - rgba[i]) + Math.abs(dec.rgba[i + 1] - rgba[i + 1]) + Math.abs(dec.rgba[i + 2] - rgba[i + 2]);
          n++;
        }
        const avgErr = n ? sum / (n * 3) : 0;
        check(avgErr <= maxAvgErr, label + ' 量化痕迹小(平均色差 ' + avgErr.toFixed(2) + ' ≤' + maxAvgErr + ')');
      }
      try {
        const dec = decodePng(enc.buf);
        check(dec.width === w && dec.height === h, label + ' 解码尺寸正确');
      } catch (e) {
        check(false, label + ' 解码失败: ' + (e && e.message));
      }
    }
    // 平滑渐变(>256 色):现在一律走 TinyPNG 式量化,但必须色差小到几乎不可见
    assertProgressive('渐变图(TinyPNG式量化)', 512, 512, () => {
      const w = 512, h = 512, rgba = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = (x * 255 / w) | 0; rgba[o + 1] = (y * 255 / h) | 0;
        rgba[o + 2] = ((x + y) * 128 / (w + h)) | 0; rgba[o + 3] = 255;
      }
      return rgba;
    }, 'quantized', 8);
    // 全随机噪声:无损必然超 100KB → 渐进式必须降色压到 ≤100KB 且解码正常
    assertProgressive('全随机噪声(需降色兜底)', 512, 512, () => {
      const w = 512, h = 512, rgba = Buffer.alloc(w * h * 4);
      let s = 0x12345678;
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        s = (s * 1664525 + 1013904223) >>> 0;
        rgba[o] = (s >>> 24) & 0xff;
        rgba[o + 1] = (s >>> 16) & 0xff;
        rgba[o + 2] = (s >>> 8) & 0xff;
        rgba[o + 3] = 255;
      }
      return rgba;
    });
    // 带透明(圆角)的噪点图:量化兜底不能把透明边缘画脏
    assertProgressive('带透明噪点图(需降色兜底)', 256, 256, () => {
      const w = 256, h = 256, rgba = Buffer.alloc(w * h * 4);
      let s = 0xabcdef01;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const dist = Math.hypot(x - w / 2, y - h / 2);
        if (dist > w / 2) { rgba[o + 3] = 0; continue; }
        s = (s * 1664525 + 1013904223) >>> 0;
        rgba[o] = (s >>> 24) & 0xff;
        rgba[o + 1] = (s >>> 16) & 0xff;
        rgba[o + 2] = (s >>> 8) & 0xff;
        rgba[o + 3] = Math.max(1, Math.min(255, 255 - Math.round((dist - w / 2 + 8) * 255 / 8)));
      }
      return rgba;
    });
    // 渐变 + 局部噪点:无损超预算 → 应走抖动量化;抖动输出必须可解码,体积不超
    assertProgressive('渐变+噪点图(应触发抖动量化)', 384, 384, () => {
      const w = 384, h = 384, rgba = Buffer.alloc(w * h * 4);
      let s = 0x0f1e2d3c;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const cx = x - w / 2, cy = y - h / 2;
        if (Math.hypot(cx, cy) > w / 2) { rgba[o + 3] = 0; continue; }
        s = (s * 1664525 + 1013904223) >>> 0;
        const n = (s >>> 24) & 0xff;
        rgba[o] = (x * 220 / w + n * 0.18) & 0xff;
        rgba[o + 1] = (y * 220 / h + n * 0.18) & 0xff;
        rgba[o + 2] = (((x + y) * 128 / (w + h)) + n * 0.18) & 0xff;
        rgba[o + 3] = 255;
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
      // 自动化只测离线压缩(在线依赖网络 + 真实 API key)
      document.querySelector('#modeSwitch .mode-btn[data-mode="offline"]').click();
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
      check(byteLen <= 100 * 1024, file + ' ≤100KB(实际 ' + (byteLen / 1024).toFixed(1) + 'KB)');
      console.log('    ' + file + ' ' + (byteLen / 1024).toFixed(1) + 'KB');

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

    // 回归:再次导出到同一目录(触发重名去重,落盘变成 xxx-1.png),
    // 结果卡片必须仍渲染「打开所在目录」按钮(曾因按实际名匹配而消失)
    const reExport = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#modeSwitch .mode-btn[data-mode="offline"]').click();
      document.getElementById('exportBtn').click();
      let statusText = '';
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const st = document.getElementById('status');
        if (st && !st.hidden && /已保存/.test(st.textContent)) { statusText = st.textContent; break; }
      }
      const opens = document.querySelectorAll('.result-item .open');
      return { statusText, openCount: opens.length, sample: opens[0] ? opens[0].textContent : '' };
    })()`);
    check(reExport.statusText && /已保存/.test(reExport.statusText), '重复导出同一目录仍提示保存');
    check(reExport.openCount === 6, '重复导出后每张卡片仍有「打开所在目录」按钮(实际 ' + reExport.openCount + ')');

    // 在线模式无 key 守卫:默认在线 + 无 key 时导出应给出明确引导、聚焦输入框,不弹对话框
    const onlineGuard = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#modeSwitch .mode-btn[data-mode="online"]').click();
      apiKeyInput.value = ''; apiKey = '';
      document.getElementById('gameName').value = '测试游戏';
      document.getElementById('exportBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      const st = document.getElementById('status');
      const focused = document.activeElement === document.getElementById('apiKey');
      return { text: st && st.textContent, focused };
    })()`);
    check(onlineGuard.text && /API Key/.test(onlineGuard.text),
      '在线无 key 导出给出明确引导: ' + (onlineGuard.text || '(无)'));
    check(onlineGuard.focused, '无 key 时聚焦到 API key 输入框');

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
