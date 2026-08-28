// 游戏图标导出 · Electron 主进程
// 职责:创建应用窗口、接收渲染层导出的 PNG(base64)批量写入用户选择的目录

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 780;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 380,
    minHeight: 600,
    title: '游戏图标导出',
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
ipcMain.handle('icon-app:save-files', async (event, files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, message: '没有可保存的文件。' };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存目录',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '保存到这里'
  });

  if (result.canceled || !result.filePaths.length) {
    return { ok: false, cancelled: true };
  }
  const dir = result.filePaths[0];

  const saved = [];
  const errors = [];
  for (const f of files) {
    const name = String(f.name || 'export.png');
    const b64 = String(f.data || '');
    try {
      const target = uniquePath(dir, name);
      await fsp.writeFile(target, Buffer.from(b64, 'base64'));
      saved.push({ name: path.basename(target), path: target });
    } catch (err) {
      errors.push({ name, message: err.message || String(err) });
    }
  }

  return { ok: errors.length === 0, dir, saved, errors };
});

// 「打开所在目录」—— 在系统文件管理器里定位到某个已保存文件
ipcMain.handle('icon-app:show-in-folder', (event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});
