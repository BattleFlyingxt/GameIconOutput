# 游戏ICON导出 · 默认各硬核渠道尺寸(OV华米荣)

把游戏 ICON 原图批量导出成**各硬核渠道(OPPO / vivo / 华为 / 小米 / 荣耀)所需的规格尺寸**:直角 216 / 256 / 258 / 320 / 512 + 圆角 222 的 PNG,按「游戏名-尺寸 类型.png」命名。**压缩方式与 tinypng.com 一致,每张都压到 100KB 以下**。

基于 Electron 的独立桌面软件,支持 **Windows** 与 **macOS**,不依赖任何运行时。

## 功能

- 把图标图片**拖进窗口**(或点击虚线框选择文件)
- 输入游戏名称 → 自动生成文件名,如「原神-216 直角.png」「原神-222 圆角.png」
- 勾选需要的规格(默认全选):直角 216 / 256 / 258 / 320 / 512 + 圆角 222
- 导出后选择保存目录,一次性批量写入全部 PNG
- 直角 = 内容填满整个分辨率;圆角 = 内容切成正圆形、圆外透明
- 压缩方式**只采用 tinypng.com 的方法**:颜色数 ≤256 的图用精确调色板(像素无损);颜色数 >256 的图一律做感知量化,从 256 色逐级降到 ≤100KB,不再走无损 RGB/RGBA 真彩 —— 所以任何图片都有可预期的压缩结果,没有"无损优先但压不掉"的中间态,每张保证 ≤100KB
- 量化采用 **TinyPNG / pngquant 同款思路**:感知色彩空间(γ≈2.2)+ 亮度加权距离、K-means 调色板精修、**选择性抖动**(只抖颜色不抖透明,纯色区几乎无噪点、渐变区不色带)、调色板瘦身、deflate 多策略择优 —— 同体积下画质明显更好
- **窗口标题与页头显示当前版本号**(如「游戏图标导出 v1.0.7」),发新版本时自动跟随 package.json
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
main.js             Electron 主进程(窗口、保存目录对话框、批量写入)
preload.js          渲染层 ⇄ 主进程安全桥
index.html          界面结构
renderer.js         拖放、Canvas 缩放/圆形裁切、PNG 无损编码、导出流程
renderer.css        界面样式(深浅色自适应)
build/icon.png      应用图标
.github/workflows/build.yml        push 到 main 时双平台自动构建(Artifacts)
.github/workflows/release.yml      打 v* 标签时出包并发布到 Releases
.github/workflows/version-bump.yml 手动触发,升级版本号并打标签
compress.js         TinyPNG 式 PNG 编码(≤256 色无损调色板,>256 色感知量化压到 ≤100KB)
verify.js           自动化验证脚本
```

## 技术要点

- 像素级处理在渲染层用浏览器 Canvas 完成(cover 等比缩放 + 圆形蒙版裁切);
- 编码在主进程用纯 Node(zlib)实现,策略与 tinypng.com 一致:颜色数 ≤256 走精确调色板(按色数压位深 1/2/4/8,全不透明去 alpha);颜色数 >256 一律感知量化 —— **浮点 γ≈2.2 感知空间**(`Math.pow` 代替 8bit 查表,消除线性↔gamma 往返取整误差)4D 中位切分初始化 + K-means 浮点中心精修;**选择性抖动**:先算像素到最近调色板色的距离生成重要性图(1/4 分辨率 + 盒式模糊 + 归一化 + 双线性放大),误差按重要性缩放后走蛇形扫描 Floyd–Steinberg(奇数行反向),误差过大钳制、过小当噪声丢弃,只抖 RGB 不抖透明 —— 纯色区几乎零噪点,渐变区防色带;每档先试抖动再试不抖动,从 256 色逐级压到 ≤100KB 即停,调色板瘦身 + deflate 多策略择优;不再做无损 RGB/RGBA 真彩输出;
- 渲染层启用 `contextIsolation` + 关闭 `nodeIntegration` + CSP,与主进程只经 preload 暴露的 `saveFiles` / `showInFolder` 两个能力通信;
- 同名文件自动追加 `-1` / `-2` 后缀,不会覆盖已有素材。
