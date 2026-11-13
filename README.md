# PiDeck Lite

用 [NSGo](https://oneo-me.github.io/nsgo/) 重做的 PiDeck：一个原生窗口的 pi 工作台。
左侧项目与会话，中间标签页与对话，右侧会话面板与文件抽屉；后端直接驱动本机 `pi` 的
RPC 模式。没有 Electron，没有浏览器内核，整个应用是一个 Go 二进制。

![PiDeck Lite 的工作台：左侧项目与会话，中间对话，右侧会话面板与 Git/文件](assets/screenshot.png)

## 运行

```sh
go tool nsgo dev                     # 热重载开发
go tool nsgo test                    # 无头 UI 与端到端测试
go tool nsgo test -target windows    # 真实窗口测试并截图
go tool nsgo build -target windows_x64
./dist/"PiDeck Lite-0.2.0-windows_x64"/"PiDeck Lite.exe"
```

前置：PATH 里有 `pi`。应用用 `pi --mode rpc` 启动它，会话放在应用自己的目录里。

### 手机端

同一份代码的 Android/iOS 目标会显示连接页，而不是桌面工作台：

```sh
go tool nsgo doctor                        # 检查 adb / NDK / Xcode / 模拟器
go tool nsgo dev -target android           # 已连接的 Android 手机或模拟器
go tool nsgo dev -target ios_simulator     # 需要 Mac + Xcode
go tool nsgo build -target android_arm64   # 手机用的 APK
go tool nsgo build -target android_x64     # x86_64 模拟器用的 APK（需要 NDK）
PIDECK_LITE_MOBILE=1 go tool nsgo dev      # 在桌面窗口预览手机页
```

Windows 上的 `nsgo doctor` 只能构建 Android 包并等待设备/模拟器；iOS 模拟器需要 Mac 和 Xcode。

#### 装 Android 模拟器（Windows，一次性）

```powershell
winget install Google.AndroidCLI Google.PlatformTools
android emulator create medium_phone        # 建 AVD，会下载系统镜像（约 2 GB）
android emulator start medium_phone         # 起模拟器，跑起来后才返回
```

`android_x64` 目标（模拟器）需要 NDK，`android_arm64`（真机）不需要。装 NDK：

```powershell
# 下载 NDK r27c 并解压到 SDK 的 ndk/ 下
curl -L -o $env:TEMP\ndk.zip https://dl.google.com/android/repository/android-ndk-r27c-windows.zip
Expand-Archive $env:TEMP\ndk.zip -DestinationPath "$env:LOCALAPPDATA\Android\Sdk\ndk" -Force
Rename-Item "$env:LOCALAPPDATA\Android\Sdk\ndk\android-ndk-r27c" "$env:LOCALAPPDATA\Android\Sdk\ndk\27.2.12479018"
go tool nsgo doctor                          # 应显示 ✓ Android NDK 与 android_x64 ✓ ✓
```

#### 让模拟器连上桌面端

模拟器把 `10.0.2.2` 指向宿主机，所以不走局域网也能连，端口就是「设置 → 远程」里的端口。

1. 桌面端打开 `设置 → 远程`，开启「允许手机连接」；这一栏里有「Android 模拟器」一行
2. 在仓库里运行：

```powershell
pwsh -File scripts/android.ps1 up      # 起模拟器（已在跑就跳过）
pwsh -File scripts/android.ps1 app     # 构建 x86_64 包、安装、打开
pwsh -File scripts/android.ps1 link    # 复制 http://10.0.2.2:<端口>/?token=…
```

3. 在模拟器窗口里点「连接地址」输入框，`Ctrl+V` 粘贴，点「连接」

模拟器和宿主机共享剪贴板，所以复制链接后直接粘贴即可；地址里已经带了令牌，令牌框可以留空。

`scripts/android.ps1 status` 会打印 SDK 路径、当前设备、AVD 和桌面端链接状态。

## 架构

从下往上，五层，一层只依赖它下面那层：

| 层 | 文件 | 职责 | 关键约束 |
| --- | --- | --- | --- |
| 进程与协议 | `rpc.go`、`env.go` | 起进程、按 LF 切 JSONL、按 id 关联命令与响应、转发扩展 UI 请求 | UI 线程永不阻塞；每条命令都有超时；目标（本机/WSL/SSH）只在这里出现 |
| 环境与目标 | `env.go`、`addons.go` | 探测 pi、WSL 发行版、SSH Host；读主题与插件 | 探测在后台跑，结果进信号；所有“在哪跑”的差异收敛成 `target.command()` |
| 存储 | `store.go` | 配置、应用自己的会话目录、扫描/导入/删除 | 只写自己的目录；导入是复制；删除是移动；不碰别人的会话文件 |
| 状态 | `app.go`、`types.go` | 会话与轮次的状态机、事件归并、动作（发送/引导/停止/压缩/模型/思考） | 一切都由信号驱动；一轮的“是否在跑”只有一个来源；文本增量合并后再进 UI |
| 界面 | `ui.go`、`ui_chat.go`、`picker.go`、`files.go`、`theme.go` | 侧栏、标签、对话、输入、抽屉、对话框 | 读信号就用它；不改状态；状态在状态层构造 |

三条硬规则，来自上一版的坑：

1. **一个事实一个来源**。一轮是否在跑 = 最后一轮 `turn.running()`，不看状态字符串、不看进程。
   会话文件、标题、用量各只有一个来源（pi / 配置 / `get_session_stats`）。
2. **有状态的视图不重建**。工具行、思考行的展开状态存在会话上（按调用 id / 步骤 id），
   不属于组件实例；对话行用稳定的轮次/步骤 id 做键；时钟只在需要显示“用时”的叶子里读。
3. **热路径不做线性重算**。文本增量进 `strings.Builder`，40ms 合并一次 `Set`；工具输出按
   24k 截断；长历史按窗口（默认 24 轮）渲染，可“加载更早”。

## 功能

**工作台**
- 项目列表（本机 / WSL / SSH）、展开会话、在文件管理器中打开
- 会话标签页：新建、关闭（进程继续跑）、`Ctrl+Tab` 轮换、标题栏可重命名
- 收藏：会话右键收藏后固定在顶部；模型收藏后排在选择器最前
- 会话侧栏：搜索、状态点（就绪/启动/运行/重试/出错）、最近活动时间
- 会话右键：收藏、重命名、复制会话、导出 HTML、复制 ID、删除（移到 `trash/`）
- 会话命令：重启 Agent（重新读取模型与配置）、关闭 Agent（释放进程，记录和标签保留）

**对话**
- 流式：思考、正文、工具调用实时进入；正文带闪烁光标，30fps 合并刷新
- 思考行：运行中自动展开并计时（“思考中 · 3s”），结束后折成一行，点开看完整推理
- 工具行：动词 + 目标 + （运行中转圈 / 毫秒 / 失败标记 / `+N −M` 改动量 / 内含调用数），
  运行时自动展开显示实时输出；编辑类工具展示带颜色标记的 diff；输出可选中
- 失败/取消：错误行 + 重试；中断的轮次留“已停止”标记
- 每轮操作：复制提问、把提问放回输入框、复制回复、重试
- 待办条：Agent 的 todo 工具一更新，输入框上方显示进度与当前任务，点开看全部条目，可清除
- 一轮结束折叠成“用时 X · N 个工具调用”
- 输入区：Enter 发送 / Shift+Enter 换行；运行中回车变“引导”；空输入时按钮变“停止”
- 模型菜单：按供应商分组、显示供应商名与上下文大小、每行可星标收藏（收藏置顶）、可搜索
- 输入框底部：项目切换菜单、pi 就绪指示、用量面板（上下文条、输入/输出/缓存、费用、轮次/工具数、压缩与打开面板）
- 粘贴/拖入图片；右侧文件抽屉点文件打开编辑器，右键可插入 `@路径`
- 命令面板（`Ctrl+K`）：会话/工作区/外观/文件/插件命令
- 提示词库（`Ctrl+Shift+P`）：分类、搜索、一键放进输入框；当前草稿可存为新提示词

**文件编辑器**
- 点文件抽屉里的文件，中央区域换成编辑器：语法高亮、行号、折叠、查找替换、多光标
- `Ctrl+S` 保存，`Ctrl+W` 关闭；未保存时标签有圆点，关闭或重新读取前会确认
- 底部状态栏显示路径、语言与是否已保存；工具栏可重新读取、在文件管理器中显示
- 只编辑本机项目的文本文件；超过 4 MB 或二进制文件会给出原因而不是半打开
- 文件树显示 Git 状态：M/A/D/?/U 字母标记，折叠的目录有改动时显示圆点
- 右键文件：在编辑器中打开、插入 `@` 路径、在文件管理器中显示、复制相对路径

**终端**
- 底部终端面板（`Ctrl+Shift+T` 或标题栏按钮），可拖动上沿改高度，关闭面板后 shell 继续运行
- 多标签：新建、切换、关闭、重启、清屏；标签跟随程序标题
- 真 PTY + Ghostty 终端模拟器（NSGo `base/terminal`）：颜色、宽字符、滚动回看、程序自绘 UI
- 在项目目录打开；本机、WSL、SSH 三种目标各自起 shell
- 搜索（高亮、上一个/下一个）、复制/粘贴/全选、右键菜单

**Git**
- 右侧 `Git` 抽屉：分支、上游、领先/落后数，获取 / 拉取 / 推送（无上游时一键发布到 `origin`）
- 改动分「已暂存 / 更改」，逐文件暂存、取消暂存、丢弃；全部暂存 / 取消暂存；未跟踪与冲突状态
- 提交框：多行说明、提交、全部提交、修订上次提交；空说明与无暂存时禁用
- 历史：最近 50 次提交，点开看完整补丁（统一 diff、可选中复制）
- 分支菜单：切换本地分支、新建并切换
- 其他：初始化仓库、贮藏全部改动 / 恢复最近贮藏、丢弃全部改动
- 同一套操作跑在本机、WSL、SSH 目标上；面板每 4 秒自动刷新状态

**远程访问**
- 设置 → 远程：开启手机服务，设置端口、访问令牌，复制连接链接
- 三种连接方式：局域网（本机所有非回环 IPv4）、Tailscale（读 `tailscale status` 的 100.x 地址）、
  EasyTier（读 `easytier-cli` 的虚拟 IP，读不到时可手动填写）
- 手机端连接后浏览电脑上的项目、会话和会话历史，列表每 2.5 秒刷新（会话运行中 1.2 秒）
- 手机端能做的会话操作：
  - 新建：标题栏「+」，只有一个项目时直接建，多个项目时先选项目；建完直接进对话
  - 搜索：标题栏放大镜，按会话标题过滤；会话内再按内容过滤已加载的消息
  - 行内「…」：重命名、置顶 / 取消置顶、删除（删除会二次确认，文件进电脑的 `trash/`）
  - 发消息：底部输入框 + 发送；运行中多一个停止键（不挡输入，pi 会排队），
    回复按 1.2 秒轮询流式出现
  - 工具调用折成一行「调用了 N 个工具」，点开原地展开每条命令
  - 模型与思考：输入框上方一行显示当前模型和思考等级，点开是原生底部弹层，
    可切模型（按供应商分组）和 low/high/max
- 令牌鉴权；链接含令牌；pi 自己的会话只能在电脑上删除

**手机端的接口**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/ping` | 主机名与版本，连接时探活 |
| GET | `/api/state` | 项目、会话、置顶与运行状态 |
| GET | `/api/session/{id}` | 一个会话的消息；运行中带 live 文本 |
| GET | `/api/session/{id}/options` | 模型列表、当前模型、思考等级；pi 没起会顺手拉起 |
| POST | `/api/sessions` | `{project}` 新建会话，返回 `{id,title}` |
| POST | `/api/sessions/{id}/prompt` | `{text}` 发一条消息 |
| POST | `/api/sessions/{id}/stop` | 停止当前一轮 |
| POST | `/api/sessions/{id}/rename` | `{title}` 改名 |
| POST | `/api/sessions/{id}/pin` | `{pinned}` 置顶或取消 |
| POST | `/api/sessions/{id}/model` | `{provider,id}` 切模型 |
| POST | `/api/sessions/{id}/thinking` | `{level}` 切思考等级 |
| POST | `/api/sessions/{id}/delete` | 删除会话（pi 自己的会话会拒绝） |

**会话与数据**
- 应用自己的会话目录（pi 原生格式），重启恢复标签与历史
- **项目下的 pi 本地会话**：只读当前项目的目录，与项目会话合并后按时间分组；
  默认显示 10 条，「更多」每次展开 40 条，展开后可「收起」；点会话用
  `--session <file>` 继续；设置里可切换成“扫描所有项目”
- 加载占位：项目历史与项目会话数量在读取时显示 pulse 骨架；打开历史会话时，
  正文区先显示加载骨架，读完再淡入内容
- 导入 `.jsonl`：复制进应用目录；删除进 `trash/`
- 配置 `config.json`：工作区（含目标）、标签、收藏、默认模型与思考等级、主题、标题、键位、停用的插件

**目标：本机 / WSL / SSH**
- 探测：`pi --version`、`wsl -l -q`、`~/.ssh/config` 的 Host，逐个试 `command -v pi`
- WSL：`wsl.exe -d <distro> --cd <dir> -- sh -lc 'exec pi …'`，会话存该发行版的
  `~/.pideck-lite/sessions`
- SSH：`ssh -o BatchMode=yes <host> "cd <dir> && exec pi …"`，同样远端存会话
- 设置页显示每台机器的 pi 路径/版本与错误，可重新探测

**设置**（左栏分类，右侧一行一条，控制项在行尾）
- 通用：新会话默认模型/思考等级、项目下是否列 pi 本地会话、是否扫描所有项目、界面语言
  （跟随系统 / 简体中文 / 繁體中文 / English）
- 模型与认证：供应商列表（模型数、API、BaseURL）、`pi auth check` 的就绪状态、
  复制登录命令、常用模型（收藏）管理
- 供应商配置：点供应商右侧的设置按钮改 `api` / `baseUrl` / `apiKey`（只写这三个字段，
  其余保持原样），可一键测试连接（先探 `/models`，再退到一次最小 chat 请求）
- 原始配置：直接在内置编辑器里打开 `models.json` / `settings.json` / `auth.json`
- 外观：配色（跟随系统/纸白/炭黑/用户主题）、打开主题目录
- 环境：pi 路径与版本、pi 会话目录、WSL 发行版与 SSH Host 的检测结果、添加远程工作区
- 扩展：插件列表与命令、打开插件目录、重新加载
- 资源：pi 的技能（读 `SKILL.md` 的 name/description，点开在编辑器里看）与扩展
  （内置 / npm / 本地 `.ts`），可启停；打开技能/扩展目录、重新读取
- 数据：应用/会话/pi 会话目录、会话数量
- 用量：从本地会话文件统计累计 tokens 与费用、最近 12 周热力图、模型与项目分布；
  只在本机计算，可手动重新统计
- 关于：版本、运行方式、检查更新、项目链接

**外观与扩展（可写文件，不跑代码）**
- 资源页：pi 的 skills 与 extensions；技能点开看 `SKILL.md`，扩展可开关（写 `settings.json`）
- 主题：内置跟随系统 / 纸白 / 炭黑；用户主题放 `themes/*.json|*.yaml`，按调色板角色覆盖，
  可带 `tokens`（字体、圆角）与 `appearance`（仅浅色/仅深色）；也读 shadcn/ui 主题文件
- 插件：`plugins/*.json`（或 `plugins/<名字>/plugin.json`），`contributes.commands` 加命令面板命令，
  `contributes.themes` 加主题，`contributes.keybindings` 声明键位；可整体启用/禁用
- 命令动作只支持声明式安全动作：填入提示词、执行内置命令、打开链接、切换主题
- 打开目录、重新加载都在设置里；每次启动也读一遍

**界面**
- PiDeck 的配色与 logo；浅色/深色/跟随系统；侧栏 `Ctrl+B`、抽屉 `Ctrl+J`、终端 `Ctrl+Shift+T`、设置 `Ctrl+,`
- 命令面板 `Ctrl+K`；键位可在 设置 → 键位 里逐条改，留空取消绑定，可一键恢复默认；插件也能声明键位
- 系统托盘：关闭窗口默认留在托盘，Agent 继续跑；托盘菜单可恢复窗口、新建会话、跳到运行中的会话、打开设置、退出
- 通知：一轮完成时发系统通知，可设「只在窗口隐藏时提醒」；设置里有测试按钮
- 空状态给四条起手式；首屏直接引导选项目文件夹

## 文件

| 文件 | 作用 |
| --- | --- |
| `rpc.go` | pi RPC 客户端：spawn、JSONL 分流、请求关联、扩展 UI、退出清理 |
| `env.go` | 目标（本机/WSL/SSH）、命令拼装、环境探测、ssh config 解析 |
| `app.go` | 状态与动作：信号、会话生命周期、事件归并、发送/引导/停止/压缩/导出 |
| `types.go` | 轮次/步骤/工具运行/用量；消息 → 轮次的重建；工具摘要与 diff 解析 |
| `store.go` | 配置、会话目录、扫描、导入、删除、pi 目录编码 |
| `addons.go` | 主题与插件、外观应用、框架重新加载、pi 自身会话列表 |
| `picker.go` | 添加工作区/导入会话的文件夹浏览器 |
| `files.go` | 右侧文件树：懒加载、隐藏文件、插入 `@路径` |
| `editor_host.go` | 内置编辑器：打开的文件、读写、未保存状态、语言识别 |
| `ui_editor.go` | 编辑器界面：文件标签、工具栏、状态栏、编辑器配色 |
| `git.go` | Git 后端：porcelain v2 状态、日志、分支、提交/同步/贮藏等操作，本机与远端命令 |
| `ui_git.go` | Git 抽屉：分支菜单、改动列表、提交框、历史、补丁与新建分支对话框 |
| `term.go` | 终端会话：Ghostty 终端、本机/WSL/SSH shell、标签生命周期与搜索 |
| `ui_term.go` | 底部终端面板：标签栏、搜索栏、右键菜单、可调高度 |
| `prompts.go` | 提示词库：播种起步包、读 JSON/YAML、搜索与保存草稿 |
| `ui_prompts.go` | 提示词库对话框：分类、搜索、列表与插入 |
| `pi_resources.go` | pi 的技能与扩展：读 SKILL.md、settings.json 的扩展列表与启停 |
| `ui_resources.go` | 设置里的资源页：技能列表、扩展开关、目录入口 |
| `i18n.go` | 界面语言：系统语言匹配、源文本查表、设置与命令面板的翻译目录 |
| `usage.go` | 本地用量统计：读会话文件、按天/模型/项目归并、热力图分级 |
| `ui_usage.go` | 设置里的用量页：累计卡片、12 周热力图、模型与项目榜 |
| `desktop_host.go` | 系统托盘、关闭到托盘、完成通知与各平台通知命令 |
| `remote.go` | 手机 HTTP 服务、令牌、快照/历史接口，局域网/Tailscale/EasyTier 地址探测 |
| `remote_client.go` | 手机端 HTTP 客户端与连接串解析 |
| `mobile.go` | 手机端连接页、项目/会话列表、只读会话历史 |
| `ui_remote.go` | 桌面设置里的远程访问面板 |
| `scripts/android.ps1` | 模拟器日常操作：启动、装包、复制连接链接、看状态 |
| `ui.go` | 侧栏、标签、抽屉、命令面板、目标/重命名/确认/扩展对话框 |
| `ui_menu.go` | 统一的菜单卡片、会话/项目右键菜单、模型/用量/项目弹层 |
| `ui_settings.go` | 设置窗口：左栏分类 + 分节行（通用/模型与认证/外观/环境/扩展/数据/关于） |
| `providers.go` | 读 pi 的 models.json、编辑供应商字段、`pi auth check` 探认证、连接测试 |
| `ui_provider.go` | 供应商配置对话框：字段、模型列表、连接测试、原始 JSON 入口 |
| `ui_chat.go` | 对话：轮次、思考行、工具行（diff/嵌套调用）、Markdown、输入区、空状态 |
| `theme.go` | PiDeck 配色的 NSGo 主题，用户主题在其上覆盖 |
| `*_test.go` | 无头 UI 测试、端到端（真 pi）、目标命令/主题/插件单测 |

## 自动更新

direct 构建从 GitHub Release 的 `appcast-<目标>.xml` 检查更新：

- `updates.pub` 是公钥，已提交；私钥 `updates.key` 不入库，CI 用 `NSGO_UPDATES_KEY`
- 生成密钥：`go tool nsgo keygen updates`
- 打包：`go tool nsgo build` 用私钥签安装程序并写出 appcast；把 `dist/releases` 整个上传到 Release
- 应用内：设置 → 关于 → 检查更新，或命令面板「检查更新」；macOS/Windows 由 Sparkle/WinSparkle 下载并安装，
  Linux 打开对应 Release 页面
- 本地没有 `updates.key` 时不会生成 macOS/Windows 的 appcast；开发构建从不检查更新

## 提示词库

首次启动会往数据目录的 `prompts/starter.json` 写一份起步提示词（代码理解、修改、调试、文档、计划、
学习、性能、安全），之后这个目录就是你的：可以加 `*.json` 或 `*.yaml`，每个文件一包。

```json
{
  "name": "团队提示词",
  "prompts": [
    {"title": "梳理改动", "category": "评审", "tags": ["git"], "body": "看看未提交的改动，用要点说明做了什么、有没有风险。"}
  ]
}
```

- 分类、搜索、标签都来自文件；点一条就放进当前会话的输入框，没有会话时复制到剪贴板
- 「保存当前草稿」写进 `prompts/user.json`，标题取正文第一行
- 起步包只在 `prompts/` 不存在时写一次，不会覆盖你的修改

## 主题与插件格式

主题 `themes/mist.json`（也接受 `.yaml`）：

```json
{
  "name": "雾蓝",
  "author": "你",
  "appearance": "both",
  "radius": 10,
  "sans": "Inter",
  "mono": "JetBrains Mono",
  "tokens": {"font-sans": "Inter", "radius": "10px"},
  "light": {"background": "#f7f9fc", "inset": "#eef2f8", "accent": "#2563eb"},
  "dark":  {"background": "#0f1419", "inset": "#151d24"}
}
```

角色名与 NSGo 调色板一致：`background surface surfaceHover surfacePressed border text
textMuted accent accentHover accentPressed accentText danger warning success selection
focus scrollbar inset raised field fieldBorder line faint accentFill light onLight track
knob code info down`。

`appearance` 为 `light` / `dark` 时，选中该主题会强制对应外观；省略或 `both` 时跟随系统的浅色/深色。
主题文件也可以直接写 shadcn/ui 的 `cssVars.theme/light/dark`，其中的 `var(--name)` 会解析，
非颜色变量进 `tokens`。

插件 `plugins/team/plugin.json`：

```json
{
  "id": "team",
  "name": "团队命令",
  "version": "1.0.0",
  "description": "常用检查与链接",
  "author": "团队",
  "contributes": {
    "commands": [
      {"id": "review", "title": "跑测试并总结失败", "group": "团队", "icon": "terminal",
       "action": {"type": "prompt", "prompt": "跑一遍测试，把失败项按文件列出来。"}},
      {"id": "open-docs", "title": "打开团队文档", "icon": "globe",
       "action": {"type": "url", "url": "https://example.com/docs"}},
      {"id": "compact", "title": "压缩上下文", "icon": "zap",
       "action": {"type": "command", "command": "compact"}}
    ],
    "themes": ["themes/team-blue.json"],
    "keybindings": [{"command": "review", "key": "mod+shift+r"}]
  }
}
```

- `action.type`：`prompt` / `insert` 填进输入框，`send` 直接发送，`command` 执行内置命令，
  `url` 打开 http(s) 链接，`theme` 切换主题（可写 id 或显示名）
- `contributes.themes` 的路径必须留在插件目录内；越界、坏命令、重复 id 会在设置里显示为警告
- 旧格式 `{"prompts": [...], "themes": [...]}` 仍然可用，提示词会自动变成 `prompt` 命令
- 命令 id 在插件内唯一；面板里显示为 `plugin:<插件 id>:<命令 id>`
- 插件可以在 设置 → 扩展 里整体启用/禁用，禁用后命令、主题、键位都不加载

插件命令出现在命令面板里，选中后按 `action` 执行。插件不运行代码，所以一个坏插件最多是没用的，
不会碰到项目文件。

## 语言

界面文案以中文为源文本，按源文本查翻译；没有译文的条目原样显示中文，所以新界面可以先上线再补翻译。
当前覆盖设置页、命令面板、托盘菜单、键位页，以及主界面的侧栏、欢迎页、输入框、抽屉、空对话、右键菜单与常用对话框。
切换在 设置 → 通用 → 界面 → 语言，立即生效并写入 `config.json` 的 `language`（`""` 跟随系统）。

新增文案时：在 `i18n.go` 的 `messages` 里给 `en-US` 与 `zh-TW` 各加一条，键就是中文原文；
命令与设置分区有测试保证两种语言都不漏。

## 键位

设置 → 键位列出可绑定的命令。写法是修饰键加键名，`mod` 在 macOS 是 Command、其他平台是 Ctrl；
`ctrl`、`alt`、`shift`、`meta` 也可以组合。回车保存，留空取消绑定，「默认」恢复。

用户键位存在 `config.json`：

```json
{"keybindings": {"new-session": "ctrl+alt+n", "settings": ""}}
```

插件的 `contributes.keybindings` 只占用空闲键；与默认或用户键位冲突时会被跳过，并在
设置 → 键位 的「冲突」里说明。命令 id 不带冒号时，插件内命令会自动加上 `plugin:<插件 id>:`
前缀，内置命令则直接绑定。

## 路线图

原 Electron 版 PiDeck 的功能对照、差距与执行顺序见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 测试

```sh
go test ./...                       # 全量（含真 pi 的端到端）
go tool nsgo test -target windows   # 真实窗口，截图写到 .nsgo/test/screenshots/windows
```

端到端用例真启动 pi：发消息等指定标记、工具行展开读文件内容、中途停止、重启恢复、
导入会话、打字期间时钟推进不丢草稿、pi 本地会话出现在侧栏。目标平台跑静态界面截图
（欢迎、文件浏览器、设置、pi 会话列表）。数据目录用 `PIDECK_LITE_HOME` 覆盖。

## 已知限制

- 工具级权限审批：pi 的工具授权在 RPC 里走扩展 UI，这里实现了
  `confirm/select/input/editor` 对话框，但没有独立的“工具调用批准”面板
- 子代理/工作流视图、MCP 管理未做
- 消息不能就地改写或删除（pi 的 RPC 没有这个能力）；提供「把提问放回输入框」与重试
- 会话树分支（`/tree`、fork）未做；重试是“把同一条提示再发一次”
- 远端目标（WSL/SSH）不列远端历史会话，只按标签恢复；文件抽屉与编辑器只处理本机文件
- 编辑器不写远端文件；超过 4 MB 或二进制文件只提示，不打开
- Git 的凭据提示走不了 GUI：HTTPS/SSH 需要先在终端里登录或配好密钥
- 供应商连接测试是轻量探测（`/models` 或一次最小 chat 请求），不等于完整模型可用性验证
- 系统通知是尽力而为：macOS 用 `osascript`、Linux 用 `notify-send`、Windows 用 PowerShell 的 WinRT 通知；系统关掉通知权限时不会补发
- 资源页的扩展开关只改 `settings.json`，重启 Agent 后生效；本地 `.ts` 扩展自动加载，不能在此停用
- 翻译覆盖设置页、命令面板、托盘、键位、主界面外壳、右键菜单与常用对话框；Git/终端面板仍显示中文，按 `i18n.go` 的目录逐步补
- 用量统计最多读最近 3000 个会话文件，按会话 ID 去重；导入副本与移动过的文件可能让统计略有偏差
- 手机端不支持：附件与图片、多行输入、会话内跳转到命中位置
- 手机端只列本机项目（WSL/SSH 目标的项目不出现）
- 局域网连接走 HTTP + 令牌，Tailscale/EasyTier 的链路本身加密
- 草稿与附件不跨重启保存；单窗口
