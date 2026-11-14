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
- 项目信任：新加的项目在第一次发送前询问一次，输入区上方有提示条；旧项目迁移为已信任，内置对话始终受信任；项目右键可信任/撤销信任，手机发消息也会被拦下
- 内置对话（`Ctrl+Shift+N` 或欢迎页「直接对话」）：不绑定项目，会话落在数据目录的 `chat/`，侧栏以对话图标置顶显示
- 智能体：命令面板「用智能体新建会话…」选代码审查/讲解/重构/测试/文档等预设，工作方式放在每个提问前；输入区徽章可一键清除，自定义智能体放 `agents/*.json`
- 项目分组：置顶、命名分组、手动顺序；排序可按最近活动 / 创建时间 / 名称；右键项目可置顶、上移/下移、移动到分组
- 会话标签页：新建、关闭（进程继续跑）、`Ctrl+Tab` 轮换、标题栏可重命名
- 收藏：会话右键收藏后固定在顶部；模型收藏后排在选择器最前
- 会话侧栏：搜索、状态点（就绪/启动/运行/重试/出错）、最近活动时间
- 会话右键：收藏、重命名、复制会话、导出（HTML / Markdown / 复制 Markdown）、复制 ID、删除（移到 `trash/`）
- 会话命令：重启 Agent（重新读取模型与配置）、关闭 Agent（释放进程，记录和标签保留）、分叉上一条提问
- 分叉：复制到该轮之前的历史到新会话，原提问放回输入框；原会话文件不动。分叉记录来源：侧栏有分支图标，概览里显示「分叉自 …」并可一键打开原会话；命令面板「查看分叉树…」按层级列出整棵分叉树，点任意节点切换

**对话**
- 流式：思考、正文、工具调用实时进入；正文带闪烁光标，30fps 合并刷新
- 思考行：运行中自动展开并计时（“思考中 · 3s”），结束后折成一行，点开看完整推理
- 工具行：动词 + 目标 + （运行中转圈 / 毫秒 / 失败标记 / `+N −M` 改动量 / 内含调用数），
  运行时自动展开显示实时输出；编辑类工具展示带颜色标记的 diff；输出可选中
- 失败/取消：错误行 + 重试；中断的轮次留“已停止”标记
- 每轮操作：复制提问、把提问放回输入框、从这里分叉、复制回复、重试
- 刻度定位轴：对话右缘按轮次排列刻度，长会话自动均匀取样（最多 24 个）；
  点刻度滚到对应位置，滚离末尾时右下角出现「跳到最新消息」
- 修改摘要：每轮结束按文件归并编辑/写入，显示「修改 N 个文件 +X −M」，点开列出路径与单文件改动量，再点路径在编辑器里打开
- 待办条：Agent 的 todo 工具一更新，输入框上方显示进度与当前任务，点开看全部条目，可清除
- 并行问询（`Ctrl+Shift+A`）：在独立会话里问一个问题，可带上主会话最近 6 轮背景；答完可插入输入框、复制或打开问询会话
- 生成图片：命令面板「生成图片…」选供应商与模型、写画面描述、尺寸与数量（1/2/4 张），走 OpenAI 兼容的 `/images/generations`；填「参考图」则改走 `/images/edits` 按描述修改这张图；可连续「再生成」多张、点缩略图选择，结果可插入输入框随消息发送或保存到当前项目
- 视觉桥：命令面板「描述图片…」选一张图（或填路径）、写问题、填视觉模型，走 OpenAI 兼容的 `/chat/completions` 图片输入；返回的描述可复制或插入输入框，给不支持图片的模型读图用；供应商与模型选择会记住
- 计划模式：输入区左侧切换；开启后下一轮先出分步计划，答完可「执行计划」「逐步执行」或「修改计划」；逐步执行会把编号/列表步骤一条条发出去，每步之间询问是否继续
- ACP 会话：命令面板「新建 ACP 会话…」选择内置或自定义预设，外部 CLI 的流式回答与工具调用进入同一时间线，权限请求走应用对话框
- ACP 工具：按 CLI 上报的 `kind` 显示「读取/编辑/运行/搜索…」，`locations` 作为目标路径，工具输出取内容块文本
- ACP 命令：CLI 上报可用命令后，输入区出现命令菜单，点一条插入 `/name` 到输入框
- 项目默认 ACP 预设：新建 ACP 会话会记住上次选的预设；「新建 ACP 会话」直接用它，另有一条「选择预设…」可改，预设对话框里可清除默认
- ACP 徽章：输入区显示预设名与当前模式，小圆点表示连接/运行/失败状态；CLI 上报模式列表后点徽章即可切换（`session/set_mode`）
- ACP 重连：进程退出会标记会话并记录日志，命令面板「重新连接 ACP」可在不关标签的情况下重新拉起
- ACP 完成时和 pi 一样发系统通知/飞书消息，并在结束时写归档
- ACP 权限记忆：选择「始终允许/始终拒绝」后，同一工具不再重复询问，并随归档保留到下次启动；命令面板可清除记忆
- 导出：概览里的「导出…」可选自包含 HTML、Markdown 文件或复制 Markdown；都写到数据目录的 `exports/`（或剪贴板），不依赖 CLI 自己导出
- 一轮结束折叠成“用时 X · N 个工具调用”
- 输入区：Enter 发送 / Shift+Enter 换行；运行中回车变“引导”；空输入时按钮变“停止”
- 模型菜单：按供应商分组、显示供应商名与上下文大小、每行可星标收藏（收藏置顶）、可搜索；
  底部「刷新模型」重新向 pi 读取模型与思考档（改完 models.json 或登录后不用重启会话）
- 输入框底部：项目切换菜单、pi 就绪指示、用量面板（上下文条、输入/输出/缓存、费用、轮次/工具数、压缩与打开面板）
- 粘贴/拖入图片；右侧文件抽屉点文件打开编辑器，右键可插入 `@路径`
- 命令面板（`Ctrl+K`）：会话/工作区/外观/文件/插件命令
- 提示词库（`Ctrl+Shift+P`）：分类、搜索、一键放进输入框；当前草稿可存为新提示词；可从 http(s) 链接导入 JSON/YAML 提示词包，按标题去重
- 全局搜索（`Ctrl+Shift+F`）：搜所有 pi 会话与 ACP 归档的标题与正文，结果显示匹配片段，点开即进入会话

**文件编辑器**
- 点文件抽屉里的文件，中央区域换成编辑器：语法高亮、行号、折叠、查找替换、多光标
- `Ctrl+S` 保存，`Ctrl+W` 关闭；未保存时标签有圆点，关闭或重新读取前会确认
- 底部状态栏显示路径、语言与是否已保存；工具栏可重新读取、在文件管理器中显示
- 只编辑本机项目的文本文件；超过 4 MB 或二进制文件会给出原因而不是半打开
- 文件树显示 Git 状态：M/A/D/?/U 字母标记，折叠的目录有改动时显示圆点
- 文件树右键：新建文件（建完直接在编辑器打开）、新建文件夹、重命名；重命名会同步编辑器里已打开的文件
- 右键文件：在内置编辑器或外部编辑器打开、插入 `@` 路径、在文件管理器中显示、复制相对路径
- 外部编辑器：自动探测 VS Code / Cursor / Windsurf / Zed / Sublime / JetBrains 系列；也可在 设置 → 环境 填自定义命令

**终端**
- 底部终端面板（`Ctrl+Shift+T` 或标题栏按钮），可拖动上沿改高度，关闭面板后 shell 继续运行
- 多标签：新建、切换、关闭、重启、清屏；标签跟随程序标题
- 真 PTY + Ghostty 终端模拟器（NSGo `base/terminal`）：颜色、宽字符、滚动回看、程序自绘 UI
- 终端配色跟随应用主题：底色、文字、光标与 ANSI 常用色取自当前调色板，浅色/深色各自成立
- 在项目目录打开；本机、WSL、SSH 三种目标各自起 shell
- 搜索（高亮、上一个/下一个）、复制/粘贴/全选、右键菜单

**Git**
- 右侧 `Git` 抽屉：分支、上游、领先/落后数，获取 / 拉取 / 推送（无上游时一键发布到 `origin`）
- 改动分「已暂存 / 更改」，逐文件暂存、取消暂存、丢弃；全部暂存 / 取消暂存；未跟踪与冲突状态
- 提交框：多行说明、提交、全部提交、修订上次提交；空说明与无暂存时禁用
- 历史：默认最近 50 次提交，可「加载更多」到 500；可按标题/作者/哈希搜索；点开看完整补丁（统一 diff、可选中复制）
- 分支菜单：切换本地分支、列出远程分支（点击创建并切换到跟踪分支）、新建并切换
- 其他：初始化仓库、贮藏全部改动 / 恢复最近贮藏、丢弃全部改动
- 同一套操作跑在本机、WSL、SSH 目标上；面板每 4 秒自动刷新状态

**远程访问**
- 设置 → 远程：开启手机服务，设置端口、访问令牌；每个地址可「复制链接」或显示二维码
- 三种连接方式：局域网（本机所有非回环 IPv4）、Tailscale（读 `tailscale status` 的 100.x 地址）、
  EasyTier（读 `easytier-cli` 的虚拟 IP，读不到时可手动填写）
- 手机端连接后浏览电脑上的项目、会话和会话历史，列表每 2.5 秒刷新（会话运行中 1.2 秒）；界面跟随手机系统语言（简中/繁中/英文），可用 `PIDECK_LITE_LANG` 覆盖
- 手机端能做的会话操作：
  - 新建：标题栏「+」，只有一个项目时直接建，多个项目时先选项目；建完直接进对话
  - 搜索：标题栏放大镜。先按标题过滤，同时去电脑上搜**所有会话的消息内容**
    （≥2 个字，300ms 防抖，命中显示片段；点一下进那个会话并直接落到匹配处）；
    会话内还能再按内容过滤已加载的消息
  - 失败重试：最后一轮失败时，输入框上方出现「重试上一条」
  - 扫码连接：连接页「扫码连接」调系统相机拍桌面上的二维码，自动填地址和令牌并连接；
    没有相机或想用截图时，「从相册选二维码」也能读
  - 记住连接：连过的服务器存在手机里，连接页「最近连接」一键重连（最多 5 个）
  - 项目：标题栏「⋯ → 添加项目…」按电脑上的文件夹路径添加，长按项目标题可移除
    （只从侧栏移除，文件不动）；没有会话的项目也会列出来，点一下就能在里面新建
  - 行内「…」：重命名、置顶 / 取消置顶、删除（删除会二次确认，文件进电脑的 `trash/`）
  - 发消息：底部多行输入框（自动换行长到 5 行左右，回车换行，发送键发送）；
    运行中多一个停止键（不挡输入，pi 会排队），回复按 1.2 秒轮询流式出现
  - 审批：电脑上的 pi/ACP 在等确认或选项时，输入框上方出现提示卡，
    可直接允许/拒绝或选一项，答案回传电脑让那一轮继续
  - Git：项目标题右侧的分支按钮打开仓库面板，显示分支、上游、领先/落后与改动文件；
    点分支行切换本地分支，获取/拉取/推送三个按钮同步；文件可暂存/取消暂存、
    点右侧箭头看补丁，写一句说明即可提交（只提交已暂存的内容）
  - 工具调用折成一行「调用了 N 个工具」，点开原地展开每条命令
  - 图片：输入框右侧的图片按钮从相册/文件里选（最多 4 张、单张 6 MB），
    选完在输入框上方出缩略图，点缩略图移除；可以只发图不写字
  - 长按任意消息复制；往上翻后右下角出现「最新」，点一下回到底部
  - 会话列表下拉刷新
  - 模型与思考：输入框上方一行显示当前模型和思考等级，点开是原生底部弹层，
    可切模型（按供应商分组）和 low/high/max
- 令牌鉴权；链接含令牌；pi 自己的会话只能在电脑上删除

**手机端的接口**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/ping` | 主机名与版本，连接时探活 |
| GET | `/api/state` | 项目、会话、置顶、运行状态与等待回答的问题 |
| GET | `/api/session/{id}` | 一个会话的消息；运行中带 live 文本，等待回答时带 `ask` |
| GET | `/api/session/{id}/options` | 模型列表、当前模型、思考等级；pi 没起会顺手拉起 |
| GET | `/api/search?q=&project=` | 跨会话搜消息正文，返回会话、标题与片段（按文件缓存） |
| GET | `/api/git?project=` | 项目的分支、上游、领先/落后与改动文件（只读） |
| GET | `/api/git/diff?project=&path=` | 一个改动文件的补丁；只接受仓库已报告的路径 |
| POST | `/api/git/stage` | `{project,path,stage}` 暂存或取消暂存一个文件 |
| POST | `/api/git/commit` | `{project,message}` 提交已暂存的内容 |
| POST | `/api/git/checkout` | `{project,branch}` 切换本地分支 |
| POST | `/api/git/sync` | `{project,action}` 获取 / 拉取 / 推送 |
| POST | `/api/projects` | `{path,remove}` 在电脑上添加/移除项目文件夹 |
| POST | `/api/sessions` | `{project}` 新建会话，返回 `{id,title}` |
| POST | `/api/sessions/{id}/prompt` | `{text,images:[{mime,data}]}` 发一条消息；运行中自动改成 steer |
| POST | `/api/sessions/{id}/stop` | 停止当前一轮 |
| POST | `/api/sessions/{id}/rename` | `{title}` 改名 |
| POST | `/api/sessions/{id}/pin` | `{pinned}` 置顶或取消 |
| POST | `/api/sessions/{id}/model` | `{provider,id}` 切模型 |
| POST | `/api/sessions/{id}/thinking` | `{level}` 切思考等级 |
| POST | `/api/sessions/{id}/answer` | `{confirmed}` / `{value}` / `{cancelled}` 回答电脑上等待的确认、选项或输入 |
| POST | `/api/sessions/{id}/delete` | 删除会话（pi 自己的会话会拒绝） |

**会话与数据**
- 应用自己的会话目录（pi 原生格式），重启恢复标签与历史
- **项目下的 pi 本地会话**：只读当前项目的目录，与项目会话合并后按时间分组；
  默认显示 10 条，「更多」每次展开 40 条，展开后可「收起」；点会话用
  `--session <file>` 继续；设置里可切换成“扫描所有项目”
- 加载占位：项目历史与项目会话数量在读取时显示 pulse 骨架；打开历史会话时，
  正文区先显示加载骨架，读完再淡入内容
- 导入会话：pi 的 `.jsonl` 直接复制；Codex rollout 与 Claude Code 日志会转换后写入应用目录；原文件不动；删除进 `trash/`
- 配置 `config.json`：工作区（含目标）、标签、收藏、默认模型与思考等级、主题、标题、键位、停用的插件、插件设置、智能体绑定、代理、生图供应商/模型/尺寸；旧文件读取时自动迁移并回写，越界的枚举/尺寸/端口会重置

**目标：本机 / WSL / SSH**
- 探测：`pi --version`、`wsl -l -q`、`~/.ssh/config` 的 Host，逐个试 `command -v pi`
- WSL：`wsl.exe -d <distro> --cd <dir> -- sh -lc 'exec pi …'`，会话存该发行版的
  `~/.pideck-lite/sessions`
- SSH：`ssh -o BatchMode=yes <host> "cd <dir> && exec pi …"`，同样远端存会话
- 设置页显示每台机器的 pi 路径/版本与错误，可重新探测

**设置**（左栏分类，右侧一行一条，控制项在行尾）
- 通用：新会话默认模型/思考等级、项目下是否列 pi 本地会话、是否扫描所有项目、界面语言
  （跟随系统 / 简体中文 / 繁體中文 / English）
- 对话内容宽度：设置 → 界面里的滑块在 520–720 pt 之间调整正文与输入框的最大宽度，
  拖动即生效并写进 `config.json`（720 为默认，不写入）
- 设置搜索：侧栏顶部输入关键词（中英文均可），结果直接跳到对应分区；命令面板里每个设置项
  也是一条命令（「设置 · 名称」），搜索后回车直达对应分区
- 模型与认证：供应商列表（模型数、API、BaseURL）、`pi auth check` 的就绪状态、
  复制登录命令、常用模型（收藏）管理
- 供应商配置：点供应商右侧的设置按钮改 `api` / `baseUrl` / `apiKey`（只写这三个字段，
  其余保持原样），可一键测试连接（先探 `/models`，再退到一次最小 chat 请求），
  也可查询余额（OpenRouter / Moonshot / DeepSeek / SiliconFlow 按 BaseURL 或供应商 ID 识别；
  其他供应商可在供应商配置里填「余额接口 / 余额字段 / 余额货币」，字段是 JSON 路径，支持数组下标）
- 原始配置：直接在内置编辑器里打开 `models.json` / `settings.json` / `auth.json`
- 外观：配色（跟随系统/纸白/炭黑/用户主题，每项带一张配色缩略图）、打开主题目录、
  把当前配色导出成主题文件（含 tokens、字体与圆角）
- 环境：pi 路径与版本、pi 会话目录、WSL 发行版与 SSH Host 的检测结果、添加远程工作区；网络代理分「应用请求」与「Agent 进程」两栏，另可填直连名单
- 扩展：插件列表与命令、插件声明式设置（开关/文本/数字/单选）、插件市场、打开插件目录、重新加载
- MCP：设置 → MCP 列出 pi 的 MCP 服务器（状态、传输、工具数、错误），可添加 HTTP 地址或启动命令、移除；配置由 pi 保存在 `mcp.json`
- 集成：飞书群自定义机器人；一轮结束把标题、状态与一句摘要发到群里，可填签名密钥并测试；
  也可接收群消息（事件订阅指向 `/api/feishu`，校验 Verification Token），消息发给当前会话，
  开启「把回答发回群」后把这一轮的回答发回群里
- 诊断：运行中的 pi/终端进程、goroutine 与堆、最近日志；可复制诊断报告、导出诊断包（zip，含报告/脱敏配置/日志尾部/插件列表）、打开日志目录、清空内存日志
- 崩溃：界面外层有错误边界，任一屏 panic 时写崩溃日志（数据目录 `crashes/`）并显示「重新加载界面」，
  应用不退出；启动时若发现上次崩溃会提示一次，设置 → 诊断可查看最近崩溃与日志数量
- 资源：pi 的技能（读 `SKILL.md` 的 name/description，点开在编辑器里看）与扩展
  （内置 / npm / 本地 `.ts`），可启停；打开技能/扩展目录、重新读取；「技能商店…」从
  `{skills:[{id,name,url}]}` 索引一键安装 SKILL.md 到 pi 的 skills 目录
- 数据：应用/会话/pi 会话目录、会话数量、配置版本；「导出设置包」把配置/插件/主题/提示词/智能体/ACP 预设打成 zip，「导入设置包」恢复（同名覆盖，部分设置重启后生效）
- 用量：从本地 pi 会话与 ACP 归档统计累计 tokens 与费用、最近 12 周热力图、模型与项目分布；
  ACP 的 token 按文本长度估算、费用记为 0；只在本机计算，可手动重新统计
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
- 命令面板 `Ctrl+K`；快捷键面板 `Ctrl+/` 按分组列出全部键位，可搜索；键位可在 设置 → 键位 里逐条改，留空取消绑定，可一键恢复默认；插件也能声明键位
- 系统托盘：关闭窗口默认留在托盘，Agent 继续跑；托盘菜单可恢复窗口、新建会话、跳到运行中的会话、打开设置、退出
- 桌面宠物：小浮窗显示运行中/出错的会话数，工作中会呼吸；点它回到主窗口；可在设置里开关
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
| `file_ops.go` | 文件操作：新建文件/文件夹、重命名的对话框与落盘 |
| `editor_host.go` | 内置编辑器：打开的文件、读写、未保存状态、语言识别 |
| `ui_editor.go` | 编辑器界面：文件标签、工具栏、状态栏、编辑器配色 |
| `git.go` | Git 后端：porcelain v2 状态、日志、分支、提交/同步/贮藏等操作，本机与远端命令 |
| `ui_git.go` | Git 抽屉：分支菜单、改动列表、提交框、历史、补丁与新建分支对话框 |
| `term.go` | 终端会话：Ghostty 终端、本机/WSL/SSH shell、标签生命周期与搜索 |
| `ui_term.go` | 底部终端面板：标签栏、搜索栏、右键菜单、可调高度 |
| `acp.go` | ACP 客户端：stdio NDJSON JSON-RPC、握手、会话、提示与权限请求 |
| `acp_session.go` | ACP 会话：预设选择、事件投影、权限对话框与停止 |
| `export.go` | 本地导出：HTML 自包含页面与 Markdown（含工具摘要），以及导出选择对话框 |
| `acp_presets.go` | ACP 预设：内置三个，另读数据目录 `acp/*.json` 的自定义命令 |
| `acp_archive.go` | ACP 归档：本地投影、2000 轮/8 MB 上限、原子写与恢复 |
| `editor_ext.go` | 外部编辑器：探测常见编辑器、按命令打开文件或项目 |
| `diag.go` | 诊断：内存日志、滚动文件、进程列表与诊断报告 |
| `diag_bundle.go` | 诊断包：zip 打包、配置脱敏、日志尾部与插件清单 |
| `crash.go` | 崩溃日志：写入 `crashes/`、查找最近崩溃、记录数据目录 |
| `ui_crash.go` | 错误边界界面：panic 摘要、重新加载、打开/复制日志 |
| `imagegen.go` | 生图：OpenAI 兼容 `/images/generations`，b64/URL 两种返回 |
| `ui_image.go` | 生图对话框：供应商/模型/尺寸、预览、插入输入框或保存项目 |
| `vision.go` | 视觉桥：图片以 data URL 进 `/chat/completions`，解析字符串/分段回答 |
| `ui_vision.go` | 视觉桥对话框：图片路径、问题、视觉模型、描述结果 |
| `pet.go` | 桌面宠物：会话状态聚合、小浮窗与开关 |
| `feishu.go` | 飞书群机器人：签名、发送与一轮完成通知 |
| `feishu_inbound.go` | 飞书事件回调：解析 v1/v2、验证 Token、转成会话提问并把回答发回群 |
| `netproxy.go` | 网络代理：应用请求与 Agent 进程分开，HTTP 客户端与进程环境变量 |
| `agents.go` | 内置/自定义智能体：提示词前缀、选择对话框、会话绑定与持久化 |
| `trust.go` | 项目信任：迁移、信任/撤销、发送前确认与输入区提示条 |
| `plan_steps.go` | 计划逐步执行：步骤解析、下一步判断与继续/停止对话框 |
| `forks.go` | 分叉树：根查找、家族遍历与树形对话框 |
| `events.go` | 应用事件总线：订阅、插件 hooks、`${event:…}` 占位符与防递归 |
| `market.go` | 插件市场：索引读取、单文件清单下载与安装 |
| `ui_market.go` | 插件市场对话框：索引链接、条目列表、安装状态 |
| `prompts_store.go` | 提示词商店：索引读取与整包导入 |
| `ui_prompts_store.go` | 提示词商店对话框：索引链接、包列表与导入状态 |
| `skills_store.go` | 技能商店：索引读取、SKILL.md 下载与安装到 pi 的 skills 目录 |
| `ui_skills_store.go` | 技能商店对话框：索引链接、技能列表与安装状态 |
| `mcp.go` | MCP：`pi mcp list/add/remove` 的调用与参数拼装 |
| `backup.go` | 设置包：zip 导出/导入、路径校验与大小上限 |
| `settings_index.go` | 设置索引：每个设置的分区、标题与搜索关键词 |
| `ui_mcp.go` | MCP 设置页：服务器列表、添加对话框与移除确认 |
| `projects.go` | 项目分组、置顶、排序与顺序持久化 |
| `ui_projects.go` | 项目分组对话框：名称输入与已有分组建议 |
| `import_ext.go` | 导入 Codex / Claude 会话：识别格式、提取消息、写成 pi 会话 |
| `search.go` | 全局搜索：会话索引、标题/正文匹配、片段截取与打开 |
| `ui_search.go` | 全局搜索对话框：输入、结果列表与索引重建 |
| `ask.go` | 并行问询：后台会话、上下文拼装、等待答案与回填 |
| `ui_ask.go` | 并行问询对话框：问题、背景开关、答案与操作 |
| `prompts.go` | 提示词库：播种起步包、读 JSON/YAML、搜索、保存草稿与从链接导入 |
| `ui_prompts.go` | 提示词库对话框：分类、搜索、列表与插入 |
| `ui_shortcuts.go` | 快捷键面板：分组、搜索、键位胶囊与设置入口 |
| `pi_resources.go` | pi 的技能与扩展：读 SKILL.md、settings.json 的扩展列表与启停 |
| `ui_resources.go` | 设置里的资源页：技能列表、扩展开关、目录入口 |
| `i18n.go` | 界面语言：系统语言匹配、源文本查表、设置与命令面板的翻译目录 |
| `usage.go` | 本地用量统计：读会话文件、按天/模型/项目归并、热力图分级 |
| `ui_usage.go` | 设置里的用量页：累计卡片、12 周热力图、模型与项目榜 |
| `desktop_host.go` | 系统托盘、关闭到托盘、完成通知与各平台通知命令 |
| `remote.go` | 手机 HTTP 服务、令牌、快照/历史接口，局域网/Tailscale/EasyTier 地址探测 |
| `remote_client.go` | 手机端 HTTP 客户端与连接串解析 |
| `mobile.go` | 手机端连接页、项目/会话列表、会话历史、发消息与审批 |
| `mobile_git.go` | 手机端 Git：分支切换、改动列表、补丁、暂存、提交与同步 |
| `ui_remote.go` | 桌面设置里的远程访问面板 |
| `scripts/android.ps1` | 模拟器日常操作：启动、装包、复制连接链接、看状态 |
| `ui.go` | 侧栏、标签、抽屉、命令面板、目标/重命名/确认/扩展对话框 |
| `ui_menu.go` | 统一的菜单卡片、会话/项目右键菜单、模型/用量/项目弹层 |
| `ui_settings.go` | 设置窗口：左栏分类 + 分节行（通用/模型与认证/外观/环境/扩展/数据/关于） |
| `providers.go` | 读 pi 的 models.json、编辑供应商字段、`pi auth check` 探认证、连接测试与余额查询 |
| `ui_provider.go` | 供应商配置对话框：字段、模型列表、连接测试、余额查询、原始 JSON 入口 |
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
- 「导入提示词包…」填一个 http(s) 链接（2 MB 上限），支持 `{prompts:[…]}` 或裸数组，`body` 与 `prompt` 两个字段名都认；导入写进 `user.json`，与已有标题重复的会跳过
- 「提示词商店…」填一个索引链接（`{packs:[{id,name,url}]}` 或数组），加载后一键导入整包；已导入的包会标记

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
    "settings": [
      {"key": "lang", "label": "回答语言", "type": "select", "default": "zh", "options": ["zh", "en"]}
    ],
    "commands": [
      {"id": "review", "title": "跑测试并总结失败", "group": "团队", "icon": "terminal",
       "action": {"type": "prompt", "prompt": "用 ${setting:lang} 跑一遍测试，把失败项按文件列出来。"}},
      {"id": "open-docs", "title": "打开团队文档", "icon": "globe",
       "action": {"type": "url", "url": "https://example.com/docs"}},
      {"id": "compact", "title": "压缩上下文", "icon": "zap",
       "action": {"type": "command", "command": "compact"}}
    ],
    "themes": ["themes/team-blue.json"],
    "keybindings": [{"command": "review", "key": "mod+shift+r"}],
    "agents": [
      {"id": "review", "name": "团队审查", "description": "按团队规则审查", "prompt": "按团队规则逐条审查，先列问题。"}
    ],
    "hooks": {
      "turn.done": [{"type": "url", "url": "https://example.com/done?s=${event:session}"}]
    }
  }
}
```

- `action.type`：`prompt` / `insert` 填进输入框，`send` 直接发送，`command` 执行内置命令，
  `url` 打开 http(s) 链接，`theme` 切换主题（可写 id 或显示名）
- `contributes.hooks` 让插件在事件上做事：`turn.start` / `turn.done` / `session.created` /
  `session.opened` / `session.deleted` / `theme.changed` / `plan.finished` / `git.commit` /
  `image.generated`，动作只允许 `url` / `command` / `theme`（不能起新一轮，避免自激）；文本里可用
  `${event:session}` / `${event:title}` / `${event:project}` / `${event:status}` / `${event:answer}`
  等字段，事件各自的字段（`origin`、`plan`、`steps`、`message`、`provider` 等）也按同名取用
- `contributes.agents` 给智能体选择器加条目：`id` / `name` / `prompt` 必填，`description` 可选；
  会话里保存为 `<插件 id>:<agent id>`，条目上标出插件名；禁用插件后它带来的智能体一起消失
- `contributes.settings` 声明插件设置：`type` 为 `bool` / `string` / `number` / `select`，
  `select` 需要 `options`；设置显示在 设置 → 扩展 的插件条目下，值存 `config.json` 的
  `pluginSettings`（键为 `<插件 id>/<key>`）
- 命令的 `prompt` / `command` / `url` / `theme` 里写 `${setting:key}`，执行时替换为当前值或默认值；
  引用未声明的 key 会在设置里显示警告
- `contributes.themes` 的路径必须留在插件目录内；越界、坏命令、重复 id 会在设置里显示为警告
- 旧格式 `{"prompts": [...], "themes": [...]}` 仍然可用，提示词会自动变成 `prompt` 命令
- 命令 id 在插件内唯一；面板里显示为 `plugin:<插件 id>:<命令 id>`
- 插件可以在 设置 → 扩展 里整体启用/禁用，禁用后命令、主题、键位都不加载
- 插件市场：设置 → 扩展 →「插件市场…」填一个索引链接（`{plugins:[{id,name,url}]}` 或数组），
  点「安装」把单文件清单下载到 `plugins/`；只安装声明式清单，不执行代码

插件命令出现在命令面板里，选中后按 `action` 执行。插件不运行代码，所以一个坏插件最多是没用的，
不会碰到项目文件。

## 语言

界面文案以中文为源文本，按源文本查翻译；没有译文的条目原样显示中文，所以新界面可以先上线再补翻译。
当前覆盖设置页、命令面板、托盘菜单、键位页，以及主界面的侧栏、欢迎页、输入框、抽屉、空对话、右键菜单、常用对话框、Git 面板与终端面板；手机端的连接页、会话列表、对话、输入区与 Git 也已迁移，其余提示逐步补。
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
- 子代理/工作流视图未做；MCP 的 OAuth 登录与原始文件编辑未接
- 消息不能就地改写或删除（pi 的 RPC 没有这个能力）；提供「把提问放回输入框」与重试
- 计划模式靠提示词约定，不是 pi 的原生协议；「执行计划」是一条后续消息，「逐步执行」按编号/列表项一条条发并逐条确认
- ACP 会话的本地归档最多 2000 轮/8 MB；重启时先试 CLI 的 `session/load`，失败则用新 CLI 会话接着聊，归档仍可浏览
- 全局搜索对 ACP 归档每个会话只取前 16 KB 文本，和 pi 会话同一口径
- ACP 用量是文本长度估算（CJK 每字 1 token，其他约 4 字符 1 token），不代表 CLI 的真实计费
- 本地 HTML 导出按纯文本保留换行，不渲染 Markdown；Markdown 导出保留回答原文；pi 会话的 HTML 仍优先用 pi 自己的导出
- ACP 的模型与思考等级由该 CLI 自己管理；预设依赖 `npx` 与网络
- 自定义 ACP 预设是手写 `acp/*.json`，没有图形化编辑器；格式为 `{"presets":[{"id","name","command","args"}]}` 或顶层数组
- ACP 权限记忆跟着归档走；删除归档或执行「清除 ACP 权限记忆」后重新询问
- 项目默认 ACP 预设就是上次使用的预设；没有单独的设置页，只能在预设对话框里清除
- ACP 进程退出后不会自动重启，需要发下一条消息或执行「重新连接 ACP」
- Codex / Claude 导入只保留用户与助手文本；工具调用、思考与附件会丢掉，能否继续运行取决于 pi 对转换后消息的接受程度
- 项目分组暂不支持拖拽；用右键菜单的上移/下移与「移动到分组…」调整
- Git 历史一次最多读到 500 条；更早的提交需要按条件筛选或到终端查看
- 远程分支只能检出为本地跟踪分支，不能在面板里新建或删除远程分支
- 分叉树是层级列表，不是可折叠的画布；重试是“把同一条提示再发一次”
- 远端目标（WSL/SSH）不列远端历史会话，只按标签恢复；文件抽屉与编辑器只处理本机文件
- 编辑器不写远端文件；超过 4 MB 或二进制文件只提示，不打开
- Git 的凭据提示走不了 GUI：HTTPS/SSH 需要先在终端里登录或配好密钥
- 供应商连接测试是轻量探测（`/models` 或一次最小 chat 请求），不等于完整模型可用性验证
- 系统通知是尽力而为：macOS 用 `osascript`、Linux 用 `notify-send`、Windows 用 PowerShell 的 WinRT 通知；系统关掉通知权限时不会补发
- 资源页的扩展开关只改 `settings.json`，重启 Agent 后生效；本地 `.ts` 扩展自动加载，不能在此停用
- 翻译覆盖设置页、命令面板、托盘、键位、主界面外壳、右键菜单与常用对话框；手机端界面与部分提示消息仍为中文，按 `i18n.go` 的目录逐步补
- 飞书集成默认只发摘要；接收群消息需要远程服务对外可达、填 Verification Token，且只发给当前会话（没有会话时新建内置对话），回答最多回传 1500 字
- 桌面宠物只有内置造型与状态色，不支持 petdex 社区宠物包
- 日志文件超过 1 MB 时轮转一次（`pideck.log` → `pideck.log.1`）；没有日志级别设置
- 外部编辑器只在本机可用；打开时不开终端，编辑器自己的报错不会回传
- 用量统计最多读最近 3000 个会话文件，按会话 ID 去重；导入副本与移动过的文件可能让统计略有偏差
- 全局搜索索引同样最多 3000 个会话、每个会话取前 16 KB 文本；更早或更长的内容需要「重建索引」后再搜
- 手机端不支持：会话内逐条跳转（命中后是过滤展示，不是滚动定位）；
  发出去的图片在会话里只显示「［图片］」占位
- 手机端只列本机项目（WSL/SSH 目标的项目不出现）
- 局域网连接走 HTTP + 令牌，Tailscale/EasyTier 的链路本身加密
- 草稿与附件不跨重启保存；单窗口
