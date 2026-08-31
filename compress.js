// 游戏图标导出 · 自适应 PNG 压缩
// 原则:尽量无损,但落盘体积有硬上限(默认 100KB)。
//   encodeLosslessPng —— 像素零失真:颜色数 ≤256 走 8 位调色板(小调色板自动压位深),
//                       全不透明走 RGB(去 alpha),有透明走 RGBA,每行选最优过滤器。
//   encodeProgressivePng —— 渐进式:先试无损;无损超上限才按需降色,
//                       从 256 色逐级往下压到体积达标,把画质损失压到最小。
//   降色路径集成 pngquant / TinyPNG 同款思路:
//     · 感知空间(γ≈2.2 校正) + 亮度加权距离 2dr²+4dg²+3db²+4da² —— 人眼更准的最近色;
//     · K-means 调色板精修(中位切分初始化后在可见像素样本上迭代),比盒均值准得多;
//     · Floyd–Steinberg 抖动只扩散 RGB,alpha 不抖 —— 渐变不色带,圆角边缘不画脏;
//     · 调色板瘦身:去掉未用入口 → PLTE 更小、位深可更低;
//     · deflate 多策略择优(Z_FILTERED / Z_RLE / Z_HUFFMAN_ONLY 取最小)。
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

// deflate 多策略择优:同一份扫描线,按最高压缩档试几种策略,取体积最小的一份
function deflateSmallest(data) {
  let best = zlib.deflateSync(data, { level: 9 });
  const strategies = [zlib.constants.Z_FILTERED, zlib.constants.Z_RLE, zlib.constants.Z_HUFFMAN_ONLY];
  for (const strategy of strategies) {
    try {
      const t = zlib.deflateSync(data, { level: 9, strategy });
      if (t.length < best.length) best = t;
    } catch (e) { /* 单策略失败忽略,继续用已选最优 */ }
  }
  return best;
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
  const idat = deflateSmallest(filtered);

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
  const idat = deflateSmallest(filtered);

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

// ---------------------------------------------------------- 感知色彩空间
// pngquant 核心思想:量化在感知空间做,而非线性 RGB。
// γ≈2.2 的幂曲线近似 sRGB 感知亮度,距离公式对 R/G/B 通道加人眼敏感度权重。
const GAMMA_TABLE = new Uint8Array(256);
const UNGAMMA_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  GAMMA_TABLE[i] = Math.round(Math.pow(i / 255, 2.2) * 255);
  UNGAMMA_TABLE[i] = Math.round(Math.pow(i / 255, 1 / 2.2) * 255);
}

// 感知距离:2·dr² + 4·dg² + 3·db² + 4·da²
// (green 敏感度最高;alpha 也参与,平衡透明混合边缘的取舍)
function pxDist(r, g, b, a, er, eg, eb, ea) {
  const dr = r - er, dg = g - eg, db = b - eb, da = a - ea;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db + 4 * da * da;
}

// ---------------------------------------------------------- 调色板量化(兜底)
// 全透明像素(a=0)统一归并为一个透明入口,不占颜色预算,透明边缘不被画脏。
// 可见像素调色板 = 中位切分初始化(K-means 每轮)在感知空间对样本迭代精修。
// 映射:最近邻(感知距离);dither=true 时做 Floyd–Steinberg 误差扩散(仅 RGB)。
function quantizeToPalette(rgba, width, height, K, dither) {
  const count = width * height;
  const transparent = [0, 0, 0, 0];
  const indices = new Uint8Array(count);
  const palette = [];

  // 可见像素索引(光栅顺序) + 全幅感知空间工作区
  const vis = [];
  const fr = new Float32Array(count), fg = new Float32Array(count), fb = new Float32Array(count);
  const al = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (rgba[o + 3] !== 0) vis.push(i);
    fr[i] = GAMMA_TABLE[rgba[o]]; fg[i] = GAMMA_TABLE[rgba[o + 1]]; fb[i] = GAMMA_TABLE[rgba[o + 2]];
    al[i] = rgba[o + 3];
  }
  const hasTransparent = vis.length !== count;
  const transparentIdx = palette.length; // 透明入口追加在最后

  if (vis.length === 0) {
    palette.push(transparent);
    indices.fill(0);
    return { palette, indices };
  }

  // 调色板构建样本:可见像素最多取 ~8192 个(等距抽),大图显著提速、结果几乎不变
  const n = vis.length;
  const SAMPLE_CAP = 8192;
  const step = Math.max(1, Math.floor(n / Math.min(n, SAMPLE_CAP)));
  const sample = [];
  for (let k = 0; k < n; k += step) sample.push(vis[k]);

  // 中位切分初始化:每轮拆「人数 × 感知空间最大通道跨度」最大的盒子
  const cutK = Math.max(1, hasTransparent ? K - 1 : K);
  const boxes = [{ idx: sample }];
  while (boxes.length < cutK) {
    let bi = -1, bestScore = -1, bestChannel = 0;
    for (let b = 0; b < boxes.length; b++) {
      const idx = boxes[b].idx;
      if (idx.length < 2) continue;
      let mn0 = 1e9, mx0 = -1e9, mn1 = 1e9, mx1 = -1e9, mn2 = 1e9, mx2 = -1e9, mn3 = 1e9, mx3 = -1e9;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const r = fr[i], g = fg[i], bl = fb[i], a = al[i];
        if (r < mn0) mn0 = r; if (r > mx0) mx0 = r;
        if (g < mn1) mn1 = g; if (g > mx1) mx1 = g;
        if (bl < mn2) mn2 = bl; if (bl > mx2) mx2 = bl;
        if (a < mn3) mn3 = a; if (a > mx3) mx3 = a;
      }
      const rng0 = mx0 - mn0, rng1 = mx1 - mn1, rng2 = mx2 - mn2, rng3 = mx3 - mn3;
      const range = Math.max(rng0, rng1, rng2, rng3);
      const score = idx.length * range;
      if (score > bestScore) {
        bestScore = score; bi = b;
        bestChannel = (rng0 >= rng1 && rng0 >= rng2 && rng0 >= rng3) ? 0
          : (rng1 >= rng2 && rng1 >= rng3) ? 1
          : (rng2 >= rng3) ? 2 : 3;
      }
    }
    if (bi === -1) break; // 没有可拆分的盒子了
    const idx = boxes[bi].idx;
    const ch = bestChannel;
    idx.sort((i, j) => (ch === 0 ? fr[i] - fr[j] : ch === 1 ? fg[i] - fg[j] : ch === 2 ? fb[i] - fb[j] : al[i] - al[j]));
    const mid = idx.length >> 1;
    boxes.splice(bi, 1, { idx: idx.slice(0, mid) }, { idx: idx.slice(mid) });
  }

  // 初始入口 = 每盒感知空间均值
  const entries = boxes.map((box) => {
    const idx = box.idx;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      sr += fr[i]; sg += fg[i]; sb += fb[i]; sa += al[i];
    }
    const m = idx.length;
    return { gr: sr / m, gg: sg / m, gb: sb / m, a: sa / m };
  });

  // K-means 精修:重复「按感知距离就近归类 → 重算中心」,中心漂移 <0.5 即收敛提前退出
  const Kc = entries.length;
  const egr = new Float32Array(Kc), egg = new Float32Array(Kc), egb = new Float32Array(Kc), ea = new Float32Array(Kc);
  for (let j = 0; j < Kc; j++) { egr[j] = entries[j].gr; egg[j] = entries[j].gg; egb[j] = entries[j].gb; ea[j] = entries[j].a; }
  const sums = new Float64Array(Kc * 4);
  const cnts = new Float64Array(Kc);
  const MAX_ITER = 10;
  for (let it = 0; it < MAX_ITER; it++) {
    sums.fill(0); cnts.fill(0);
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < Kc; j++) {
        const d = pxDist(fr[i], fg[i], fb[i], al[i], egr[j], egg[j], egb[j], ea[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      sums[best * 4] += fr[i]; sums[best * 4 + 1] += fg[i]; sums[best * 4 + 2] += fb[i]; sums[best * 4 + 3] += al[i];
      cnts[best] += 1;
    }
    let moved = 0;
    for (let j = 0; j < Kc; j++) {
      const c = cnts[j];
      if (c === 0) continue;
      const nr = sums[j * 4] / c, ng = sums[j * 4 + 1] / c, nb = sums[j * 4 + 2] / c, na = sums[j * 4 + 3] / c;
      if (Math.abs(nr - egr[j]) + Math.abs(ng - egg[j]) + Math.abs(nb - egb[j]) + Math.abs(na - ea[j]) > 0.5) moved++;
      egr[j] = nr; egg[j] = ng; egb[j] = nb; ea[j] = na;
    }
    if (moved === 0) break;
  }

  // 精修结果转回 8 位线性 RGB 入口 + 追加透明入口
  for (let j = 0; j < Kc; j++) {
    palette.push([UNGAMMA_TABLE[Math.max(0, Math.min(255, Math.round(egr[j])))],
      UNGAMMA_TABLE[Math.max(0, Math.min(255, Math.round(egg[j])))],
      UNGAMMA_TABLE[Math.max(0, Math.min(255, Math.round(egb[j])))],
      Math.max(0, Math.min(255, Math.round(ea[j])))]);
  }
  const pl0 = palette.length;
  if (hasTransparent) palette.push(transparent);

  // 调色板入口的感知空间表示
  const pl = palette.length;
  const per = new Float32Array(pl), peg = new Float32Array(pl), peb = new Float32Array(pl), pea = new Float32Array(pl);
  for (let j = 0; j < pl; j++) {
    per[j] = GAMMA_TABLE[palette[j][0]]; peg[j] = GAMMA_TABLE[palette[j][1]];
    peb[j] = GAMMA_TABLE[palette[j][2]]; pea[j] = palette[j][3];
  }

  // 透明像素先钉死
  if (hasTransparent) {
    for (let i = 0; i < count; i++) if (al[i] === 0) indices[i] = transparentIdx;
  }

  if (dither) {
    // Floyd–Steinberg:误差只扩散 RGB(alpha 不抖,保证半透明/圆角边缘不被破坏)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (al[i] === 0) continue;
        let best = 0, bestD = Infinity;
        for (let j = 0; j < pl; j++) {
          const d = pxDist(fr[i], fg[i], fb[i], al[i], per[j], peg[j], peb[j], pea[j]);
          if (d < bestD) { bestD = d; best = j; }
        }
        indices[i] = best;
        const er = fr[i] - per[best], eg = fg[i] - peg[best], eb = fb[i] - peb[best];
        if (er !== 0 || eg !== 0 || eb !== 0) {
          if (x + 1 < width) { const j = i + 1; fr[j] += er * 0.4375; fg[j] += eg * 0.4375; fb[j] += eb * 0.4375; }
          if (y + 1 < height) {
            if (x > 0) { const j = i + width - 1; fr[j] += er * 0.1875; fg[j] += eg * 0.1875; fb[j] += eb * 0.1875; }
            { const j = i + width; fr[j] += er * 0.3125; fg[j] += eg * 0.3125; fb[j] += eb * 0.3125; }
            if (x + 1 < width) { const j = i + width + 1; fr[j] += er * 0.0625; fg[j] += eg * 0.0625; fb[j] += eb * 0.0625; }
          }
        }
      }
    }
  } else {
    for (let k = 0; k < n; k++) {
      const i = vis[k];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < pl; j++) {
        const d = pxDist(fr[i], fg[i], fb[i], al[i], per[j], peg[j], peb[j], pea[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      indices[i] = best;
    }
  }

  // 去掉未使用的调色板入口(PLTE 更小 + 可能降到更低位深)
  return compactPalette(palette, indices, count, pl0);
}

// 调色板瘦身:只用实际出现的入口,重映射索引
function compactPalette(palette, indices, count, opaqueCount) {
  const used = new Map();
  for (let i = 0; i < count; i++) {
    const v = indices[i];
    if (!used.has(v)) used.set(v, used.size);
  }
  if (used.size === palette.length) return { palette, indices };
  const newPal = new Array(used.size);
  const remap = new Uint8Array(Math.max(palette.length, 256));
  used.forEach((nv, ov) => { newPal[nv] = palette[ov]; remap[ov] = nv; });
  for (let i = 0; i < count; i++) indices[i] = remap[indices[i]];
  return { palette: newPal, indices };
}

// ------------------------------------------------------ 渐进式编码(对外主入口)
// 先无损;无损超出预算才按需降色,从 256 色逐级往下压到 ≤ 预算即停。
// 每档先试「抖动」再试「不抖动」:同色数下抖动视觉更好,若体积超预算则退回不抖动。
// 返回 { buf, mode: 'lossless' | 'quantized', colors? , dither? }
const DEFAULT_MAX_BYTES = 100 * 1024;

function encodeProgressivePng(width, height, rgba, maxBytes = DEFAULT_MAX_BYTES) {
  const lossless = encodeLosslessPng(width, height, rgba);
  if (lossless.length <= maxBytes) return { buf: lossless, mode: 'lossless' };

  // 降色阶梯:多给几个中间档,尽量用「恰好够用」的颜色数,画质损失最小
  const K_LIST = [256, 224, 192, 160, 128, 96, 80, 64, 48, 32, 24, 16, 12, 8, 4, 2];
  for (const K of K_LIST) {
    const q1 = quantizeToPalette(rgba, width, height, K, true);
    const png1 = encodePalettePng(width, height, q1.palette, q1.indices);
    if (png1.length <= maxBytes) return { buf: png1, mode: 'quantized', colors: q1.palette.length, dither: true };
    const q2 = quantizeToPalette(rgba, width, height, K, false);
    const png2 = encodePalettePng(width, height, q2.palette, q2.indices);
    if (png2.length <= maxBytes) return { buf: png2, mode: 'quantized', colors: q2.palette.length, dither: false };
  }
  // 到 2 色(位深 1)必然 < 预算;这里兜底再走一次
  const q = quantizeToPalette(rgba, width, height, 2, false);
  return { buf: encodePalettePng(width, height, q.palette, q.indices), mode: 'quantized', colors: q.palette.length, dither: false };
}

module.exports = { encodeLosslessPng, encodeProgressivePng };
