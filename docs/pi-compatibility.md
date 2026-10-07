# Pi CLI 兼容性记录

> 这是一份**兼容账本**，不是 PiDeck 的功能设计文档。每次升级 Pi CLI 时，先把上游行为、PiDeck 处理方式和兼容代码的移除条件记在这里。
>
> 模型能力、思考档位和多模态配置的详细链路与重构方案见 [`docs/pi-model-capability-plan.md`](./pi-model-capability-plan.md)。

## 当前基线

- 最近核对版本：`pi 1.0.2`（1.0.1/1.0.2 于 2026-10-03/04 发布；依据：npm 包 CHANGELOG + dist 与 1.0.0 逐文件 diff；未运行真实供应商 OAuth）
- PiDeck 通信方式：`pi --mode rpc`，stdio JSON-RPC
- 本记录范围：Pi 后端（`src/main/pi/`）以及 PiDeck 对 Pi 配置/事件的适配
- 不包含：DSH 的 `pwsh_persistent`、Electron 自带终端、PiDeck 自己的应用更新器
- 当前原则：工具选择由用户决定，PiDeck 的图形编辑器写 pi 原生 `settings.json`，解析与执行仍归 pi；不自动安装 PowerShell 7，不向 Pi 传硬编码 `--tools` 白名单。

## 白名单机制移除核对（2026-10-01 终态，源码逐项验证）

执行计划 A5 的「退出三类 argv 白名单」已落地。源码级核对结果：

| 核对项 | 事实 |
|---|---|
| `--no-extensions` + 逐条 `-e` 白名单注入分支 | **已删除**（PiProcess 启动参数组装中不存在该路径） |
| `--no-skills` + `--skill` 白名单注入 | **已删除** |
| `--no-prompt-templates` + `--prompt-template` 白名单注入 | **已删除** |
| `skillWhitelistResolver` / `promptWhitelistResolver` / `piProcessSkillResolvers` / `piProcessPromptResolvers` / `whitelistSkipNotice` / `builtInExtensionToggles` | **模块已删除** |
| 白名单总开关（`extensions:set-whitelist-disabled` IPC、preload、扩展页按钮、`disableExtensionWhitelist` 设置字段、中英文案、预算跳过诊断） | **全部删除** |
| `resolveEnabledExtensionPaths` | 改名 `resolveLoadableExtensionPaths` 且**始终返回数组**，仅作「会加载哪些扩展」只读查询（压缩归属启发式使用），不再有 null 白名单语义 |
| 诊断开关 `piRpcNoExtensions` / `piRpcNoSkills` | **保留**（开发设置里的总关开关，语义就是「一个都不加载」） |
| `ExtensionManager.setEnabled` 的旧禁用列表写入 | 仅作原生服务未装配时的兜底通道（渐进迁移）；生产装配后走 `PiResourceConfigService` 原生规则 |
| 残留 `--no-*` 参数使用位置 | 仅三处合法场景：PiProcess 诊断开关、模型列表/探测快查（`modelListCache`/`PiModelProber`）、git 快照探针（`gitIpc`）——均与白名单机制无关 |
| 迁移门禁 | `AgentManager.createUnlocked` 在 spawn 前 `await resourceMigrationGate(projectId)`（幂等，全局启动即跑、项目按需） |

真实冒烟证据（`scripts/smoke-pi-native-resources.mjs`，对 pi 0.99.2 与 1.0.0 各 19/19）：
无白名单启动下，原生 `+/-` 规则真实控制技能/扩展加载、`-builtin:mcp` 生效、项目层覆盖生效、
未信任项目不读项目配置、旧禁用记录迁移后 pi 真的不加载该资源。

## 1.0.1 / 1.0.2 审计矩阵（npm 包 dist 源码逐条核对）

核对方式：npm pack 拉取 1.0.2 完整包，与本机 1.0.0 逐文件 diff；`package-manager.js`/`settings-manager.js` **逐字节一致**（资源过滤与 defaultTools 合并零变化，A 系列/T1 直接适用）。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| **MCP 项目覆盖条目**：项目 `.pi/mcp.json` 无 `command/url/type` 的条目合法，只覆盖全局同名 server 的 `enabled/exposure/toolExposure`（#10277） | 校验 + 合并均已适配：项目层无传输条目按覆盖形态处理（只允许三键、需全局基座），部分覆盖保留全局传输/凭据；全局层仍要求完整传输。PiDeck 自己的「在本项目停用」继续写 `{url,enabled:false}` 整体替换（两种形态都合法） | 已适配 | `mcpConfig.validateMcpServerValue`/`mergeMcpServersWithErrors`、`tests/mcpConfig.test.mjs` | 无 |
| `oauth.clientRegistration: "dcr"/"cimd"`（Client ID Metadata Document 代替动态注册，#10302） | 类型 + 校验（cimd 禁 clientId/clientName、回调须 localhost/127.0.0.1 的 /callback）+ 表单字段 + 中英文案 | 已适配 | `types/mcp.ts`、`mcpConfig.validateOAuth`、`McpTab.tsx`、`tests/mcpConfig.test.mjs` | 无 |
| `samplingParamsByThinkingLevel`（models.json 按思考档位配采样参数，#9776） | 已验证 `normalizeModelsForPi` 用 `...data` 展开，未知顶层字段（含本字段）原样保留；可视化编辑不感知也不丢 | 无需改动 | `ConfigManager.normalizeModelsForPi` 的 spread 语义 | 无 |
| 资源过滤 / defaultTools 合并（`package-manager.js`/`settings-manager.js`） | 与 1.0.0 逐字节一致 | **已核对无变化** | diff 验证 | — |
| Nix flake、`pi.registerToolRenderer()`、Clef 分类器、TUI/供应商/内存泄漏修复、`--models` 尾逗号修复 | 运行时行为，PiDeck 不经手；`--provider` 缺 `--model` 报错不影响 PiDeck（探测始终成对传） | 无需改动 | — | — |
| 移除 `npm-shrinkwrap.json`（npm 安装不再锁传递依赖） | PiDeck 不打包 pi；用户侧安装行为变化与 PiDeck 无关，`pi update` 推荐托管安装的提示由 pi 自己展示 | 无需改动 | — | — |

## 1.0.0 审计矩阵（本机 dist 源码逐条核对）

结论：**资源管理与 defaultTools 合并语义完全未变，0.99.2 适配全部直接适用**；变化集中在 MCP OAuth（凭据按 name+URL、`authServerMetadataUrl`、`iss` 校验、scope 保留）与 TUI。本轮已修两处 + 一处文案。

| 上游变化（CHANGELOG + 源码核实） | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| `settings.json` 资源过滤：`RESOURCE_TYPES`/`isEnabledByOverrides`/`applyPackageFilter`/`applyPackageDeltaFilter`/builtin 处理逐行一致（`package-manager.js`） | A1–A5 原生规则层/迁移/白名单移除全部直接适用 | **已核对无变化** | 源码比对 | — |
| `defaultTools` 合并：`mergeDefaultTools`/`resolveDefaultTools` 与 0.99.2 逐行一致（`settings-manager.js`） | T1 编码回验继续有效 | **已核对无变化** | 源码比对 | — |
| MCP schema：名称正则/exposure 四值 + 别名/项目层禁 `auth`/`enabled` 语义不变；**新增 `oauth.authServerMetadataUrl`**（https 或环回 http，替代 OAuth 自动发现） | 类型 + 校验 + 表单字段（高级区） | 已适配（本轮） | `types/mcp.ts`、`mcpConfig.validateOAuth`、`McpTab`、`tests/mcpConfig.test.mjs` | 无 |
| **OAuth 凭据改为按服务器名 + URL 分别存储**（`McpOAuthCredentialStore.forServer(name, url)`）；按 URL 存的旧凭据自动迁移给第一个使用它的服务器；`credentials.remove(name, url)` | 登出确认文案更新（旧文案称同 URL 全部失效，已不准确） | 已适配（本轮） | `McpTab` 登出确认、`rendererCopy.*.ts` | 无 |
| MCP OAuth 安全加固：RFC 9207 `iss` 校验、空 `scope` 容忍、`insufficient_scope` 追加登录保留已授 scope、登录 URL 超链接修复 | pi 运行时行为，PiDeck 不经手令牌交换 | 无需改动 | — | — |
| `pi mcp list/login/logout` 仍不接受 `-l`（帮助文本与命令分发核实：`-l` 只属于 add/remove）；登录输出格式不变 | M2 的作用域假设与 URL 逐行解析继续有效 | **已核对无变化** | `extensions/mcp/cli.js` 源码比对 | — |
| RPC `get_commands` 的 `sourceInfo`（含 `builtin:mcp` 合成路径）不变 | M3 第三方接管提醒继续有效 | **已核对无变化** | `modes/rpc/rpc-mode.js` 源码比对 | — |
| **`quietStartup` 新增 `"header"` 三态**（保留版本横幅、隐藏模型范围行与资源列表） | 设置页布尔开关会把 `"header"` 覆盖成 true/false——已改三态下拉并保留原值 | **已修复数据丢失缺陷**（本轮） | `SettingsTab.tsx`、`tests/settingsQuietStartup.test.mjs` | 无 |
| codemode 描述瘦身 ~40%（`models.generateImages()`、错误恢复提示、`"name" in tools` 探测） | pi 运行时行为；PiDeck 的 codemode 预算提示文案仍准确 | 无需改动 | — | — |
| `/login` 顶层提供 Radius 登录并可写入 `auth:{provider:"radius"}` 的 MCP 配置 | PiDeck 已按 `auth.provider` 展示「供应商登录」并隐藏 MCP OAuth 按钮 | 无需改动 | `McpResourceViews.usesProviderAuth` | — |
| TUI 默认全屏（`tuiMode`）、`--provider` 缺 `--model` 报错、主题/内存/补全等修复 | PiDeck 走 RPC 不受 TUI 影响；PiModelProber 始终同时传 `--provider --model` | 无需改动 | `PiModelProber.tsx` 核实 | — |

## 0.99.2 增量核对

来源：[v0.99.2 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.99.2)、[v0.99.1 → v0.99.2 差异](https://github.com/earendil-works/pi/compare/v0.99.1...v0.99.2)。以下已并入执行计划第 1.4 节及原有阶段，不是另一份独立计划。

前轮本地源码核对中已有 description/clientName/provider auth 等内容，但版本归属写成了 0.99.1；按正式 tag 校正为 0.99.2。本轮用明确版本的本机包重跑了四组 defaultTools 合并、exposure alias、namespace、HTTPS/loopback、clientName 和 provider-token 回调的纯内存探针，未访问真实凭据或 MCP 网络服务。

| 变化 | PiDeck 适配结论 | 状态/验收 |
|---|---|---|
| 默认 codemode 的 MCP 不进工具描述，首轮只等待含 direct 工具的服务器；其他服务器后台连接 | 去掉两种 codemode exposure 的误导性解释；不在桌面 prompt 前增加全连接检测，不从 codemode 描述判断服务器不存在 | 待 A5/M2/M3；慢连接不能阻塞普通首轮 |
| `description`、`mcp_servers` 提示词段、`describeNamespace()` | 补配置编辑/导入/保存；提示词和工具搜索归 pi，PiDeck 不生成另一份 server 摘要 | 待 M1/M3；字段保留与请求日志兼容 |
| MCP namespace 将 `-` 规范为 `_`；工具重名都加 hash；server 命名冲突拒绝 | 校验配置命名冲突；toolExposure 仍按 server 原始工具名，RPC 工具名原样消费。现有 `mcp__` badge 判断无需换算法 | 待 M1/V1；新旧历史名称、hash 后缀用例 |
| `oauth.clientName` | 类型/表单/导入支持非空客户端名称；仅注册时生效，改名需登出再注册，不能自动替用户登出 | 待 M1/M3 |
| HTTP `auth.provider` 使用供应商当前 token，逐请求刷新，配置限全局和 HTTPS（loopback HTTP 例外） | 复用现有供应商登录入口；不调用 MCP OAuth login/logout，不读取/复制 provider token，不允许项目 provider-auth 覆盖 | 待 M1/M2/M3 |
| **0.99.2 独立 MCP CLI 未传 providerToken 回调**，会话路径有该回调 | CLI 对 provider-auth 的认证结论不能代表会话；如实保留报告并标注检测限制，不提示用户反复 MCP OAuth 登录；不引入 SDK 验证通道 | 源码与纯内存探针已确认；处理待 M2/M3。上游修复后重核并撤销限制 |
| `/reload` 只激活 defaultTools 新增项，移除项仍可活跃，CLI tools flags 优先 | 不是新增 RPC，也不是完整重置工具集；桌面继续以新建/重启完整应用配置，不发送虚构 reload_config | 待 T1/V1；运行态和配置态文案分开 |
| Anthropic workload identity federation | native env 清洗当前保留其变量；补假值透传测试，token 文件读取/交换/刷新归 pi；WSL 不自动拷宿主凭据路径 | 待 A1/A5/V1；不新增联邦认证 UI |
| `/mcp` TUI 超链接、TUI 单行折叠；codemode worker/image、provider/model/retry 修复 | 独立 CLI login 仍是明文 URL，RPC 命令定义未改；不移植 TUI renderer 或重写 pi 内部逻辑，相关既有接入路径回归 | 上游随外部 pi 升级生效；PiDeck 验收待 V1 |

`package-manager/settings-manager` 未在本次 tag 差异中改动，原生资源管理方向保持。静态模型 catalog 的源数据也未改；PiDeck 的构建期 `pi-ai@0.99.1` 和 DSH 独立依赖不随外部 CLI 补丁版本自动升级。

## 0.99.x 整体适配矩阵

以下按当前工作区事实记录，**初版代码存在不等于适配已验收**。完整收尾与原生资源迁移方案见 [pi 原生资源管理与 MCP / Codemode 执行计划](./pi-0.99-mcp-codemode-plan.md)；其中阶段和测试尚待执行，本次文档更新没有重跑业务测试。

| 上游变化 | PiDeck 当前处理与待办 | 状态 | 代码/验证入口 | 兼容代码移除条件 |
|---|---|---|---|---|
| `--no-extensions` 连带关闭 mcp/codemode/tool-search/llama.cpp；0.99+ 支持 `builtin:` | 白名单机制已整体移除：普通启动不再传 `--no-extensions`（内置四扩展随 pi 正常加载）；`piRpcNoExtensions` 诊断开关仍在（诊断路径本来就要求一个扩展都不加载）；PiDeck 自带扩展仍以 `-e` 附加 | 已完成（提交 `37b38180` + A5 清理） | `PiProcess.ts`、`piProcessExtensionResolvers.ts`、迁移门禁 `AgentManager.createUnlocked` | 不适用（白名单已删除） |
| 原生 `extensions/skills/prompts/packages` 支持过滤和项目覆盖；`pi config` 提供四个内置扩展开关 | 已完成：原生规则层/服务/启动期迁移；技能、提示词、扩展的全局与项目开关都写原生过滤规则，列表与发现按原生条目投影；四个内置扩展开关有全局/项目 UI。白名单机制与私有禁用字段写入已全部移除，旧记录仅由启动迁移读取并清理 | 已完成（提交 `42f6ffda`…`f6880d9b` + A5 清理） | `piResourceRules.ts`、`PiResourceConfigService.ts`、`piResourceMigration*.ts`、`PiBuiltinExtensionsPanel.tsx`、各 Manager / `resourceDiscovery.ts` | 原生管理基线为 pi >= 0.99.2；私有旧字段仅作迁移读取，不再双写 |
| MCP 全局 + 已信任项目配置，同名项目定义整体替换全局 | 当前数据层仍浅合并，项目只读；需要完整 project CRUD、来源展示、有效停用覆盖与恢复继承 | 待 M1 | `mcpConfig.ts`、`ConfigManager.ts`、`McpTab.tsx`、`tests/mcpConfig.test.mjs` | 无；整体替换是长期原生语义 |
| MCP schema：`enabled/exposure/toolExposure/oauth`、全局 `auth.provider`、顶层 `autoEnableCodemode` | 已有表单初版；需补严格类型校验、未知字段保留、OAuth 字段与原生 provider auth；`codemode-deferred` 仅为 `codemode` 别名 | 部分实现，待 M1/M3 | `types/mcp.ts`、`mcpConfig.ts`、`mcpForm.ts`、MCP UI 测试 | 旧别名读取跟随 pi，不能当成第五种独立 exposure |
| `pi mcp list/login/logout` CLI | 已有命令包装和页面按钮；尚缺准确 scope/cwd、WSL/agentDir 对齐、取消、操作身份、退出原因校验和 URL 分块处理。报告仅代表 CLI 检测进程 | 部分实现，待 M2 | `piMcpCli.ts`、system IPC/preload；应补 CLI 行为测试 | 长期只走 CLI，不以 RPC OAuth 或 SDK 桥替代 |
| 第三方 `/mcp` 扩展可替换内置 MCP | 已有已知包识别和启动提醒初版；缺当前 runtime 来源确认、迟到结果保护、可靠首轮投递和可用导航 | 部分实现，待 M3 | `mcpThirdParty.ts`、`AgentManager.ts`；应补启动提醒行为测试 | 保留准确的检测/卸载引导，不恢复 adapter 安装教程 |
| 默认工具选择及 codemode 子设置 | 多选初版已存在；显式空列表后添加工具会错误恢复默认，项目跨层空数组语义未处理，子字段启用判断及未知字段保存有缺陷 | 部分实现，待 T1 | `defaultTools.ts`、`DefaultToolsInput.tsx`、`SettingsTab.tsx`、`tests/defaultTools.test.mjs` | 无；必须按实际原生合并语义编码 |
| `disabled` 不是原生启停字段；socket / SSE 不支持 | UI 仍将 `disabled` 当作停用，启用实际写 `enabled:true`；导入器仍有 legacy 转换路径。须纠正展示、校验和导入，保留原文且提示不支持项 | 待 M1/M3 | `McpResourceViews.isMcpServerDisabled`、`McpTab.toggleDisabled`、`mcpImport.ts` | 仅在明确旧来源导入时转为原生值；不能永久伪装 legacy 字段生效 |
| OAuth 凭据存于 `mcp-auth.json` | 备份 file key 已加入；脱敏、旧备份兼容与恢复行为仍需验证 | 待 M1 验证 | `ConfigBackupManager.ts`、`types/backup.ts`、`tests/configBackupManager.test.mjs` | 无；凭据继续由 pi 管理，PiDeck 不借备份实现认证 |
| bash 结构化结果 1MiB + `truncated/full_output_path`（codemode 脚本可见） | 提交 `65da84fe` 已适配提示；本轮不扩展该逻辑 | 已有提交 | `65da84fe` | 不适用 |

## 0.85.0 适配矩阵

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 兼容代码移除条件 |
|---|---|---|---|---|
| Anthropic transports 持久化每轮 thinking effort，安全恢复 signed-thinking mismatch | PiDeck 的思考选择器走 `get_available_thinking_levels` + `set_thinking`，effort 持久化是 Pi 内部行为 | 已确认 | `thinkingLevels.ts`、`AgentManager.setThinking` | 不适用；RPC 边界无变化 |
| SDK 新增 `SessionManager.inMemory()` 恢复外部管理会话 | PiDeck 只走 stdio JSON-RPC，不使用 pi SDK | 无需改动 | Pi RPC 边界 | 不适用 |
| 新增继承模型设置 `vllmPriority` / `supportsMaxOutputTokens` | PiDeck 配置模板/模型编辑不写这两个字段，pi 读取自己的 models.json；catalog 提取字段集合不含它们，无需新逻辑 | 已确认 | `generate-pi-ai-catalog.mjs`、`ConfigManager` | 不适用 |
| provider stream 事件序列与自定义 tool-call delta 修复 | PiDeck 流式投影已兼容 delta-only `message_update`，本次修复不改变事件形状 | 已确认 | `AgentManager.handleAssistantMessageEvent()` | 保留 delta-only 处理；不要恢复依赖 partial 的逻辑 |
| 恢复 `@earendil-works/pi-coding-agent/client` 入口 | PiDeck 不使用该入口 | 无需改动 | Pi SDK 边界 | 不适用 |
| Qwen Token Plan Individual catalog 补入 Qwen3.8 Flash | catalog artifact 重新生成（pi-ai 0.85.0）后自动获得 | 已完成 | `resources/pi-ai-catalog.json`、`tests/adaptiveModelTemplate.test.mjs` | 与主进程 catalog 升级同步完成 |
| Baseten GLM-5.2 不再误报图像输入 | catalog artifact 重新生成后 `input` 字段已修正 | 已完成 | `resources/pi-ai-catalog.json`（GLM-5.2 `input: ["text"]`） | 与主进程 catalog 升级同步完成 |
| 继承 NO_PROXY 根域/子域匹配修复 | PiDeck 只透传 `NO_PROXY` env（`PiLocator`/`sessionProxyPolicy`），匹配逻辑在 pi 内部 | 无需改动 | `PiLocator.createProcessEnv()` | 不适用 |
| 内置工具（bash/edit/find/grep/ls/read/write）尊重 `ctx.cwd` | PiDeck 不注入 cwd 策略，工具行为由 pi 自己管理 | 无需改动 | Pi 工具边界 | 不适用 |
| 导入会话同名不再覆盖已有文件 | pi 自身 `session import` 的修复；PiDeck 的 Codex/Claude/OpenCode 导入器是自己实现的独立路径 | 已确认 | `sessions/CodexSessionImporter.ts` 等 | 不适用；PiDeck 导入器是独立实现 |
| RPC `abort` 在手动压缩期间真正取消（此前误报成功） | PiDeck 发送 `compact` 命令后由 pi 执行；abort 语义修复让取消更可靠 | 已确认 | `compactRpc.ts`、AgentManager abort 路径 | 不适用 |
| `/model` 移除 Grok Build 0.1 | 运行中的 pi CLI 自己维护模型列表，PiDeck 不自建 `/model` | 无需改动 | Pi 边界 | 不适用 |
| `reload_config` RPC 提案被关闭（not_planned） | PiDeck `refreshModels()` 策略 1 永远不可用；注释与实现需改为现实的提示/重启方案 | 待做（P1） | `AgentManager.refreshModels()`、issue #6890 | 见下方专节 |

### reload_config 现状（2026-09 确认）

`https://github.com/earendil-works/pi/issues/6890` 已于 2026-07-21 以 `not_planned`（`no-action`）关闭，v0.85.0 与 main 的 `rpc-types.ts` 均无该命令。PiDeck 的 `refreshModels()` 中等待该 RPC 自动生效的策略 1 不会到来，应更新注释，并将后续工作改为：提示用户重启 Agent，或评估重启子进程策略（需处理 exit 事件竞态）。

## 0.84.3 适配矩阵

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 兼容代码移除条件 |
|---|---|---|---|---|
| `compact` 自定义指令字段由 `prompt` 改为 `customInstructions` | 同时发送两个字段；旧 Pi 读取 `prompt`，新 Pi 读取 `customInstructions` | 已完成 | `src/main/pi/compactRpc.ts`、`tests/compactRpc.test.mjs` | PiDeck 的最低支持 Pi 版本提升到 `>=0.84`，并完成一个迁移周期后，删除旧 `prompt` 字段与对应测试 |
| Windows 默认 shell 仍为 Bash | 不修改 Pi 的 shell 选择；Pi 自己按 `shellPath`、Git Bash、PATH 顺序解析 | 已确认 | Pi 0.84.3 `getShellConfig()`；PiDeck 不注入 shell 参数 | 不适用；这是 Pi 的职责 |
| 新增可选 `powershell` 工具 | 不默认写入 `defaultTools`，由用户在 Pi 的 `~/.pi/agent/settings.json` 中选择；Pi 自己负责 `pwsh.exe` → `powershell.exe` 回退 | 暂不接管 | 不修改 `PiProcess` 的 `--mode rpc` 启动参数 | 不适用；若未来 PiDeck提供开关，应单独定义配置契约和迁移策略 |
| `message_update` 改为 delta-only，不再带完整 partial message | 现有流式处理已可在无 partial 时使用 `delta` 累积正文/思考 | 已基本兼容 | `AgentManager.handleAssistantMessageEvent()` | 保留 delta-only 处理；不要恢复依赖 partial 的逻辑 |
| `toolcall_start` 携带稳定 id/name | 当前 UI 主要消费顶层 `tool_execution_start/update/end`，并按 `toolCallId`/`toolName` 合并工具卡 | 已基本兼容 | `AgentManager.upsertToolMessage()`、工具状态回归测试 | 只有当 Pi 删除顶层工具事件、或需要在执行前展示工具调用参数时才补专门处理 |
| streaming usage 数据修复 | PiDeck 当前主要在终态消息/`get_state`/session stats 读取 usage；不依赖中间 partial usage | 暂无必须改动 | `AgentManager` runtime stats 路径 | 若要显示实时 token 计数，再单独消费 `message_update.usage` |
| `compaction_end` 失败信息更完整 | 当前记录 `result/errorMessage` 到日志，但失败未形成明确用户提示 | 待做（P1） | `AgentManager` 的 `compaction_end` 分支 | 完成用户可见错误卡/提示并加入回归测试后关闭 |
| 压缩摘要模型不再暴露工具 | Pi 自己处理，PiDeck不复制摘要逻辑 | 无需改动 | Pi RPC 边界 | 不适用 |
| 新增模型/provider/thinking 能力 | 运行中的 Pi CLI 自动获得；配置自适应模板只读 PiDeck 自带、由 `pi-ai@0.84.4` 构建期提取的 catalog artifact，endpoint `/models` 实报字段优先合并，不读 capability cache / 外部 Pi 目录 | 已完成 | `src/main/pi/modelCapabilityResolver.ts`、`src/renderer/src/utils/modelSpecAutoFill.ts`、`ConfigModal.handleResetModelToAdaptive`、`tests/adaptiveModelTemplate.test.mjs` | 升级 catalog 输入后重新生成 artifact，并跑 typecheck、catalog 与自适应模板测试，并确认 DSH 仍使用 adapter 声明兼容的独立版本 |
| 按模型提供 thinking levels | Pi `0.81.0` 新增 `get_available_thinking_levels`；DSH 按 host 的 `reasoning.efforts` 过滤；Pi 活跃 runtime 调用该 RPC，旧 Pi/查询失败回退固定列表 | 已完成（带兼容回退） | `AgentManager.ts`、`thinkingLevels.ts`、`SessionRuntimeCoordinator.ts`、`ComposerPickerHost.tsx`、`tests/piThinkingLevels.test.mjs` | 最低支持 Pi 提升到 `>=0.81` 并完成迁移周期后，删除旧 RPC 的静态列表回退与 `TODO(remove-compat)` 分支；`THINKING_LEVELS` 的本地化标签映射仍保留 |
| `/thinking`、模型/思考级别默认变为 session-scoped、`Ctrl+S` 保存全局默认 | PiDeck 使用自己的模型/思考级别 UI；RPC 模式没有 Pi TUI 快捷键冲突 | 无需照搬 | `AgentManager.setModel/setThinking`、renderer composer | 不适用 |
| `pi update --self` 成为官方自更新入口 | PiDeck 当前仍执行兼容的 `pi update pi` | 待做（P1） | `src/main/extensions/ExtensionManager.ts` | 确认最低支持版本后改为 `--self`，或保留版本门控 |
| 更新机制增加版本缓存/原子更新语义 | PiDeck 自有 `PiProcess.versionCache`、`ExtensionManager.piVersion` 尚未在 Pi 更新后统一失效 | 待做（P1） | `src/main/pi/PiProcess.ts`、`src/main/extensions/ExtensionManager.ts` | 新 Agent 已能稳定使用更新后的版本，并有缓存失效回归测试后再关闭 |
| Pi 配置读取兼容 BOM | PiDeck 部分 JSON 读取仍直接 `JSON.parse(raw)` | 待做（P1） | `src/main/index.ts`、`src/main/settings/SettingsStore.ts`、配置读取模块 | 统一 JSON 读取入口并加入 BOM 测试后关闭 |

## 思考级别过滤现状

### Pi 后端：已接入按模型过滤

Pi 0.84.3 的 RPC 会基于当前模型的 `thinkingLevelMap`/`getSupportedThinkingLevels()` 返回档位。PiDeck 活跃 Pi session 打开思考选择器时调用：

```text
sessions:runtime-thinking-levels
→ get_available_thinking_levels
→ ThinkingPicker.levels
```

旧 Pi 返回 unknown-command、runtime 查询失败或返回结构不合法时，渲染层继续使用固定的 `off/minimal/low/medium/high/xhigh/max` 列表，保证未升级 Pi 的用户可用。RPC 返回的未知未来档位仍会显示原始 id。

### DSH 后端：已经有按模型过滤

流程是：

1. DSH host 的 `llm.models` / `session.models` 返回模型的 `reasoning.efforts`；
2. `src/main/dsh/dshModels.ts` 转换为 `AvailableModel.reasoningEfforts`；
3. `ComposerPickerHost.tsx` 找当前 provider/model，把这些 effort 映射成 `ThinkingPicker.levels`。

其中 `llm-deepseek` 通常返回自己的档位声明；`llm-pi-ai` 则由 `@deepseek-ai/dsh-llm-pi-ai` 调用 pi-ai 的 `getSupportedThinkingLevels(model)`，依据 `reasoning` 与 `thinkingLevelMap` 生成档位，并在请求不支持时拒绝 `UNSUPPORTED_REASONING_EFFORT`。

### RPC 接入后，模型映射仍然需要

需要保留，且它们不是同一层的重复数据：

- Pi 模型的 `reasoning`：仍表示模型是否支持推理，是 Pi 自己计算可用档位的输入；
- Pi 模型的 `thinkingLevelMap`：仍负责把规范档位映射成 provider 的 wire 值。RPC 只返回“可选哪些档位”，不替用户配置或保存这个映射；
- DSH 模型的 `reasoningEfforts`：仍是 DSH host 的模型目录契约；
- `providerMigration.ts` 中 `thinkingLevelMap ↔ reasoningEfforts` 的双向映射：仍需保留，因为它负责持久化的 Pi↔DSH 配置迁移，不是思考选择器的运行时查询。

因此本次改动只替换 Pi 选择器的能力来源，不删除新增模型配置里的两个 reasoning 映射。

## Windows shell / tool 决策

### Bash（当前默认，推荐保持）

Pi 0.84.3 在 Windows 上按以下顺序找 Bash：

1. `~/.pi/agent/settings.json` 的 `shellPath`
2. Git Bash 默认路径
3. PATH 中的 `bash.exe`（Cygwin/MSYS2/WSL 等）

保持 Bash 默认的理由：

- 与 Pi 原生默认行为和既有扩展/skills/提示词兼容；
- 不把工具策略写进 PiDeck，避免覆盖用户 Pi 配置；
- Git for Windows 已经是 Windows 开发环境的常见依赖。

### PowerShell（可选，不要求 PS7）

只有用户把 `powershell` 放入 `defaultTools` 后，模型才会把它作为内置工具使用：

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Pi 负责执行器选择：优先 `pwsh.exe`，否则 `powershell.exe`。因此 PiDeck 不应下载或捆绑 PowerShell 7。

`defaultTools` 的职责是 Pi 的配置，不是 PiDeck 的运行时开关。若同时启用 Bash 和 PowerShell，模型会拥有两个命令工具，适合用户对比测试，不建议作为 PiDeck 默认策略。

注意：`shellPath` 控制的是 Pi 的 Bash 工具路径，不是 PowerShell 的路径；PowerShell 有自己的自动探测逻辑。

### DSH 例外

PiDeck 的 `pwsh_persistent` 是 DSH 独立工具。其当前实现默认指向 Windows PowerShell 7 路径；这不代表 Pi 原生 `powershell` 工具要求安装 PS7。本记录不把两者合并。

## PiDeck 后续工作清单

### P0 / 应优先

- [x] `compact` 同时发送 `prompt` + `customInstructions`，兼容未升级 Pi 的用户。
- [ ] 如果 PiDeck 宣称支持“用户手动启用 powershell”，把 `powershell` 加入安全门的受管工具集合，并补充工具短语/回归测试；但不替用户启用 `defaultTools`。

### P1 / 建议

- [ ] `compaction_end` 失败形成用户可见提示。
- [ ] 更新完成后失效 `PiProcess.versionCache` 和 `ExtensionManager.piVersion`，并提示已有 Agent 需重启。
- [ ] 评估 `pi update --self`，必要时按 Pi 版本门控。
- [x] Pi 后端调用 `get_available_thinking_levels`，按 sessionId + agentId + runtimeGeneration 读取，旧 Pi 回退静态列表。
- [ ] 统一 PiDeck JSON 读取入口，兼容 UTF-8 BOM。
- [x] PiDeck 主进程 catalog 已从精确锁定的构建期 `@earendil-works/pi-ai@0.85.0` 提取为静态资源；DSH adapter 继续使用其声明兼容的 `0.82.1`，不通过 overrides 强行升级。

## pi-ai 依赖边界

PiDeck 当前有三条不同的 pi-ai 使用路径，不能混为一谈：

| 路径 | 实际使用 | 当前版本/职责 |
|---|---|---|
| Pi 后端运行时 | 外部 `pi --mode rpc` 进程内部使用用户安装的 Pi 自己携带的 pi-ai | PiDeck 不打包 Pi CLI，也不把自己的 pi-ai 注入 Pi 子进程；Pi 0.85.0 的 provider/thinking 逻辑由外部 Pi 自己负责 |
| PiDeck 主进程 | 只读构建期生成的 `resources/pi-ai-catalog.json` 与 manifest | `@earendil-works/pi-ai@0.99.1` 是精确锁定的 `devDependency` 输入；构建脚本只提取 context/maxTokens/reasoning/input/name/thinkingLevelMap 等规格字段，运行时不加载 SDK |
| DSH host | `dsh-llm-pi-ai` 动态调用 `createModels`、catalog、`getSupportedThinkingLevels` 和 provider API | `dsh-llm-pi-ai` 声明 `^0.82.1`；lock 将其解析为嵌套的 `@earendil-works/pi-ai@0.82.1`。对 0.x semver 而言该范围为 `>=0.82.1 <0.83.0`，不包含 `0.85.0` |

因此：

- **仅升级 PiDeck 的构建期 `@earendil-works/pi-ai` 输入到 0.99.1，不会让 Pi 后端 runtime 变成 0.99.1**，也不会自动打开 Pi UI 的按模型过滤；
- DSH adapter 在自己的依赖树中解析 `0.82.1`；PiDeck catalog artifact 的来源是 `0.99.1`，两者有意共存；
- 不建议用 `overrides` 强行把 DSH 的 pi-ai 改成 0.99.1。应等待/推动 `dsh-llm-pi-ai` 发布声明兼容 0.99.x 后，再整体升级 DSH 相关包并做 host smoke、thinking effort、流式请求和 provider catalog 回归。

### 是否打包进 PiDeck

**PiDeck 主进程不再打包完整的 `@earendil-works/pi-ai@0.99.1` SDK；安装包只带静态 catalog artifact**：

- `@earendil-works/pi-ai` 位于精确锁定的 `devDependencies`，`npm run build` 先运行 `scripts/generate-pi-ai-catalog.mjs`；
- 生成器在使用默认来源目录（`node_modules`）时会校验本地安装版本与 `package.json` 精确锁定一致，不一致直接失败并提示 `npm ci`（防陈旧安装静默降级目录）；确需从未锁定来源生成时显式传 `--source-dir`；
- 生成器从官方 `dist/providers/data/*.json` 提取条目时**保留官方全部字段**（含 `type`、`cost`、`inputLimits`、`compat` 等），只丢弃无 `id` 的条目，并用紧凑序列化写入 `resources/pi-ai-catalog.json` 及带来源/完整性信息的 manifest；
- artifact `schemaVersion` 为 **2**：旧版（v1）按白名单只留 9 个字段、没有 `type`，无法在读取时区分 chat / image / classifier，因此 v1 产物（含用户机器上旧版下载的覆盖层）会被校验拒绝并回落随包目录，不提供迁移器；
- 查询入口（能力补全、内置 provider 快照）只取 chat 条目；官方存在 3 组同 provider+id 的 chat/image 重名（openrouter），此时 chat 优先，生图条目不得抢占（否则容量列为空）；
- electron-builder 通过 `extraResources` 将这两个文件放进 `resources/`；`piAiBuiltinCatalog.ts` 运行时校验 manifest 的 catalog SHA-256 与条目数，失败则回退 endpoint `/models` 或用户手填；
- `scripts/verify-asar-runtime.js` 守护 app 的两份 catalog 资源；`scripts/check-dsh-asar.mjs` 与 `scripts/check-dsh-boot.mjs` 继续守护 DSH runtime 所需的 `pi-ai@0.82.1`；
- DSH 的完整 `pi-ai@0.82.1` 仍是其独立运行时闭包的一部分，不能为瘦身主进程而删除。

这份 catalog artifact **不是 Pi 后端 runtime 使用的那一份**。PiDeck 通过 `PiLocator` 执行用户已经安装的 `pi` CLI；Pi CLI 自己携带/解析自己的 pi-ai。PiDeck 不打包 `pi-coding-agent`，也不把 catalog 来源版本注入外部 Pi 进程。

升级记录：PiDeck 主进程 catalog artifact 的来源从 `0.84.4` 起，随上游 pi-ai 发布逐版跟进：`0.85.0` → `0.85.1` → `0.86.0` → `0.86.1` → `0.99.1`（2026-09；0.99.1 对应 42 个源 JSON、1592 条模型，含 OpenAI Codex 默认模型 gpt-6.1-sol）；DSH 仍保留 adapter 兼容的嵌套 `0.82.1`。catalog 与运行时的 Pi 版本解耦——补的是能力字段（contextWindow/maxTokens/thinkingLevelMap），权威闸门仍是 `pi --list-models` 与 RPC `set_model`。只有当 `@deepseek-ai/dsh-llm-pi-ai` 发布明确兼容 `@earendil-works/pi-ai 0.86.x` 的版本后，才升级 DSH adapter/runtime 依赖树，并完成 typecheck、catalog/迁移测试、DSH host smoke、thinking effort、流式请求和 provider catalog 回归。

## 兼容代码移除规则

兼容代码不能仅因“过了一段时间”删除。删除前必须同时满足：

1. PiDeck 明确提高最低支持 Pi 版本；
2. 安装/诊断数据或发布观察确认旧版本占比已低于项目设定阈值；
3. 对应的旧版本回归测试已改为最低版本测试；
4. 发布说明记录迁移影响；
5. 删除后跑 `npm run typecheck` 和对应针对性测试。

所有临时兼容分支应在代码中写明 `TODO(remove-compat)`，并在本文件同步写出移除条件，便于后续检索。
