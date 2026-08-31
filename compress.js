// 游戏图标导出 · 无损 PNG 压缩
// 纯 Node(zlib)实现 PNG 编码。原则:像素零失真(无损),同时尽量做小:
//   - 颜色数 ≤256 的图 → 8-bit 调色板 PNG(颜色精确保留,体积最小)
//   - 全不透明 → RGB(去掉 alpha 通道,省约 25%)
//   - 有透明度 → RGBA
//   每行在 None/Sub/Up/Avg/Paeth 五种过滤器里选最优,再 zlib 最高级别压缩
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

// ---------------------------------------------------------- 无损 PNG 编码
// rgba: RGBA 顺序原始像素(长度 = width*height*4);返回 PNG Buffer
function encodeLosslessPng(width, height, rgba) {
  const count = width * height;

  // 统计唯一颜色(RGBA 组合),决定编码形态
  const colorMap = new Map(); // key -> {r,g,b,a}
  const order = [];           // 首次出现顺序
  let allOpaque = true;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const key = (rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3];
    if (!colorMap.has(key)) { colorMap.set(key, { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] }); order.push(key); }
    if (rgba[o + 3] !== 255) allOpaque = false;
  }

  let colorType, bpp, raw, plte = null, trns = null;
  if (order.length <= 256) {
    // 颜色本来就不超过 256:精确调色板,无损且最小
    colorType = 3; bpp = 1;
    const pal = order.map((k) => colorMap.get(k));
    plte = Buffer.alloc(pal.length * 3);
    let hasAlpha = false;
    for (let i = 0; i < pal.length; i++) {
      plte[i * 3] = pal[i].r; plte[i * 3 + 1] = pal[i].g; plte[i * 3 + 2] = pal[i].b;
      if (pal[i].a < 255) hasAlpha = true;
    }
    if (hasAlpha) {
      trns = Buffer.alloc(pal.length);
      for (let i = 0; i < pal.length; i++) trns[i] = pal[i].a;
    }
    const keyToIdx = new Map();
    order.forEach((k, idx) => keyToIdx.set(k, idx));
    raw = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      raw[i] = keyToIdx.get((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]);
    }
  } else if (allOpaque) {
    colorType = 2; bpp = 3; // RGB,不写 alpha
    raw = Buffer.alloc(count * 3);
    for (let i = 0; i < count; i++) {
      raw[i * 3] = rgba[i * 4]; raw[i * 3 + 1] = rgba[i * 4 + 1]; raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
  } else {
    colorType = 6; bpp = 4; // RGBA 全保留
    raw = Buffer.from(rgba);
  }

  // 逐行过滤 → deflate
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
  if (colorType === 3) {
    parts.push(chunk('PLTE', plte));
    if (trns) parts.push(chunk('tRNS', trns));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { encodeLosslessPng };
