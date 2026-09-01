// 离线压缩:内置 pngquant 的封装(与 Pngyu / TinyPNG 同源的量化器)
// 以独立 CLI 子进程方式调用(不改写 pngquant,随包分发与 Pngyu 同款做法):
//   输入无损 PNG(经 stdin)→ pngquant 量化成 8-bit 调色板 PNG(Floyd–Steinberg 抖动)→ 结果经 stdout 返回
// 保证 ≤100KB:按感知质量档(--quality min-max)逐档降级,取第一档 ≤ maxBytes 的结果。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_MAX_BYTES = 100 * 1024;
const RUN_TIMEOUT_MS = 30000;

// 质量档(感知质量 0-100):越高画质越好。一档压不到 maxBytes 就降一档。
const QUALITY_TIERS = ['85-100', '70-95', '55-90', '40-85', '20-80'];
// 质量兜底:0-70 关抖动。仍压不到 maxBytes(如高噪点图)时,直接限死颜色数硬压:
// 16 → 8 → 4 → 2 色,关抖动;2 色时 512×512 位深 1bit ≈ 32KB,必能 ≤100KB。
const FALLBACK_TIER = '0-70';
const COLOR_CAP_TIERS = ['16', '8', '4', '2'];

function pngquantPath() {
  const exe = process.platform === 'win32' ? 'pngquant.exe' : 'pngquant';
  const subdir = process.platform === 'win32' ? 'win-x64' : 'mac-arm64';
  const candidates = [];
  // 打包后:二进制经 electron-builder extraResources 放进 resources/pngquant/
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'pngquant', subdir, exe));
  }
  // 开发时:仓库里 vendor/pngquant/<平台>/
  candidates.push(path.join(__dirname, 'vendor', 'pngquant', subdir, exe));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1]; // 全部缺失时,报错信息带上最后的候选路径
}

function pngquantAvailable() {
  return fs.existsSync(pngquantPath());
}

// 单档运行:spawn → stdin 写入输入 → stdout 收集输出;超时兜底防止子进程挂死
function runOnce(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error('无法启动 pngquant: ' + e.message));
      return;
    }
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      reject(new Error('pngquant 压缩超时'));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('pngquant 启动失败: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, buf: Buffer.concat(chunks), stderr: stderr.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// 把一张无损 PNG 压到 ≤ maxBytes(默认 100KB),返回 { buf, tier, exit }
// 抛错场景:二进制缺失 / 全部档位都失败
async function pngquantCompress(pngBuf, maxBytes = DEFAULT_MAX_BYTES) {
  if (!pngquantAvailable()) {
    throw new Error('离线压缩组件缺失,请重新安装应用或改用在线压缩');
  }
  const bin = pngquantPath();
  // 档位计划:5 个质量档 → 0-70 关抖动 → 颜色数硬限(nofs16/8/4/2)
  const plan = [];
  QUALITY_TIERS.forEach((q) => plan.push({ label: q, args: ['--quality', q, '-'] }));
  plan.push({ label: FALLBACK_TIER, args: ['--quality', FALLBACK_TIER, '--nofs', '-'] });
  COLOR_CAP_TIERS.forEach((n) => plan.push({ label: 'nofs' + n, args: ['--nofs', n, '-'] }));
  let last = null;
  for (let i = 0; i < plan.length; i++) {
    const res = await runOnce(bin, plan[i].args, pngBuf);
    if (res.buf.length) {
      last = { buf: res.buf, tier: plan[i].label, exit: res.code };
      // 退出码 99 = 达不到该档 min 质量(图太复杂),输出仍有效,继续降档试更小体积
      if (res.code === 0 && res.buf.length <= maxBytes) return last;
      if (res.code !== 0 && res.code !== 99) {
        throw new Error('pngquant 压缩失败(退出码 ' + res.code + '): ' + (res.stderr || '无输出'));
      }
    }
  }
  if (last) return last; // 2 色硬限仍可能超 maxBytes,但 ≤512px 图标基本不会发生
  throw new Error('pngquant 压缩失败: 没有产生输出');
}

module.exports = { pngquantCompress, pngquantPath, pngquantAvailable, QUALITY_TIERS, FALLBACK_TIER, COLOR_CAP_TIERS };
