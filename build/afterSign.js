// macOS 构建后钩子:给随包分发的 pngquant 二进制显式补 ad-hoc 签名,并重签整个 .app。
// 背景:app 未用付费开发者证书签名,只做 ad-hoc 签名;若包内存在未签名/签名不完整的
// Mach-O 代码(extraResources 里的 pngquant),Gatekeeper 对下载(app 带 quarantine 标记)
// 的 app 做深度校验时会报「App 已损坏,代码与原始签名不匹配」,导致无法打开。
// 这里把 Contents/Resources/pngquant 下的每个文件显式签名,再重签 app 包,深度校验即可通过。

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const binRoot = path.join(appPath, 'Contents', 'Resources', 'pngquant');
  if (!fs.existsSync(binRoot)) {
    // 找不到就大声失败:说明打包配置漏了 extraResources,别让坏包发出去
    throw new Error(`[afterSign] 未找到 pngquant 资源目录: ${binRoot}(检查 package.json 的 build.extraResources)`);
  }
  const targets = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/^\./.test(e.name)) targets.push(p);
    }
  };
  walk(binRoot);
  for (const t of targets) {
    execSync(`codesign --force --sign - "${t}"`, { stdio: 'inherit' });
  }
  execSync(`codesign --force --sign - --deep "${appPath}"`, { stdio: 'inherit' });
  console.log(`[afterSign] 已 ad-hoc 签名 ${targets.length} 个 pngquant 文件并重签 ${appPath}`);
};
