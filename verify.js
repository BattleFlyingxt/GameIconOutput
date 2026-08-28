// 自动化验证:启动真实应用,注入一张测试图走完整导出流程,核对落盘文件
// 运行:npx electron verify.js  (退出码 0 = 通过)
// 保存对话框被 monkey-patch 到临时目录,不弹真实窗口

const { app, dialog, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
      check(byteLen < 100 * 1024, file + ' <100KB(实际 ' + (byteLen / 1024).toFixed(1) + 'KB)');

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
