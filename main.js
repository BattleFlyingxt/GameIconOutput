// 游戏图标导出 · Electron 主进程
// 职责:创建应用窗口、接收渲染层导出的 PNG(base64)批量写入用户选择的目录

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const { encodeLosslessPng } = require('./compress');
const { pngquantCompress } = require('./pngquant');
const pkg = require('./package.json');

const APP_TITLE = '游戏图标导出 v' + pkg.version;
const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 780;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 380,
    minHeight: 600,
    title: APP_TITLE,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');
  // 页面里的 <title> 加载后会覆盖窗口标题,拦掉,始终显示带版本号的标题
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // 菜单栏对这个小工具没有用处;mac 保留默认应用菜单(Cmd+C/V/Q 等)
  if (process.platform !== 'darwin') {
    const { Menu } = require('electron');
    Menu.setApplicationMenu(null);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ------------------------------------------------------------- 配置持久化
// 保存:压缩模式(在线/离线)、TinyPNG API key、上次导出目录。写 userData/config.json

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      mode: c.mode === 'offline' ? 'offline' : 'online',
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
      lastSaveDir: typeof c.lastSaveDir === 'string' ? c.lastSaveDir : ''
    };
  } catch (err) {
    return { mode: 'online', apiKey: '', lastSaveDir: '' };
  }
}

function saveConfig(patch) {
  const cfg = Object.assign(loadConfig(), patch || {});
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const tmp = configPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, configPath());
  } catch (err) { /* 持久化失败不影响本次功能 */ }
  return cfg;
}

// ------------------------------------------------------------- 在线压缩(tinypng 官方 API)
// 上传 PNG → api.tinypng.com/shrink(Basic auth,key 为 api:KEY)→ 从 Location 下载压缩结果。
// 官方接口需要免费 API key(tinypng.com/developers 申请,每月 500 张免费);
// 网页端免 key 接口(web/shrink)已下线,不再依赖。

function tinypngShrink(pngBuf, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.tinypng.com',
      path: '/shrink',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
        'Content-Type': 'image/png',
        'Content-Length': pngBuf.length,
        'User-Agent': 'game-icon-export-app/' + pkg.version
      }
    }, (res) => {
      res.resume(); // 丢弃响应体,只要头
      const loc = res.headers.location;
      if (res.statusCode === 401) { reject(new Error('在线压缩失败:API Key 无效,请到 tinypng.com 核对后重新填写')); return; }
      if (res.statusCode === 429) { reject(new Error('在线压缩失败:TinyPNG 每月免费配额(500 张)已用尽,可到 tinypng.com 升级或改用离线压缩')); return; }
      if ((res.statusCode === 201 || res.statusCode === 200) && loc) {
        https.get(loc, (res2) => {
          if (res2.statusCode !== 200) {
            res2.resume();
            reject(new Error('在线压缩失败:下载压缩结果出错(' + res2.statusCode + '),请重试'));
            return;
          }
          const chunks = [];
          res2.on('data', (c) => chunks.push(c));
          res2.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', (e) => reject(new Error('在线压缩失败:网络错误(' + e.message + ')')));
        return;
      }
      reject(new Error('在线压缩失败:tinypng.com 返回异常状态 ' + res.statusCode));
    });
    req.on('error', (e) => reject(new Error('在线压缩失败:网络错误(' + e.message + ')')));
    req.write(pngBuf);
    req.end();
  });
}

// 若目标目录里已有同名文件,自动追加 -1 / -2,避免覆盖已有素材
function uniquePath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i += 1) {
    candidate = path.join(dir, base + '-' + i + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// 渲染层导出完成 → 选目录 → 批量写入全部 PNG
// opts: { mode: 'online' | 'offline', apiKey } —— 在线=tinypng 官方 API 压缩,离线=本地 TinyPNG 式量化
ipcMain.handle('icon-app:save-files', async (event, files, opts) => {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, message: '没有可保存的文件。' };
  }

  const cfg = loadConfig();
  const mode = opts && opts.mode === 'offline' ? 'offline' : 'online';
  const apiKey = (opts && typeof opts.apiKey === 'string' && opts.apiKey) || cfg.apiKey;
  if (mode === 'online' && !apiKey) {
    return { ok: false, needKey: true, message: '在线压缩需要 TinyPNG API Key,请先填写(免费申请)或切换到离线压缩。' };
  }

  const lastDir = cfg.lastSaveDir && fs.existsSync(cfg.lastSaveDir) ? cfg.lastSaveDir : null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存目录',
    defaultPath: lastDir || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '保存到这里'
  });

  if (result.canceled || !result.filePaths.length) {
    return { ok: false, cancelled: true };
  }
  const dir = result.filePaths[0];
  // 目录记忆:下次导出默认在此打开
  if (dir !== lastDir) saveConfig({ lastSaveDir: dir });

  const saved = [];
  const errors = [];
  for (const f of files) {
    const name = String(f.name || 'export.png');
    try {
      const width = Number(f.width) || 0;
      const height = Number(f.height) || 0;
      const pixels = f.pixels;
      // 校验像素数据完整(渲染层传的是 Uint8ClampedArray,结构化克隆后仍为视图)
      const okView = pixels && typeof pixels.byteLength === 'number' && typeof pixels.byteOffset === 'number';
      if (!okView || width <= 0 || height <= 0 || width * height * 4 !== pixels.byteLength) {
        throw new Error('像素数据无效');
      }
      const rgba = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      let buf;
      if (mode === 'online') {
        // 在线压缩:本地仅无损编码 → 上传 tinypng.com 官方 API → 取回压缩结果
        const rawPng = encodeLosslessPng(width, height, rgba);
        buf = await tinypngShrink(rawPng, apiKey);
      } else {
        // 离线压缩:调用内置 pngquant(与 Pngyu / TinyPNG 同源),按质量档降级保证每张 ≤ 100KB
        const rawPng = encodeLosslessPng(width, height, rgba);
        buf = (await pngquantCompress(rawPng)).buf;
      }
      const target = uniquePath(dir, name);
      await fsp.writeFile(target, buf);
      // requestedName 是渲染层请求的原始名;name 可能是去重后的实际名(重名会追加 -1)
      saved.push({ name: path.basename(target), requestedName: name, path: target, size: buf.length });
    } catch (err) {
      errors.push({ name, message: err.message || String(err) });
    }
  }

  return { ok: errors.length === 0, mode, dir, saved, errors };
});

// 「打开所在目录」—— 在系统文件管理器里定位到某个已保存文件
ipcMain.handle('icon-app:show-in-folder', (event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// 应用版本号(标题与页头显示)
ipcMain.handle('icon-app:version', () => pkg.version);

// 配置读写:压缩模式 / API key / 上次导出目录
ipcMain.handle('icon-app:get-config', () => loadConfig());

ipcMain.handle('icon-app:set-config', (event, patch) => {
  const clean = {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.mode === 'string') clean.mode = patch.mode;
    if (typeof patch.apiKey === 'string') clean.apiKey = patch.apiKey;
    if (typeof patch.lastSaveDir === 'string') clean.lastSaveDir = patch.lastSaveDir;
  }
  return saveConfig(clean);
});

// 「获取免费 Key」等外部链接用系统浏览器打开(不在应用窗口里跳转)
ipcMain.handle('icon-app:open-external', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
