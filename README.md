# 游戏ICON导出 · 默认各硬核渠道尺寸(OV华米荣)

把游戏 ICON 原图批量导出成**各硬核渠道(OPPO / vivo / 华为 / 小米 / 荣耀)所需的规格尺寸**:直角 216 / 256 / 258 / 320 / 512 + 圆角 222 的 PNG,按「游戏名-尺寸 类型.png」命名。支持**在线压缩(上传 tinypng.com 官方 API)**与**离线压缩(内置 pngquant)**两种方式,**默认在线**。

基于 Electron 的独立桌面软件,支持 **Windows** 与 **macOS**,不依赖任何运行时。

## 功能

- 把图标图片**拖进窗口**(或点击虚线框选择文件)
- 输入游戏名称 → 自动生成文件名,如「原神-216 直角.png」「原神-222 圆角.png」
- 勾选需要的规格(默认全选):直角 216 / 256 / 258 / 320 / 512 + 圆角 222
- 导出后选择保存目录,一次性批量写入全部 PNG;**记住上次导出的目录**,下次保存框自动在它上面打开
- **在线压缩(默认)**:先把原图裁切成目标规格,无损上传到 tinypng.com 官方 API 压缩,再把压缩结果下载到选定目录 —— 画质与 tinypng.com 网页版完全一致
- **离线压缩**:不依赖网络,本地调用**内置 pngquant**(与 Pngyu、TinyPNG 同源的量化器),保证每张 ≤100KB
- 两种模式在软件内一键切换,默认【在线压缩】;模式与 API Key 保存在本机,下次启动自动恢复
- 在线压缩需填一个 **TinyPNG 免费 API Key**(每月 500 张免费);点「获取免费 Key」直达 tinypng.com/developers 申请,Key 仅保存在本机
- 直角 = 内容填满整个分辨率;圆角 = 内容切成正圆形、圆外透明
- 离线压缩**直接调用内置 pngquant**(与 Pngyu、TinyPNG 同源的量化器)以独立 CLI 子进程方式运行:先无损编码,再交给 pngquant 压成 8-bit 调色板 PNG(Floyd–Steinberg 抖动),按感知质量档逐档降级,最后一档还压不下就限死颜色数兜底 —— 任何图片都有可预期的压缩结果,每张保证 ≤100KB
- **窗口标题与页头显示当前版本号**(如「游戏图标导出 v1.0.9」),发新版本时自动跟随 package.json
- 结果卡片可查看大图、打开所在目录
- 自动适配系统深色 / 浅色主题

## 本机运行(开发)

```bash
npm install
npm start
```

## 自动化验证

```bash
npx electron verify.js
```

脚本会启动真实应用、注入一张测试图走完整导出流程,核对落盘文件的命名、尺寸与圆角透明,全部通过退出码为 0。

## 从 GitHub Actions 出安装包(Windows + Mac)

仓库已配置 `.github/workflows/build.yml`,每次 `push` 到 `main`(或手动 **Run workflow**)都会自动并行构建两个平台的安装包:

- `windows-latest` → NSIS 安装包 `.exe`
- `macos-latest` → `.dmg`

构建完成后进入仓库 **Actions** 页面对应 Job 的 **Artifacts**,下载 `installers-*.zip`,解压即得安装包。

## 版本号管理 + 自动发布 Releases

项目配了两条辅助工作流,让「发新版本」变成点几下的事:

- **Bump Version**（版本号管理）
  仓库 **Actions** 页 → **Bump Version** → **Run workflow**,选一个增量:
  - `patch`(小修复,1.0.0 → 1.0.1)
  - `minor`(新功能,1.0.0 → 1.1.0)
  - `major`(大版本,1.0.0 → 2.0.0)
  它会自动升级 `package.json` 版本号、提交到 main 并打 `v*` 标签。

- **Release**（自动出包 + 发布）
  打 `v*` 标签(上面 Bump Version 自动打,或本地 `git tag v1.0.0 && git push --tags`)后自动运行:
  并行构建 Windows `.exe` + macOS `.dmg`,然后到仓库 **Releases** 页创建一个正式版本,把两平台的安装包直接挂上去,用户点下载即得安装包。

本地手动发版也可以:改 `package.json` 的 `version`,`git commit`、`git tag v1.1.0`、`git push origin main --tags`,一样会触发 Release。

## 安装提示(未签名)

本项目的安装包未做代码签名(签名需要付费开发者证书),安装时系统会提示"不明来源",属正常现象:

- **Windows**:运行安装包时如出现 SmartScreen 提示,点「更多信息」→「仍要运行」。
- **macOS**:首次打开 .dmg 后,若提示"无法验证开发者",在「系统设置 → 隐私与安全性」里点「仍要打开」。

## 更换应用图标

把 `build/icon.png` 替换成你的图标(建议 ≥512×512 正方形 PNG),重新构建即可,不需要改配置。

## 项目结构

```
main.js             Electron 主进程(窗口、保存目录对话框、在线压缩上传、批量写入、配置持久化)
preload.js          渲染层 ⇄ 主进程安全桥
index.html          界面结构
renderer.js         拖放、Canvas 缩放/圆形裁切、PNG 无损编码、导出流程
renderer.css        界面样式(深浅色自适应)
build/icon.png      应用图标
.github/workflows/build.yml        push 到 main 时双平台自动构建(Artifacts)
.github/workflows/release.yml      打 v* 标签时出包并发布到 Releases
.github/workflows/version-bump.yml 手动触发,升级版本号并打标签
pngquant.js         离线压缩:pngquant 封装(质量档迭代压到 ≤100KB)
vendor/pngquant/    随包分发的 pngquant 二进制(GPL-3.0,与 Pngyu 同款做法;Windows 2.17.0 / macOS 3.0.3)
compress.js         无损 PNG 编码(在线压缩喂入 + 离线压缩的 pngquant 输入)
verify.js           自动化验证脚本
```

## 技术要点

- 像素级处理在渲染层用浏览器 Canvas 完成(cover 等比缩放 + 圆形蒙版裁切);
- 离线压缩在主进程把无损 PNG 经 stdin 喂给**内置 pngquant**(独立 CLI 子进程,stdout 取回结果):按感知质量档 `85-100 → 70-95 → 55-90 → 40-85 → 20-80` 逐档降级,仍超 100KB 就 `0-70` 关抖动,再超就限死颜色数(`--nofs 16/8/4/2`)硬压兜底 —— 保证每张 ≤100KB;pngquant 以 GPL-3.0 等双许可随包分发(vendor/pngquant/,与 Pngyu 同款做法),代码不改写、不链接,调用方式与 Pngyu 一致;
- 在线压缩在主进程用纯 Node `https` 调 tinypng.com 官方 API:先本地 `encodeLosslessPng` 无损编码,POST 到 `api.tinypng.com/shrink`(Basic 认证),从响应 `Location` 头下载压缩结果;**串行上传**避免限流;错误分类提示(Key 无效 / 月配额用尽 / 网络异常);
- 配置(模式 / API Key / 上次导出目录)持久化到 `userData/config.json`,原子写(temp + rename);保存对话框 `defaultPath` 用上次目录,导出成功后写回;
- 渲染层启用 `contextIsolation` + 关闭 `nodeIntegration` + CSP,与主进程只经 preload 暴露的 `saveFiles` / `showInFolder` / `getConfig` / `setConfig` / `openExternal` 能力通信;
- 同名文件自动追加 `-1` / `-2` 后缀,不会覆盖已有素材。
