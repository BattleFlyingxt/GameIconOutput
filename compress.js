// 游戏图标导出 · 自适应 PNG 压缩
// 原则:尽量无损,但落盘体积有硬上限(默认 100KB)。
//   encodeLosslessPng —— 像素零失真:颜色数 ≤256 走 8 位调色板(小调色板自动压位深),
//                       全不透明走 RGB(去 alpha),有透明走 RGBA,每行选最优过滤器。
//   encodeProgressivePng —— 渐进式:先试无损;无损超上限才按需降色(中位切分 4D 调色板),
//                       从 256 色逐级往下压到体积达标,把画质损失压到最小。
//   quantizeToPalette —— 中位切分:全透明像素归并为一个透明入口(不占颜色预算),
//                       可见像素做 4D(r,g,b,a) 中位切分 + 最近邻映射。
'use strict';

const zlib = require('zlib');

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ------------------------------------------------------------- PNG 过滤器
// 逐行选最优过滤器,能把平滑渐变/色块压得明显更小(无损前提下的体积优化)
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterRow(cur, prev, bpp) {
  const n = cur.length;
  let best = 0, bestCost = Infinity, bestBytes = null;
  const out = Buffer.alloc(n);
  for (let f = 0; f < 5; f++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const x = cur[i];
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let val;
      if (f === 0) val = x;                       // None
      else if (f === 1) val = x - left;           // Sub
      else if (f === 2) val = x - up;             // Up
      else if (f === 3) val = x - ((left + up) >> 1); // Avg
      else val = x - paeth(left, up, upLeft);     // Paeth
      out[i] = val & 0xff;
      cost += Math.abs(val);
    }
    if (cost < bestCost) { bestCost = cost; best = f; bestBytes = Buffer.from(out); }
  }
  return { filter: best, bytes: bestBytes };
}

// ------------------------------------------------------ 调色板位深与打包
// 调色板颜色越少,可用更低位深(原始扫描线更小 → 必然更小):
// ≤2 色 → 1 bit,≤4 色 → 2 bit,≤16 色 → 4 bit,否则 8 bit
function paletteBitDepth(palLen) {
  if (palLen <= 2) return 1;
  if (palLen <= 4) return 2;
  if (palLen <= 16) return 4;
  return 8;
}

// 把像素索引按位深打包成扫描线字节(MSB 优先)
function packIndices(width, height, indices, bitDepth) {
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const out = Buffer.alloc(height * rowBytes);
  if (bitDepth === 8) {
    for (let i = 0; i < indices.length; i++) out[i] = indices[i];
    return out;
  }
  const pxPerByte = 8 / bitDepth;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const byteBase = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const bytePos = (x * bitDepth) >> 3;
      const shift = 8 - bitDepth - (x % pxPerByte) * bitDepth;
      out[byteBase + bytePos] |= (indices[rowBase + x] & 0xff) << shift;
    }
  }
  return out;
}

// 编码调色板 PNG:PLTE + 需要时 tRNS + 打包扫描线 + 逐行过滤 + deflate
function encodePalettePng(width, height, palette, indices) {
  const palLen = palette.length;
  const bitDepth = paletteBitDepth(palLen);
  const plte = Buffer.alloc(palLen * 3);
  let hasAlpha = false;
  for (let i = 0; i < palLen; i++) {
    plte[i * 3] = palette[i][0]; plte[i * 3 + 1] = palette[i][1]; plte[i * 3 + 2] = palette[i][2];
    if (palette[i][3] < 255) hasAlpha = true;
  }
  const trns = hasAlpha ? Buffer.alloc(palLen) : null;
  if (trns) for (let i = 0; i < palLen; i++) trns[i] = palette[i][3];

  const raw = packIndices(width, height, indices, bitDepth);
  const stride = raw.length / height;
  const filtered = Buffer.alloc(height * (1 + stride));
  let prev = null;
  for (let y = 0; y < height; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const r = filterRow(cur, prev, 1);
    filtered[y * (1 + stride)] = r.filter;
    r.bytes.copy(filtered, y * (1 + stride) + 1);
    prev = cur;
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;   // bit depth
  ihdr[9] = 3;          // color type: palette
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte)
  ];
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------- 无损 PNG 编码
// rgba: RGBA 顺序原始像素(长度 = width*height*4);返回 PNG Buffer(像素零失真)
function encodeLosslessPng(width, height, rgba) {
  const count = width * height;

  const colorMap = new Map(); // key -> {r,g,b,a}
  const order = [];           // 首次出现顺序
  let allOpaque = true;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const key = (rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3];
    if (!colorMap.has(key)) { colorMap.set(key, { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] }); order.push(key); }
    if (rgba[o + 3] !== 255) allOpaque = false;
  }

  if (order.length <= 256) {
    // 颜色本来就不超过 256:精确调色板,无损且最小
    const keyToIdx = new Map();
    order.forEach((k, idx) => keyToIdx.set(k, idx));
    const indices = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      indices[i] = keyToIdx.get((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]);
    }
    const palette = order.map((k) => {
      const c = colorMap.get(k);
      return [c.r, c.g, c.b, c.a];
    });
    return encodePalettePng(width, height, palette, indices);
  }

  let colorType, bpp, raw;
  if (allOpaque) {
    colorType = 2; bpp = 3; // RGB,不写 alpha
    raw = Buffer.alloc(count * 3);
    for (let i = 0; i < count; i++) {
      raw[i * 3] = rgba[i * 4]; raw[i * 3 + 1] = rgba[i * 4 + 1]; raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
  } else {
    colorType = 6; bpp = 4; // RGBA 全保留
    raw = Buffer.from(rgba);
  }

  const stride = width * bpp;
  const filtered = Buffer.alloc(height * (1 + stride));
  let prev = null;
  for (let y = 0; y < height; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const r = filterRow(cur, prev, bpp);
    filtered[y * (1 + stride)] = r.filter;
    r.bytes.copy(filtered, y * (1 + stride) + 1);
    prev = cur;
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)
  ];
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------- 调色板量化(兜底)
// 把可见像素做 4D(r,g,b,a) 中位切分到 K 个盒子,每盒均值作调色板入口,
// 每个像素映射到欧氏距离最近的入口;全透明像素(a=0)统一归并为一个透明入口,
// 不占颜色预算,保证透明边缘不被画脏。
function quantizeToPalette(rgba, count, K) {
  const vis = [];
  for (let i = 0; i < count; i++) if (rgba[i * 4 + 3] !== 0) vis.push(i);
  const hasTransparent = vis.length !== count;
  const transparent = [0, 0, 0, 0];
  const palette = [];
  const indices = new Uint8Array(count);

  if (vis.length === 0) {
    palette.push(transparent);
    indices.fill(0);
    return { palette, indices };
  }

  // 中位切分:从 1 个盒子开始,每轮拆分「人数 × 最大通道跨度」最大的盒子
  const cutK = Math.max(1, hasTransparent ? K - 1 : K);
  const boxes = [{ idx: vis }];
  while (boxes.length < cutK) {
    let bi = -1, bestScore = -1, bestChannel = 0;
    for (let b = 0; b < boxes.length; b++) {
      const idx = boxes[b].idx;
      if (idx.length < 2) continue;
      let min0 = 255, max0 = 0, min1 = 255, max1 = 0, min2 = 255, max2 = 0, min3 = 255, max3 = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = idx[k] * 4;
        const r = rgba[p], g = rgba[p + 1], bl = rgba[p + 2], a = rgba[p + 3];
        if (r < min0) min0 = r; if (r > max0) max0 = r;
        if (g < min1) min1 = g; if (g > max1) max1 = g;
        if (bl < min2) min2 = bl; if (bl > max2) max2 = bl;
        if (a < min3) min3 = a; if (a > max3) max3 = a;
      }
      const range0 = max0 - min0, range1 = max1 - min1, range2 = max2 - min2, range3 = max3 - min3;
      const range = Math.max(range0, range1, range2, range3);
      const score = idx.length * range;
      if (score > bestScore) {
        bestScore = score; bi = b;
        bestChannel = (range0 >= range1 && range0 >= range2 && range0 >= range3) ? 0
          : (range1 >= range2 && range1 >= range3) ? 1
          : (range2 >= range3) ? 2 : 3;
      }
    }
    if (bi === -1) break; // 没有可拆分的盒子了
    const idx = boxes[bi].idx;
    idx.sort((i, j) => rgba[i * 4 + bestChannel] - rgba[j * 4 + bestChannel]);
    const mid = idx.length >> 1;
    boxes.splice(bi, 1, { idx: idx.slice(0, mid) }, { idx: idx.slice(mid) });
  }

  // 每盒均值作调色板入口
  for (const box of boxes) {
    const idx = box.idx;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k] * 4;
      sr += rgba[p]; sg += rgba[p + 1]; sb += rgba[p + 2]; sa += rgba[p + 3];
    }
    const n = idx.length;
    palette.push([Math.round(sr / n), Math.round(sg / n), Math.round(sb / n), Math.round(sa / n)]);
  }
  const transparentIdx = palette.length; // 透明入口追加在最后
  if (hasTransparent) palette.push(transparent);

  // 最近邻映射(4D 欧氏距离)
  const pl = palette.length;
  const pr = new Int32Array(pl), pg = new Int32Array(pl), pb = new Int32Array(pl), pa = new Int32Array(pl);
  for (let j = 0; j < pl; j++) { pr[j] = palette[j][0]; pg[j] = palette[j][1]; pb[j] = palette[j][2]; pa[j] = palette[j][3]; }
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a === 0) { indices[i] = transparentIdx; continue; }
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < pl; j++) {
      const dr = r - pr[j], dg = g - pg[j], db = b - pb[j], da = a - pa[j];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestD) { bestD = d; best = j; }
    }
    indices[i] = best;
  }
  return { palette, indices };
}

// ------------------------------------------------------ 渐进式编码(对外主入口)
// 先无损;无损超出预算才按需降色,从 256 色逐级往下压到 ≤ 预算即停。
// 返回 { buf, mode: 'lossless' | 'quantized', colors? }
const DEFAULT_MAX_BYTES = 100 * 1024;

function encodeProgressivePng(width, height, rgba, maxBytes = DEFAULT_MAX_BYTES) {
  const lossless = encodeLosslessPng(width, height, rgba);
  if (lossless.length <= maxBytes) return { buf: lossless, mode: 'lossless' };

  // 降色阶梯:多给几个中间档,尽量用「恰好够用」的颜色数,画质损失最小
  const K_LIST = [256, 192, 128, 96, 64, 48, 32, 24, 16, 12, 8, 4, 2];
  for (const K of K_LIST) {
    const q = quantizeToPalette(rgba, width * height, K);
    const png = encodePalettePng(width, height, q.palette, q.indices);
    if (png.length <= maxBytes) return { buf: png, mode: 'quantized', colors: q.palette.length };
  }
  // 到 2 色(位深 1)必然 < 预算;这里兜底再走一次
  const q = quantizeToPalette(rgba, width * height, 2);
  return { buf: encodePalettePng(width, height, q.palette, q.indices), mode: 'quantized', colors: q.palette.length };
}

module.exports = { encodeLosslessPng, encodeProgressivePng };
