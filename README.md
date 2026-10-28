# 图片压缩显微镜

在 Windows 上观察「压缩到底吃掉了什么」的本地工具。导入一张图，程序用真实编码器压一遍、再把产物重新解码，逐像素对比原图，让你看到每一处损失落在哪里。

所有图像处理都在本机完成，不联网、不上传。

## 它不是什么

- **不是批量压缩工具。** 一次只处理一张图，目的是看清楚，不是压得快。
- **不给「画质评分」。** 所有数字都是 0—255 sRGB 通道差的实测值，不是 SSIM/PSNR 之外的感知打分，也没有「画质 92 分」这种编造指标。
- **不做 HDR / 动画 / RAW。** 遇到就明确拒绝，不静默降级。

## 功能

**两种模式**

- 现场压缩：导入原图，按所选格式与参数真实编码，与原始像素对比。
- 已有图片：导入两张图并排比较，用于核对「这张是不是那张压出来的」。

**三种观察视图**

- 并排对照：原图与结果同屏，同步平移缩放。
- 分割对照：同一张图上左右分割，拖动分界。
- 差异显影：逐像素差值，可调显影增益，可切换独立 Alpha 通道差异。

**编码控制**

- JPEG：质量 1—100、色度采样 4:2:0 / 4:4:4、透明区域合成背景。
- PNG：无损，压缩级别 0—9。
- WebP：有损或无损。
- **体积上限**：填入 KiB 后，程序二分搜索质量，取不超过上限的最高质量。每次都真编一次再量字节，不是按曲线估算；上限做不到时如实报告「无法达成，质量 1 时最小 N KiB」，不会偷偷给一个超标的文件。

**观察与导出**

- 滚轮缩放以光标为锚点，100% 时一图像像素对应一物理显示像素；≥800% 可开像素网格。
- 导出差异图 PNG、对照图 PNG，均附参数 JSON。
- 会话保存：只记录素材引用与参数，重开时按 SHA-256 校验素材，变了会要求重新关联。

**安全与边界**

- 源文件只读，任何情况下不允许覆盖；保存路径等于源文件会被拒绝（含硬链接别名）。
- 分析基准统一为方向校正后的 8 位 sRGB RGBA；16 位 PNG 需明确勾选才生成 8 位分析副本。
- 编码输出去除 GPS、EXIF、XMP、IPTC 与旧缩略图；「另存比较图副本」除外，那是原字节复制。

## 安装

到 [Releases](../../releases) 下载 `ImageCompressionMicroscope-1.0.1-Setup.exe` 双击安装。per-user 安装到 `%LOCALAPPDATA%\ImageCompressionMicroscope`，不需要管理员权限。

> 安装包文件名用 ASCII，因为 GitHub 会把 Release 附件名里的非 ASCII 字符直接剥掉（中文名会变成 `-1.0.1-Setup.exe` 这种残缺样子）。

> 安装包约 160 MB，超过 GitHub 单文件 100 MB 上限，因此**不放在仓库里**，只作为 Release 附件。

卸载：控制面板「应用」里卸载，或执行 `%LOCALAPPDATA%\ImageCompressionMicroscope\Update.exe --uninstall`。

## 开发

需要 Node 22。

```bash
npm ci
npm run build        # vite 渲染层 + esbuild 主进程/preload/worker
npm run dev          # 构建后启动
npm test             # 管线与体积上限单元测试（15 项）
npm run smoke        # 真实 Electron 启动 + 真实导入/编码/另存 + SHA 核验
npm run check:diff    # 差异显影崩溃回归（10 项断言）
npm run check:sizecap # 体积上限界面链路（10 项断言）
npm run check:zoom    # 滚轮缩放跟随光标（10 项断言）
```

打包：

```bash
npm run package   # 目录版，产物在 out/
npm run make      # zip + Squirrel 安装包
```

两条打包注意，都是本机实测踩出来的：

1. `rcedit.exe` 处理不了含中文的路径，构建目录必须先映射成 ASCII 盘符：
   `subst X: "D:\path\to\project"`，然后在 `X:` 下打包。
2. `@electron/get` 即使命中本地缓存，仍要下载 `SHASUMS256.txt` 校验；该校验请求失败会被当成「缓存不匹配」，于是回退重下整个 Electron 包，导致打包必然中断。`scripts/make-offline.mjs` 用缓存里的真实 zip 自算 SHA-256，起本地镜像让校验就地完成。

## 架构

```text
src/main/index.ts        主进程：窄 IPC、输入快照、修订屏障、协议、会话
src/preload/index.ts     contextBridge，仅暴露必要方法
src/workers/image.cjs    utilityProcess：sharp 规范化 / 编码 / 解码 / 全图统计 / 瓦片金字塔
src/domain/files.cjs     源文件身份保护、原子提交、字节哈希核验
src/renderer/            React 界面与 canvas 视口
src/contracts/model.ts   参数契约与校验（主进程与渲染层共用）
```

几个刻意的设计：

- 全分辨率图像操作一律在可丢弃的 utilityProcess 里做，渲染进程只碰瓦片。
- 每次处理都带 revision，迟到的旧结果不会覆盖新结果。
- 参数校验在主进程与渲染层各做一次，主进程侧以 IPC 来源（sender + frame URL）为信任边界。
- 视口用 512px 瓦片金字塔，缩小时用 Lanczos3 重采样，避免整图常驻显存。

## 已知限制

完整清单见 [docs/implementation-status.md](docs/implementation-status.md)，这里只列影响使用的：

- 单图上限 2400 万像素（保护性上限，不是内存保证）。
- 16 位 PNG 需显式勾选生成 8 位分析副本；HDR、gain-map、动画、多页一律拒绝。
- 体积上限只调质量，不会自动换格式或缩小像素尺寸。
- 卸载会残留 `.dead` 空目录、`Update.exe` 与 `app-x.y.z\squirrel.exe`，这是 Squirrel 的自删除机制。
- 未在无开发环境的干净系统上做过安装验收；DPI 150% / 200% 与小窗口未逐项验证。

## 第三方

Electron（MIT）、React（MIT）、sharp / libvips（Apache-2.0 / LGPL-3.0）、Vite（MIT）、esbuild（MIT）、Electron Forge（MIT）。各自许可证见 `node_modules` 内附文件。

图标为本项目自制（`resources/icon.svg` → sharp 渲染多尺寸 → 手工封装 ICO）。

## 许可

[MIT](LICENSE)
