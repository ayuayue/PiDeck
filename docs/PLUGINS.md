# PiDeck Lite 插件审计与实现方案

首轮审计日期：2026-11-20，使用 NSGo `a4a00f7f38b3`。2026-11-21 续作基于
`go.mod` 当前锁定的 `c70af8a79201` 验证。不把框架具备的能力算成 Lite 已经开放的 API。

## 结论与本轮边界

当前桌面版开放了六类声明式贡献，市场支持单文件安装、更新和可恢复卸载，也能离线安装三套完整示例。
共用市场的混合索引已在独立仓库准备发布。桌面插件设置页可预览内置 NSGo 面板、徽标与函数；外部包的安装、授权和执行入口待接入。

| 能力 | 当前状态 | 所有者 / 限制 |
| --- | --- | --- |
| 命令与键位 | 已开放 | 内置命令注册表 + 插件规范化结果；冲突键不抢占 |
| 设置 | 已开放 | bool/string/number/select 四类宿主控件，值归 `config.json` 的 `pluginSettings` |
| 主题 | 已开放 | 浅深角色色、token；本地相对文件或兼容的内联主题 |
| 智能体 | 已开放 | 提示词 persona，适用于现有后端；不是新后端或自定义工具运行时 |
| 事件 | 已开放 | 九类既有事件；同步事件通知与受限动作，不是持久化工作流引擎 |
| 市场 | 部分完成 | 单文件安装/更新、可恢复卸载、回收区备份、内置例子。共用仓库已准备混合索引的发布改动，线上仍提供 v1。资源包、摘要与签名待接入 |
| 自定义 UI | 内置预览 | 插件设置页可挂载随二进制携带的命名面板与徽标。下载包的 page/modal/popover/工具渲染器尚未开放 |
| 自定义函数 / 工具 | 内置预览 | 用户可调用同包的演示统计函数。下载包的 JS 导出、shell、文件 API 和 MCP 工具尚未开放 |
| 移动端 / Web 插件 | 未开放 | 当前加载器在桌面宿主；客户端只走远程 API，不下发桌面能力 |

普通命令可填草稿、主动发送、调用内置命令、打开链接、切主题。插件并非“没有任何副作用”：
主动发送可能调用智能体，内置命令也有自己的效果。不能把“不运行插件自己的代码”描述成
“不会碰项目文件”的安全承诺。

## 已修复的实际缺口

1. **更新按钮不可用**：原安装器遇到既有文件就拒绝。现在校验索引与清单版本、ID、runtime 后，
   在已有目录/单文件的原位置原子替换；下载和校验失败保留旧文件，下载期间发现本地编辑则拒绝覆盖。
   版本不同只表示用户可手动切换到明确版本，不代表自动判断语义版本新旧。
2. **纯智能体插件无法安装**：空插件判断漏了 agents。现在六类贡献均计入，设置页摘要也显示设置、事件、智能体。
3. **命令边界可绕过**：原 `command` 进入通用命令面板路由，可递归调用插件，也可经 hook 间接调用 send。
   现在只查内置命令注册表；替换变量后再次校验，并检查 `When`。
4. **禁用仍可通过 ID 执行**：执行入口现在再次检查 Disabled / Error，而非只在列表里隐藏。
5. **hook 只限制动作类别，不足以约束副作用**：新增内置命令注册表的 `HookSafe` 标记，默认拒绝自动事件调用；
   静态目标在加载时过滤，插值目标执行时复查。当前允许 palette、chat-outline、git-refresh、
   sidebar、drawer、shortcuts、settings；发送、压缩、新建会话/终端和删除不在其中。
6. **清单缺少宿主身份**：新增明确的 runtime 与 schemaVersion，未知契约不会激活；旧清单只做内存兼容。
7. **示例覆盖不足**：新增三套离线可安装例子，每套覆盖六类贡献；新建插件的 greeting 设置已真正被提示词引用。
   脚手架在后台创建，清单/README 改走原子写，README 写入失败不再被吞掉。
8. **键位误跑同名内置命令**：插件声明的局部命令优先解析为该插件的命令 ID；未声明为局部命令的内置目标
   继续按原语义处理，宿主或用户已经占用的键仍不被抢占。
9. **重复插件被静默改名**：同 ID 清单现在全部显示冲突，不按目录顺序挑选、不生成新 ID，六类贡献都不激活。
   保留一个清单后重新加载，原 ID 的设置和禁用记录恢复；历史合成后缀的残留配置保留，不自动合并。
10. **设置缺少运行时校验**：拒绝未知插件/键、错误类型、非有限数字与无效选项；bool/number/string 默认值类型不符时，
    仅丢弃该设置并给警告。省略默认值时分别采用 false/0/空字符串；select 沿用原规则，默认值不在 options 时回退首项。
    坏的已保存值读取时回退，
    不偷偷改写配置；数字控件允许编辑负号/小数等中间态，回车或失焦校验失败时就地提示。
11. **市场关闭与来源切换的请求没有所有者**：三种索引来源共用取消与代次；关闭、重开、切换到内置例子或发起新请求时，
    旧请求立即取消。即使完成回调已经排队，也不能覆盖新列表、错误、加载状态或持久化旧地址。
    取消官方源时不再继续尝试备用源。安装由应用生命周期拥有，关闭市场可继续安装，重开不会清掉互斥标记；
    应用退出取消下载，失败保留旧清单。设置和最近索引地址使用现有 store 原子写，在后台串行保存并反馈失败；
    退出等待已接受的配置写入完成。

对应回归测试在 `plugin_contract_test.go`、`market_regression_test.go`、`plugin_examples_test.go`、
`plugin_identity_regression_test.go`、`plugin_settings_regression_test.go`、`market_lifecycle_test.go`。
核心回归用例先在旧实现上复现，再验证修复，不依赖网络、真实账户或外部智能体。

## 安装生命周期与设置残留

插件设置与停用状态按稳定 ID 记录在 `config.json`。卸载和恢复都不清理它们；同 ID 再安装时原样继续使用，
避免更新、修复或暂时移除造成设置丢失。移除操作将单文件清单或完整插件目录原子移至
`trash/plugins/<slot>/<原文件名>`，同目录主题等资源一并保留。设置页从回收区恢复到原文件名和原位置；
原路径被占用或已有相同 ID 时拒绝恢复，回收副本保留。坏清单和其他 runtime 的清单也能移出活动列表并原样恢复，
恢复后仍遵循原有校验结果。回收区进入设置备份包，不进入诊断包（诊断仍只含活动插件的摘要）。
损坏或不可读取的回收槽被忽略，不阻断启动；永久清理只能由用户在文件管理器中删除 `trash/plugins/`。

市场安装、脚手架创建、移除与恢复共用单个插件文件写入状态，直到最新插件列表发布后再释放，防止应用内操作交错。
同一插件多次卸载时各副本独立保留，并有独立恢复控件。插件文件改变时若清单字节
与页面上看到的版本不同，卸载会拒绝并要求重新加载。卸载前如有清单或资源仍在编辑器里打开，也会拒绝。

## 清单 v2 身份与兼容

```json
{
  "schemaVersion": 2,
  "runtime": "pideck-lite",
  "id": "lite-review-kit",
  "name": "代码审查工具箱",
  "version": "1.0.0",
  "contributes": {}
}
```

- `runtime` 是执行契约，不能拿表示 GitHub/AtomGit 的 `host` 代替，也不能只靠名称、标签或 ID 前缀授权。
- 已有 Lite 清单没有这两个字段时，按 v2 / pideck-lite 读取，不重写文件；旧 prompts/内联 themes 仍可用。
- 显式指定其他 runtime 或未知 schemaVersion 时在插件设置页显示错误，贡献项不生效。
- 插件 ID 仍是安装、设置、键位与 persona 引用的稳定身份；示例使用 `lite-` 前缀方便人辨认，
  机器判定看 runtime。开发模式、正式渠道、桌面/客户端都不应靠改 ID 混用同一份授权。

## 复用 pideck-plugins 市场

当前线上 `registry.json` 对应 `pideck-plugin.json` 的 HTML 宿主插件，使用严格的 v1 schema。
市场仓库的构建改动另发布 `registry-v2.json`，按运行时区分条目。Electron 和市场网站继续读取原入口。
混合索引示意如下。

```json
{
  "schemaVersion": 2,
  "plugins": [
    {
      "id": "project-notes",
      "name": "项目便签",
      "version": "0.1.0",
      "runtime": "pideck-electron",
      "repo": "ayuayue/pideck-plugins",
      "subpath": "plugins/project-notes"
    },
    {
      "id": "lite-review-kit",
      "name": "代码审查工具箱",
      "version": "1.0.0",
      "runtime": "pideck-lite",
      "repo": "owner/plugin-repository",
      "url": "https://example.com/lite-review-kit.json"
    }
  ]
}
```

Lite 的「官方索引」优先取 GitHub Pages 的混合索引，失败时尝试原有 GitHub 和 AtomGit v1 源。
混合索引要求每条声明 `runtime`。`pideck-lite` 条目带清单下载地址，可以安装、更新。
`pideck-electron` 条目保留项目入口。旧官方 v1 和自定义 `{plugins:[{id,name,url}]}` 或数组仍可读取。

市场构建从原 v1 派生 Electron 条目，从 PiDeck Lite 公开仓库的固定提交派生三套 Lite 示例，下载地址同样固定到
这个提交。市场侧检查清单标识、必填字段、ID 冲突和单文件分发条件，实际安装时由 Lite 校验 ID、版本和各项贡献。
市场仓库发布后，在线官方索引即可显示这三套示例。资源包与自动更新仍需另行验证内容摘要、签名和更新策略。

当前 HTTP 下载有超时与硬体积上限，写入是原子文件替换；**市场仍只下载一个清单**，不会顺带下载
`contributes.themes` 的相对文件，更不会执行仓库安装脚本。基础示例使用现有内联主题格式解决单文件分发，
不是偷偷把资源包下载器实现成无限制抓仓库。

## 内置例子的完整路径

设置 → 扩展 → 插件市场，默认显示“内置示例”。示例嵌在桌面二进制里，用户主动安装后进入自己的
`plugins/`，可以查看和编辑清单、调设置、禁用和重新加载；不会启动时自动开启示例 hooks。

| 例子 | 完整使用路径 | 六类贡献 |
| --- | --- | --- |
| `lite-ui-basics.json` | 四种设置控件 → 准备提示词 → 切换雾蓝/恢复系统 → 查看键位 → 讲解员 persona → 计划完成显示大纲 | 全部 |
| `lite-review-kit.json` | 选审查范围/重点 → 准备或主动发送审查 → Git 面板 → 审查员 persona → 提交后刷新 Git | 全部 |
| `lite-writing-kit.json` | 配置读者/风格 → 准备写作任务 → 文档 persona → 文档主题 → 计划完成显示大纲 | 全部 |

源文件位于 `internal/workbench/plugin_examples/`。这些清单内容与用户创建的插件一样属于可编辑内容；
宿主的按钮、说明、错误和计数补齐六个翻译目录。三个例子的快捷键互不冲突，且只占空闲键。
“基础界面”演示宿主已有控件，不能误称可动态加载任意 UI 组件。

## Magpie 与 NSGo 的扩展方式

以 Magpie `2a2a8d734210` 为准，社区插件已经可以定义自己的界面。内置扩展、社区界面和社区功能分别有各自的入口。

| 扩展 | Magpie 已实现的能力 | Lite 可借鉴的做法 |
| --- | --- | --- |
| 内置插件 | Go `pluginrt` 管理服务依赖、配置 schema、启停和反向清理。Gateway、Sessions 等内置插件通过 `page` 插槽提供 Web 页面 | 在宿主整理清楚扩展点、状态归属和停用清理，再开放接口 |
| 社区 UI | `package.json` 的 `magpie.page` 提供独立 HTML 页面，`magpie.panels` 可放进 Agents、Usage、Settings 或提供商编辑器。宿主通过沙箱 iframe、受限消息桥与读取权限提供主题、配置和数据。页面可按允许列表替换内置页 | 保留命名插槽、可预览的权限和单组件失败回退。Lite 用 NSGo 原生树承载首个面板 |
| 社区功能 | OpenCode 兼容的 Bun/npm 宿主可提供 provider 与工具。工具可经受控 MCP 入口提供给智能体，插件进程按本机用户权限运行 | 先让 Lite 的函数由用户触发，复用宿主有界数据。单独处理智能体工具注册和授权 |

Magpie 的社区页面可以独立安装，无需启动 Bun。以本机的 CodeBuddy 导入为例，它使用 provider 扩展点；同一市场还
有 Day card 这类自定义界面。需要核对页面和面板的声明格式时，可直接查看上游的 `panel-plugin` fixture。

## NSGo 作为下一阶段的实现基础

锁定版本已有完整的相关原语：

- `tsx.View{Export, Props}` 按导出名把已验证包里的组件放入 Go 视图树。宿主给定视图、尺寸和 JSON 参数，每次挂载拥有自己的 VM。
  `tsx.Load` / `Plugin.Call` 可用同一个包运行命名函数。示例入口只导出组件和函数，函数加载时无需挂载 UI。
- `Trust.Verify` 验证证书、签名、包哈希、最低运行时版本和撤销状态。在后台用 `OpenTrust` 持久化撤销列表和已接受的构建号。
  `Trust.Accept` 在宿主确认候选版本可用时推进构建号下限，并复查撤销。当前 API 允许同一构建号出现不同包，授权仍需绑定签名者和包摘要。
  若启用 `RequireFreshRevocations`，每个受信根都须有有效撤销列表。宿主决定何时刷新，并负责停掉之后被撤销的活跃实例。
- `Sandbox.Grant` 与包声明取交集。每个活跃视图或函数实例使用独立 `core.Host`，因为一个通道在同一时间只有一个接收者。
  Storage 按包 ID 分区，同包的视图可以共享持久化偏好，内存状态仍各自独立。`Limits.CallTotal` 可选，作用于 `tsx.Load`
  创建的函数运行时。`Plugin.Interrupt` 可从后台停止函数，`Close` 由宿主引擎线程负责。
- `core.Catch` 在宿主视图内捕获失败并回退。移除视图会释放该作用域的订阅和回调，宿主发起的后台工作仍由宿主负责取消。

Lite 可以保留 v2 的命令、设置、主题、键位、事件和智能体，再用独立运行时标识分发签名 NSGo 包。
`pkg.Contents.Extra` 可以携带签名覆盖的 Lite Host API 版本与组件导出声明；权限申请由包的 `Capabilities` 声明。
市场标识用于发现和选择安装流程。
生产接入属于新的外部契约，需要更新项目的插件边界和运行授权流程。

下列源码示例由测试宿主编译、签名和运行。会话统计示例还提供桌面内置预览；桌面市场目前仍只安装声明式示例。

- `nsgo-ui/App.tsx`：真实组件、响应式信号、一个受限 `context.read` host 调用、插件分区存储、状态/失败反馈。
  测试编译并签名，验证合法包，拒绝篡改包，挂载组件、点击两次、验证状态与宿主存储隔离；
  包声明的能力被宿主 `Grant` 收回后，Host handler 也不会收到调用。
- `nsgo-functions/App.ts`：无 UI 的会话摘要函数，只消费调用方传入的有界摘要，验证类型/数量/计数，不读取文件或全局状态。
  测试验证包并 `tsx.Load`，检查 JSON 返回值、坏输入和缺失导出的失败路径。
- `nsgo-session-tools/App.tsx`：一个包导出 `SessionPanel`、`SessionBadge` 和 `readSessionTotals`，分别验证宿主面板、紧凑组件和函数调用。
  面板与徽标使用同一套统计逻辑。固定的 `sessions.list` 方法只返回测试会话的后端和消息数量，最多 200 条。
  验证声明权限与实际授权的差异、实例隔离、关闭后丢弃旧回复、函数关闭时结束在途调用，以及缺失组件时兄弟面板仍能刷新。

`nsgo.yaml` 是示例包身份、版本与最小能力的来源，测试直接读取它构包。测试密钥每次在内存生成，
不写私钥、不依赖真实发布凭据。在仓库根目录可单独运行三套示例；测试数据与签名密钥均由测试提供。

```powershell
go test ./internal/workbench -run '^TestNSGoPlugin' -count=1
```

### 桌面内置预览

设置 → 扩展 → 插件 →「NSGo 插件预览」→「打开预览」。这不是市场安装项，预览不读写用户插件目录。
默认未授权，面板与徽标显示权限不足；打开「允许读取演示摘要」后，两者分别加载三个固定摘要，
「调用统计函数」在独立的无 UI 实例里返回同一统计结果。宿主只返回 `backend` 与 `messages`，没有真实会话、路径、标题或正文。

- 预览内联显示在设置页，两个组件各自有受限尺寸和错误边界，每个组件与函数各拥有独立 Host 通道与 VM。
- 关闭预览、离开插件设置页或收回权限会销毁旧实例；重开默认未授权，不继承旧数据和函数结果。
  验证在后台进行，发布结果的 `Scope.Post` 属于本次预览，关闭后即丢弃。Host 处理器也复查实时授权与作用域。
- 生产二进制只嵌入 `preview.bundle.json` 中的已编译签名包及公钥，在后台验证后才挂载。
  公钥仅对随二进制携带的示例有效，不建立外部发布者信任。没有运行时 TSX 编译器、私钥、用户包入口或持久化授权。
- 宿主通过 JSON props 提供随界面语言翻译的文案；示例自身保留中文默认值，独立测试或复制示例时仍可运行。
  示例请求被限制为 `sessions.list({limit: 1..200})`，无额外字段；只公开固定三条演示摘要。

修改会话示例源码或 `nsgo.yaml` 后需显式重新生成内置资源，再重新运行检查；普通测试只做漂移检测，不改文件。
生成时的临时私钥只存在于测试进程内，文件仅保留公钥与签名包。嵌入资源是本仓库的运行资源，需要随源码提交。

```powershell
go test ./internal/workbench -run '^TestPluginPreviewBundleCurrent$' -update-plugin-preview
go test ./internal/workbench -run '^(TestPluginPreview|TestNSGoPlugin)' -count=1
```

### 生产接入的最小设计

1. 从桌面插件详情里的单个面板插槽起步。宿主通过独立作用域控制打开、关闭、尺寸、焦点和错误回退；对话框和菜单等在有实际插件需要时再归位。
2. 首个 `sessions.list` 仅提供当前项目有界的会话摘要。Go 侧校验入参、当前项目和授权。会话来源仍由 pi 文件和 ACP 投影决定，插件内的存储仅持有自己的偏好。
3. 对安装或更新包先在后台验证，展示签名者和权限后按需激活。候选包通过健康检查前保留可运行的旧包，之后再接受新的构建号。
   停用、撤销、切项目和重载都要让旧实例退出，取消后台工作并阻止旧结果进入新实例。撤销后恢复旧包时也要重新验证。
4. 执行层留在 workbench。客户端需要显示结果时走 `remotewire` 和 HTTP。独立评估 Web 的隔离方式及 12 MB 体积预算后再决定是否开放执行。

两个真实限制必须进入产品边界：升级后锁定的 NSGo 默认以 `Limits.Memory` 对原生目标的部分按大小分配内置操作
设置 64 MiB 预算，但对象、逐个增长的数组、拼接与展开等内存不在完整计量范围，仍没有硬堆内存隔离。因此只能先
支持受信发布者的签名包，不能宣称任意社区代码强隔离；Web 的签名包默认因无法隔离而拒绝运行，不能打开
`WebUnisolated` 来伪装兼容。当前下载插件仍为声明式 v2；桌面 TSX 仅运行随二进制携带的内置预览，
没有启用这些退让选项。首个外部签名包仍需按上述安装、授权和撤销方案接入。

## 实施顺序与验收

- 第一阶段：明确身份、修好声明式链路、三套离线例子、UI/函数验证例子与回归测试。
- 第二阶段：市场仓库按原 v1 与混合 v2 双入口分发，Lite 已接入优先读取与旧源回退。还需要发布市场仓库的提交，在线确认收录与安装。资源包、摘要和更新策略另行验收。
- 第三阶段：桌面内置示例已接入 UI、函数、临时权限与释放。外部包仍需经明确的 v3 契约设计，
  接入发布者信任、安装授权、撤销、禁用清理与失败恢复。
- 第四阶段：按实际需求补充 API，而不是一次开放所有宿主能力；客户端/浏览器支持另做隔离与预算验收。

仍需后续处理的 v2 事项包括：市场资源包发布、摘要校验与内容授权。
当前设置契约没有 min/max 范围字段，本轮没有添加新字段；number 只承诺有限数值，业务范围仍由声明者说明。
它们没有因本轮增加示例就自动完成。

窄验证：

```powershell
go test ./internal/workbench -run 'TestPlugin|TestMarket|TestInstallMarket|TestOfficialRegistry|TestMixedRegistry|TestBuiltinPlugin|TestLegacyPlugin|TestNSGoPlugin|TestNewPlugin|TestEventText|TestEventBus' -count=1
go test ./internal/apptext -count=1
go test ./internal/architecture -count=1
```

涉及 i18n 与结构后，按工程规范串行执行 `go tool nsgo check` 和
`go tool nsgo test -- -short -count=1 -timeout=20m`。本轮不运行全平台构建矩阵。

### 首轮工作区验证记录（2026-11-20）

- 上述插件针对性测试通过（最终一次 35.630s）；翻译与架构包测试通过。
- `go tool nsgo check` 通过。独立 TSX 示例由集成测试实际编译、签名和运行；仓库没有独立的 TSX `tsconfig.json`，
  不把 check 的跳过提示记成额外的 TypeScript 类型检查通过。
- `go tool nsgo build -target windows_x64` 通过（62.2 MB）；输出重定向到本轮临时目录，未运行应用或生成 NSIS 安装器。
- 完整 short 门禁结果为 **543 通过、3 失败、48 跳过**，不能记为通过：
  - `TestMobileStatePollIgnoresPreviousConnection/OK`：客户端 `disconnectWith` 在 `draftChange.Set(nil)` 处空指针。
    该处属于工作区本轮之前已有的客户端改动，本轮没有修改。
  - `TestPiRefreshFindsSessionsStartedElsewhere`、`TestDeleteTheme`：套件中等待超时；用下列命令单独复跑均通过
    （9.436s），超时根因尚未定位，没有改断言、放宽等待或跳过它们。

```powershell
go test ./internal/workbench -run '^(TestPiRefreshFindsSessionsStartedElsewhere|TestDeleteTheme)$' -count=1 -timeout=2m
```

最初的完整门禁因 C 盘不足而无法编译；后续验证把 `GOCACHE`、`GOTMPDIR`、`TEMP`、`TMP` 临时指向
D 盘的独立目录，未改变全局 Go 配置。其他平台、真实上游市场发布、生产 TSX 宿主与安装器未验证。

### 续作提交验证记录（2026-11-20）

为避免依赖其他未提交功能，使用独立 Git 索引导出插件暂存树到 D 盘，编译缓存和临时目录也只在该目录内。
基线是已提交的 `0df5c5b`；另一份基线副本不含本次身份、设置和市场生命周期补丁，用于对照失败项。

- 重复 ID、坏默认值/存储值、未声明设置写入、数字编辑中间态、关闭取消、新请求替换和安装互斥的回归用例，
  均先在旧实现上复现，再验证修复。后台保存还复现并修复了“文件已可见但排队写入尚未结束”的收尾问题；
  现在退出等待已接受的写入，测试等待真实文件保存与写入任务结束，不增加固定睡眠。
- 最终插件专项测试通过（31.291s）；翻译与架构包测试、`go tool nsgo check` 通过。
- `go tool nsgo build -target windows_x64` 通过，产物 **59.4 MB**；未执行应用、未编译 NSIS 安装器。
- 最终源码的完整 short 门禁为 **568 通过、3 失败、46 跳过**，仍未通过。失败项：
  - `TestTrustMigration`：现有测试固定要求落盘 `version: 2`，基线的 `configVersion` 已是 3。
    在不含本次补丁的基线副本中同样失败；本次不改配置版本或这条断言。
  - `TestTerminalFont`：等待字号设置落盘超时，基线副本独立运行也失败；根因尚未定位。
  - `TestTokenDanceSettingsRows`：等待对话框或错误文本超时；最终源码独立运行也曾失败。
    三次对照运行中，基线出现一次同类失败，最终源码三次通过（2.414s）；只能确认存在间歇失败，不能记为已修复。

首遍 short 还出现 `TestSkillStoreDialog` 的等待超时，独立复跑和最终完整套件中均通过。
以上失败没有通过放宽超时、跳过或改断言消除。完整门禁的失败状态与插件专项通过分别记录，
不把已有失败当作本次新增能力已被全面验证的证明。

复现基线对照的测试选择器：

```powershell
go test -mod=readonly ./internal/workbench -run '^(TestTrustMigration|TestTerminalFont)$' -count=1 -timeout=2m
go test -mod=readonly ./internal/workbench -run '^TestTokenDanceSettingsRows$' -count=3 -timeout=1m
```

本轮没有修改客户端或 Web 代码；其他平台、上游市场收录发布、生产 TSX 宿主仍未验证。

### 卸载恢复续作验证记录（2026-11-21）

基线为 `1eade54`。只把本次插件改动的暂存树导出到独立目录验证，未带入工作区其他设置页改动。

- 新增回归先复现了“文件操作成功回调早于列表刷新”和“同一清单重复卸载的恢复控件 ID 重复”，
  修复后验证通过；归档往返、主题资源、坏清单、路径/ID 冲突、设置保留和备份白名单边界均有回归覆盖。
- 插件、市场、NSGo UI/函数示例、归档和备份专项测试通过（38.716s）。六语种文案与架构包测试通过。
- `go tool nsgo check` 通过；框架自带目录的部分语言回退提示仍存在，不影响应用文案覆盖检查。
- `go tool nsgo test -- -short -count=1 -timeout=20m` 通过：**668 通过、0 失败、55 跳过**。
- `go tool nsgo build -target windows_x64 -output <验证目录>/build` 通过，产物 **63.5 MB**；
  未运行桌面程序、未生成 NSIS 安装器。本轮未改客户端代码，未执行 Web 或其他平台构建。

卸载恢复提交未修改市场上游仓库，也未开放生产 TSX 宿主。

### 混合市场索引与命名视图验证（2026-11-21）

- Lite 仓库的 `go tool nsgo check`、会话统计示例的独立类型检查、插件专项和 Windows x64 构建通过。
  最终 `go tool nsgo test -- -short -count=1 -timeout=20m` 为 **675 通过、0 失败、55 跳过**。
  最终门禁保留了示例生成的 `.nsgo` 缓存，架构扫描与测试嵌入都排除了它。首轮曾遇到 pi 认证测试的 Windows 临时目录清理失败；
  基线和本次代码各独立复跑三次均通过，最终完整套件也通过。
- `pideck-plugins` 的本地 `codex/lite-plugin-registry` 分支（`47cfe72`）通过原有插件校验、打包、混合索引测试和网站构建，
  生成 4 个 Electron 条目及 3 个 Lite 条目。用实际生成的索引和 Lite 安装器验证了三套清单，六类贡献均可加载。
  市场提交未推送，线上仍待部署。

### 桌面内置预览验证（2026-11-21）

基线为 `2f9c65b`。在独立 worktree 中仅叠加本轮插件补丁验证，未带入主工作区正在进行的设置界面修改。

- 插件专项在 `nsgocheck` 下通过：资源与源码/清单的漂移检查、篡改拒绝、请求边界、默认未授权、
  授权与收回、重开与离开页面、迟到函数结果、组件失败隔离及英文文案均有覆盖。
  资源源码使用定向的 LF 检出规则，避免跨平台换行改变内联 source map 而造成漂移误报。
- `internal/apptext` 和 `internal/architecture` 测试、`go tool nsgo check`、会话统计示例的独立类型检查均通过。
  生产 workbench 的依赖图不包含 `tsx/bundler` 或 esbuild；生成签名包只在测试命令中完成。
- Windows 原生 `TestNativePluginPreviewScreens` 通过，已检查未授权、已授权和 440 点窄窗口截图。
  截图保存在验证 worktree 的 `.nsgo/test/screenshots/plugin-preview/plugins/`。
- `go tool nsgo build -target windows_x64` 通过，产物 **82.1 MB**，未生成 NSIS 安装器。
  上一轮同目标产物为 63.5 MB；本轮桌面接入 TSX 执行路径后增加约 18.6 MB，后续应单独评估体积优化。
  未向客户端引入执行能力，本轮没有运行 Web 或其他平台构建。
- 完整 `go tool nsgo test -- -short -count=1 -timeout=20m` 为 **680 通过、4 失败、56 跳过**，不能记为门禁全通过。
  `TestPiRefreshFindsSessionsStartedElsewhere`、`TestPiScanFindsAFolderSpelledInAnotherCase` 和 `TestDeleteTheme`
  在未修改的基线上也分别复现了相同等待超时。`TestMobileComposerControls` 在完整套件中失败，
  在基线和本轮补丁下单独各复跑三次均通过，套件内失败原因仍未收敛。本轮未修改这些用例或放宽超时。

日志、失败基线对照与 Windows 构建产物保存在 `D:\CodexTemp\pideck-plugin-preview-evidence-20261121\`；
验证 worktree 为 `D:\CodexTemp\pideck-plugin-preview-20261121\`。
上述结果只验证内置示例，外部签名包的安装授权、发布者信任和撤销仍未实现；共用市场仓库也未在本轮推送或部署。

## 一手参考

- 市场 registry：<https://github.com/ayuayue/pideck-plugins/blob/main/registry.json>
- 市场 schema：<https://github.com/ayuayue/pideck-plugins/blob/main/schema/registry.schema.json>
- 市场收录契约：<https://github.com/ayuayue/pideck-plugins/blob/main/docs/registry.md>
- Magpie 的内置运行时、社区页面和面板：<https://github.com/yetone/magpie/blob/2a2a8d734210dd22785280513bad64036c2063d3/docs/subsystems/plugin-runtime.md>
- Magpie 的社区面板清单例子：<https://github.com/yetone/magpie/blob/2a2a8d734210dd22785280513bad64036c2063d3/internal/gui/testdata/panel-plugin/package.json>
- Magpie 的 OpenCode 插件工具：<https://github.com/yetone/magpie/blob/2a2a8d734210dd22785280513bad64036c2063d3/docs/subsystems/plugin-tools.md>
- NSGo 插件示例（当前锁定提交）：<https://github.com/nsgo-dev/nsgo/tree/c70af8a79201/examples/plugins>
- NSGo 沙箱与签名设计（当前锁定提交）：<https://github.com/nsgo-dev/nsgo/blob/c70af8a79201/docs/architecture/tsx.md>
- NSGo 命名组件与函数入口（当前锁定提交）：<https://github.com/nsgo-dev/nsgo/blob/c70af8a79201/tsx/view.go>
- NSGo 签名包、能力约束与锁定版本的默认内存预算提交：<https://github.com/nsgo-dev/nsgo/commit/593206699920d77f036e8bed67fcbd7325034989>、<https://github.com/nsgo-dev/nsgo/commit/4e2f0da91a08d0007a4c90ab17638a9a9e457a40>、<https://github.com/nsgo-dev/nsgo/commit/c70af8a79201695f8b37d76fc4436430d08d6e64>
