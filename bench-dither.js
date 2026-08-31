// 基准:对比当前量化抖动 vs 改进版 —— 重点看「纯色区噪点」和「渐变区色带」
// 运行:node bench-dither.js   (输出存档 tmp-bench-*.png 供肉眼对比)
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { encodeLosslessPng, encodeProgressivePng } = require('./compress');

// ---- 真彩 RGBA PNG 编码器(仅用于存档可查看的对比图,不走调色板)----
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function writeTruecolorPng(path, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0; // filter None
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]));
}

// ---- 最小 PNG 解码器(与 verify.js 同源)----
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
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
    const data = buf.slice(off, off + len); off += len + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < len; i += 3) plte.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'tRNS') trns = Array.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
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

// ---- 合成一张「真实图标感」测试图 ----
function makeIcon(size) {
  const w = size, h = size;
  const rgba = Buffer.alloc(w * h * 4);
  const R = w / 2 - 2; // 圆角:内切圆外透明(模拟 222 圆角)
  const cx0 = w / 2, cy0 = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const dx = x - cx0, dy = y - cy0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 圆角遮罩:圆外全透明,近边缘 2px 平滑
      if (dist > R) { rgba[o + 3] = 0; continue; }
      let a = 255;
      if (dist > R - 2) a = Math.round((R - dist) * 255 / 2);
      rgba[o + 3] = a;

      let r, g, b;
      // 大块纯色背景(左上 + 右下区域)
      const bgFlat = (x < w * 0.55 && y > h * 0.45) || (x > w * 0.7 && y < h * 0.3);
      if (bgFlat) {
        r = 0x2A; g = 0x3B; b = 0x4C; // 纯色 #2A3B4C —— 全量抖动会在这里撒噪点
      } else if (x < w * 0.6) {
        // 顶部横向平滑渐变(需要抖动来防色带) —— 逐通道 lerp:青 0,229,255 → 红 255,23,68
        const t = x / (w * 0.6);
        r = Math.round(0x00 * (1 - t) + 0xFF * t);
        g = Math.round(0xE5 * (1 - t) + 0x17 * t);
        b = Math.round(0xFF * (1 - t) + 0x44 * t);
      } else {
        // 右侧径向渐变太阳
        const d = Math.sqrt((x - w * 0.82) * (x - w * 0.82) + (y - h * 0.28) * (y - h * 0.28));
        const t = Math.min(1, d / (w * 0.22));
        r = Math.round(255 * (1 - t)); g = Math.round(215 * (1 - t)); b = Math.round(0 * (1 - t));
      }
      // 扁平色块:绿方块 + 紫三角(纯色,不该被抖动污染)
      if (x > w * 0.62 && x < w * 0.78 && y > h * 0.5 && y < h * 0.66) { r = 0x4C; g = 0xAF; b = 0x50; }
      if (x > w * 0.45 && x < w * 0.55 && y > h * 0.7 && y < h * 0.9 && Math.abs(x - w * 0.5) < (y - h * 0.7)) { r = 0x9C; g = 0x27; b = 0xB0; }
      // 硬边白色细线(高对比边缘,不该抖动出虚线)
      if (Math.abs(x - w * 0.3) < 1.5 || Math.abs(y - h * 0.75) < 1.5) { r = 255; g = 255; b = 255; }
      // 文字笔画的近似(几根平行斜线)
      if (Math.abs((x - y) - w * 0.15) < 1.5 && y > h * 0.1 && y < h * 0.3) { r = 255; g = 255; b = 255; }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
    }
  }
  return rgba;
}

// ---- 指标 ----
// 纯色区噪点:解码后与「意图颜色 #2A3B4C」相比,出现几种颜色、噪点像素多少、偏离多大
function flatRegionNoise(dec, w, h, rect, wantR, wantG, wantB) {
  const [x0, y0, x1, y1] = rect;
  const colors = new Map();
  let noisePx = 0, n = 0, maxDev = 0, sumDev = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * w + x) * 4;
    if (dec[o + 3] < 250) continue;
    const key = (dec[o] << 16) | (dec[o + 1] << 8) | dec[o + 2];
    colors.set(key, (colors.get(key) || 0) + 1);
    const dev = Math.abs(dec[o] - wantR) + Math.abs(dec[o + 1] - wantG) + Math.abs(dec[o + 2] - wantB);
    if (dev !== 0) noisePx++;
    sumDev += dev;
    if (dev > maxDev) maxDev = dev;
    n++;
  }
  let total = 0;
  for (const c of colors.values()) total += c;
  let max = 0;
  for (const c of colors.values()) if (c > max) max = c;
  return {
    distinct: colors.size,
    mainShare: total ? max / total : 0,
    noisePx,
    noisePct: n ? (noisePx / n) * 100 : 0,
    avgDev: n ? sumDev / n : 0,
    maxDev
  };
}

function avgErr(orig, dec) {
  let sum = 0, n = 0;
  for (let i = 0; i < orig.length; i += 4) {
    if (orig[i + 3] === 0) continue;
    sum += Math.abs(dec[i] - orig[i]) + Math.abs(dec[i + 1] - orig[i + 1]) + Math.abs(dec[i + 2] - orig[i + 2]);
    n++;
  }
  return n ? sum / (n * 3) : 0;
}

// 渐变区:纯渐变段(避开 x=153 白色竖线),统计噪点色、相邻跳变、暗/亮杂点
function gradientRegion(dec, w, h, segs, wantOf) {
  // segs: 渐变扫描线段集合 [[x0,x1],...], y 固定
  const colors = new Map();
  let maxStep = 0, darkPx = 0, lightPx = 0, n = 0;
  for (const [gy, [gx0, gx1]] of segs) {
    let prev = null;
    for (let x = gx0; x < gx1; x++) {
      const o = (gy * w + x) * 4;
      if (dec[o + 3] < 250) continue;
      const key = (dec[o] << 16) | (dec[o + 1] << 8) | dec[o + 2];
      colors.set(key, (colors.get(key) || 0) + 1);
      const v = dec[o] + dec[o + 1] + dec[o + 2];
      if (prev !== null) { const s = Math.abs(v - prev); if (s > maxStep) maxStep = s; }
      prev = v;
      // 杂点:与期望渐变值相差过大的像素(黑/白/其它脏色)
      const want = wantOf(x, gy);
      const dev = Math.abs(dec[o] - want[0]) + Math.abs(dec[o + 1] - want[1]) + Math.abs(dec[o + 2] - want[2]);
      if (dev > 60) {
        if (v < 130) darkPx++; else if (v > 560) lightPx++; else darkPx++;
      }
      n++;
    }
  }
  return {
    distinct: colors.size,
    maxStep,
    speckPct: n ? ((darkPx + lightPx) / n) * 100 : 0,
    n
  };
}

// ---- 主流程 ----
const size = 512;
const orig = makeIcon(size);
writeTruecolorPng('tmp-bench-orig.png', size, size, orig);

const enc = encodeProgressivePng(size, size, orig);
const dec = decodePng(enc.buf).rgba;
writeTruecolorPng('tmp-bench-current.png', size, size, dec);

// 纯色区放大 6 倍(噪点肉眼可见) —— 区域避开 x=153 白竖线
const ZX = 40, ZY = 250, ZS = 80, ZSCALE = 6, ZW = ZS * ZSCALE, ZH = ZS * ZSCALE;
const zoom = Buffer.alloc(ZW * ZH * 4);
for (let y = 0; y < ZH; y++) for (let x = 0; x < ZW; x++) {
  const sx = ZX + ((x / ZSCALE) | 0), sy = ZY + ((y / ZSCALE) | 0);
  const so = (sy * size + sx) * 4, do_ = (y * ZW + x) * 4;
  zoom[do_] = dec[so]; zoom[do_ + 1] = dec[so + 1]; zoom[do_ + 2] = dec[so + 2]; zoom[do_ + 3] = 255;
}
writeTruecolorPng('tmp-bench-flat-zoom.png', ZW, ZH, zoom);

// 纯色区 [40,250]→[130,300]:避开 x=153 白竖线、y=384 白横线,全是 #2A3B4C
const flat = flatRegionNoise(dec, size, size, [40, 250, 130, 300], 0x2A, 0x3B, 0x4C);
console.log('文件体积       :', (enc.buf.length / 1024).toFixed(1), 'KB', '(mode=' + enc.mode + ', colors=' + enc.colors + ', dither=' + enc.dither + ')');
console.log('平均色差(全图):', avgErr(orig, dec).toFixed(2));
console.log('纯色区 噪声   : 出现颜色数=' + flat.distinct + ', 主色占比=' + (flat.mainShare * 100).toFixed(1) + '%, 噪点像素=' + flat.noisePct.toFixed(2) + '%, 平均偏离=' + flat.avgDev.toFixed(2) + ', 最大偏离=' + flat.maxDev);
// 渐变区:y=180 在 x<153 与 x>153 两段都测(避开白竖线),期望值=当前 t 的逐通道 lerp
function gradWant(x, y) {
  const t = Math.min(1, x / (size * 0.6));
  return [Math.round(0xFF * t), Math.round(0xE5 + (0x17 - 0xE5) * t), Math.round(0xFF + (0x44 - 0xFF) * t)];
}
const g = gradientRegion(dec, size, size, [[180, [10, 140]], [180, [170, 300]], [90, [10, 140]], [90, [170, 300]]], gradWant);
console.log('渐变区 色带   : 扫描线不同色数=' + g.distinct + ', 相邻最大跳变=' + g.maxStep + ', 杂点占比=' + g.speckPct.toFixed(2) + '% (' + g.n + 'px)');
