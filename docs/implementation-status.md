# 实施状态

2026-10-24，源码版本 0.1.0（未发布）。五小时窗口实查 52%，按用户50%停止线保存并停止；没有继续新增功能。

## 2026-10-28 安装 / 卸载实测（用户授权后执行）

用户在机器上双击了第一版安装包，随后要求做完整安装卸载测试。以下全部是实机结果。

### 第一轮：发现两个真缺陷

| 步骤 | 结果 |
|---|---|
| 安装 | `Setup.exe` → `%LOCALAPPDATA%\CompressionMicroscope`（`Update.exe` + `app-0.1.0\` + `packages\*.nupkg` + `RELEASES`），退出码 0 |
| 注册表 | 创建 `HKCU\...\Uninstall\CompressionMicroscope`，DisplayVersion 0.1.0，Publisher "Personal instruments"，UninstallString 指向 `Update.exe --uninstall` |
| 首启 | 安装器以 `--squirrel-firstrun` 自动拉起，窗口标题「压缩损失显微镜」，RSS 156.7 MB |
| **缺陷 1** | **没有创建任何开始菜单快捷方式**，用户装完只能去 `%LOCALAPPDATA%` 里翻 |
| **缺陷 2** | 应用与安装包**没有图标**（`iconUrl` 指向 GitHub 远程 electron.ico，本网络下不可靠） |
| 卸载 | `Update.exe --uninstall` 退出码 0；`app-0.1.0` 移除、注册表项移除、进程终止；残留 `.dead`（空目录）+ `Update.exe`（1.9 MB） |

### 修复

1. **图标**：新增 `resources/icon.svg`（深色仪器感、透镜 + 压缩像素带 + 刻度），用 sharp 渲染 16/24/32/48/64/128/256 七种尺寸，手工封装成多尺寸 `resources/icon.ico`（28,081 字节，PNG 压缩条目）。
2. **`package.json`**：`packagerConfig.icon` 与 maker-squirrel 的 `setupIcon` 都指向 `resources/icon.ico`。
3. **快捷方式**：`src/main/index.ts` 增加 Squirrel 事件钩子，在 `--squirrel-install` / `--squirrel-updated` 时执行 `Update.exe --createShortcut <exe>`，`--squirrel-uninstall` / `--squirrel-obsolete` 时执行 `--removeShortcut`，随后 `app.exit(0)`。
   - 只匹配这四个事件，**不匹配 `--squirrel-firstrun`**——那是安装后自动启动应用的事件，误匹配会导致装完打不开。

### 第二轮：复测通过

| 步骤 | 结果 |
|---|---|
| 卸载（旧版） | 退出码 0，`app-0.1.0` 与注册表项均移除，无残留进程 |
| 安装（新版） | `Setup.exe --silent` 退出码 0，`app-0.1.0` 出现 |
| 注册表 | `CompressionMicroscope | v0.1.0 | Personal instruments | %LOCALAPPDATA%\CompressionMicroscope` |
| **快捷方式** | ✅ `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Personal instruments\CompressionMicroscope.lnk`（2,540 字节） |
| 启动 | 窗口标题「压缩损失显微镜」，RSS 131.7 MB，存活 |

### 环境性障碍（不是产品缺陷，但会影响复现）

1. **本会话 GPU 进程无法启动**：`GPU process exited unexpectedly: exit_code=-1073741819` → `GPU process isn't usable` → 渲染进程崩溃 → `loadFile` 报 `ERR_FAILED (-2)`，应用直接退出。加 `--disable-gpu --in-process-gpu` 后正常出窗口。同一会话里两个 Electron 项目的冒烟也受此影响。**在正常桌面会话里不需要这个参数**（用户 10:27 双击安装后的自动首启就没有加参数，窗口正常）。
2. **`Start-Process` 无法启动含中文路径的 exe**：直接对含中文的绝对路径 `...\Setup.exe` 调用报"无法完全运行此命令"，复制到 `%TEMP%` 的 ASCII 路径后正常。这是 PowerShell 侧的问题，用户双击不受影响。
3. **`NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` 污染**：IDE 终端注入的 shim 会让打包应用报 "Most NODE_OPTIONs are not supported in packaged apps"，`ELECTRON_RUN_AS_NODE=1` 会让应用以纯 Node 运行并立即退出。从资源管理器/开始菜单启动不受影响。

### 仍未解决

- **卸载残留**：`.dead` 空目录 + `Update.exe`（1.9 MB）留在 `%LOCALAPPDATA%`。这是 Squirrel 的自删除机制，需要额外的清理步骤才能彻底干净。
- **显示名仍是英文** `CompressionMicroscope`，不是「压缩损失显微镜」。Squirrel 的 nuspec `<title>` 取自 maker 的 `name`，改成中文会把安装目录也变成中文，未贸然改。
- **快捷方式被放进 `Personal instruments` 子文件夹**，而不是开始菜单根层。这是 `Update.exe --createShortcut` 按 publisher 分组的默认行为。
- 没有在**干净系统**（无 Node/Python/开发环境）上验证；本次是同一台开发机。

## 2026-10-28 冒烟脚本的环境适配（接手修正，并复跑全部检查）

在本会话（IDE 内置终端 + 远程桌面会话）直接跑 `node scripts/smoke.mjs` 曾以退出码 3 失败，原因不在产品代码，已修：

1. 终端自带 `ELECTRON_RUN_AS_NODE=1`，electron 二进制退化成纯 Node，`app` 为 `undefined`。脚本 spawn 前删除该变量。
2. 本会话无可用图形适配器，且默认 `%APPDATA%\Electron` 的 GPU 缓存被宿主占用，GPU 进程反复崩溃（`exit_code=-1073741819`），导致 `loadFile` 报 `ERR_FAILED (-2)`。脚本改用独立 `--user-data-dir` + `--no-sandbox --disable-gpu --in-process-gpu --disable-gpu-sandbox`。

修复后 `node scripts/smoke.mjs` **退出码 0**，输出与 09:11 那次记录一致：

```text
[smoke] EXIF 方向 1: 规范化 60×30 · 方向1 · 对照 mae=0.000 max=0
[smoke] EXIF 方向 8: 规范化 30×60 · 方向8 · 对照 mae=0.000 max=0
[smoke] saved ...\microscope-smoke-saved-*.jpg (8983 B, sha 143f72e0a954…) source unchanged
[smoke] difference export ok (156929 B) + 参数JSON一致
[smoke] comparison export ok (386891 B, 1224x464)
[smoke] compare-mode save is byte-identical copy of original
[smoke] OK: EXIF 1-8 + 编码闭环 + 辅助导出 + 原字节副本 全部通过
```

这些开关只在冒烟脚本里，产品代码未改动。

## 2026-10-28 安装包生成成功：`make` 的真实阻塞点是中文路径，不是网络

上一节记录的"`npm run make` 三次失败，Squirrel 工具下载被 ECONNRESET"只对前两次成立。第 4 次（构建日志留在本机，未随仓库分发）实际已经越过下载阶段，失败在 `rcedit.exe`：

```text
Fatal error: Unable to load file
command invoked was: '...\electron-winstaller\vendor\rcedit.exe "...\out\make\squirrel.windows\x64\Setup.exe" --set-version-string ...'
```

即 rcedit 无法处理含中文的绝对路径。这是工具链的路径编码问题，与网络无关。

处理方式与结果：

1. `subst X: "<项目根>"` 把项目根映射为纯 ASCII 盘符（同一份文件，不是复制）。
2. `npx electron-forge make --skip-package` 复用已打包的 `out/CompressionMicroscope-win32-x64`，避免重复下载 Electron 二进制。
3. **成功产出**：
   - `out/make/squirrel.windows/x64/CompressionMicroscope-0.1.0 Setup.exe`，163,548,672 字节，SHA-256 `21adbb102ff9c7afc544675493312be1631e1cd4b851631cbf2d508daef606c6`
   - `out/make/squirrel.windows/x64/CompressionMicroscope-0.1.0-full.nupkg`，162,862,597 字节
   - `out/make/squirrel.windows/x64/RELEASES`
   - `out/make/zip/win32/x64/CompressionMicroscope-win32-x64-0.1.0.zip`，SHA-256 `1ffffb5f6dd9daf4bb63c9850619a526711a1d8c67be2aba25416e70ab9bad8f`
4. nupkg 内容抽验（379 条目）：`lib/net45/CompressionMicroscope.exe`、`lib/net45/resources/app/node_modules/@img/sharp-win32-x64/`（sharp 原生模块在位）。`asar: false`，因此是 `resources/app` 目录而非 `app.asar`，符合当前配置。

**诚实边界**：安装包已生成并通过内容抽验，但**没有在干净系统上执行安装/卸载**。Squirrel 会写入 `%LOCALAPPDATA%` 与开始菜单，属于对用户机器的副作用，未在未获同意时执行。安装验收仍为未完成项。

可复现命令（Windows，中文路径必须走 subst 或 ASCII 路径）：

```bash
subst X: "<项目根>"
cd /x/compression-microscope && npm run build && npx electron-forge make --skip-package
```

## 2026-10-28 实机验证与打包（协调者直接执行）

接手审计后在本机（Windows 11，node 22.15.1 / npm 10.9.2）完成以下真实验证，取代"依赖未安装"的旧记录：

- `node_modules` 与 `package-lock.json` 完整（Electron 44.9.3、sharp 0.35.5 固定）。
- `npm test`：**7/7 全部通过**，含此前被沙箱 EPERM 阻止的 C05 硬链接保护用例（真实 Windows 权限下通过）。
- `npm run build`：成功（vite renderer + main/preload/worker 产物齐全）。
- 新增实机冒烟入口 `npm run smoke`（`scripts/smoke.mjs` 驱动 `tests/smoke.cjs`，复用主进程既有 MICROSCOPE_TEST 钩子，不新增产品代码路径）：真实 Electron 启动 → 渲染进程挂载（`window.microscope` 存在、#root 有内容）→ 真实导入带透明渐变 PNG 夹具（272,767 字节）→ utilityProcess + sharp 真实 JPEG 编码（600×400，产物 8,983 字节，4:4:4、matte #102030）→ 渲染进程收到真实结果事件并更新状态文案 → 队列化确认/保存对话框真实另存 → 落盘字节与 SHA-256 核验一致 → 源夹具哈希不变。退出码 0。
- `npm run package`（electron-forge）：成功产出 `out/CompressionMicroscope-win32-x64/`（约 396 MB 解包目录），`sharp-win32-x64-0.35.5.node` 原生模块在位。
- 打包版实机启动验证：`CompressionMicroscope.exe` 启动后窗口标题「压缩损失显微镜」，运行 10 秒存活，随后正常关闭。启动级验证；完整 GUI 人工交互验收仍未做。

尚未完成（不因上述通过而豁免）：EXIF 1—8 与真实 16 位/动画/HDR 样本、取消与迟到任务竞态的自动测试、会话重开与文件替换、辅助导出（差异/对照图及参数 JSON）、alpha 显影与背景切换界面、大图瓦片/内存基准、DPI 与小窗口、Squirrel 安装包及安装/卸载验收、依赖许可清单。GUI 交互验收需人工操作。

下一项：补辅助导出与 EXIF 方向用例，然后做 Squirrel `npm run make` 与干净系统安装验证。

补充（2026-10-28）：`npm run make` 三次尝试均失败——Squirrel.Windows 工具下载阶段 TLS 连接被重置（ECONNRESET），本网络访问 GitHub Releases 不稳定。`package` 产物已实机验证可用；Squirrel 构建记为环境限制，待网络恢复重试。

## 2026-10-28 冒烟扩展：EXIF 1—8 方向 + 辅助导出 + 原字节副本（协调者执行）

`tests/smoke.cjs` 扩展后全部通过（`npm run smoke`，退出码 0）：

- **EXIF 方向 1—8 端到端**：手工构造最小 EXIF APP1（sharp 0.35.5 的 withExif 无法写 Orientation——写回为 1，已记录）；每个方向经应用 compare 模式与 sharp 自动转正基准对照，**mae=0.000 / max=0（像素级一致）**，方向 5—8 规范化尺寸正确交换（60×30→30×60）。EXIF 夹具生成器在测试内，无第三方素材。
- **辅助导出真实跑通**：差异图 PNG（600×400，156,929 B）+ 参数 JSON（gain/background 与实际导出参数一致）；对照图 PNG（1224×464 并排+标注）。此前"辅助导出未实现"的 10-24 记录被代码与实机证据共同取代。
- **比较模式另存 = 原字节副本**：同一文件双导入后另存，SHA-256 与原文件逐位一致（"副本保留原元数据"语义验证）。
- 编码闭环、源文件保护、渲染进程事件等原有检查复跑通过。

仍未完成（不因本轮通过而豁免）：16 位/动画/HDR/损坏文件真实样本、取消与迟到竞态自动测试、会话重开+文件替换实机、alpha 显影/背景切换界面、大图瓦片与内存基准、DPI/小窗口、Squirrel 安装包与安装/卸载验收（第 4 次尝试进行中）、许可清单。GUI 人工交互验收需用户参与。

## 本次完成的用户流程（源码）

真实 JPEG/PNG/WebP 输入快照 → EXIF方向规范 → sRGB 8位RGBA → 编码 → 同一产物重新解码 → 全图差异 → 核验另存；已有图片模式；线性alpha背景合成；16位明确复选选择；动画/常见HDR标记拒绝；基本会话与重新关联；窄IPC和工作进程取消。源文件身份和原始路径禁止覆盖。界面有同步观察/分割/差异和撤销入口。

## 实际执行及结果

1. 沙箱 `npm install --no-audit --no-fund` 长时间无输出，未完成。
2. 升级沙箱后 `npm install --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` 未完成；达到阈值中止。
3. 使用 bundled sharp，以进程级 NODE_PATH 执行 `node --test tests/pipeline.test.cjs`。最近一次运行：7 项、6 通过、1 失败。第一次临时目录提交被沙箱 EPERM，改为本工程测试目录后保存成功。
4. 测试夹具由 tests/pipeline.test.cjs 本地生成渐变和彩色透明像素，可自由使用，无第三方素材。失败的夹具可能留在 tests/fixtures/；不是用户媒体。

## 已通过的有限证据

- C01 子集：同一规范像素颜色/alpha差异为零；隐藏透明RGB不造成可见差异；半透明线性合成真值。
- C03/C04 管线子集：三格式实际编码、重新解码、保存字节数与SHA-256一致，完整尺寸一致，源哈希不变；PNG规范像素差异零。
- C06 子集：尺寸不同不提供差异分数。

这些是核心管线测试，不能当作GUI或安装版C01—C07整项通过。

## 未通过或未执行

- 硬链接创建被沙箱EPERM阻止（第7条中的C05测试失败），原路径拒绝此前断言已执行。需要允许文件链接的Windows环境重新验收。
- npm依赖安装、锁文件、构建、TypeScript检查、Electron GUI、utilityProcess协议、打包与干净系统安装均未完成。未生成Windows产物。
- EXIF 1—8、有效/异常ICC、16位/动画/HDR真实样本、损坏文件、取消和旧任务竞态、会话恢复与文件替换、磁盘满/占用/覆盖确认、C07更大产物尚未实测。
- 主进程已修：等待保存对话框返回后再核验jobId/revision；mkdir后fork前再核验revision。仍需自动竞态测试和提交瞬间复核设计审查。
- 4000万像素为未基准的保护上限，非内存保证。当前整图RGBA/PNG显示，未实现分层瓦片、大图缓存及资源基准。
- 辅助对照图导出未实现；差异导出当前输出原始RGB差值，尚未输出用户增益/JSON说明。
- alpha独立数值已实现，独立alpha显影、背景切换界面未完成；透明JPEG已有合成结果预览，但未做导出前独立确认面板。
- 当前UI gain/view/zoom不触发编码；背景仍固定白色。渲染侧大图差异增益逐像素开销待优化。
- 完整HDR/gain-map判定、输入前内存估计、启动崩溃缓存回收登记、全部跨进程字段校验尚未完备。
- 依赖许可清单、源码许可证最终确认、第二解码器验证、100/150/200% DPI和小窗口尚未完成。

## 下一项具体任务

先完成本目录依赖安装与锁文件，修正任何实际构建错误，运行全部管线测试并在允许的Windows权限环境检查硬链接保护；再启动Electron核验真实导入/编码/另存和utilityProcess消息。其后按上述缺口继续，不宣布产品完成。

## 2026-10-28 「差异显影」崩溃：定位、修复、可复现验证

用户报告：导入图片后切到「差异显影」直接崩溃。本节记录的是**实际跑出来的**结果，不是推断。

### 复现

新增 `tests/diffview.cjs`，由主进程在 `MICROSCOPE_TEST=1` 且 `MICROSCOPE_TEST_SCRIPT` 指向它时加载。夹具 3000×2000（渐变 + 8px 棋盘 + 半透明右半），真实走 `drop → process → 结果事件`，然后通过 `executeJavaScript` 点击界面上的真实按钮「差异显影」。

第一次运行即复现：

```text
[renderer:3] Uncaught SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D':
             The canvas has been tainted by cross-origin data.
```

### 根因

差异与 alpha 金字塔在渲染时需要把瓦片画进离屏 canvas 再 `getImageData` 逐像素乘增益。瓦片走自定义协议 `microscope://`，而页面由 `loadFile` 载入（`file://` 源），两者跨源；`Image` 又没有设 `crossOrigin`，属于 no-cors 请求 → 响应被视为不透明 → canvas 被污染 → `getImageData` 抛异常。异常发生在 `requestAnimationFrame` 渲染回调里，每一帧都抛，界面表现为直接崩掉。

### 修复（三处，各司其职）

1. `src/renderer/Viewport.tsx`：`image.crossOrigin='anonymous'` —— **这是真正的修复**，把 no-cors 请求改成 CORS 请求，画布不再被污染。
2. `src/main/index.ts`：`microscope://` 响应补 `Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`、`Cache-Control: no-store` —— 防御性冗余（见下方反向对照，去掉它并不复现问题）。
3. `src/renderer/Viewport.tsx`：增益分支加 `try/catch` + `gainCache`（上限 120 项）—— 安全网。画布万一再次被污染，只退回原始瓦片，不让整帧渲染中断。**单独靠它不够**：异常被吞掉后增益会静默失效（见反向对照）。

### 验证：10 项断言 + 反向对照

断言不只看"进程没死"，还**读回画布像素**：若 CORS 仍有问题，代码会静默回退成原始瓦片，画布亮度就不会随增益变化，断言会失败。

| 断言 | 结果 |
|---|---|
| 渲染进程存活 | PASS 无 `render-process-gone` |
| 无未捕获异常 | PASS 无 `SecurityError`/`Uncaught` |
| 视图确为差异显影 | PASS `view=差异显影` |
| 画布可读回（未被跨源污染） | PASS `getImageData` 成功 |
| gain=1 有差异内容 | PASS 非零采样 36896/36960，max=544 |
| gain=32 比 gain=1 更亮 | PASS avg 23.751 → 398.054 |
| 增益确实乘上去 | PASS 比值 16.76×（×32 受 255 截断，非线性但同向） |
| Alpha 模式可渲染 | PASS avg=0.302 |
| Alpha 模式增益生效 | PASS avg 0.302 → 0.321 |
| 恢复默认后仍正常 | PASS avg=171.386 |

**反向对照 A —— 只去掉 CORS 响应头**：10 项全部照旧通过。说明 `Access-Control-Allow-Origin` 不是修复的关键，留着只是防御。

**反向对照 B —— 只去掉 `crossOrigin='anonymous'`**：7 项失败，且失败方式很说明问题：

```text
[diff] probe gain=1: {"err":"READ FAILED: ... The canvas has been tainted by cross-origin data."}
[diff] RESULT: SURVIVED BUT 7 CHECK(S) FAILED
```

进程**没崩**（`try/catch` 生效），但画布确实被污染、增益静默失效。这证明：`crossOrigin` 是根因修复，`try/catch` 是安全网，两者缺一不可 —— 只有安全网会得到"不崩但功能坏了"的假通过。

### 重新打包

`npm run make` 两次都在 `Copying files` 阶段 `read ECONNRESET`。开 `DEBUG=@electron/get*` 才看清不是网络抖动：

```text
@electron/get:index Cache hit
@electron/get:index Downloading .../SHASUMS256.txt ...
@electron/get:index Artifact in cache didn't match checksums RequestError: read ECONNRESET
@electron/get:index falling back to re-download
```

缓存命中后仍要下载 `SHASUMS256.txt` 校验；校验请求被重置，被当成"校验不匹配"，于是回退重下整个 158 MB zip —— 同样失败。新增 `scripts/make-offline.mjs`：用缓存里那份真实 zip 自算 SHA-256，起 127.0.0.1 镜像同时提供 zip 与 `SHASUMS256.txt`，让校验就地完成。打包随即通过。

### 顺带修掉的安装缺陷：快捷方式

复测时发现新装机器上**开始菜单项没生成**（只有桌面项）。逐层排查后有两个独立原因：

1. 原钩子 `spawn(Update.exe).unref()` 后立刻 `app.exit(0)`，`Update.exe` 没跑完就被带走 → 改成 `spawnSync(..., {timeout:20000})`，有界等待。
2. **从带 `ELECTRON_RUN_AS_NODE=1` 的终端启动 `Setup.exe`**，该变量被继承，安装时应用以纯 Node 启动，报 `bad option: --squirrel-install`、退出码 9，钩子根本不执行 —— 安装"成功"但没有任何快捷方式。双击安装不受影响。这是测试环境陷阱：凡在本机测试安装，务必先清掉这两个变量。

清除两个变量后重跑完整卸载 → 安装：开始菜单项 2,540 字节、桌面项 2,526 字节均自动生成，无需人工干预。

### 交付物

```text
交付物/压缩损失显微镜-0.1.0-Setup.exe
  163,695,104 字节  SHA-256 4178e4a296463a81c8339a618ec7cf244762abaa9dde4c422375740297c331bf
```

打包产物内已核对三处修复均在位：渲染包 `index-D1-mG8Hk.js` 含 4 处 `crossOrigin`，主进程包含 `Access-Control-Allow-Origin` 与 `spawnSync` 各 1 处。

### 本轮仍未解决

- **卸载不删快捷方式**：`--removeShortcut` 在 Squirrel 卸载序列里未生效，开始菜单与桌面 lnk 都残留；需改为按安装目录反查 lnk 目标后自行删除。未修。
- 卸载残留 `.dead`、`Update.exe`、`app-0.1.0\squirrel.exe`、`v8_context_snapshot.bin` 未清。
- 显示名仍是英文 `CompressionMicroscope`；快捷方式仍在 `Personal instruments` 子文件夹。
- 差异显影只在 3000×2000 / 单图编码路径上验证；大图内存、16 位、HDR 拒绝路径未覆盖。
- **用户本人尚未在安装版上确认**「差异显影」不再崩溃 —— 代码路径已由自动断言证明，但最终确认需用户点击。

## 2026-10-28 新增：体积上限（回答"在哪里设置最终大小"）

用户问在哪里设置压缩后的最终大小。查证结论：**原版本没有这个能力**，只有质量驱动（质量、格式、色度采样、压缩级别），结果体积在左侧「实际体积」里被动显示。用户确认要「体积上限」语义后新增。

### 语义

给定字节上限，在 1—100 质量里取**不超过上限的最高质量**。不是"精确命中"，也不是"按比例"。

### 实现

- `src/contracts/model.ts`：`Spec` 增加 `sizeCap`（字节，0 = 不限）。旧会话文件没有该字段，按 0 处理而不是判为无效，否则历史会话会打不开。
- `src/workers/image.cjs`：编码阶段抽出 `encodeAt(quality)` 构造器，**搜索与最终产物共用同一个构造器**——这是关键，保证"搜索时量到的字节数"就是"产物的真实字节数"，不会出现搜到 300 KiB、实际写出 310 KiB。
  - 二分 1—100，约 7 次真编码；命中后再实编一次作为产物，并额外编码 `quality+1` 复核它确实越界（`monotonic` 标记），**不假设质量与体积严格单调**。
  - 上限连质量 1 都放不下时，`satisfied=false` 并退回质量 1，如实报"无法达成"，不伪造达标。
  - PNG 与 WebP 无损：`ignored=true` 并给出原因——无损格式没有可调画质，压缩级别只能小幅改变体积。
- `src/renderer/main.tsx`：右侧「编码设置」新增「体积上限 KiB」输入框（留空=不限），仅在有损格式下出现。反馈三态：已达上限（含质量、实际体积、真编码次数）、无法达成（含质量 1 时的最小体积）、上限未生效（含原因）。
- `src/main/index.ts`：保存对话框在已设上限时带上限值与采用质量；未达成时明确写出"无法达成"。

### 验证

单元测试 `tests/sizecap.test.cjs`（8 项）：无上限不搜索、上限命中、搜索字节数==产物字节数、`quality+1` 确实越界、过小上限如实报失败、PNG/WebP 无损明确忽略、同上限两次结果确定性一致、搜索不改源文件。

界面测试 `tests/sizecap-ui.cjs`（10 项，走真实导入与真实按钮）：

```text
初始       质量 80 → 559.39 KiB
设 307 KiB → 已达上限 · 质量 49 · 实际 306.30 KiB · 真编码 9 次
设 1 KiB   → 上限无法达成 · 质量 1 时最小 28.31 KiB
清空       → 559.39 KiB，反馈消失
```

回归：`npm test` 15/15；`check:diff` 10/10；`smoke` 产物 8,983 字节与改动前一致（默认不限体积时行为未变）。

### 未做 / 边界

- 只调质量。不会自动换格式、改色度采样或缩小像素尺寸；上限过小时只能报告无法达成，不提供降采样兜底。
- 每次搜索约 9 次真编码，大图上会明显变慢；未做粗估预筛。
- 未在 16 位 / HDR 拒绝路径上验证。
- 质量与体积非严格单调时，结果可能不是理论最高质量；界面会显示提示而不是隐瞒。

## 2026-10-28 滚轮缩放改为跟随光标

用户要求：放大时默认从鼠标所在位置放大（原来是以画布中心为锚点）。

### 实现

`src/renderer/Viewport.tsx` 新增 `wheel` 处理器替换原来的 `setZoom(z*factor)`。

推导依据：图像像素 `ix` 在画布上的设备像素位置是 `originX + ix*zoom`，而
`originX = area/2 − W*zoom/2 + pan.x*dpr`。要求缩放前后 `ix` 不变，即可解出新的 `pan`：

```text
ix    = (cx − originX0) / z0
pan1  = (cx − ix*z1 − area/2 + W*z1/2) / dpr
```

y 方向同理。要点：

- 并排模式下 `area` 只有画布宽度的一半，光标落在哪一侧都要先按面板宽度取模，否则右面板会算错。
- `dpr` 参与换算：`pan` 以 CSS 像素存，`origin` 以设备像素算，两者必须统一。
- 结果未就绪时退化为普通缩放，不抛错。

### 验证

`tests/zoomcursor.cjs`（10 项，走真实界面导入，用页脚自带的 `x / y px` 读数判断锚点是否不动）。

实测（画布 911×456 CSS px，dpr=1.25，锚点取面板 62% 处）：

| 场景 | 结果 |
|---|---|
| 100% → 125% | 锚点偏移 0 / 0 px |
| 再缩回 100% | 回到原读数，偏移 0 / 0 px |
| 面板正中缩放 | 0 / 0 px |
| 连续 6 次放大到 381.5% | 0 / 0 px |

**反向对照**：把滚轮临时改回中心锚点，同一测试得到单次偏移 13 / 12 px、连续 6 次累积到 50 / 43 px，测试报 FAIL。说明断言确实能区分两种行为，不是恒真。

回归：`npm test` 15/15、`check:diff` 10/10、`check:sizecap` 10/10、`smoke` 全部通过。

### 踩到的测试坑（值得记住）

合成事件的 `clientX` 在 `WheelEvent` 与 `PointerEvent` 之间取整行为不一致（实测一个截断、一个进位）。若两个事件传同一个浮点坐标，会落到相邻整数上，锚点就不是同一个点，测出来是假漂移。测试里一律用整数 client 坐标。

另外就绪判断必须等真实结果出现：结果未到时 `result` 为空，指针读数会少掉图宽/2 的偏移，量到的"漂移"其实是测量时机问题。

### 边界

- 左侧「缩放」下拉框仍按中心缩放（那里没有光标位置可言）。
- 未做 pan 边界钳制，缩到很小时可以把图拖出视野，靠「重置位置 / 100%」恢复。

## 2026-10-28 改名「图片压缩显微镜」+ 开源仓库整理

### 改名范围

产品名由「压缩损失显微镜」改为「图片压缩显微镜」。**只改面向人的名字，不改可执行文件名**：

| 位置 | 值 |
|---|---|
| `package.json` `productName` | `图片压缩显微镜` |
| 窗口标题 / `index.html` `<title>` / `<h1>` | `图片压缩显微镜` |
| 注册表 `DisplayName` | `图片压缩显微镜` |
| 快捷方式文件名 | `图片压缩显微镜.lnk` |
| `packagerConfig.name` / `executableName` | `ImageCompressionMicroscope`（ASCII） |
| 安装目录 | `%LOCALAPPDATA%\ImageCompressionMicroscope` |
| 安装包文件名 | `ImageCompressionMicroscope-<版本> Setup.exe` |

可执行文件保持 ASCII，是为了让 `rcedit`、Squirrel 的 nupkg 命名和命令行调用都不必碰中文路径。

### 踩到的坑：`maker-squirrel` 会把中文产品名覆盖掉

只设 `productName` 时，安装后的显示名仍然是 `ImageCompressionMicroscope`。原因是 `electron-winstaller` 里 nuspec 的取值顺序：

```js
title: appMetadata.productName || appMetadata.name,
```

而 `@electron-forge/maker-squirrel` 会显式传入 `title: appName`（即 `packagerConfig.name`），随后 `Object.assign(metadata, options)` 把它盖回去。**必须在 maker 配置里显式写 `title`**：

```json
["@electron-forge/maker-squirrel", {
  "name": "ImageCompressionMicroscope",
  "setupIcon": "resources/icon.ico",
  "title": "图片压缩显微镜"
}]
```

### 快捷方式改由钩子自己写

原来依赖 `Update.exe --createShortcut`，它建出来的是英文名，且在 `Personal instruments` 子文件夹里。现在 Squirrel 钩子里直接用 `shell.writeShortcutLink` 写两份 LNK（开始菜单 + 桌面），文件名用中文产品名；卸载事件走 `unlinkSync` 删除，并顺手清理旧的英文 LNK。

`--squirrel-*` 事件处理完立刻 `app.exit(0)`，不启动窗口。

### 实测

| 项 | 结果 |
|---|---|
| 卸载旧版 `CompressionMicroscope` | 目录、注册表项、快捷方式全部清掉 |
| 安装新版 | 退出码 0，目录 `%LOCALAPPDATA%\ImageCompressionMicroscope` |
| 注册表 `DisplayName` | 码位 `22270,29255,21387,32553,26174,24494,38236` = 图片压缩显微镜 |
| 开始菜单 LNK | `图片压缩显微镜.lnk` 存在 |
| 桌面 LNK | `图片压缩显微镜.lnk` 存在 |
| 从开始菜单快捷方式启动 | 窗口标题码位同上，窗口存活 |

安装/卸载必须清掉环境里的 `ELECTRON_RUN_AS_NODE`（见上文），否则钩子不会执行、快捷方式不会生成。

### 仓库整理

- `git init -b main`，单一初始提交；`README.md`、`LICENSE`（MIT）、`.gitignore`、`.gitattributes` 齐全。
- 不入库：`node_modules/`、`out/`、`dist/`、测试夹具、`*.exe`/`*.nupkg`/`RELEASES`。
- **也不入库**：`docs/make-attempt*.log`、`docs/pipeline-test-output.txt`。这三份是排障时的原始输出，含本机绝对路径与用户名，对读者没有价值，留在本机即可；文档正文已改为描述结论而非指向文件。
- 源码包用 `git archive` 导出（不带 `.git`），安装包因 163 MB 超出 GitHub 单文件上限，只能作为 Release 附件。

## 2026-10-28 版本号 0.1.0 → 1.0.0

按使用者要求把版本提升到 `1.0.0`（semver 不接受 `1.0` 两段写法，故补全为 `1.0.0`），并重新打包、重测安装。

改动只有三处，都是版本载体：

| 文件 | 改动 |
|---|---|
| `package.json` | `version` → `1.0.0` |
| `package-lock.json` | 根 `version` 与 `packages[""].version` → `1.0.0`（由 `npm version --no-git-tag-version` 生成，未手改） |
| `README.md` | 安装一节的文件名 → `图片压缩显微镜-1.0.0-Setup.exe` |

代码零改动。产物名由版本号派生，因此自动变成 `ImageCompressionMicroscope-1.0.0 Setup.exe`、`...-1.0.0-full.nupkg`、`...-win32-x64-1.0.0.zip`。

### 实测

| 项 | 结果 |
|---|---|
| 安装包内嵌版本资源 | `FileVersion 1.0.0`、`ProductVersion 1.0.0` |
| 卸载 0.1.0 | `Update.exe --uninstall` 退出码 0，注册表项清除 |
| **卸载是否删快捷方式** | ✅ 开始菜单与桌面 `图片压缩显微镜.lnk` **均被删除**，旧 `Personal instruments` 子文件夹也已清掉 |
| 安装 1.0.0 | `Setup.exe --silent` 退出码 0，目录 `app-1.0.0\` 出现 |
| 注册表 | `DisplayName 图片压缩显微镜`、`DisplayVersion 1.0.0`、`InstallLocation %LOCALAPPDATA%\ImageCompressionMicroscope` |
| 从开始菜单快捷方式启动 | 窗口标题「图片压缩显微镜」，码位 `22270,29255,21387,32553,26174,24494,38236`，完全一致；关闭后进程退出 |

**顺带修掉一条历史欠账**：之前一直记为「未验证」的卸载删快捷方式路径，这次实测通过——钩子里的 `unlinkSync` 分支是有效的，不需要再依赖 `Update.exe --removeShortcut`。

卸载残留比早先记录的少一项：现在只剩 `.dead`（空目录）、`Update.exe`、`app-1.0.0\squirrel.exe`，`v8_context_snapshot.bin` 已不在。

### 安装包

```text
ImageCompressionMicroscope-1.0.0 Setup.exe
  163,699,200 字节  SHA-256 975c9193e20537ae86850f7a95e1e5f73a4f7d50e17c9e7191e59cb792f9d7ec
```

体积与 0.1.0 完全相同（163,699,200 字节）不是巧合：版本串 `0.1.0` 与 `1.0.0` 等长，Squirrel 的填充式写入后长度不变；但 SHA-256 不同，两者是不同文件。

## 2026-10-28 版权与作者统一为 Over9rowth

`LICENSE` 版权行与 `package.json` 的 `author` 由 `Personal instruments` 改为 `Over9rowth`。

### 为什么改这两处就必须重新打包

`author` 不只是仓库里的一行文字，它往下游渗透到三个用户可见的位置：

| 落点 | 取值链 |
|---|---|
| nuspec `<authors>` → 注册表 `Publisher` | `electron-winstaller` 里 `metadata.authors = metadata.author` |
| nuspec `<copyright>` | `"Copyright © " + 年份 + " " + metadata.authors` |
| exe 的 `CompanyName` | `electron-packager` 取 `package.json` 的 `author` |

所以只改仓库文本、不重打包，装出来的程序在「控制面板 → 应用」里仍然写着旧名字，属于改了半截。

### 实测

| 项 | 结果 |
|---|---|
| exe `CompanyName` | `Over9rowth` |
| exe `LegalCopyright` | `Copyright © 2026 Over9rowth` |
| 注册表 `Publisher` | `Over9rowth` |
| 注册表 `DisplayName` / `DisplayVersion` | `图片压缩显微镜` / `1.0.0` |
| 安装 / 启动 | 退出码 0，两个快捷方式生成，窗口标题码位一致 |

新安装包 163,699,712 字节（比上一版多 12 字节，作者串变短导致压缩后长度略变），SHA-256 `cdc0a16191b9feaf335f452f06ab0cba38e581b8736ef97f247ec834add15c09`。

### 故意没改的

`packagerConfig.appBundleId` 仍是 `local.instruments.compression`。它是应用标识而不是署名，改了会让 Electron 的 `userData` 目录跟着变，已有会话与设置会「消失」。要改就单独做一次迁移。

`src/main/index.ts` 里清理旧快捷方式时用的 `'Personal instruments'` 字符串也保留——那是历史遗留目录名，不是署名。

## 2026-10-28 Release 附件名必须用 ASCII

第一次发布 `v1.0.0` 时上传的附件是 `图片压缩显微镜-1.0.0-Setup.exe`，GitHub 把它存成了 **`-1.0.0-Setup.exe`**——附件名里的非 ASCII 字符被整段剥掉，只剩连字符和后面的部分。文件本身没坏，大小 163,699,712 字节与本地完全一致，只是名字残缺，和 README 里写的名字对不上。

GitHub 的 Release 附件名只接受 ASCII。仓库名、Release 标题、正文都可以随便用中文，**只有附件名不行**。

因此安装包统一改为 `ImageCompressionMicroscope-1.0.0-Setup.exe`，与构建产物同名；README 的安装一节同步。源码 zip 不上传，保留中文名。

## 2026-10-28 修正：exe 版本信息仍写着 GitHub Inc.（v1.0.1）

**问题**：v1.0.0 的 `ImageCompressionMicroscope.exe` 属性里
`LegalCopyright` 是 `Copyright (C) 2015 GitHub, Inc.`，`CompanyName` 是 `GitHub, Inc.`，
`FileVersion` 为空。原因是 `packagerConfig` 只给了 `name`/`executableName`/`icon`，
没有 `appCopyright`、`appVersion`、`win32metadata`——Electron 自带的默认值就留在 exe 里了。

另外两个项目（日光落点预报、反光检查镜）当时已经补齐，所以只有这一个漏了。

**改法**：

```json
"appCopyright": "Copyright (c) 2026 Over9rowth",
"appVersion": "1.0.1",
"win32metadata": {
  "CompanyName": "Over9rowth",
  "FileDescription": "图片压缩显微镜",
  "ProductName": "图片压缩显微镜",
  "LegalCopyright": "Copyright (c) 2026 Over9rowth",
  "InternalName": "ImageCompressionMicroscope",
  "OriginalFilename": "ImageCompressionMicroscope.exe"
}
```

**验证**（读安装后 exe 的 `VersionInfo`，不是看文件名）：

```
CompanyName     : Over9rowth
FileDescription : 图片压缩显微镜
ProductName     : 图片压缩显微镜
LegalCopyright  : Copyright (c) 2026 Over9rowth
FileVersion     : 1.0.1
ProductVersion  : 1.0.1
OriginalFilename: ImageCompressionMicroscope.exe
```

`npm test` 15/15 通过，`tsc --noEmit` 通过，安装后启动正常（标题「图片压缩显微镜」，
界面完整渲染，截图 `outputs/ui/launch-1.0.1.png`）。

**本轮只改了 package.json 元数据，没有动任何功能代码。**
版本号升到 1.0.1，因为 1.0.0 已经发布过——同一个版本号对应两份不同二进制会造成混乱。
如果 GitHub Release 上挂着 v1.0.0，需要决定是替换资产还是另发 v1.0.1。

交付：`交付物/ImageCompressionMicroscope-1.0.1-Setup.exe`，
SHA-256 `c428585d6f1f55424729c8ec31d2c2a19c1b102c96ee5264e1c9ae54bd7416be`。

## 2026-10-28 发布：撤下 v1.0.0，改发 v1.0.1

**决定**：不是替换 v1.0.0 的附件，而是撤掉整个 v1.0.0（release + tag），另发 v1.0.1。

理由：v1.0.0 那个包里 exe 的属性页写着 `GitHub, Inc.`，是个有瑕疵的二进制；
若把新包挂在 v1.0.0 名下，同一个版本号会对应两份不同文件，比撤下更糟。
撤下的成本为零——`v1.0.0` 附件的 `download_count` 是 **0**，没有人的校验记录会因此失效。
提交历史里 `c2a92d9`（1.0.0 的打包提交）仍在，需要时可以从那个 commit 重新构建。

**过程里的一个坑：本机连不上 `github.com`。**

```text
$ git push origin HEAD:main
fatal: unable to access 'https://github.com/Over9rowth/image-compression-microscope.git/':
       CONNECT tunnel failed, response 502
```

本地代理对 `github.com:443` 一律返回 502，直连也不通；但 `api.github.com` 与
`uploads.github.com` 都正常。所以 git 传输层走不了，改用 REST 的 Git Data API：

1. `POST /git/blobs` 建两个 blob —— 注意**必须从 `git cat-file blob HEAD:<path>` 取字节**，
   不能读工作区文件：工作区 `package.json` 是 CRLF（2605 字节），仓库里存的是 LF（2524 字节），
   读错源会让 tree 哈希对不上。
2. `POST /git/trees`（带 `base_tree`）→ `POST /git/commits` → `PATCH /git/refs/heads/main`。

author / committer / 时间戳都按本地提交原样填（`date` 要用 ISO 8601，直接写
`1793190775 +0800` 会被 422 拒掉）。这样建出来的提交 SHA 与本地 `1c19ccd` **逐位相同**，
本地与远端没有产生分叉，下次网络正常时 `git push` 是空操作。

**发布结果**（以下均为 API 返回，不是本地推算）：

| 项 | 值 |
| --- | --- |
| tag | `v1.0.1` → 指向本文档所在的那个提交 |
| release | <https://github.com/Over9rowth/image-compression-microscope/releases/tag/v1.0.1> |
| 附件 1 | `ImageCompressionMicroscope-1.0.1-Setup.exe`，163,699,712 字节 |
| 附件 2 | `ImageCompressionMicroscope-1.0.1-Source.zip`，约 160 KB |

两个附件的确切字节数与 SHA-256 写在 Release 正文里，不在这里重复——源码 zip 每跟着
文档改一次内容，字节数就会变，写死在文档里必然对不上。

源码 zip 这次一并上传了（v1.0.0 当时只传了 exe）。文件名用 ASCII，理由同上次：
GitHub 会剥掉附件名里的非 ASCII 字符。zip 由 `git archive HEAD` 生成，
只含 48 个受版本控制的文件，不含 `node_modules`、`out`、`outputs` 与本机日志。

**回读校验**（不是只信上传返回）：

- 源码 zip 全量下载回来，SHA-256 与本地文件一致，48 个条目可正常打开。
- 安装包 163 MB，当前链路下载约 37 KB/s，全量下载不现实，改用 `Range` 抽查：
  首 1 MiB 与末尾 513 KiB 与本地文件逐字节相同。
- GitHub 为两个附件算出的 `digest` 字段与本地 `sha256sum` 结果相同。

**未验证**：撤下 v1.0.0 后 `https://github.com/.../releases/tag/v1.0.0` 这个 HTML 页面的
返回码没有实测——本机到 `github.com` 不通。能确认的是 API 侧
`/releases/tags/v1.0.0` 与 `/git/ref/tags/v1.0.0` 都已 404。
