# Electron 实战手册

> **Status: Current（2026-11-11 核对；以代码与测试为准）**


> 改 `main/index.ts`、窗口创建、preload、webview、打包配置、原生模块或跨平台路径前读本文。每条都是踩坑结论。

## 启动与生命周期

- `commandLine.appendSwitch` / `app.setPath` / 单实例判断必须在 `app.whenReady()` 前。
- **userData 三分支**（`portableUserData.resolveAppUserDataDir`，有单测；不要按旧文档「dev 加 -dev 后缀」理解；完整路径与迁移细节见 `docs/maintenance-domains.md` §应用命名与历史数据目录迁移）：
  - 未打包 `npm run dev`：按 git 分支隔离到 `PiDeck-dev[-branch]`，避免多 worktree 共用 catalog / 单实例锁 / DSH home。
  - 打包态（stable 与 dev 通道安装包）：**共用** `%APPDATA%/PiDeck`——用户在两个通道间切换不丢 settings / 会话 / 扩展配置，这是刻意决策。
  - 便携 exe：落 `PORTABLE_EXECUTABLE_DIR/data`，与安装版隔离。
- 启动前还有一次性目录改名迁移（历史 `pi-desktop` → `PiDeck`，含 pi 会话 encoded 目录）；失败自动回退旧目录、下次重试。
- 关键节点（窗口创建、load、preload、pi 启动）必须写 `appLogger`；冷启动有里程碑计时（`bootAnchorMs`），改动启动链后看日志对比回归。
- 单实例用自研按版本互斥 `acquireVersionSingleInstance`（见 `instanceLockFile.ts`），**不用** `requestSingleInstanceLock`（原生锁会阻止不同版本并行）；第二实例 `app.exit(0)`。dev 与 stable 使用不同 AUMID，避免通知归属混淆。
- **关掉单实例（多开）时锁仍存在**：它不再互斥，只当「深链激活的路由目标」——点系统通知/资源管理器右键是 Windows 按 `pideck://` 唤起**新进程**，若那次启动再开一扇窗就是「点一下通知多出一个 PiDeck」（2026-10 用户反馈）。规则：多开下普通启动照常开窗并把锁过户给自己（`rebindVersionLock`），深链激活先握手交给已运行实例、确认后自己退出；旧窗口按锁 pid 让位，持有者退出后剩下的窗口自动接回路由权（watcher 里 `claimVersionLock` 只回收可证死的锁）。
- 窗口隐藏时先 `maximize()` 再加载，避免布局跳变；`zoomFactor` 在 `did-finish-load` 后应用。
- quit 路径覆盖 pi 子进程、node-pty、watcher、锁文件；新增常驻资源必须同步登记 `QuitCleanupRegistry`（`registerQuitCleanup`）。
- **Windows 没有 SIGTERM**：停 pi 先关 stdin 走 RPC 约定的有序退出（宽限 `WINDOWS_PI_GRACEFUL_EXIT_MS`，要短于删会话的 3s 等待），超时才 `taskkill /T /F`；启动后按当前 MCP/ACP 配置回收「父进程已消失」的孤儿 node/cmd（`src/main/process/orphanSweep.ts`，issue #450）。活的进程（父进程还在）一律不碰。
- **Linux 托管孤儿回收只认本版本标记**（issue #534）：PiDeck 启动的本地 pi/ACP 通过 `PIDECK_PROCESS_OWNER` 继承实例作用域、PID、`/proc/<pid>/stat` 启动 ticks 和 boot ID。启动扫描仅处理同 uid、同 userData 作用域、同 boot，且 owner 已退出或 PID 已复用的记录；发信号前重读并核对目标身份。坏标记、权限不足、读取不全及超过上限都跳过，不读命令行、不记录环境内容。0.12 及更早启动的无标记孤儿不回收；Linux 实机的权限与进程生命周期仍需安装版验收。实现与假 `/proc` 回归见 `src/main/process/linuxOrphanSweep.ts`、`tests/linuxOrphanSweep.test.mjs`。

## 窗口与 webview

- 主窗口基线：`contextIsolation: true` + `nodeIntegration: false` + `webviewTag: true`（仅主窗口）。其它窗口（浮动窗、选择浮窗、插件视图）必须 `webviewTag: false`，新增窗口逐项评估，禁止默认全开。
- Chromium 沙箱默认关闭是刻意的（Windows 安全软件/旧驱动在沙箱初始化触发 `0x80000003`）；关闭时显式 `appendSwitch("no-sandbox")`。开关改动需整应用重启。
- `setWindowOpenHandler` 主窗口与 webview guest 都要注册：走 `openExternalUrl` 并 deny；浮动窗/插件视图/选择浮窗一律 `deny`。
- webview 安全（`configureBrowserPanelWebviewHost`，只在主窗口注册一次）：专属 `partition` 强制 `sandbox: true` / `nodeIntegration: false` / `webSecurity: true`；删除外部传入的 `preload` / `allowpopups`；`did-attach-webview` 校验 partition，不符立即 close。
- 导航白名单三层都要过：`will-frame-navigate` / `will-redirect` / `setWindowOpenHandler`（只拦一层会被重定向绕过）。内置浏览器的常规导航只允许 HTTP(S) 和空白页（`src/main/browser/browserSecurity.ts`）。宿主可在主框架打开单文件 HTML 快照（`pideck-html://browser/`）。文件经过原有读取边界后，以令牌索引的快照保存在主进程内存中，单份上限 16 MiB。浏览器 partition 的独立 handler 使用 CSP sandbox 隔离。
- 自定义标题栏改动要验证三平台控制按钮、拖拽区、双击最大化。
- 窗口**呈现态**（normal / maximized / fullscreen）由 `src/main/index.ts` 的 `mainWindowVisualIntent` 跟踪（`trackMainWindowVisualIntent` 监听 maximize / unmaximize / enter-full-screen / leave-full-screen）。所有唤回路径（托盘双击、`app.activate`、桌面宠物、通知/协议深链唤起）一律走 `revealMainWindow`，禁止直接 `show() + focus()`：Windows 上「最小化 → show()」不会恢复最大化，窗口会停在伪全屏几何，下次还原就掉回正常尺寸。恢复策略集中在纯模块 `src/main/windowReveal.ts`（`planMainWindowReveal` 纯函数，`tests/windowRevealState.test.mjs` 固定矩阵）：全屏意图先 `maximize()` 再 `setFullScreen(true)`，退出全屏才能回到最大化。
- **透明/无边框窗口的 bounds 会被系统放大**（Windows 实测：悬浮球窗口 `224×104` 被放大到 `690×632`）：窗口内可视内容的锚点随窗口尺寸漂移（拖动后自动跑、静止也偏移），放大后的透明区域还会拦截下层页面点击（透明像素同样命中）。规则：高频移动一律走 `moveWindowWithSize`（`src/main/windowGeometry.ts`，强制带设计尺寸），尺寸用 `WindowSizeGuard` 定期拉回（悬浮球 1s、桌宠 5s；窗口销毁自动停表）；新增透明/无边框窗口必须登记守卫。窗口尺寸要贴合可见内容——删掉气泡/标题等 UI 后同步收紧窗口，别留大片透明命中区。
- `last-window-bounds.json` 同时记 `maximized` 与 `fullscreen`，启动时全屏优先于最大化（以前只记最大化，关窗即退出的机器重启后就会丢全屏）。新增窗口状态字段时同步 `src/main/windowState.ts` 的读写与 `quickTaskWindowChrome.saveWorkbenchBoundsOnClose`。

## Linux 托盘（StatusNotifierItem）

- **Electron 43.3.0–43.4.1 的托盘在 GNOME / xapp 宿主上必丢（issue #521）**：Chromium `StatusIconLinuxDbus::Multiplexer` 用一块共享的 `/StatusNotifierItem` 按 **destination（well-known 名）** 查图标，而 GDBus 宿主（`gnome-shell-extension-appindicator`、`xapp-sn-watcher`）先 `GetNameOwner` 再问 unique name（`:1.N`），查不到即返回 `org.freedesktop.DBus.Error.Failed: error occurred in Get/GetAll`，宿主随即丢弃该图标。Electron 43.5.0（[electron#53215](https://github.com/electron/electron/pull/53215)）恢复 per-icon 导出后两种地址都能读。**升级 Electron 时不要停在 43.4.x。**
- 判定方法（不依赖桌面环境）：起一个 `org.kde.StatusNotifierWatcher` stub → 应用创建 `Tray` → 对 `/StatusNotifierItem` 的 `Properties.GetAll` 分别用 well-known 名与 `GetNameOwner` 解析出的 unique name 各调一次。两者都成功才算正常；只有 well-known 成功即是上述回归（43.4.0 实测复现，43.8.7 实测通过）。
- 托盘注册验收（`startTrayRegistrationVerify`，启动 6s 后查一次 watcher 的 `RegisteredStatusNotifierItems`）只记日志、不重建 Tray —— 换名重建实测无效，宿主的读法不变。

## E2E 测试窗口（不打扰模式）

- `PIDECK_E2E=1` 时主窗口默认摆到屏幕外（`src/main/e2eWindowMode.ts`）：`setPosition(-32000,-32000)` + `setSkipTaskbar(true)` + `showInactive`。
- 同时关闭后台节流：`backgroundThrottling: false` + `disable-background-timer-throttling` / `disable-renderer-backgrounding` / `disable-backgrounding-occluded-windows` + `disable-features=CalculateNativeWinOcclusion`。否则 Windows 遮挡判定会把屏幕外窗口当不可见，Playwright 点击/截图随机卡死。
- **跑 e2e 不得把窗口弹到用户桌面最前或抢焦点**：新增窗口/fixture 必须沿用同一开关，禁止 `show()` / `focus()` / `maximize()` 抢前台。
- 需要真实窗口位置/几何的用例（如 `window-memory`、`quick-task`）必须 `test.use({ e2eWindowMode: "visible" })`（fixture 下发 `PIDECK_E2E_WINDOW_MODE=visible`）；调试时同样设该环境变量。
- 摆放失败必须静默回退，不阻断 e2e。守卫：`tests/e2eWindowMode.test.mjs` + `e2e/window-background.spec.ts`。

## 本机文件编辑与透明加密环境

- 打开或外部同步内容不算用户编辑，不能触发 dirty 或自动保存。`CodeMirrorEditor` 对外部同步事务加标记，`FileDiffViewer` 仅在载入时确定换行形式，保留 CRLF 与保存后的撤销历史；重载开始取消旧防抖、读取失败禁止保存旧缓冲。
- 文本读写共用 `src/main/files/textFileRead.ts` / `textFileWrite.ts`：非法 UTF-8 或非文本内容拒绝编辑/覆盖；异常大小与访问错误给专项提示。非 UTF-8 也可能是合法的其它编码，不能据此认定为密文。
- 保存使用同目录随机、排他创建的临时文件再 rename；写入、权限恢复或替换失败时不回退原位截断写。编辑器合并重叠保存并追上最新内容，安装前置任务也等最新内容落盘；主进程按目标排队，链接解析后替换真实文件，不能静默替换 symlink 目录项。失败保留未保存内容与 dirty；新建文件使用 `wx`，不清空同名文件。不在 userData 等目录额外备份明文。
- 加密客户端错误码（如 `[49-0]`）本身不能证明 PiDeck 已损坏文件。真实兼容性需在受管目录的测试副本上由管理员核对驱动日志和访问权限；不能靠绕过策略或关闭安全软件修复。
- 回归：`node --test tests/textFileReadGuard.test.mjs tests/textFileWriteGuard.test.mjs tests/fileEditorSaveSafety.test.mjs tests/fileLoadErrorMessage.test.mjs tests/filesListTarget.test.mjs`。这些验证应用行为与注入的文件系统失败，不代替真实加密驱动验收。

## IPC 与 preload

- preload 不做业务，只做校验后的转发与订阅封装；通道名一律引用 `ipcChannels` 常量，不写字面量。
- 事件推送 preload 侧返回 unsubscribe 函数；渲染层卸载必须退订。

## 原生模块与打包

- **打包默认图标为白底 pi-tui，三色主体占底板宽高的 65%**：修改 `build/icon-pi-tui.svg` 后运行 `npm run make-icon`，同步生成 `icon.ico` / `icon.icns` / `icons/*.png` 与运行时 PNG。Windows ICO、`icon-pi-tui-windows.png` 和 `icon-classic-windows.png` 不加外层留白；macOS/Linux 的 PNG 与 ICNS 保留每边 6.25% 边距。`appWindowLogo.ts` 按平台选图，避免运行后任务栏又缩小。安装器和 exe 图标在构建时固定；「Logo 风格 / 自定义 Logo」只改变运行时图标与应用内品牌位。验证：`node --test tests/iconPiTui.test.mjs tests/appWindowLogo.test.mjs tests/macIcon.test.mjs`。
- **应用内品牌位与系统图标同规格**：经典标为白底深灰主体，三色标保留品牌原色；主体均占底板宽高的 65%。启动页的内联 SVG/CSS 与 `LogoMark` 对齐，关于、新建/空态和设置预览共用白底图标。桌面与 Web 标题栏使用 `LogoMark variant="inline"`：18px 透明底主体，不加底板、阴影或描边，经典标随明暗主题切换黑白以保持对比。经典动画在白底容器内固定用深灰色，避免暗色主题下反白失去对比；用户自定义图片不叠底板、不改变主体占比。覆盖见 `tests/brandLogoSurfaces.test.mjs`、`tests/appearanceLogoPreview.test.mjs`、`tests/piTuiLogo.test.mjs`。
- node-pty 等原生模块必须 `asarUnpack` 并 postinstall 修权限（`scripts/fix-pty-permissions.js`）；afterPack 删 node_modules 冗余文件必须有对应测试（`tests/afterPackCleanup.test.mjs`）。
- 资源路径用 `process.resourcesPath` / `app.getAppPath()` 推导，禁止裸 `__dirname` 假设 asar 可读；preload 路径走 `preloadPath.ts`。
- **原生模块禁止顶层静态 import**：JS 包装可能在模块求值时同步加载对应平台二进制（koffi 即如此），跨 arch 打包时可选依赖（`@koromix/koffi-*`）不会自动跟随，缺二进制环境启动即崩（issue #313）。必须经专属模块函数内 `createRequire` 惰性加载 + try/catch 降级；守卫 `tests/cua/cuaKoffiFallback.test.mjs`，同约束见 `nodePtyRuntime.ts`。
- 安装器完成页的「运行 PiDeck」必须直接启动 `$INSTDIR\${APP_EXECUTABLE_FILENAME}`（`build/installer.nsh` 的 `customFinishPage`）。electron-builder 默认用 `$launchLink`，它优先取开始菜单 `PiDeck.lnk`，那条 .lnk 可能指向另一份同名同版本 PiDeck（解包构建/旧安装目录），装完点运行会跑错程序且版本号看着是对的。守卫 `tests/nsisFinishPageLaunch.test.mjs`。

## 跨平台

- 禁止硬编码 `/` 或 `\`；平台特判集中在专属模块（如 `linuxDisplayBackend.ts`）。
- Windows「偶发失败」优先怀疑路径空格、杀毒锁文件、长路径、权限弹窗；日志带足上下文。
- **WSL 项目的 git 一律走发行版内 git**：cwd 是 `\\wsl.localhost\...` UNC 时经 `wsl.exe -d <distro> … git` 执行（`src/main/git/gitWsl.ts`）。理由：宿主 git.exe 经 9P 会被判 dubious ownership，两套索引视角不一致会让仓库反复「整树改动」。
- **git 子进程只有两个入口**：`execGit`（读类）与 `runGitCommand`（写类），都在 `src/main/git/gitRun.ts` 收口；新增 git 调用不得绕过。
