# PiDeck Lite 插件审计与实现方案

审计日期：2026-11-20。基于当前工作区与 `go.mod` 锁定的 NSGo `a4a00f7f38b3`，不把
框架具备的能力算成 Lite 已经开放的 API。

## 结论与本轮边界

现有实现是一套可用的**声明式扩展系统**，不是完整的 UI/功能代码插件平台。插件市场有 UI、
自定义索引、官方/社区发现与单文件安装；此前更新按钮没有真正完成更新，官方发现也不等于
Lite 兼容市场。沿用当前工程约束，本轮修复声明式链路并提供完整示例；TSX 宿主作为明确的下一阶段，
不悄悄把现有“不执行插件代码”的契约改掉。

| 能力 | 当前状态 | 所有者 / 限制 |
| --- | --- | --- |
| 命令与键位 | 已开放 | 内置命令注册表 + 插件规范化结果；冲突键不抢占 |
| 设置 | 已开放 | bool/string/number/select 四类宿主控件，值归 `config.json` 的 `pluginSettings` |
| 主题 | 已开放 | 浅深角色色、token；本地相对文件或兼容的内联主题 |
| 智能体 | 已开放 | 提示词 persona，适用于现有后端；不是新后端或自定义工具运行时 |
| 事件 | 已开放 | 九类既有事件；同步事件通知与受限动作，不是持久化工作流引擎 |
| 市场 | 部分完成 | 单文件安装/更新、内置例子、索引发现；无资源包发布/签名/完整卸载生命周期 |
| 自定义 UI | 未在 Lite 开放 | 不能贡献 page/modal/popover/工具渲染器，也不能直接注册任意 NSGo 组件 |
| 自定义函数 / 工具 | 未在 Lite 开放 | 不能提供自定义 JS 导出、shell、文件 API 或 MCP 工具 |
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

已核实上游目前是 registry v1，条目对应 `pideck-plugin.json` 的 HTML 宿主插件，schema 使用
`additionalProperties: false`，收录脚本还会核对插件目录和派生字段。因此**只向现有文件加 runtime 会被拒绝**。
本轮只修改 Lite 消费端，没有改写或发布市场仓库。

建议保留同一个市场仓库与贡献流程，协调升级成混合 registry v2：

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

上面是格式示意，第二条 URL 不是已发布下载源。Lite 侧已能消费此格式：v2 要求每条声明 runtime，
仅明确的 pideck-lite + 合法清单 URL 出现安装按钮，其他运行时仅跳项目。旧官方 v1 无 runtime 的条目
仍按 Electron 项目发现；旧自定义 `{plugins:[{id,name,url}]}` 和数组索引仍按原 Lite 格式处理。

市场仓库下一步要一起改：

1. registry schema 增加 runtime，并按运行时区分清单位置、下载地址与允许的派生字段。
2. 校验器按 runtime 分派给 Lite v2 与 Electron 校验器；保留每类的独立预算、模板和安装验证。
3. Electron 消费端也按 runtime 筛选；先发布双版本读取，再切 v2 索引，防止旧客户端把 Lite 清单当 HTML 插件。
4. CI 验证 manifest ID/版本与 registry 一致，拒绝跨运行时混装；同仓库多插件保留各自稳定身份。
5. 后续资源包引入内容摘要/签名与确定版本的下载地址，再做自动更新；v2 清单现在没有签名验证。

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

## NSGo 作为下一阶段的实现基础

锁定版本已有完整的相关原语：

- `tsx.View` 把已验证包放入原生 Go 视图树，`tsx.Load` / `Plugin.Call` 加载无界面的函数包。
- `tsx/pkg.Trust.Verify`、签名证书、撤销列表和防回滚；验证在 UI 线程外，接受运行版本与授权必须由宿主管理。
- `Sandbox.Grant` 缩小包声明的能力，独立 `core.Host` 桥接、按包 ID 分区的 Storage、时间/节点/请求预算；升级后增加默认 64 MiB 的部分内存分配预算、可选 `Limits.CallTotal` 总调用期限和 `Plugin.Interrupt`。
- `core.Catch` 做 UI 异常边界，插件作用域销毁时回收回调、订阅和运行时，不能只从列表删掉名字。

因此不建议自行发明 JSON UI 树或另一套 JS 引擎。推荐保留 v2 作为轻量零代码层，未来新增一个明确版本的
“签名 NSGo 包层”，复用框架 UI 与函数运行时。它是新的外部契约，进入生产前需要更新项目的插件边界说明，
不能默认把现有 v2 清单升级为有代码执行权的插件。

两个源码验证例子已放入同一目录的子目录；**它们只由测试宿主运行，不进入生产插件市场，也不启用 TSX 生产宿主**：

- `nsgo-ui/App.tsx`：真实组件、响应式信号、一个受限 `context.read` host 调用、插件分区存储、状态/失败反馈。
  测试编译并签名，验证合法包，拒绝篡改包，挂载组件、点击两次、验证状态与宿主存储隔离；
  包声明的能力被宿主 `Grant` 收回后，Host handler 也不会收到调用。
- `nsgo-functions/App.ts`：无 UI 的会话摘要函数，只消费调用方传入的有界摘要，验证类型/数量/计数，不读取文件或全局状态。
  测试验证包并 `tsx.Load`，检查 JSON 返回值、坏输入和缺失导出的失败路径。

`nsgo.yaml` 是示例包身份、版本与最小能力的来源，测试直接读取它构包。测试密钥每次在内存生成，
不写私钥、不依赖真实发布凭据。
这证明锁定的 NSGo 接口可以承载两类插件，不代表生产授权、分发和生命周期已经实现。

### 生产接入的最小设计

1. **UI 插槽固定**：先开放插件页、对话框、轻量弹出面板三个明确位置；宿主拥有打开/关闭、尺寸、焦点和异常边界。
   先不让插件替换整个聊天树、编辑器或终端。
2. **Host API 小而显式**：起步只提供 `context.read`、有界 `sessions.list`、用户触发的 `draft.replace` 和受限命令调用。
   每个插件一条 channel，入参 schema、会话 ID、作用域、授权和限额都在 Go 侧重查；不暴露 `*app`、任意路径、exec 或令牌。
3. **数据仍归宿主**：会话来自文件/pi 投影，函数包收副本；每次调用重新验证会话是否存在，不能缓存一个可变“第二会话库”。
   插件自己的偏好进分区存储，文档与备份明确范围；凭据不能混入普通 Storage。
4. **生命周期有验收条件**：用户授权 → 校验 → 安装 → 按需激活 → 禁用/重新加载释放；升级权限变化重新授权，失败保留可用旧版本。
   未获授权的事件不下发完整回答、路径和图片。
5. **先桌面、再客户端**：执行层留在 workbench；需要共享时只投影 DTO 到 remotewire，客户端走 HTTP。
   不把 workbench、Goja 或打包器带入 Web，以免破坏包边界和 12 MB 预算。

两个真实限制必须进入产品边界：升级后锁定的 NSGo 默认以 `Limits.Memory` 对原生目标的部分按大小分配内置操作
设置 64 MiB 预算，但对象、逐个增长的数组、拼接与展开等内存不在完整计量范围，仍没有硬堆内存隔离。因此只能先
支持受信发布者的签名包，不能宣称任意社区代码强隔离；Web 的签名包默认因无法隔离而拒绝运行，不能打开
`WebUnisolated` 来伪装兼容。当前生产插件仍为声明式 v2，TSX 只在测试宿主运行，没有启用这些退让选项。

## 实施顺序与验收

- 第一阶段（本轮）：明确身份、修好声明式链路、三套离线例子、UI/函数验证例子与回归测试。
- 第二阶段：在市场仓库和两端消费者中协调 registry v2，真正收录 Lite 例子；资源包、摘要和更新策略一起验收。
- 第三阶段：经明确的 v3 契约设计接入受信签名 TSX UI 与函数宿主，加入权限、撤销、禁用清理、取消和失败恢复测试。
- 第四阶段：按实际需求补充 API，而不是一次开放所有宿主能力；客户端/浏览器支持另做隔离与预算验收。

仍需后续处理的 v2 事项包括：卸载与设置残留策略、包资源与内容授权。
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

## 一手参考

- 市场 registry：<https://github.com/ayuayue/pideck-plugins/blob/main/registry.json>
- 市场 schema：<https://github.com/ayuayue/pideck-plugins/blob/main/schema/registry.schema.json>
- 市场收录契约：<https://github.com/ayuayue/pideck-plugins/blob/main/docs/registry.md>
- NSGo 插件示例（锁定提交）：<https://github.com/nsgo-dev/nsgo/tree/a4a00f7f38b3/examples/plugins>
- NSGo 沙箱与签名设计（锁定提交）：<https://github.com/nsgo-dev/nsgo/blob/a4a00f7f38b3/docs/architecture/tsx.md>
