# PiDeck dev 与 PiDeck V2 桌面 UI 对照（2026-11-21）

参照本机 PiDeck Electron `dev`（v0.13.1），遍历系统设置导航、Pi 配置页、模型与凭据、会话与输入区、终端、左右面板及典型弹窗和右键菜单。Electron 使用隔离 profile 和本地样例；V2 使用临时配置与测试 fixture，不读取或改写用户会话、密钥或正式配置。改动保留 V2 的独立标签、抽屉、数据所有权与 NSGo 宿主边界。

## 对照入口

本机 HTML 图册包含 31 组 Electron / V2 双侧对照、25 项 V2 补充状态，共 87 张嵌入式截图，可离线查看。未采集到 Electron 相同状态的项目单独标明，不用其他页面代替：

`%TEMP%\pideck-v2-ui-compare\pideck-v2-ui-comparison.html`

Electron 原始截图与采集日志：

`%TEMP%\pideck-v2-ui-compare\reference-final\`、`%TEMP%\pideck-v2-ui-compare\reference\`

PiDeck V2 截图：

`internal\workbench\.nsgo\test\screenshots\windows\comparison\`

其中包括设置 16 个分区、供应商添加/配置、凭据与 MCP 对话框；会话草稿、思考、工具运行/完成、流式回复、错误与停止；会话标签、回复、项目、文件与终端右键菜单；输入框扩展菜单、概览/文件/Git 抽屉、收藏与任务；终端、搜索、Shell 选择及标签重命名。

## 已落地的改进

- 设置区改成「系统设置 / 配置管理」两个分组，分组与正文分别滚动；切换分区重置正文位置，搜索跳转保持可见。语言控件与设置、终端/会话标签以及右侧概览/文件/Git 页面采用 NSGo `ui.Select`、`base.Tabs`、`ui.Tabs`、`base.Tab` 等现成组件。
- Pi 配置页将供应商、凭据与 Pi 自己的设置入口拆开，让设置页更接近按配置文件类型工作的路径；供应商配置表单有独立滚动区。添加供应商可以一次写入 `models.json` 与首个模型，拒绝重复 ID 和无效地址，保留其他 JSON 字段；成功后列表和按工具设置的模型选项立即刷新。Pi 会话仍按原有流程重启 Agent 后读取更新。
- 供应商读取从文件先发布、认证状态后补全；较早的状态探测不能覆盖较新的列表。工具模型选择直接订阅已发布的供应商信号，不在渲染时读磁盘。
- 会话正文与输入框共享响应式内容宽度；两侧面板打开时长模型名可省略、模型和思考等级可换行。运行中的按钮和占位文案跟随回合状态更新。流式工具步骤现在从当前消息节点取数据，修复稳定节点复用后继续读取旧缓冲区导致步骤消失的问题。
- 会话标签右键在被点中的会话上重命名、复制与导出；回复菜单覆盖复制、翻译、收藏和轨迹入口。文件菜单区分内置与外部编辑器，并继续复用菜单组件。
- 关闭 Pi 历史扫描时，环境刷新不再重复发布本来就是空的历史列表，避免重建会话行并关闭用户刚打开的右键菜单；已有外部历史仍按原有规则清除。
- 终端继续使用 NSGo `base.Terminal`，多标签改用 `base.Tabs`，选中标签时切换对应 PTY，并避免键盘移动焦点后被终端画布抢回。补上终端画布的复制/粘贴引用；Windows 本机可按安装情况新开 PowerShell、Windows PowerShell、cmd 或 Git Bash 标签。WSL/SSH 继续由工作区目标决定 shell。
- 新增中文设置词条已同步 en-US、zh-TW、ja-JP、ko-KR、ru-RU、fr-FR。

## 保留的差异与验收边界

- V2 仍使用适合 Go/NSGo 宿主的独立侧栏、标签页与抽屉，设置页布局和 PiDeck Electron 不会像素级复刻；此轮以对应的任务与操作路径为比较单位。
- Electron 的 DSH 配置管理、SSH 主机上的 Pi 配置文件直接编辑，以及更完整的 GTD 分诊与撤销工作流不在这轮改动范围内，按路线图的延后状态处理。
- Windows Shell 选择只列出可检测到的本机 Shell；远程工作区继续使用各自目标，不提供在本机菜单中替换远端 shell 的入口。Electron 的 WSL Shell 项也不是 V2 的本机菜单项。
- Electron 用量页在本机隔离采集中未成功加载；部分弹窗与异常状态只有 V2 的回归截图，图册已标出。Electron 终端采集未等到 Shell 就绪，仅用于布局对照；V2 终端另以真实 Shell 原生测试验证。
- 会话截图用固定 Pi RPC 事件验证状态变化，没有发送真实模型请求。PiDeck Electron 截图是一次桌面页面采集，不代表全部远程服务、设备权限或 Pi 行为已完成端到端验收。当前本机 mise 的 `pi` 命令是不可运行的 shim；依赖真实 Pi CLI 的短测试按仓库约定跳过。

## 验证

通过：

```powershell
go tool nsgo check
go tool nsgo test -target windows -run '^(TestTerminalPanel)$' -timeout 8m ./internal/workbench
go tool nsgo test -- -run '^(TestToolModelsPerTool|TestProviderCreateFromSettings)$' -count=1 -timeout=4m
go tool nsgo test internal/workbench -- -run '^(TestSessionMenuSurvivesEmptyPiRescan|TestArchiveSession|TestSettingsToggles)$' -short -count=1 -timeout=2m
go tool nsgo test -- -short -count=1 -timeout=20m
go tool nsgo build -target windows_x64
git diff --check
```

Windows 原生 UI 回归覆盖设置分区、配置与弹窗、会话各状态、输入框、抽屉、右键菜单和终端；终端测试启动真实 shell，选择 `cmd.exe`，并实测搜索、标签焦点、隐藏后保留、重命名与关闭。供应商添加流程覆盖取消、字段校验、重复 ID、保存和工具模型刷新。核心原生回归为 15 passed、0 failed、1 skipped；菜单刷新修复后的追加原生测试为 2 passed、0 failed、0 skipped。`TestProviderCreateFromSettings` 单独测试为 1 passed、0 failed、0 skipped。归档菜单问题先由新增测试复现，再修复空历史列表的无效更新。完整短测试最终为 **651 passed、0 failed、108 skipped**；跳过项包括需要原生截图驱动、外部服务或本机 Pi CLI 的测试。Windows x64 交叉构建通过。

短测试执行期间仅在该进程的 PATH 中移除了不可运行的 Pi shim 所在目录（`mise/shims`、`mise/installs/node/24.13.0` 与 `.local/bin`），退出后恢复，没有改系统环境或测试的跳过条件。最终短测试日志为 `%TEMP%\pideck-v2-ui-compare\short-after-menu-fix.log`；图册的浏览器验证确认 87 张图片全部加载、页面没有横向溢出，预览保存在同目录的 `gallery-preview.png`。
