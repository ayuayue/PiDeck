# 2026-11-20 补全与验收记录

## 范围与环境

本轮按 `ROADMAP.md` 原定的 PiDeck v0.12.0 功能面补全。上游在 2026-11-19 发布了 v0.13.0，不能把本轮结果解释为已完成 v0.13.0 的逐项对照。

主源核对：[DSH 官方 CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md)确认 `dsh --profile acp` 提供 ACP stdio；[PiDeck v0.13.0 发布说明](https://github.com/ayuayue/PiDeck/releases/tag/v0.13.0)确认发布日期与消息编辑方案。初轮没有将 v0.13 新增的 GTD 分诊、SSH Pi 配置编辑、增强模板编辑等标为已完成；随后新增的增强模板与首版体验验收见文末。

验证环境为 Windows x64、Go 1.27.3、仓库锁定的 NSGo `a4a00f7f38b3`。为避免干扰原工作区中运行的开发实例，构建和测试在 `D:\pideck-lite-validation-1120\source-final` 源码快照中串行执行；SHA256 清单为同目录上一级的 `source-manifest.json`。未运行全平台构建矩阵，也未签名、公证或发布。

## 本轮实现

- DSH 使用外部 npm 包 `@deepseek-ai/dsh`，启动参数为 `dsh --profile acp`。沿用通用 ACP 的会话、能力声明、审批、归档和恢复；没有内嵌另一套 DSH 宿主。初始化、建会话、关闭和恢复已验证，真实认证模型回合没有验收。
- ACP 增加预设安装检测、配置记忆和无输出看门狗；安装动作仅接受内置元数据。
- 记忆 MCP、实际 pi 扩展工具、系统提示词轨迹、分支重试、父子会话、分组、持久化草稿和 Shell 输入已接入。
- 子代理/工作流增加有界概览和虚拟化完整历史，保留原始结果、嵌套步骤和回合跳转；派发回执不会被标成完成。
- 浏览器使用系统 WebView，按可信会话和站点显式共享；点击、输入逐次审批，跨站或退出共享会撤销租约。
- WSL/SSH 文件、历史、草稿和编辑走同一目标 provider；保存携带内容版本并拒绝覆盖并发修改。
- 桌面和移动端图片、全屏预览/保存、CSV、原生视频、Office 系统编辑入口、翻译、语音服务、视频任务、微信渠道、在线生态、余额多账户及设置同步等路径已补充，具体状态见路线图。

## 稳定性与原生界面

NSGo 的主题按对象身份发布。后台环境/插件探测曾重新发布内容相同的主题，重建控件并中断焦点或指针目标。现在先对比已发布主题；相同主题不再发布。文件树也把 Git 标记和索引结果的更新限制在各自区域，避免重建搜索框和整棵文件树。

两条回归均先在旧实现上失败，再在修复后通过：

- 后台刷新/相同主题发布时，文件行和搜索框身份保持不变，搜索内容保留。
- 大提示词库可以导入、重复导入不重复，并可生成设置备份。原实现会把全部内容放进超过 10 MB 的 `user.json`；现在复用现有提示词包格式，按不超过 4 MB 的分包原子保存，保留备份限制。

大提示词库的打开读取已移到后台，加载期间保留明确状态并暂停冲突的导入/保存操作。评审的「提交评审」与「合并」操作区也改为独立响应状态变化，不再依赖后台刷新才能展开。

文件内容搜索的后台结果绑定发起搜索的项目，新查询立即清空旧命中；切换项目不会显示或打开旧项目的搜索结果。`file-search-delivery.log`：**5 通过、0 失败、0 跳过**，包含三条跨项目与新查询回归。

`prompt-review-delivery.log`：提示词、后台加载、大库备份和评审面板共 **12 通过、0 失败、0 跳过**。

`theme-stability-verified.log`：主题、文件编辑、CRLF、最近文件及 TokenDance 设置共 8 项测试连续执行三轮，**24 通过、0 失败、0 跳过**。未修改原有断言或放宽测试超时。

`native-delivery.log`：**2 通过、0 失败、0 跳过**。使用本地 HTTP 页面验证真实 Windows WebView 的快照与审批执行：批准前页面保持原状，批准后按钮变为 `Done`。已查看审批、完成、记忆、草稿本、视频页和提示词库的原生截图，未发现裁切或控件重叠。截图位于验证快照的 `internal/workbench/.nsgo/test/screenshots/windows/supplement/`。

## 完整回归

- `go tool nsgo check`：通过，包含目录和静态检查。
- `go tool nsgo test -- -short -count=1 -timeout=20m`：**548 通过、0 失败、51 跳过**（`short-final-delivery.log`）。包含包依赖、平台隔离、文件规模、六语言翻译、桌面与手机端逻辑及无头 UI 测试。跳过项包括需显式开启的外部环境测试和非当前测试模式，不能据此视为全部实机验收。
- 显式开启 `PIDECK_LITE_TEST_WSL=Debian`、`PIDECK_LITE_TEST_PI_TOOLS=1`，使用 NSGo runner 执行 `TestRemoteComposerControls`、`TestRemoteSessionActions`、`TestWSLWorkspaceRoundTrip`、`TestPiMemoryToolsAndSystemTrajectory`：**4 通过、0 失败、0 跳过**（`pi-wsl-delivery.log`）。pi 调用的是本地模型 fixture，不消耗真实模型额度；WSL 使用真实 Debian 和隔离临时项目。
- `node --test extensions/pi-deck-retry-no-body.test.mjs`：**2 通过、0 失败、0 跳过**（`retry-delivery.log`）。
- `go run ./scripts web`：通过 Web 构建、Brotli 压缩和带嵌入站点的 Windows x64 宿主构建（`web-delivery.log`）。`app.9eea448217.wasm.br` 为 **9,114,922 字节（8.69 MiB）**，低于 CI 的 **12,582,912 字节（12 MiB）**上限（`web-budget.log`）。
- `go tool nsgo test -run 'WebAsset|WebClient' -- -tags webassets -count=1`：**3 通过、0 失败、1 跳过**（`webassets-delivery.log`）；跳过的是仅在不带 Web 资源标签时执行的反向测试。
- `go tool nsgo build -target windows_x64 -installers=false`：通过，生成独立桌面构建（`windows-delivery.log`）。本轮没有创建正式安装器或签名发布。
- 相对起始基线 `ad823ce`，验证快照中 225 个有改动的 Go 文件通过 `gofmt -l` 检查（`format-task-delivery.json`）；收尾时 `git diff --check`、暂存区及 `HEAD` 合并差异的空白检查均通过。未全局格式化未改动文件，未调整其他执行者仍在编辑的文件。

完整短测的源码清单保留为 `short-manifest.json`；随后同步的浏览器测试平台标签不改变 Windows 桌面的生产源码集合。

构建产物与全部日志均在 `D:\pideck-lite-validation-1120\`；带 Web 的宿主为 `source-final/dist/PiDeck Lite-web-host.exe`，独立桌面构建在 `source-final/dist/PiDeck Lite-0.2.0-windows_x64/`。产物未复制回主工作区，未提交生成目录。

主工作区仍有其他执行者并行编辑插件、收藏等功能。快照之后的并行修改不纳入上述通过统计，也未覆盖或清理；通过结果以所列 SHA256 快照和日志为准。

## 在线目录与真实数据

- skills.sh：真实搜索和完整 `find-skills` 快照安装通过，包含参考文件；安装过程不运行脚本。
- prompts.chat：此前真实 CSV 下载和解析得到 3075 条；收尾复测的大文件请求发生超时，不能声称在线网络测试始终通过。
- 中文库：上游发布的 `xueprompts.db` 与 SHA256 文件已下载校验。生产 Go 读取代码从该真实库得到 **4012 条**，包含 gzip BLOB 内容；旧版 UTF-8 文本仍支持，损坏/过大解压内容被拒绝。延长目录文件的下载预算后，真实 Go 下载、校验、读取、导入与设置备份已全部通过（`chinese-live-six-minute.log`，耗时 323.48 秒）；未掩盖此前 180 秒预算下的超时。
- 官方插件索引：真实读取 4 个条目通过。同仓库插件按子路径保留独立身份；Electron 插件保持发现入口，不装入 Lite 的声明式执行环境。

普通测试保持离线。联网试验需显式设置 `PIDECK_LITE_TEST_CATALOGS=1`；`PIDECK_LITE_TEST_CHINESE_DB` 仅为测试提供已下载的真实数据库 fixture。联网超时与本地协议/存储回归分开记录。

## 尚未完成或需要外部验收

- 桌面 CUA、原生聊天选中文字浮钮、桌宠嵌入运行时受当前公开 SDK/运行时边界约束。
- pi 消息就地编辑/删除尚未实现，当前提供分支重试与重发。通用 RPC 没有相应方法；上游 v0.13.0 的发布说明采用停止目标会话活动 writer 后追加 `context_edit` 的方案。Lite 尚未实现相应的停止、重载与落盘一致性链路，不能直接修改正在写入的会话文件。
- 任意插件自定义记录派生的完整工作流依赖图尚未实现；现有视图覆盖可识别工具记录与完成通知。
- Windows 原生麦克风和实时流式字幕未实现；手机麦克风、媒体及系统通知权限需要设备验收。
- 微信真实登录收发、付费视频、云同步、SSH 和 DSH 认证模型回合需要相应账号/主机验收。真实 WSL 往返与协议 fixture 不能代替这些环境。
- 应用离线或被系统挂起后的 APNs/FCM 推送需要后台服务与证书。
- macOS 发布流程已接签名/公证参数，仍需维护者配置证书和 Apple/CI 凭据并在发布环境验收。

本轮未执行 `git add`、提交、推送或发布。工作区中的其他并行修改和既有暂存内容保留原状。

## 首版体验续补

根据首版优先核心体验的取舍，本次继续使用仓库锁定的 NSGo SDK，没有新增依赖或改动外部会话/RPC 格式。

- **草稿保护**：先用延迟响应回归复现桌面增强/续写以及手机端晚到响应覆盖新输入的问题（`v1-draft-red.log`、`v1-mobile-draft-red.log`）。现在只有草稿仍与发起请求时一致才自动替换；编辑、清空或手机切换会话后保留现有文字，结果作为一次临时预览供复制或主动替换。替换可撤销，继续编辑后撤销入口改为复制原草稿，避免覆盖新输入。手机结果按发起连接和会话隔离。
- **增强模板**：输入框工具菜单和设置 → 模型均可打开原生多行编辑器，支持保存、取消与恢复默认；失败后保留编辑内容和错误。`prompt-enhance.md` 限定非空 UTF-8、24 KB，原子保存，纳入设置备份/同步，不进诊断包。损坏时回退内置模板并提示；桌面和手机 HTTP 工具共用，系统指令与原始草稿分开传输。
- **修改与翻译**：新增「修改提问」入口，本机 pi 复用分支编辑，ACP/远程准备为新消息；旧「把提问放回输入框」也会保护已占用的草稿。新增「翻译回复」，浏览器选区和回复入口都不会覆盖已有翻译；翻译期间锁定原文与语言，避免结果和原文错配。就地删除仍未实现。
- **原生布局**：沿用现有主题、字号、输入框宽度与 NSGo 控件，桌面和客户端共用有界结果栏；补齐六个语言目录。

续补源码快照为 `D:\pideck-lite-validation-1120\v1-verified`，SHA256 清单为 `v1-verified-manifest.json`。Web/宿主构建在 `v1-web` 的独立副本中串行运行；复制前逐文件核对与该清单一致，未在同一 checkout 并发运行 NSGo 命令，也未干扰主工作区的开发实例。

- `go tool nsgo check`：通过（`v1-check-verified.log`）。
- `go tool nsgo test -- -short -count=1 -timeout=20m`：**590 通过、1 失败、53 跳过**（`v1-short-verified.log`），不宣称完整回归全绿。失败为原有 `TestSearchOpensSession` 在清除最近搜索后等待标签消失的界面步骤（`search_test.go:105`）；随后保持源码与断言不变，使用 `go tool nsgo test -run '^TestSearchOpensSession$' -- -count=1` 单独复测 **1 通过、0 失败、0 跳过**（`v1-search-investigation.log`）。原因尚未确定，按工程规范保留为待定位的不稳定项；未放宽超时、跳过或修改断言。
- 定向测试覆盖草稿冲突、显式应用、撤销保护、空结果、删除中的会话、跨连接/会话隔离、模板默认/坏文件/超限/保存失败/备份往返、桌面/手机模板传参和翻译原文保护（`v1-feature-tests.log`；完整最终回归另列）。
- `go tool nsgo test -target windows -run '^TestNativeDraftExperienceScreens$' -timeout 3m ./internal/workbench` 及对应客户端 `TestNativeMobileDraftChangeScreens`：各 **1 通过、0 失败、0 跳过**（`v1-native-workbench.log`、`v1-native-client.log`）。已检查桌面结果预览/撤销、回复翻译、浅深色模板和 390 pt 英文窄屏结果栏，共 7 张截图，无裁切或控件重叠；窄屏由 Windows 原生窗口模拟，不代表真实手机设备验收。截图分别在验证快照两个包的 `.nsgo/test/screenshots/windows/v1/`。
- `go run ./scripts web`：Web 和嵌入 Web 的 Windows x64 宿主构建通过（`v1-web.log`）。`app.4f9279bff3.wasm.br` 为 **9,129,664 字节（8.71 MiB）**，低于 **12,582,912 字节（12 MiB）**预算。产物在 `v1-web/dist/PiDeck Lite-web-host.exe`，未复制回工作区或发布。
- 带 Web 资源标签的 `WebAsset|WebClient` 检查：**3 通过、0 失败、1 跳过**（`v1-webassets.log`），跳过项是反向检查未嵌入 Web 的构建。
- Impeccable 对变更界面的机械检查无报告项（`v1-design-detect.json`）；最终布局以原生截图为准。

本次改动的 Go 文件已 `gofmt`，`git diff --check` 通过。收尾期间其他执行者继续修改文档、插件测试和图像拖放（`app_images.go`、`session_state.go` 的 `dropTail`），这些快照后的并行修改不包含在上述统计中，未覆盖或回滚；验收结论以所列 SHA256 快照为准。本次仍未暂存、提交、推送、发布或清理其他执行者的改动。

首版不等待 CUA、原生选中文字浮钮、Windows 麦克风实时字幕、桌宠运行时、任意插件工作流依赖图或离线推送；账号、实际 SSH 主机、设备权限与签名发布的边界仍见上节。

### 最终首版工作流复核

- 文件搜索换词后立即清空旧命中，回车只执行当前查询；最近搜索清除控件保持稳定身份。原生活动页集中显示待确认与运行中的会话，审批项优先、按会话状态更新，最多显示 100 项；选择后回到原对话。
- 验收副本 587 个受跟踪文件均与当前工作区 SHA256 一致；随后所有 NSGo 检查、短测与构建均在此副本串行运行。
- `go tool nsgo check`：通过（`workflow-check-current.log`）。
- `go tool nsgo test -- -short -count=1 -timeout=20m`：**617 通过、0 失败、54 跳过**（`workflow-short-final-exact.log`）。Go 编译临时目录和系统 `TEMP` / `TMP` 都指向 D 盘验收目录，避免系统 C 盘空间不足影响 UI / Git 临时文件；跳过项是显式环境测试或其他测试模式。
- `go tool nsgo build -target windows_x64 -installers=false`：通过（`workflow-windows-build-exact.log`）。
- Windows 原生 `TestNativeActivityScreen`：**1 通过、0 失败、0 跳过**（`workflow-native-activity-exact.log`）。已目视确认活动页标题计数、会话标题/项目时间、待确认与运行中状态无裁切或重叠。截图：`D:\pideck-lite-validation-1120\v1-workflow\internal\workbench\.nsgo\test\screenshots\windows\supplement\activity-review.png`。
- Impeccable 对活动页的机械检测无报告项（`ui_activity.go` 检测结果 `[]`）。

主工作区仍有其他未提交改动，本次未暂存、提交、推送、发布或清理它们。外部账号、设备、SSH 主机、签名/公证等验收限制仍适用；本结果不表示这些真实环境已验收。

## NSGo 主分支升级

NSGo 从 `v0.1.1-0.20261117180649-a4a00f7f38b3` 升至 `v0.2.1-0.20261120132814-c70af8a79201`，固定到本轮查询时上游 `main` 的最新提交 [c70af8a](https://github.com/nsgo-dev/nsgo/commit/c70af8a79201695f8b37d76fc4436430d08d6e64)（2026-11-20）。新版 SDK 的扫码实现带入 `github.com/makiuchi-d/gozxing v0.1.1` 和 `golang.org/x/xerrors` 两个间接依赖；其他依赖版本保持不变，现有 API 调用无需兼容补丁。桌宠移除回归通过，旧桌宠继续停用。

本轮从干净工作区开始，仅修改 `go.mod`、`go.sum` 和本节验收记录。由于 C 盘空间不足，验证在 `D:\pideck-lite-validation-1120\nsgo-upgrade-c70af8a\source` 的源码副本中串行执行；复制时逐文件校验 687 个受跟踪文件，SHA256 清单为同级 `source-manifest.json`。Go 编译缓存、`GOTMPDIR`、`TEMP` 和 `TMP` 均使用 D 盘目录。

- `go tool nsgo check`：通过（`check.log`）。
- `go tool nsgo test -- -short -count=1 -timeout=20m`：**627 通过、0 失败、54 跳过**（`short.log`）。
- `go run ./scripts web`：Web 和嵌入 Web 的 Windows x64 宿主均构建通过（`web-windows.log`）。`app.e2106f6e16.wasm.br` 为 **9,184,820 字节（8.76 MiB）**，低于 **12,582,912 字节（12 MiB）**预算；尺寸记录为 `artifact-sizes.json`。
- `go tool nsgo test -run 'WebAsset|WebClient' -- -tags webassets -count=1`：**3 通过、0 失败、1 跳过**（`webassets.log`）；跳过项为检查不嵌入 Web 资源的反向测试。

上述日志、源码清单和产物均位于 `D:\pideck-lite-validation-1120\nsgo-upgrade-c70af8a\`。Windows 宿主为 `source\dist\PiDeck Lite-web-host.exe`，生成资源和二进制未提交。本次未执行其他平台构建、设备验收、安装器制作、签名或发布。
