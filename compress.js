// 游戏图标导出 · PNG 压缩
// 纯 Node(自带 zlib)实现调色板 PNG 编码 + 中位切分颜色量化。
// 原理与 pngquant 一致:把颜色压到 ≤256 色再按 8-bit 调色板编码,
// 图标类图片观感几乎无差,体积却能稳定压到 100KB 以下;
// 圆角图边缘的柔化(半透明抗锯齿)通过 tRNS 逐色块记录 alpha 保留。
'use strict';

const zlib = require('zlib');

const TARGET_BYTES = 100 * 1024; // 每张目标 < 100KB
// 由多到少逐档试,命中 <100KB 即停;颜色越少压得越狠(对噪点/渐变图兜底)
const COLOR_LIMITS = [256, 192, 144, 112, 88, 64, 48, 36, 24, 16, 12, 8];

// ------------------------------------------------------------------ CRC32
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------- 分块
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ------------------------------------------------- 中位切分量化(RGBA)
// rgba: Uint8ClampedArray(RGBA 顺序,非预乘);count: 像素数
// 返回 { palette: [{r,g,b,a}], indices: Uint8Array } —— 每个像素直接归属其分桶
function quantize(rgba, count, maxColors) {
  let buckets = [new Int32Array(count)];
  for (let i = 0; i < count; i++) buckets[0][i] = i;
  let sizes = [count];

  while (buckets.length < maxColors) {
    // 找范围内最大的可分桶
    let best = -1, bestRange = -1, bestChan = 0;
    for (let b = 0; b < buckets.length; b++) {
      const size = sizes[b];
      if (size <= 1) continue;
      const idx = buckets[b];
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, aMin = 255, aMax = 0;
      for (let i = 0; i < size; i++) {
        const o = idx[i] * 4;
        const r = rgba[o], g = rgba[o + 1], bl = rgba[o + 2], a = rgba[o + 3];
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        if (bl < bMin) bMin = bl; if (bl > bMax) bMax = bl;
        if (a < aMin) aMin = a; if (a > aMax) aMax = a;
      }
      const ranges = [rMax - rMin, gMax - gMin, bMax - bMin, aMax - aMin];
      let chan = 0;
      for (let c = 1; c < 4; c++) if (ranges[c] > ranges[chan]) chan = c;
      const range = ranges[chan];
      if (range === 0) continue; // 桶内颜色一致,不可再分
      if (range > bestRange) { bestRange = range; best = b; bestChan = chan; }
    }
    if (best === -1) break; // 全部分桶到位

    // 沿该通道按中位数对半切
    const idx = buckets[best];
    const size = sizes[best];
    const off = bestChan;
    const arr = Array.from(idx);
    arr.sort((x, y) => rgba[x * 4 + off] - rgba[y * 4 + off]);
    const mid = size >> 1;
    buckets[best] = Int32Array.from(arr.slice(0, mid));
    buckets.push(Int32Array.from(arr.slice(mid)));
    sizes[best] = mid;
    sizes.push(size - mid);
  }

  // 每桶平均色即调色板;像素按所属桶直接落索引
  const palette = [];
  const indices = new Uint8Array(count);
  for (let b = 0; b < buckets.length; b++) {
    const idx = buckets[b];
    const size = sizes[b];
    let r = 0, g = 0, bl = 0, a = 0;
    for (let i = 0; i < size; i++) {
      const o = idx[i] * 4;
      r += rgba[o]; g += rgba[o + 1]; bl += rgba[o + 2]; a += rgba[o + 3];
    }
    palette.push({ r: Math.round(r / size), g: Math.round(g / size), b: Math.round(bl / size), a: Math.round(a / size) });
    for (let i = 0; i < size; i++) indices[idx[i]] = b;
  }
  return { palette, indices };
}

// --------------------------------------------------- 调色板 PNG 编码
// color type 3(8-bit 索引色),全不透明时不写 tRNS,否则逐色块记录 alpha
function encodePalettePng(width, height, palette, indices) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 3;   // color type: indexed
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = Buffer.alloc(palette.length * 3);
  let hasAlpha = false;
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i].r;
    plte[i * 3 + 1] = palette[i].g;
    plte[i * 3 + 2] = palette[i].b;
    if (palette[i].a < 255) hasAlpha = true;
  }
  const trns = hasAlpha ? Buffer.alloc(palette.length) : null;
  if (trns) for (let i = 0; i < palette.length; i++) trns[i] = palette[i].a;

  // 每行前置 filter type 0(None),8-bit 索引色每像素 1 字节
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) raw[rowStart + 1 + x] = indices[y * width + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    ...(trns ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------ 入口:压到 <100KB
// width × height 的 RGBA 像素 → 尽量小的调色板 PNG
function compressImage(width, height, rgba) {
  const count = width * height;
  let best = null;
  for (const limit of COLOR_LIMITS) {
    const { palette, indices } = quantize(rgba, count, limit);
    const buf = encodePalettePng(width, height, palette, indices);
    best = buf;
    if (buf.length < TARGET_BYTES) break; // 达标即收手
  }
  return best;
}

module.exports = { compressImage, TARGET_BYTES };
