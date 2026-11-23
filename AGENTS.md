# AGENTS.md — PiDeck V2 工程规范

本文件约束在本仓库工作的编码代理（含子代理）。它与 `ARCHITECTURE.md`（包边界与状态所有权）、
`CONTRIBUTING.md`（提交与验证流程）配套。冲突时优先级：本次用户指令 > 本文件的硬约束 >
`ARCHITECTURE.md` > `CONTRIBUTING.md`。

目标不是"能跑就行"，而是：**改动最小、事实单一、边界不破、扩展点归位、验证可复现**。

## 1. 项目事实（决定了所有取舍）

- 一个 Go 二进制、两个宿主。桌面宿主 `internal/workbench` 拥有 pi/ACP 进程、文件、Git、终端与
  回环 HTTP 服务；客户端宿主 `internal/client` 是 Android / iOS / Web(WASM)，只能走 HTTP。
- 会话归 pi 所有：应用读写自己的会话目录，绝不改写 pi 在别处打开的会话文件；ACP 归档是投影，
  不是真相。
- 外部契约不随手改：pi RPC 的 JSONL、ACP 的 JSON-RPC、`models.json` / `auth.json` /
  `settings.json`、`internal/remotewire` 的 JSON、`config.json`（`configVersion`）、插件清单 v2、
  主题文件、`tasks.json` / `favorites.json` / `acp/presets.json`、`trash/`。
- 目标平台：六个发布目标（`windows_x64`/`arm64`、`macos_x64`/`arm64`、`linux_x64`/`arm64`）由 CI
  交叉编译；本机常用 `windows_x64`、`macos_arm64`、`android_arm64`/`android_x64`、
  `ios_simulator`、`web`。Web 产物有 **12 MB** brotli 预算，CI 硬门禁。
- 门禁：`internal/architecture/structure_test.go` 解析所有平台的源文件（包括当前主机不构建的），
  `internal/apptext` 的测试守护文案与翻译覆盖，`TestSourceFileSize` 守护文件规模。

### 从 PiDeck 复刻得到的教训

1. 复刻不是照抄 Electron 的分层：浏览器 webview、CUA 桌面注入、视频壁纸这类能力先在 NSGo 侧
   定方案，不要先写调用方。
2. 会话文件是唯一真相：所有 UI 状态都由文件或 pi 响应派生，别在内存里养第二份。
3. 外部 CLI 的字段多代并存，适配层只做只读宽容，不改出站协议。
4. 任何落盘都先写临时文件再重命名；大会话按增量读，不整份重解析。
5. 文案与翻译是产品契约，新增一条中文就必须补齐六个目录，否则测试直接失败。

## 2. 硬约束（违反即返工，不讨论）

| 编号 | 约束 | 判定方式 |
| --- | --- | --- |
| H1 | `internal/sessionimport` 所有 Go 文件及 `internal/workbench` 生产文件首行必须是 `//go:build !js && !android && !ios` | `TestDesktopBuildConstraints` |
| H2 | 依赖只能朝 `ARCHITECTURE.md` 的表指向；新增包必须同时改表与 `structure_test.go` 的 `dependencies` | `TestDependencyLayers` |
| H3 | 生产 Go 文件 ≤ 800 行，测试文件 ≤ 1000 行；超过 400 行且出现第二种职责就拆 | `TestSourceFileSize` |
| H4 | `internal/client` 不得导入 `workbench`、`sessionimport`、SQLite、`os/exec` 或任何桌面能力 | H2 + wasm 预算 |
| H5 | 不得把桌面代码带进 Web 产物；`webassets/site/` 是生成物，不手改、不提交 | CI wasm 预算 |
| H6 | UI 线程不做磁盘、网络、子进程与长计算；结果用 `cx.Post` 回到图；用户可感时长用 `cx.Now()` | 代码审查 |
| H7 | 每个事实只有一个来源：`turn.running()` 决定是否在跑；会话文件、配置、pi 响应各自拥有自己的值 | 代码审查 |
| H8 | 不改外部文件格式与凭据语义；必须改时带版本号与迁移测试（参考 `config_migrate.go`） | 代码审查 + 测试 |
| H9 | 新增依赖必须先说明理由并单独确认，不在功能补丁里顺带引入 | 差异检查 |
| H10 | 不新增 `utils`、`common`、`helpers`、`models`、`global` 这类无边界包 | `TestDependencyLayers` |

## 3. 开发流程

### 3.1 动手前（只读）

1. 读 `ARCHITECTURE.md` 中与任务相关的包，再读该包里**同类**功能的现有实现，照它写。
2. 确认这件事是否已有扩展点（见第 5 节）。有就归位，没有才讨论新机制。
3. 写出完成条件与最短验证路径：改哪个文件、跑哪条命令、看到什么算通过。
4. 只碰任务需要的文件。发现无关缺陷时记录，不顺手修。

### 3.2 设计取舍

- 先问"需要吗"，再问"仓库里已有吗"，再问"标准库或已装依赖够吗"，最后才写新代码。
- 抽象要等第二个使用者。一个调用点不抽接口、不建工厂、不加配置项、不留兼容分支。
- 新增能力优先落成**数据**而不是代码：命令、设置、主题、预设、导入源、文案都能声明式扩展。
- 行为变化配一条能复现原问题的测试；纯文案、生成物和机械重构用与风险匹配的验证。
- 需要改外部契约、新增包、新增依赖、删除用户数据时，先说清方案与影响再动手。

### 3.3 验证分级（只跑能证明本次改动的那一档）

| 改动 | 必跑 |
| --- | --- |
| 单包纯逻辑 | `go test ./internal/<pkg> -run <Test> -count=1` |
| `workbench` 行为 / UI | `go test ./internal/workbench -run <Test> -count=1`；必要时 `go tool nsgo test -- -run <Test> -count=1` |
| 跨包、契约、i18n、结构 | `go tool nsgo check` + `go tool nsgo test -- -short -count=1 -timeout=20m` |
| 客户端 / Web | `go run ./scripts web`（顺带验证 wasm 体积） |
| 桌面目标 | `go tool nsgo build -target windows_x64`（只构建本次涉及的目标） |

- 禁止全仓库 `go build ./...`、全平台构建或会触发全量编译的门禁脚本，除非用户本次明确要求。
- 不需要按平台验证时不要跑 `-target` 矩阵。
- 声称"修好了""通过了"之前，只跑能直接证明该声明的最窄验证。
- 同一工作区内的 NSGo build/check/test 必须串行；Windows 构建会在模块根临时写入并删除 `.syso`，并发会互相干扰。不同 CI job 或不同 worktree 可并行。

### 3.4 收尾

- `gofmt -w` 改过的文件；`git diff --check` 通过。
- 提交信息沿用 `<领域>: <中文一句话>`（如 `导入：…`、`fix: …`），一个提交只装一个可独立验证、
  可回滚的单元。
- 检查 `git status`：不暂存、不提交、不清理与本任务无关的改动；并行改动原样保留。
- 用户可见行为、公共契约、配置语义、部署方式变化时，同步 README / `docs/ROADMAP.md`。
- 删除本任务的临时脚本与探针文件；保留的验证证据在总结里写明路径与用途。

## 4. 代码规范

### 4.1 文件与命名

- 按职责命名，沿用现有前缀：`*_state` / `*_events` / `*_actions` / `*_engine`（行为与生命周期）、
  `ui_<area>.go` 与 `_header` / `_list` / `_dialog` / `_row`（视觉区域）、
  `<source>` / `convert`（适配与转换）、`<protocol>_wire` / `<domain>_types`（传输与领域契约）。
- 同一文件只装一个可命名的职责。类型与它的小帮手跟着所有者走，不建"类型大全"文件。
- 导出要有外部使用者；私有状态保持私有。包注释写清契约、真相来源与不变量。

### 4.2 错误、日志与外部输入

- 分类用 `errors.Is` / `errors.As`，包装用 `%w`；不要让错误在中间层被 `_` 丢掉。
- 用户可见失败转成 `a.toast(...)` 或对话框，正文用 `apptext.T`；命令行的原始报错保留原文。
- 子进程与网络调用 context-first，显式超时；不用 `time.Sleep` 轮询。
- 日志走 `diagf`/诊断环，不刷屏、不打印凭据、会话正文与完整用户路径。
- 路径、令牌、远端响应都当不可信输入：校验越界、限定项目目录内、限制体积。

### 4.3 并发与信号

- 信号是 UI 的唯一事实源。在 `ContentFunc`、`StyleFunc`、`When`、`Count` 等响应式回调里读信号；
  构造函数里一次 `Get()` 只捕获一次值，别写到响应式位置。
- 后台 goroutine 不直接改图：算完用 `cx.Post` 发布结果。处理函数里刻意避开依赖时才用 `Untracked()`。
- 可取消的长任务带 `context`；锁不跨 I/O；不共享可变切片，跨 goroutine 传副本。

### 4.4 磁盘、配置与数据

- 写文件一律"临时文件 + 重命名"（参考 `store_config.go`）；凭据文件 `0o600`。
- 新增配置项要同时改：`config.go` 字段 → `appSettingFields`（类型/默认值/范围）→ `settingsIndex`（搜索）
  → `config_migrate.go`（旧文件迁移）→ 设置页 UI → README「设置」。
- 新增持久化文件要明确：是否进设置包（`backup.go`）、是否进诊断包（脱敏）、是否在 README
  「整理数据」登记、坏了如何降级。默认策略是"坏了当空、不阻断启动"。
- 不应期写盘：拖动、缩放这类交互在停下后写；热路径不落盘。
- 大会话按大小/修改时间缓存，只读新增尾部；不要为了一个小功能整份重解析会话。

### 4.5 UI 构建

- 有状态的控件用稳定 ID 作键（会话 ID、轮次 ID、工具调用 ID、步骤 ID），不用列表下标。
  展开/选中状态挂在领域对象上，不挂在临时组件实例上。
- 每个可交互控件给 `TestID` 或稳定 `Label`；这是测试契约，改名视为破坏性改动。
- 文本、尺寸、颜色与格式化从 `apptext` / `viewkit` / 主题取值；不写死像素、字号与颜色。
- 行宽、字号、行高按已有设置项走，不在局部再发明一套。
- 长列表按窗口渲染，扩窗与"加载更多"用现有模式；新增列表不得一次性渲染全部数据。

### 4.6 国际化

- 用户可见文本一律 `apptext.T("中文源文本")`，中文是源语言。
- 新增一条源文本必须补齐 `internal/apptext/locales/` 下的 `en-US`、`zh-TW`、`ja-JP`、`ko-KR`、
  `ru-RU`、`fr-FR`；缺条目会被 `TestVisibleStringsTranslated`、`TestToastTitlesTranslated`、
  `TestToastDetailsTranslated`、`TestTranslationCallsCovered` 拦住。
- 已有键改动要同步全部目录；不要用英文当源文本，也不要拼接句子（语序会坏）。
- pi / ACP 的原始报错原样显示，不翻译、不吞掉。

## 5. 扩展性规范

默认路径是"往既有扩展点里加数据"，不是"新写一套机制"。

| 要加的东西 | 落点 | 必须同步 |
| --- | --- | --- |
| 命令 | `commands.go` 的 `builtinCommands()` | 图标、分组、可用条件 `When`、需要时补键位 |
| 键位 | `keybindings.go` 的 `defaultKeybindings()` | 命令 ID 已存在；冲突检测会报告 |
| 设置项 | 第 4.4 节的五处 | 搜索关键词、默认值、范围与迁移 |
| 主题 / 配色 | `addon_themes.go` / `addon_palettes.go` / `addon_appearance.go` | 角色色、token、浅深两套对比度 |
| 插件贡献 | `plugin.json` 的 `contributes`（commands / themes / keybindings / settings / hooks / agents） | 只允许声明式动作：填提示词、执行内置命令、开链接、切主题；插件不跑代码 |
| 事件 | `events.go` 的常量与订阅者 | 文档、hook 引用写法、防递归 |
| ACP 预设 | `acp_presets.go` | 安装元数据、官网链接、启动参数 |
| 会话导入源 | `sessionimport/source.go` 注册 + 独立转换器 | 测试 fixture、`PIDECK_V2_IMPORT_*` 覆盖、README 来源列表 |
| 远程 API | `internal/remotewire` 的 DTO + `remote_http.go` 路由 | 客户端调用、令牌校验、README 接口表 |
| 文案 | `apptext` + 六个语言目录 | 第 4.6 节 |
| 共享显示逻辑 | `internal/viewkit` | 两套宿主共用，不引入桌面依赖 |

- **新机制的门槛**：现有表里放不下、并且有第二个使用者时，才允许新增扩展点；新扩展点必须是
  声明式、可校验、可降级（坏文件只丢该项，不影响启动）。
- **稳定 ID 只增不改**：命令 ID、设置键、插件 ID、事件名、远程路由、`TestID` 一旦对外发布，
  改名要同时提供兼容或迁移。
- **后端可插拔**：新后端沿 ACP 的投影模式 `wire → domain → UI`，UI 不判断后端种类；
  差异在适配层消化，出站协议不迁就某一家的字段。
- **单向依赖**：共享协议进 `remotewire`，共享显示进 `viewkit`，cron 这类纯算法进独立小包；
  不为了少写两行把 `workbench` 的东西挪进 `client`。

## 6. 测试规范

### 6.1 分层与选择器

- 纯逻辑：表驱动，放被测包同目录的 `*_test.go`。
- 包内集成：`t.TempDir()` + `PIDECK_V2_HOME`，不碰真实用户目录。
- 无头 UI：`nsgotest.Start(t, Root, nsgotest.Size(...))`，选择器优先级
  `id:` > 稳定 `TestID` > 用户可见 `text:` > `role:`；`nth=` 只用于确认过的列表。
- 端到端：`requirePi(t)` 在 PATH 无 pi 时 `t.Skip`，不联网、不依赖已登录凭据。
- 测试名说清保护什么（`TestACPPermissionMemory`），失败信息带实际值与期望值。

### 6.2 等待与稳定性

- 用 `app.Settle()`、`WaitFor(sel, timeout)`、`WaitUntil(timeout, cond)` 表达条件；
  需要时钟时用 `Advance`，不要 `time.Sleep` 猜时间。
- 异步文件 I/O 与外部进程不受手动时钟控制：settle 应用直到条件成立。
- 必须重试的交互（拖动、输入、菜单落位）写成有上限的重试帮手，并在注释里说明原因。
- 弹框里排在输入框之前的列表若由空变满，子树会重排、输入框身份（view id）随之变化，
  跨帧的 `Type` 会丢字符：测这类表单先 `WaitFor` 列表里的第一条再输入；列表本身放进
  自己的 `core.Dynamic`，让外层结构稳定。
- 超时取 5–30 秒，给出有意义的失败信息；不写无限等待。

### 6.3 必须补的测试

- Bug 修复：先写能复现的回归测试，再修。
- 新增命令 / 设置 / 导入源 / 远程路由：至少一条成功路径 + 一条拒绝/降级路径。
- 改外部格式：旧文件迁移测试 + 坏文件降级测试。
- 结构调整：`structure_test.go` 的规则与 `ARCHITECTURE.md` 表同步。
- 新增文案：跑 `internal/apptext` 的守护测试（缺翻译会失败）。

### 6.4 不许做的事

- 不许为了过测试改断言、放宽超时或跳过测试；不许把真实依赖 mock 成永远成功。
- 不许让测试依赖执行顺序、真实网络、系统通知权限或用户已有的配置文件。
- 不许用覆盖率当目标；边界与失败路径比行数重要。

## 7. 反模式清单（出现即打回）

1. 在 `internal/client` 里 import `workbench`、`os/exec`、SQLite 或桌面路径。
2. 在 `ContentFunc` 里读一次信号就当成响应式，或在渲染路径里读磁盘、发网络请求。
3. 用 `time.Sleep`、轮询或"多试几次"掩盖未知竞态；根因没定位就加兼容代码。
4. 新建 `utils.go`、`common`、`helpers`、`global` 之类的杂物包。
5. 在 `ui_*.go` 里写业务规则、协议解析或文件 IO。
6. 直接 `os.WriteFile` 写配置/会话，绕过 store 与临时文件+重命名。
7. 用户可见字符串写死、或只补中文不补翻译目录。
8. 一个功能顺手重命名/移动/格式化无关文件，或改 README 的无关段落。
9. 单次使用就抽接口、加配置项、留兼容分支或"以后可能用得上"的扩展字段。
10. 未确认就改外部 JSON 格式、凭据字段或删除用户数据。
11. 把后端差异写进 UI 分支（`switch backend`），而不是适配层的投影。
12. 提交生成物（`webassets/site/`）、`dist/`、临时脚本或测试残留的数据目录。

## 8. 交付清单

- [ ] 只改了任务需要的文件；并行改动未被覆盖、暂存或提交。
- [ ] `gofmt` 已跑，`git diff --check` 干净。
- [ ] 窄验证通过；跨包改动另跑 `go tool nsgo check` 与 `-short` 测试。
- [ ] 新增/变更的行为有测试；bug 有回归测试。
- [ ] 文案已翻译；设置项五处齐；新包规则已加。
- [ ] 用户可见变化已写进 README 或 `docs/`；路线图状态已更新。
- [ ] 结论、验证命令与未验证项写在交付说明里，不夸大。
