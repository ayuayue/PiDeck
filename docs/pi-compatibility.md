# Pi CLI 兼容性记录

> **Status: Current（2026-11-09 核对；以代码与测试为准）**


> 这是一份**兼容账本**，不是 PiDeck 的功能设计文档。每次升级 Pi CLI 时，先把上游行为、PiDeck 处理方式和兼容代码的移除条件记在这里。
>
> 模型能力、思考档位和多模态配置的详细链路与重构方案见 [`docs/archive/plans/pi-model-capability-plan.md`](./archive/plans/pi-model-capability-plan.md)。

## 当前基线

- 最近核对版本：`pi 1.5.1`（2026-11-09 发布；依据：npm 包 CHANGELOG + `npm pack` 完整包与 `1.5.0` 的 `dist` 逐文件 diff）
- 核对方式：静态 diff + 源码核对（`npm pack @earendil-works/pi-coding-agent@1.5.0` 与 `@1.5.1`，排除 `bundle/` 的 chunk 哈希噪声）。RPC 类型面（`rpc-types.js`/`rpc-types.d.ts`/`rpc-mode.d.ts`）与 1.5.0 **逐字节相同**（`rpc-mode.js` 仅内部关闭/信号处理修复，协议不变）；`CURRENT_SESSION_VERSION` 仍为 **3**；`dist/index.js`、`settings-manager.js`、`session-manager.js` 相同；有差异的契约面逐条记在下面的 1.5.1 矩阵。**1.5.1 未在真实会话上跑回归**（见 1.5.1 矩阵末尾「待真实回归」）
- PiDeck 通信方式：`pi --mode rpc`，stdio JSON-RPC
- 本记录范围：Pi 后端（`src/main/pi/`）以及 PiDeck 对 Pi 配置/事件的适配
- 不包含：DSH 后端工具（原持久 pwsh 工具已于 0.2.1 下线）、Electron 自带终端、PiDeck 自己的应用更新器
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

## 1.5.1 审计矩阵（2026-11-09 发布；npm 包完整 dist 与 1.5.0 逐文件 diff）

核对方式：`npm pack @earendil-works/pi-coding-agent@1.5.0` 与 `@1.5.1`，解包后对契约面逐个 `cmp`（排除 `bundle/` 的 chunk 哈希噪声），有差异的再读源码确认语义。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| RPC 命令面与事件面 | `rpc-types.js`/`rpc-types.d.ts`/`rpc-mode.d.ts` 与 1.5.0 **逐字节相同**；`rpc-mode.js` 只改关闭/信号语义：空闲时扩展 `ctx.shutdown()` 立即生效、SIGTERM/SIGHUP 也触发优雅关闭、关闭中 stdin EOF/单次信号不打断（二次才强退）、shutdown 等待 pending work（如 MCP token 刷新）。协议与事件形状不变；PiDeck 停止顺序（stdin EOF → 宽限期 → taskkill/SIGKILL）与新语义兼容且更稳 | **已核对无变化**（关闭语义列入待真实回归） | 逐文件 `cmp` + `docs/rpc.md` diff | — |
| 扩展 API（`core/extensions/types.d.ts`） | `registerMarkdownTransformer(transformer, options?)` 增可选第二参（`messageTypes` 选 Markdown surface）；`GrepOperations.readFile` 改可选+deprecated（grep 上下文行改由 ripgrep 直接提供）；`ctx.ui.custom()` overlay 的 `blocked` 语义文档化。全部向后兼容；PiDeck 4 个内置扩展均未用这些面 | **无需改动** | 类型 diff + `grep registerMarkdownTransformer\|GrepOperations` 零命中 | — |
| `dist/index.js` / `index.d.ts`（SDK 入口） | `index.js` 逐字节相同；`index.d.ts` 只多导出 Markdown* 与 `CacheWarmingDecisionEventResult` 类型 → `pi-auth-host` / `pi-enhance-host` 入口安全 | **已核对无变化** | `cmp` + 导出列表 diff | — |
| settings：`settings-defaults.js` 仅 `cacheWarming` 默认 `"streaming"` → `"idle"`（空闲期也保温 prompt cache 至 30 分钟）；`settings-manager.js` 相同 | PiDeck 零引用 `cacheWarming`，未知键随设置快照往返保留，不加专用控件 | 无需改动 | `grep cacheWarming src/` 零命中 | — |
| `core/mcp-servers.js` 重构：`mcpServers` 形状校验与 `mcpNamespace`/`isMcpServerOverride` 等挪进 `@earendil-works/pi-mcp`（`mcp-servers.js` 不再导出 `mcpNamespace`/`isLoopbackRedirectUri`）；`oauth.clientRegistration` 取值不变 | PiDeck 的 `mcpNamespaceKey` 是自实现，不 import pi dist 内部模块；1.5.0 适配的 `auto` 语义仍有效 | 无需改动 | `grep mcpNamespace src/` 只命中自实现；`tests/mcpConfig.test.mjs` 不变全绿 | — |
| `pi mcp list --json`：每个 server 新增可选 `authProvider` 字段（`auth.provider` 的 server）；provider-auth server（如 Radius）现在真的带 provider token 连接（少误报 `needs-auth`）；非 JSON 输出的 sign-in 提示改为 `pi auth <login\|logout> <provider>` | PiDeck 解析器只挑已知字段，新字段被安全忽略；`state`/`tools` 等语义不变。未来要在 MCP 页展示「用 `pi auth login <provider>` 登录」提示时再消费 `authProvider` | 无需改动（MCP 页状态准确性列入待真实回归） | `parseMcpListOutput` 字段挑选逻辑 | 要展示 authProvider 登录提示时再消费 |
| 新 CLI：`pi auth login/logout <provider>`（不走会话，`--api-key`/`--no-browser`）；登录 Radius 时自动配置 Radius MCP server（只在 CLI 与 TUI `/login` 路径）；`pi update` 列出每个包的版本变化（`PackageManager.update()` 增 `result` progress 事件） | PiDeck 登录走 SDK 侧车（`pi-auth-host`，不经 CLI/TUI 路径，Radius MCP 自动配置不生效——与 1.5.1 前一致，非回归）；`pi update --self` 输出当不透明文本展示 | 无需改动（观察项） | `piSelfUpdateRunner.ts` 的 raw output 通道；`grep "auth login" src/main` 零命中 | 若要给 Radius 登录补 MCP 自动配置，再评估调用 `planRadiusMcpServer` |
| OpenAI 兼容模型禁用全部工具时不再发 `"tools": []`（vLLM 0.20+ 400 修复）；新增 compat：`requiresToolsWithToolHistory` / `promptCacheKeyMode` / `requiresNonNullAssistantContent` / `supportsMessageThreads`（Anthropic message threads 对 `anthropic` provider 默认开） | PiDeck 的 compat 编辑面 spread 合并（`...props.compat` / `...(original.compat ?? {})`），手写未知子键原样保留，不被表单抹掉 | 无需改动 | `ProviderConnectionForm.tsx` / `addProviderDraft.ts` 的 spread 语义（同 1.4.0 轮核对） | — |
| **模板参数引号语义（#11861）**：`parseCommandArgs` 改为引号只在参数开头开启（词中擇号如 `doesn't` 保持字面）、闭合引号内 `\"`/`\'` 产出字面引号、未闭合引号回读为文本后重解析（`core/prompt-templates.js` 变更） | PiDeck 在 `templateArgs.ts` **逐条移植了该函数**（本地展开为保住模板名 → chip），旧副本停在 1.5.0 语义：同一模板在「PiDeck 展开」与「pi 展开」会产出不同正文（如 `/review doesn't matter` 旧版被并成一个参数、词尾引号被丢弃）。已同步移植 1.5.1 版本（含轮末未闭合回读检查，需去掉 `continue` 早退） | **本轮已适配** | `src/renderer/src/utils/templateArgs.ts`、`tests/templateArgs.test.mjs`（新增 1.5.1 边界期望，来自对 pi 1.5.1 dist 实跑对拍 20/20 一致）；`composerBehavior`/`composerChips`/`composerChipIcon` 回归全绿 | 无 |
| **pi-ai 1.5.0 → 1.5.1**：1712 → **1768** 条（chat 1592→1639 / classifier 56→63 / image 64→66），新增 77 / 移除 21，新 provider `qwen-token-plan-individual-cn`（Qwen Token Plan 个人版中国端点）；`baseUrl` 与 `api` **零变化** | 重锁 pi-ai 1.5.1（连带 pi-schema / pi-telemetry 1.5.1）、重生成 catalog、更新 packaging 测试断言；用量探针 host 白名单与 `KNOWN_PROVIDER_ENDPOINTS` 无需改 | **本轮已适配** | `package.json`/lock、`resources/pi-ai-catalog*.json`、`tests/piAiCatalogPackaging.test.mjs`；`npm run check:pi-ai-catalog` → up to date | 无 |
| 默认模型改名（anthropic → Claude Opus 5.5、azure → GPT-6.1 Sol、google/google-vertex → Gemini 4 Argon、GLM 5.3、MiniMax-M3、Qwen3.8 Max、Kimi K3.1 Pro / K2.7 Code 等）+ 新模型 Claude Fable 5.2 / Microsoft-Decision-1 classifier（GitHub Copilot） | PiDeck 不硬编码这些默认值，模型列表来自 catalog artifact + endpoint `/models` + `pi --list-models` | 无需改动 | `grep claude-opus-5-5\|microsoft-decision-1` 为 0 | — |
| `pi update --models` 失败语义修复：pi.dev 来源的内置 provider（如 `openai`）刷新目录不再刷新 OAuth token；登录型 provider（Radius/OpenRouter）token 过期只打警告且其余目录照常刷新，只有网络故障等才失败 | PiDeck 的冷启动目录刷新正好调用该命令（`modelListCache.ts` 的 `MODEL_CATALOG_REFRESH_ARGS`），旧行为下任一 provider 登录过期会让整次刷新失败（PiDeck 已有容错返回 false）；新行为减少误失败，退出码判定仍有效 | 无需改动（净改善，列入待真实回归观察） | `src/main/pi/modelListCache.ts` 的刷新容错路径 | — |
| 其余 pi 运行时修复：grep `glob` 相对 `path` 匹配、bash 超时报 exit code、steering 图片缩放、MCP OAuth 刷新/SSE/stdio 清理、OpenAI Responses `session-id` 头、扩展 symlink 解析（`canonicalizePath`）、SDK/RPC reload 等待运行中的响应/压缩、Windows Ctrl+V 粘贴、Windows 安装器（`install.ps1`）的 PowerShell 5.1 `NativeCommandError` 与 `managed-install.json` 容错 | 均为 pi 进程内/安装器行为，RPC 事件形状与会话 JSONL 格式不变；PiDeck 对 `managed-install.json` 只读且 1.4.0 轮已做 BOM 容错；symlink 解析修复对 PiDeck 的扩展加载只有正向影响（模板参数引号解析另见上方对齐行） | 无需改动 | `diff -rq` 文件清单；`PiLocator.isManagedInstallRoot` 的 `stripBom`（1.4.0 已适配） | — |

**待真实回归（1.5.1）**：

- RPC 关闭语义：空闲时扩展 `ctx.shutdown()` 立即生效、SIGTERM 触发优雅关闭且关闭期间 stdin EOF/单次信号不打断——PiDeck 停止会话/重启 pi 进程路径实测干净退出；
- `pi mcp list` 对 `auth.provider` server（如 Radius）带 provider token 连接：MCP 页状态不再误报 `needs-auth`；
- `cacheWarming: "idle"` 默认下空闲期保温行为（PiDeck 不经手，观察用量统计是否受影响）。

### 1.5.1 本机实测与跟进（2026-11-09，pi 1.5.0 / 1.5.1 各三次）

上面的矩阵是静态契约核对；这一节是**跑起来测到的数**以及据此做的改动。探针：`pi --mode rpc --no-session --no-extensions --no-tools`，隔离 `PI_CODING_AGENT_DIR` + `PI_OFFLINE=1`，发一次 `get_state` 后分别关 stdin / 发 SIGTERM，计到进程退出。

| 场景 | 1.5.0 | 1.5.1 |
|---|---|---|
| 空闲会话 stdin EOF → 退出 | 10–13ms | 9–11ms |
| 空闲会话 SIGTERM → 退出 | 8–10ms | 8–10ms |
| 挂一个 sleep 2s 的 `session_shutdown` 处理器 → EOF → 退出 | **2054ms** | **2092ms** |

由此得到的结论（都已落成代码改动）：

- **「shutdown 等待 pending work」不是 1.5.1 才有的**：`AgentSessionRuntime.dispose()` 在 1.5.0 就 `await emitSessionShutdownEvent(...)`，1.5.1 只是追加 `await settleCredentialWrites()`（在途 OAuth token 必须先落盘，`invalid_grant` 修复的前提）。PiDeck 的 `WINDOWS_PI_GRACEFUL_EXIT_MS` 因此从 1500ms 提到 **2500ms**：旧值会让自带 `session_shutdown` 清理的 `pi-deck-subagents` 在半途被 `taskkill`，新值盖住实测 ~2.1s 并给删除会话前的 3s 预算（`stopAndWaitForExit`）留 500ms。Unix 的组 SIGKILL 仍为 3s（同一份实测装得下，且它只清理退出后残留的组成员，不参与 `stop()` 等待）。
- **关闭语义的真实会话回归仍未做**：本节测的是 pi 进程自身；PiDeck 端到端（停止按钮 / 重启 pi / 删除会话）仍留在上面的待回归清单里。
- **`cache_warm` 用量条目**：`type:"usage"` 在 1.5.0 就有，PiDeck 的 `sessionProcessEvents` 已把它当过程事件（带 `usageKind`），`cacheHitStats` 只统计 assistant 消息 → 空闲保温只影响费用总量，不影响缓存命中率口径，无需改代码。
- **`pi mcp list` 的 `authProvider`**：PiDeck 渲染层（`McpResourceViews`/`McpTab`）本来就照实渲染 `needs-auth`（黄点 + 详情行），唯一被抑制的是「MCP OAuth 登录按钮」——那是 `auth.provider ≠ MCP OAuth` 的永久语义，不是版本兼容垫子。所以 1.5.1 之后少报 `needs-auth` 完全由 pi 侧数据生效，PiDeck 不需要版本门控（`piMcpCli.ts` 里 0.99.2 时代的降级注记已同步改写）。
- **上游 `CHANGELOG.md` 只增不减（增长型门槛的教训）**：实测 1.5.0 = 682,079 字符、1.5.1 = 712,870（每 minor 约 +30k）。`PiChangelogService.MaxFetchChars` 原值 800k（注释写「约 160KB」，早已失效）只剩 11% 余量，再过两三个版本会让「更新详情」对所有人静默降级成「在浏览器查看」。已改为 2M 并加回归用例（用旧上限必红的尺寸）。**不要按「当时文件大小 + 一点余量」定这类阈值。**
- **做运行时探针不要用 `npm pack` 解包目录**：包里没有 `node_modules`，加载 `.ts` 扩展会报 `Cannot find module 'jiti'` 并直接退出；要 `npm install --prefix <临时目录> @earendil-works/pi-coding-agent@<版本>`。

## 1.5.0 审计矩阵（2026-11-02 发布；npm 包完整 dist 与 1.4.0 逐文件 diff）

核对方式：`npm pack @earendil-works/pi-coding-agent@1.4.0` 与 `@1.5.0`，解包后对契约面逐个 `cmp`（排除 `bundle/` 的 chunk 哈希噪声），有差异的再读源码确认语义。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| RPC 命令面与事件面 | `rpc-types.js` / `rpc-types.d.ts` / `rpc-mode.js` / `rpc-mode.d.ts` 与 1.4.0 **逐字节相同** | **已核对无变化** | 逐文件 `cmp` | — |
| 扩展 API（`core/extensions/types.d.ts`） | 只增 TUI 渲染相关可选字段：`KeybindingHints`（`keyText()`/`keyHint()`，被 `ToolRenderContext`/`MessageRenderOptions`/`EntryRenderOptions` 继承）、`ctx.ui.custom()` 的 `blocked`、`MessageRenderOptions.messageId/timestamp` | **无需改动**（PiDeck 用 GUI 桥，不实现 TUI 渲染扩展） | `cmp` + 类型增量阅读 | — |
| `dist/index.js` / `index.d.ts`（SDK 入口） | `index.js` 逐字节相同；`index.d.ts` 只多导出 `KeybindingHints` 与 `PackageInstallFailure` 类型 | **已核对无变化** | `cmp` + 导出列表 diff | — |
| **`mcp.json` 的 `oauth.clientRegistration` 新增 `"auto"`，且 1.5.0 起为默认**（上游 `validateMcpServer` 允许 `"auto"`/`"dcr"`/`"cimd"`；`cimd` 的两条约束不变） | PiDeck 的校验只允许 `dcr`/`cimd`，会把 `auto` 判非法并拦保存 | **本轮已适配** | `src/shared/types/mcp.ts`、`src/main/config/mcpConfig.ts`、`tests/mcpConfig.test.mjs`（`auto` 通过 + 新文案断言） | pi 1.4 及更早完全下线后删掉兼容说明 |
| `pi mcp add --oauth-client-registration <mode>`、`pi mcp login\|logout [-l]` | PiDeck 不构造 `mcp add`；登录用 cwd 定位项目文件，不传 `-l` 仍能读到项目 server（`-l` 只是"强制只认项目定义"） | 无需改动 | `src/main/pi/piMcpCli.ts` 的 `login`/`list` scope 实现 | 若 PiDeck 要强化"只认项目 server"，再补 `-l` |
| 工具参数校验改由 `@earendil-works/pi-schema`：TypeBox 的 `Refine`/`BigInt`/`Undefined`/codec/`Format.Set` 不再作用，纯 JSON Schema（含 MCP）获得 coercion，失败文案改为 `- path: missing` 风格 | PiDeck 内置扩展没有这些受限特性；参数由 pi 校验，PiDeck 不解析失败文案 | 无需改动（文案变化列入真实回归观察） | `grep -rnE 'Type\.(Refine\|BigInt\|Undefined)\(\|Format\.Set\(\|Type\.Codec\('` 零命中 | — |
| pi-ai 不再 re-export TypeBox；扩展仍可从 `@earendil-works/pi-ai` 取 `Type`/`Static`/`TSchema`（pi 映射到 compat entry），`StringEnum` 仍是 TypeBox `TUnsafe<T>` | 4 个内置扩展从 pi-ai 导入 `StringEnum`；`npm run typecheck` 在 pi-ai 1.5.0 下通过 | **已核对无变化** | `npm run typecheck` exit 0；`resources/extensions/pi-deck-{ask-question,todo,linked-sessions}.ts` | — |
| `core/session-manager.js`：`pathsEqual` 路径比较、`_appendEntry` 写失败回滚内存、fork 用单 fd 写入；`CURRENT_SESSION_VERSION` 仍 3 | PiDeck 自己扫描会话（`src/main/sessions/SessionScanner.ts`，含 WSL `/mnt` 归一口径），不经 pi 的 list/fork 写入 | 无需改动 | `cmp` + 常量核对 + `SessionScanner` 路径归一实现 | — |
| `core/package-manager.js`：`pi` 对象只有元数据（`changelogPath`、画廊）时仍走目录自动发现；新增 `installFailures`；npm 更新校验带回 installed/target 版本并提示 registry 陈旧 | PiDeck 不消费 package-manager（扩展安装走 pi CLI 与自有商店链路） | 无需改动 | 全仓无 `changelogPath` / `installFailures` 消费点 | — |
| `schemas/settings.schema.json` 新增 `extensionChangelogVersions`、`selfUpdateCommand`；`settings-manager.js` 加对应 getter/setter；`settings-defaults.js` 不变 | PiDeck 设置页写 `settings.json` 是读-改-写、未知键保留，不为新键加专用控件 | 无需改动 | `ConfigManager` 读写路径；1.4.0 起的三处 BOM 容错仍有效 | — |
| `Usage.cost.totalFromProvider`（区分 provider 报账与 catalog 估算，只有各部分都由 provider 报账时才标记） | PiDeck 的用量统计读会话 JSONL 的 `usage.cost.total`，新字段是增量 | 无需改动 | `src/renderer/src/components/app/settings/UsageStatsTab.tsx` 等只读 `cost.total` | 若将来要区分"估算/官方账单"再消费新字段 |
| 信任修复：`trust.json` 里保存的 "Do not trust" 优先，项目没有 trust-requiring 资源时也不再自动信任 | 信任状态由 pi 判定，PiDeck 只展示/写同一份 `trust.json` | 无需改动（回归观察） | 见「待真实回归（1.5.0）」 | — |
| 内置模型目录更新到 models.dev v2（realtime/image-only 不再作为 chat 模型，新增 GPT-6.1 Terra 等）；默认 OpenAI 模型 `gpt-5.5` → `gpt-6.1-sol` | pi-ai 已锁 1.5.0 并重生成 catalog（1712 entries）；PiDeck 没有硬编码默认模型 | **本轮已核对** | `f7ecacadc`（合并自上游 dev）、`npm run check:pi-ai-catalog` → up to date | — |
| `pi.exec()` 的 `maxBuffer`/`truncated`、扩展更新 changelog（`collapseChangelog`）、`PI_SELF_UPDATE_COMMAND`、compaction/branch summary 的 OAuth token 修复、系统提示词收紧、`/model`、`/resume` 搜索排序 | PiDeck 扩展不用 `pi.exec`；其余是 pi 内部行为或 TUI 显示 | 无需改动 | `grep -rn 'pi\.exec' resources/extensions/` 零命中 | — |

**待真实回归（1.5.0）**：

- 工具参数校验失败时模型看到的文案换成 pi-schema 风格（`- limit: expected number, got string`），确认安全门与工具错误展示不依赖旧 TypeBox 文案；
- `trust.json` 的 "Do not trust" 优先后，PiDeck 项目/扩展页的信任状态展示与实际一致；
- 扩展包更新后的 changelog 首启提示（PiDeck 不渲染 TUI，确认不会影响会话启动或在 GUI 中出现未知提示）。

## 1.4.0 审计矩阵（2026-10-26，npm 包完整 dist 与 1.3.0 逐文件 diff）

核对方式：`npm pack @earendil-works/pi-coding-agent@1.3.0` 与 `@1.4.0`，两边解包后对关键契约面逐个 `cmp`，非逐行人工阅读。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| RPC 命令面与事件面 | `rpc-types.js` / `rpc-types.d.ts` / `rpc-mode.js` / `rpc-mode.d.ts` 与 1.3.0 **逐字节相同** → 会话/模型/思考档/压缩/命令列表等边界无变化 | **已核对无变化** | 逐文件 `cmp` | — |
| 扩展 API（`dist/core/extensions/types.d.ts`） | 与 1.3.0 **逐字节相同**；钩子名集合（`before_*` / `after_*` / `agent_*` / `turn_*`）diff 为空 | **已核对无变化** | `cmp` + 钩子名集合 diff | — |
| `dist/index.js` / `index.d.ts`（`ModelRuntime` SDK 入口） | 与 1.3.0 **逐字节相同** → `pi-auth-host.mjs` / `pi-enhance-host.mjs` 的入口安全 | **已核对无变化** | `cmp` | — |
| `package-manager.js` / `settings-manager.js` / `settings-defaults.js`（资源过滤与默认值） | 三个文件与 1.3.0 **逐字节相同** → 1.2.0 补的 `~` 归一仍是正确口径，原生资源投影无需再改 | **已核对无变化** | 逐文件 `cmp` | — |
| 会话文件格式 | `session-manager.js` 与 1.3.0 **逐字节相同**，`CURRENT_SESSION_VERSION` 仍为 **3** | **已核对无变化** | `cmp` + 常量核对 | — |
| `pi mcp list --json` CLI 输出 | `extensions/mcp/cli.js` 与 1.3.0 **逐字节相同** | **已核对无变化** | `cmp` | — |
| **`mcp.json` 读取兼容 UTF-8 BOM**（#11191；`extensions/mcp/config.js` 改用 `stripBom`） | PiDeck 的 `parseMcpConfigFile` 仍是裸 `JSON.parse`：同一份带 BOM 的文件 pi 能加载、PiDeck 报「配置损坏」并拦住可视化保存与配置包导入。已改为先 `stripBom`，与 pi 同口径 | **本轮已适配** | `src/main/config/mcpConfig.ts`、`tests/mcpConfig.test.mjs`（BOM 用例） | 无 |
| **`managed-install.json` 读取兼容 BOM**（同一根因；pi 1.4.0 的 `pi update` 不再因 BOM 报「Managed install marker is missing or invalid」） | `PiLocator.isManagedInstallRoot` 与 `piAuthHostLaunch.isManagedInstallRoot` 都是裸 `JSON.parse`：带 BOM 时官方安装被误判成 `custom`，`pi-auth` / `pi-enhance` 侧车解析不到 SDK 入口（提示词增强置灰、智能体不可用）。两处均改为先 `stripBom` | **本轮已适配** | `src/main/pi/PiLocator.ts`、`src/main/pi/auth/piAuthHostLaunch.ts`、`tests/piLocatorInstallations.test.mjs`、`tests/piAuthHostLaunch.test.mjs` | 无 |
| **PiDeck 通用配置读取兼容 BOM**（非 1.4.0 引入，是账本既有 P1 待办的顺带收口） | `ConfigManager.readJsonFile` 读 `models.json` / `auth.json` / `settings.json` / `mcp.json` 是裸 `JSON.parse`；失败后 `parsed` 退回空对象——页面显示「配置是空的」，用户一点保存就把真配置写没。改为复用 `piConfigFileStore.stripBom` | **本轮已适配** | `src/main/config/ConfigManager.ts`、`tests/configReadBom.test.mjs`（新增；含「BOM 之外的损坏仍如实报诊断」反例） | 无 |
| **`compaction.reserveTokens` 语义收窄**：摘要改用模型 output limit，该设置只决定「何时开始压缩」 | PiDeck 的滑条换算（`reserveTokens / contextWindow` 占比）本来就对应新语义，算法无需改；只有设置页提示文案仍写「为模型回复预留的 token 空间」，会误导用户以为它还在限制摘要长度。已改中英文案 | **本轮已适配** | `src/shared/compactionSlider.ts`（逻辑不变）、`rendererCopy.zh-CN.ts` / `en-US.ts` / 生成物 `zh-TW.ts`、`tests/compactionSliderSettings.test.mjs` | 无 |
| `models.json` schema 新增 `default`（`contextWindow:128000` / `maxTokens:16384` / `input:["text"]` / `reasoning:false`），并新增 `ModelsJsonSchemas` 导出与 `docs/models-configuration.md` | 在整个 `dist`（含 `bundle/`）grep `Value.Default` **零命中**；`provider-composer.js` 本来就是 `?? 128000` / `?? 16384`。这些 `default` 只喂新生成的文档，运行时语义不变 → PiDeck 的模型编辑表单无需补默认值逻辑 | 无需改动 | `cmp` + 全仓 `Value.Default` 检索 + `provider-composer.js` 源码核对 | — |
| provider 级 `compat` 现在也作用于 classifier（新增 `imageInput` / `sendImageOptInHeader`） | PiDeck 的 compat 编辑面用 `...props.compat` / `...(original.compat ?? {})` 展开合并，手写的未知子键（含这两个）原样保留，不会被表单抹掉 | 无需改动 | `src/renderer/src/config/ProviderConnectionForm.tsx`、`addProviderDraft.ts` 的 spread 语义 | — |
| `before_provider_headers` 不再收到 OpenRouter / NVIDIA NIM / OpenCode 归因头（改由 pi-ai client identity 统一注入） | PiDeck 从未注册 `before_provider_headers` handler（`pi-deck-model-trace.ts` 只用 `before_provider_request`，且明确不采集请求头） | 无需改动 | `grep before_provider_headers` 只命中类型注释 | — |
| 截断响应恢复：`_omitRecoveryAttempt` 改为从投影上下文里成对找 assistant + toolResult，用 `context_edit` 一并排除（#11227/#11233） | 会话文件仍只追加 `context_edit`（`replacement: null`），PiDeck 的 `sessionContextProjection` 已按 pi 语义应用 `context_edit`（排除即不显示、原条目保留）→ 无需适配；这是对「恢复后会话永久 400」的净修复 | 无需改动（观察项） | `src/main/pi/sessionContextProjection.ts` 的 `parseReplacement` / 投影应用 | — |
| 恢复会话/`/tree` 后扩展工具活跃性（#11062/#11075）：按分支历史 `toolsAdded`/`toolsRemoved` 重放，未提及的扩展工具视为新注册并激活 | pi 内部装载逻辑；PiDeck 的 `promptLoadout` 只**读**系统消息重放当前装载用于 token 估算，不参与激活决策 | 无需改动（真实回归观察项） | `src/main/pi/promptLoadout.ts`（只读重放） | — |
| 扩展可用 `@earendil-works/pi-ai/models` 子路径（#11156；`virtual-modules.js` + `loader.js` 新增该别名） | 纯增量：PiDeck 的 4 个内置扩展只 import `@earendil-works/pi-ai`（值）与 `@earendil-works/pi-ai/compat`（`completeSimple`），`compat.d.ts` 与 1.3.0 逐字节相同 | 无需改动 | `grep` 扩展 import 面 | — |
| `pi-ai` 1.3.0 → 1.4.0 目录变化 | 见下方「pi-ai 升级记录」：1714 → **1713** 条（chat 1599 / classifier 51 / image 63）；`baseUrl` 与 `api` **零变化** → 用量探针 host 白名单与 `KNOWN_PROVIDER_ENDPOINTS` 均无需改 | **本轮已适配** | `package.json` / lock、`resources/pi-ai-catalog*.json`、`tests/piAiBuiltinCatalog.test.mjs`（新增 1.4.0 断言）、`tests/piAiCatalogPackaging.test.mjs` | 无 |
| 其余 pi 运行时修复：`grep` 工具强制 `rg --no-config`（#11203）、Windows shell 探测（Store 别名 / PowerShell 不在 PATH / 非 `C:\Windows` 系统目录，#9504/#9501）、Copilot 大请求体 413 先压缩重试（#11016）、whitespace-only 工具输出不再让请求 400（#8720）、自动重试覆盖更多网关错误（#10920/#11057/#10996）、OpenAI Responses 缓存保留（#10940）、`/compact <instructions>` 在 split turn 生效（#11058）、HTML 导出 CJK 加粗、`@` 补全正则元字符、Rex terminal、`generateSummary` 忽略 `reserveTokens` 参数 | 均为 pi 进程内的请求构造 / 工具执行 / TUI 行为，RPC 事件形状与会话 JSONL 格式不变 | 无需改动 | `diff -rq` 文件清单 | — |
| 默认模型改名（copilot `gpt-5.4` → `gpt-6.1-sol`、xiaomi `mimo-v2.5-pro` → `mimo-v2.6-pro`、nvidia `nemotron-3.5-super-vl-120b-a12b`） | PiDeck 不硬编码这些默认值（`grep` 全仓为 0），模型列表来自 catalog artifact + endpoint `/models` + `pi --list-models` | 无需改动 | `grep gpt-5.4` / `grep mimo-v2.5-pro` 为 0 | — |
| `pi-tui` 1.3.0 → 1.4.0 | `dist/index.d.ts` 逐字节相同；其余变动在 `autocomplete` / `markdown` / `terminal` / `tui-alt-screen`。PiDeck 只用 pi-tui 的**图标资源**（`build/icon-pi-tui.png`），不 import 该包 | 无需改动 | `cmp` + `grep pi-tui src/` | — |

**真实回归（2026-10-26 已跑，`scripts/probe-pi-1.4-regression.mjs`）**

机器判据脚本，可复跑；退出码 0 = 全通过。对 pi 1.4.0（本机 CLI）实跑结果 **6/6 通过**：

| 项 | 判据 | 结果 |
|---|---|---|
| 扩展工具恢复（#11062/#11075） | 会话中途注册的扩展工具，`new_session` + `switch_session` 恢复后仍在 `activeTools` | ✅ |
| 截断响应恢复（#11227） | 会话文件与投影上下文均无「孤儿 toolResult」（assistant toolCall 被排除时其 toolResult 必须同批排除） | ✅ |
| `/compact <instructions>`（#11058） | 带 `customInstructions` 压缩后 `compaction_end` 无错误、会话文件写入 compaction 条目且带摘要文本 | ✅ |
| 压缩不撞 output cap（#9512/#9075） | 压缩结束无 `token cap` 报错 | ✅ |
| 恢复会话保留工具（#10785，1.3.0 遗留） | `switch_session` 前后 `activeTools` 集合一致 | ✅ |
| `/share` 目标设置（1.3.0 遗留） | `sessionShareDestination` 取 `auto`/`gist`/`radius` 时会话均正常启动（`share` 是 TUI 内置命令，RPC `get_commands` 不返回，故不断言命令存在） | ✅ |
| OpenCode 端点（1.3.0 遗留） | 内置 catalog 里 `opencode`/`opencode-go` 的 baseUrl host 为 `opencode.ai` 且路径含 `inference` | ✅ |

复跑方式：

```bash
# 零成本项（不调模型）
node scripts/probe-pi-1.4-regression.mjs --pi <pi 可执行文件>

# 含真实模型调用（会消耗额度）；--auth-from 借真实凭据，--provider/--model-id 指定可用模型
node scripts/probe-pi-1.4-regression.mjs --pi <pi> --live   --auth-from ~/.pi/agent --provider openrouter --model-id deepseek/deepseek-chat
```

脚本自带三个易踩的坑，已在注释里写明原因：`switch_session` 的参数名是 `sessionPath`；
`agent_end` 之后 pi 还会跑压缩检查，必须等 `agent_settled` 才能发下一条 prompt；
`prepareCompaction` 用 `keepRecentTokens` 从尾部找切点，会话不够大时会直接报
"Nothing to compact"，故 live 用例在隔离 settings 里把该值调小。

**仍需人工确认**（脚本无法覆盖）：带 BOM 的 `mcp.json` 在真实 Windows 上让 PowerShell 5.1
重写一次后，PiDeck 的 MCP 页不再报损坏、可正常保存与导入（本轮只有单测覆盖）；
以及 PiDeck 桌面端自身的 `/reload`、重启会话路径（探针直连 pi，不经 PiDeck 进程管理）。

## 1.3.0 审计矩阵（2026-10-16，npm 包完整 dist 与本机 1.2.0 逐文件 diff）

核对方式：`npm pack @earendil-works/pi-coding-agent@1.3.0`，与用户机器上已装的 1.2.0 比对；关键文件用 `cmp`/`diff` 判定，非逐行人工阅读。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| RPC 命令面与事件面 | `rpc-types.js`、`rpc-mode.js` 与 1.2.0 **逐字节相同** → 会话/模型/思考档/压缩/命令列表等边界无变化 | **已核对无变化** | 逐文件 `cmp` | — |
| `dist/index.js` / `index.d.ts`（`ModelRuntime` SDK 入口） | 只新增一个导出 `formatReadLineRange`（来自 `core/tools/render-utils`），无签名/行为变更 → `pi-auth-host.mjs`、`pi-enhance-host.mjs` 的入口安全 | **已核对无变化** | `cmp` + `diff` | — |
| `package-manager.js`（资源过滤/原生规则语义） | 与 1.2.0 **逐字节相同** → 1.2.0 补的 `~` 归一仍是正确口径，资源投影无需再改 | **已核对无变化** | 逐文件 `cmp` | — |
| 新增 `sessionShareDestination` 设置（`settings-defaults.js` 只加该键，`settings-manager.js` +13 行 get/set，`settings-schema.js` 随发布更新） | 不新增专用控件：设置文件整份快照往返（`ConfigModal` 持有 settings.json 全量），未知顶层键原样保留，新键随「其他设置项」区的可编辑条目展示；`ensurePiSettingsDefaults` 只补主题/思考/信任/压缩/重试，不接管 `/share` 目标 | 无需改动 | `src/main/config/settingsFormPayload.ts`、`src/renderer/src/ConfigModal.tsx`（`filteredEntries` 兜底区）、`src/main/index.ts`（`ensurePiSettingsDefaults`） | — |
| `/share` 描述改为「Radius artifact 或 GitHub gist」 | PiDeck 没有自己的 `/share` 实现，斜杠命令面板只透传 pi 的 `get_commands`，无硬编码文案 | 无需改动 | `grep /share` 核对（命中项均与共享会话无关） | — |
| `--model` 的 provider 歧义修复（`model-resolver.js` 重构出 `resolveModelReference` / `findExactModelReferenceMatch`；无凭据的单一匹配也能解析） | PiDeck 探测/列表始终同时传 `--provider` + `--model`，不依赖歧义猜测 | 无需改动 | `src/main/pi/PiModelProber.ts` | — |
| 恢复会话保留 active tools，`--tools +name/-name` 叠加在恢复的装载结果上 | PiDeck 不向 pi 传 `--tools`（工具选择由用户在 pi 侧配置），恢复会话的工具面仍由 pi 自己决定 | 无需改动 | `grep --tools src/main` 为 0 | — |
| `models.json` 新增 compat 标记 `supportsMidConvoEffort`（`model-config.d.ts` 联合类型扩展） | 自定义供应商配置整对象往返（`normalizeModelsForPi` 展开 provider/model 对象、只补默认值），未知字段不丢 | 无需改动 | `src/main/config/ConfigManager.ts`（`normalizeModelsForPi`） | — |
| 工具调用参数 JSON 解析失败改为在校验层直接判失败（pi-ai 类型新增 `argumentsError`） | pi 内部行为，不产生新的 RPC 事件形状；PiDeck 工具卡片按通用参数展示，不解析该字段，空 `arguments` 不崩溃 | 无需改动（观察项） | — | 用户反馈需展示原始参数错误时再补卡片展示 |
| `parseCommandArgs` 保留引号内的空参数（`prompt-templates.js`） | PiDeck 提示词库把模板文件交给 pi 解析，自己不解析参数 | 无需改动 | — | — |
| kimi-coding：`api` 由 `anthropic-messages` 改为 `openai-completions`，baseUrl 由 `api.kimi.com/coding` 改为 `api.kimi.com/coding/v1` | PiDeck 的用量探针用 host 前缀 `api.kimi.com` 匹配，两种形态都命中；catalog 的 `api`/`baseUrl` 只作为 DSH 用量档案与 endpoint 兜底回退，不写死到会话链路 | 无需改动 | `src/main/config/providerUsageProbe.ts`、`ConfigManager`（`profile.api ?? catalogSnapshot?.api`）、`tests/providerUsageProbe.test.mjs` | — |
| opencode / opencode-go：provider baseUrl 由 `opencode.ai/zen` 改为 `opencode.ai/inference`（catalog 里 82 + 27 条） | 实测两 host 都可访问（别名，`/v1/models` 与 `/go/v1/models` 四种组合均 200），且 DSH 自带的 pi-ai 仍用 `zen`；PiDeck 侧把 `inference` 加入用量探针的 host 白名单并保留 `zen` 兼容既有配置，`KNOWN_PROVIDER_ENDPOINTS` 的模型发现端点改用官方注册表的 `inference`（存量 `models.json` 不动） | **本轮已适配** | `src/main/config/providerUsageProbe.ts`、`tests/providerUsageProbe.test.mjs`、`src/renderer/src/config/providerHeaders.ts`（`KNOWN_PROVIDER_ENDPOINTS`） | `zen` 域名彻底下线后删掉 zen 分支 |
| PiDeck 静态模型目录来源更新 | 构建期 `pi-ai` 精确锁定从 1.2.0 更新到 1.3.0；42 个 provider、1714 条模型（chat 1614 / image 60 / classifier 40），相较 1.2.0 目录新增 84、移除 19、字段变更 185。仅更新静态资源，不改 OpenRouter 联网刷新或 DSH 独立依赖 | 已更新（本轮） | `package.json` / lock、`resources/pi-ai-catalog*.json`、目录生成/读取/打包与能力补全测试 | 无 |
| TUI 侧变化（`modes/interactive/*`、`core/tools/renderers/read.js` 行号标签、`export-html`、`credential-print`、`bundle/*`、`extensions/codemode/execute.js` 等） | 只影响 TUI/CLI 呈现；PiDeck 走 `pi --mode rpc`，`bundle/rpc-entry.js` 路径未变。`ctx.ui.custom({ overlay: true })` 的 `done()` 修复（#10648）也只在 TUI：RPC 下 `ctx.ui` 是空实现，PiDeck 只在扩展里读模型快照 | 无需改动 | `diff -rq` 文件清单 + `pi-deck-model-trace.ts` 头注核对 | — |
| 扩展 API 与 pi-tui | `dist/core/extensions/types.d.ts` 与 1.2.0 逐字节相同；`@earendil-works/pi-tui@1.3.0` 的 `dist` 与 1.2.0 逐字节相同 | **已核对无变化** | `cmp` + `tests/extensionEntry*.test.mjs` | — |
| codemode worker 全局上限 2、取消占用到退出（#10748）与 Bun 中断修复 | pi 运行时；PiDeck 不管理 codemode worker | 无需改动 | — | — |
| 其余 pi 运行时修复：Anthropic/Bedrock 错误 tool result 图片移到工具结果之后（#10794）、自动重试触发条件（#10920/#10965）、OpenAI 兼容流 thinking 顺序（#10926）、Gemini 4 Argon thinking budget（#10890）、模型切换丢弃异模型 thinking 块（#10995）与 GPT-6 缓存保留（#10853） | 均为请求构造/重试行为，会话 JSONL 与 RPC 事件形状不变；thinking 块仍存盘并在时间线显示，只是不再发给不同模型的请求 | 无需改动 | `addProviderDraft.ts`、`ConfigManager`（未知 compat 字段展开保留）核对 | — |
| 内部 pi 依赖改为精确版本锁定 | pi 自身打包行为，不影响 RPC 协议面 | 无需改动 | — | — |

**待真实回归**（本机 pi CLI 已是 1.3.0，但本轮只做静态核对，未跑真实会话）：

- `/share` 目标设置：`auto` 在已登录 Radius 时走 Radius、否则建 GitHub gist；`gist` / `radius` 强制生效；
- OpenCode Zen/Go 新端点：模型发现与用量探测在新 baseUrl 下都能命中（存量 `models.json` 仍指 `zen` 时探测同样命中）；
- 恢复一个会话：会话期间激活的工具在恢复后仍在（#10785），且 PiDeck 的 `/reload`、重启会话路径无回归。

## 1.2.0 审计矩阵（2026-10-13，npm 包完整 dist 与本机 1.1.0 逐文件 diff）

核对方式：`npm pack @earendil-works/pi-coding-agent@1.2.0`，与用户机器上已装的 1.1.0 比对；关键文件用 `cmp`/`diff` 判定，非逐行人工阅读。

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 移除条件 |
|---|---|---|---|---|
| RPC 命令面与事件面 | `rpc-types.js`、`rpc-mode.js` 与 1.1.0 逐字节相同 → 会话/模型/思考档/压缩/命令列表等边界无变化 | **已核对无变化** | 逐文件 `cmp` | — |
| `dist/index.js`（`ModelRuntime`） | 逐字节相同 → `pi-auth-host.mjs` / `pi-enhance-host.mjs` 的 SDK 入口安全 | **已核对无变化** | 逐文件 `cmp` | — |
| `settings-manager.js` 92 行 diff | 全部是把字面量抽成 `SETTINGS_DEFAULTS` 常量的重构，默认值逐个一致（16384 / 20000 / 3 / 2000 / `one-at-a-time` / `auto` …）；`defaultTools` 合并、`RESOURCE_TYPES`、`isEnabledByOverrides`、`applyPackageFilter` 未出现在 diff | **已核对无变化** | `diff` + `dist/core/settings-defaults.js` 值比对 | — |
| `package-manager.js` 新增 `normalizePath()` 包装（#10765：资源过滤条目支持 `~`） | 投影求值同步补 `~`（含 Windows `~\`）与 `file://` 归一，与 pi 的 `normalizePath` 同口径（通配分支不剥 `./`、精确分支先剥） | **本轮已适配** | `src/main/config/piResourceRules.ts` 的 `expandRulePath`、`tests/piResourceRules.test.mjs` | 无 |
| `pi mcp list --json` 的 `resources` 由数量改为 `true`，且不再输出 `resourceTemplates` | 类型改 `number \| boolean`，解析两种形态都收（1.1 数字 / 1.2 布尔），避免新 pi 下静默丢字段 | **本轮已适配** | `src/shared/types/mcp.ts`、`src/main/pi/piMcpCli.ts`、`tests/piMcpCli.test.mjs` | 无 |
| **扩展 API 破坏性变更**：`before_agent_start` 变成按 `messageType` 的联合；`pi.sendMessage(..., { triggerTurn: true })` 触发的 custom run 也会触发；起始阶段 `ctx.isIdle()` 为 false、`pi.sendMessage()` 改为排队进本轮、`pi.sendUserMessage()` 必须传 `deliverAs` | PiDeck 的 4 个处理函数都忽略事件参数 → 联合类型不会解构出错；`isIdle()`/`sendUserMessage()` 均未使用。但 goal/plan 模式自己用 `triggerTurn: true` 发消息，这些 run 现在会多注入一次 `[GOAL MODE ACTIVE]` / `[PLAN MODE ACTIVE]` / `[EXECUTING PI_DECK PLAN]`；同时 1.2 修好了「custom run 首次工具调用后丢掉 `before_agent_start` 的 systemPrompt 段」，对安全档位提示是改善 | **待真实回归**（静态判定兼容） | `pi-deck-goal-mode.ts:224`、`pi-deck-plan-mode.ts:333`、`pi-deck-security-gate.ts:327`、`pi-deck-todo.ts:369`；回归项：goal/plan 各一轮、安全档位提示、todo 压缩后补注 | 无 |
| 发布配置 schema（`schemas/{settings,models,keybindings,theme}.schema.json`），主题 schema 收紧且启动即校验 | `settings-schema.js`/`keybindings-schema.js` 在 dist 内**没有任何 import 方**（只用于生成给编辑器用的 schema）；运行时校验只在 TUI 主题（`dist/main.js` 的 `setThemeJsonValidator`）。PiDeck 走 RPC，主题是自有的 `userData/custom-themes/`，不写 pi 主题也不写 `$schema` | 无需改动 | 源码核对 | — |
| 移除 experimental server/client/plugin 栈与 `./client`、`./experimental/plugin` 导出，删除 `pi-client` / `pi-protocol` / `pi-server` / `@earendil-works/chord` | PiDeck 不依赖（package.json 与 lock 无引用）；`.` 与 `./rpc-entry` 导出保留 | 已核对无变化 | package.json / lock 核对 | — |
| OSC 7501 程序状态上报（1.1.0） | 只存在于 `dist/modes/interactive/`，`bundle/rpc-entry.js` 引用数为 0 → 不会污染 PiDeck 的 stdio JSON-RPC | 已核对无变化 | `grep -c 7501` | — |
| `agent_settled` 新增 `aborted`（1.1.0） | `AgentManager` 用 `aborted === true` 抑制成功完成通知；保留本地停止记录与 settled 超时状态作为旧版/迟到事件兜底。取消仍收敛为 idle，不覆盖已有 error 状态 | 已适配（本轮） | `AgentManager.ts`、`tests/agentSettledAbortLifecycle.test.mjs`、`tests/agentSettledContract.test.mjs` | 最低支持 pi 提升到 1.1 后仍保留本地迟到事件保护 |
| PiDeck 静态模型目录来源更新 | 构建期 `pi-ai` 精确锁定从 1.0.4 更新到 1.2.0；42 个 provider、1649 条模型（chat 1554 / image 61 / classifier 34），相较原目录新增 60、移除 31、字段变更 232。仅更新静态资源，不改 OpenRouter 联网刷新或 DSH 独立依赖 | 已更新（本轮） | `package.json` / lock、`resources/pi-ai-catalog*.json`、目录生成/读取/打包与能力补全测试 | 无 |
| OpenRouter 按 key 列模型（1.2.0） | 只影响 `pi --list-models` 的条目数；PiDeck 的能力字段仍来自 catalog artifact + endpoint `/models` | 无需改动（行为变化） | — | — |
| codemode 输出格式（`==> text N/M <==`、`<console_output>`）、`reachesTools`、工具声明 `@` 约束 | 时间线只渲染文本，无解析依赖 | 无需改动 | — | — |
| `serializeConversation()` 不再带 thinking 块 | pi 内部行为；PiDeck 上下文圆环按会话条目 + 实测提示词装载计算 | 无需改动 | — | — |
| `auth.json` 写入在 Windows 上遇 EPERM 短暂重试（1.2.0） | 对 `pi-auth` 是改善 | 无需改动 | — | — |
| 剩余已知差异：pi 的 `normalizePath` 在 Windows 上还会做 `normalizeWindowsShellPath`（`/c/...`、`/mnt/c/...` → `C:\...`） | 投影未实现该归一 | 已知差异（未适配） | `piResourceRules.ts` | 出现 MSYS 形态条目导致投影与 pi 不一致的用户反馈时再补 |

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

以下按当前工作区事实记录，**初版代码存在不等于适配已验收**。完整收尾与原生资源迁移方案见 [pi 原生资源管理与 MCP / Codemode 执行计划](./archive/plans/pi-0.99-mcp-codemode-plan.md)；其中阶段和测试尚待执行，本次文档更新没有重跑业务测试。

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

PiDeck 曾内置 DSH 持久 pwsh 工具（`pwsh_persistent`，本地 file: 包 `packages/dsh-tool-pwsh-persistent`），0.2.1 起下线，DSH 会话只用官方预设工具；这不代表 Pi 原生 `powershell` 工具要求安装 PS7。本记录不把两者合并。

## PiDeck 后续工作清单

### P0 / 应优先

- [x] `compact` 同时发送 `prompt` + `customInstructions`，兼容未升级 Pi 的用户。
- [ ] 如果 PiDeck 宣称支持“用户手动启用 powershell”，把 `powershell` 加入安全门的受管工具集合，并补充工具短语/回归测试；但不替用户启用 `defaultTools`。

### P1 / 建议

- [ ] 在真实 pi 1.2.0 上回归 goal/plan 模式、安全档位提示与 todo 压缩后补注（`before_agent_start` 触发范围扩大，见 1.2.0 矩阵第 6 行）。
- [ ] `compaction_end` 失败形成用户可见提示。
- [ ] 更新完成后失效 `PiProcess.versionCache` 和 `ExtensionManager.piVersion`，并提示已有 Agent 需重启。
- [x] 评估 `pi update --self`：pi 1.5.0 起提供 `selfUpdateCommand` / `PI_SELF_UPDATE_COMMAND`，让 `pi update` 走包装器或其它包管理器。PiDeck 不改写该键（用户在 `settings.json` 自行配置，未知键保留），PiDeck 自己的更新器仍独立。
- [ ] 评估消费 pi 1.5.0 的扩展更新 changelog（`extensionChangelogVersions` + `collapseChangelog`）：PiDeck 商店/扩展页是否展示包内 `changelogPath`，先定 GUI 呈现再动手。
- [x] Pi 后端调用 `get_available_thinking_levels`，按 sessionId + agentId + runtimeGeneration 读取，旧 Pi 回退静态列表。
- [x] 统一 PiDeck JSON 读取入口，兼容 UTF-8 BOM（2026-10 随 pi 1.4.0 同步收口：`ConfigManager.readJsonFile` / `mcp.json` / `managed-install.json` 三处，见 1.4.0 矩阵）。
- [x] PiDeck 主进程 catalog 已从精确锁定的构建期 `@earendil-works/pi-ai@0.85.0` 提取为静态资源；DSH adapter 继续使用其声明兼容的 `0.82.1`，不通过 overrides 强行升级。

## pi-ai 依赖边界

PiDeck 当前有三条不同的 pi-ai 使用路径，不能混为一谈：

| 路径 | 实际使用 | 当前版本/职责 |
|---|---|---|
| Pi 后端运行时 | 外部 `pi --mode rpc` 进程内部使用用户安装的 Pi 自己携带的 pi-ai | PiDeck 不打包 Pi CLI，也不把自己的 pi-ai 注入 Pi 子进程；Pi 0.85.0 的 provider/thinking 逻辑由外部 Pi 自己负责 |
| PiDeck 主进程 | 只读构建期生成的 `resources/pi-ai-catalog.json` 与 manifest | `@earendil-works/pi-ai@1.5.1` 是精确锁定的 `devDependency` 输入；构建脚本只提取 context/maxTokens/reasoning/input/name/thinkingLevelMap 等规格字段，运行时不加载 SDK |
| DSH host | `dsh-llm-pi-ai` 动态调用 `createModels`、catalog、`getSupportedThinkingLevels` 和 provider API | `dsh-llm-pi-ai` 声明 `^0.82.1`；lock 将其解析为嵌套的 `@earendil-works/pi-ai@0.82.1`。对 0.x semver 而言该范围为 `>=0.82.1 <0.83.0`，不包含 `0.85.0` |

因此：

- **仅升级 PiDeck 的构建期 `@earendil-works/pi-ai` 输入到 1.5.1，不会让 Pi 后端 runtime 变成 1.5.1**，也不会自动打开 Pi UI 的按模型过滤；
- DSH adapter 在自己的依赖树中解析 `0.82.1`；PiDeck catalog artifact 的来源是 `1.5.1`，两者有意共存；
- 不建议用 `overrides` 强行把 DSH 的 pi-ai 改成 1.4.0。应等待/推动 `dsh-llm-pi-ai` 发布声明兼容更新版本后，再整体升级 DSH 相关包并做 host smoke、thinking effort、流式请求和 provider catalog 回归。

### 是否打包进 PiDeck

**PiDeck 主进程不再打包完整的 `@earendil-works/pi-ai@1.5.1` SDK；安装包只带静态 catalog artifact**：

- `@earendil-works/pi-ai` 位于精确锁定的 `devDependencies`，`npm run build` 先运行 `scripts/generate-pi-ai-catalog.mjs`；
- 生成器在使用默认来源目录（`node_modules`）时会校验本地安装版本与 `package.json` 精确锁定一致，不一致直接失败并提示 `npm ci`（防陈旧安装静默降级目录）；确需从未锁定来源生成时显式传 `--source-dir`；
- 生成器从官方 `dist/providers/data/*.json` 提取条目时**保留官方全部字段**（含 `type`、`cost`、`inputLimits`、`compat` 等），只丢弃无 `id` 的条目，并用紧凑序列化写入 `resources/pi-ai-catalog.json` 及带来源/完整性信息的 manifest；
- artifact `schemaVersion` 为 **2**：旧版（v1）按白名单只留 9 个字段、没有 `type`，无法在读取时区分 chat / image / classifier，因此 v1 产物（含用户机器上旧版下载的覆盖层）会被校验拒绝并回落随包目录，不提供迁移器；
- 查询入口（能力补全、内置 provider 快照）只取 chat 条目；官方存在 3 组同 provider+id 的 chat/image 重名（openrouter），此时 chat 优先，生图条目不得抢占（否则容量列为空）；
- electron-builder 通过 `extraResources` 将这两个文件放进 `resources/`；`piAiBuiltinCatalog.ts` 运行时校验 manifest 的 catalog SHA-256 与条目数，失败则回退 endpoint `/models` 或用户手填；
- `scripts/verify-asar-runtime.js` 守护 app 的两份 catalog 资源；`scripts/check-dsh-asar.mjs` 与 `scripts/check-dsh-boot.mjs` 继续守护 DSH runtime 所需的 `pi-ai@0.82.1`；
- DSH 的完整 `pi-ai@0.82.1` 仍是其独立运行时闭包的一部分，不能为瘦身主进程而删除。

这份 catalog artifact **不是 Pi 后端 runtime 使用的那一份**。PiDeck 通过 `PiLocator` 执行用户已经安装的 `pi` CLI；Pi CLI 自己携带/解析自己的 pi-ai。PiDeck 不打包 `pi-coding-agent`，也不把 catalog 来源版本注入外部 Pi 进程。

升级记录：PiDeck 主进程 catalog artifact 的来源从 `0.84.4` 起，随上游 pi-ai 发布逐版跟进：`0.85.0` → `0.85.1` → `0.86.0` → `0.86.1` → `0.99.1`（2026-09；0.99.1 对应 42 个源 JSON、1592 条模型，含 OpenAI Codex 默认模型 gpt-6.1-sol）→ `1.0.4` → `1.2.0`（1649 条）→ `1.3.0`（2026-10-15，1714 条，chat 1614 / image 60 / classifier 40；随目录带入 MiMo 档位、Claude `off`、gpt-6.1-sol 500K 与 OpenCode 新端点）→ `1.4.0`（2026-10-26，**1713 条**，chat 1599 / image 63 / classifier 51；相对 1.3.0 新增 59、移除 60、字段变更 185，**`baseUrl` 与 `api` 零变化**；带入 MiniMax-M3.1-Flash、xai `xhigh` 档、classifier 图像输入（`input` 含 `image`）、grok-4.3/4.5 `xhigh`，并移除 `openai-codex` 的 gpt-5.5 / gpt-5.3-codex-spark 与 copilot 的 claude-opus-4.7 / gemini-3.5/3.6-flash）→ `1.5.0`（2026-11-02，1712 条；见 1.5.0 矩阵）→ `1.5.1`（2026-11-09，**1768 条**，chat 1639 / classifier 63 / image 66；新增 77 / 移除 21，新 provider `qwen-token-plan-individual-cn`；**`baseUrl` 与 `api` 零变化**）；DSH 仍保留 adapter 兼容的嵌套 `0.82.1`。catalog 与运行时的 Pi 版本解耦——补的是能力字段（contextWindow/maxTokens/thinkingLevelMap），权威闸门仍是 `pi --list-models` 与 RPC `set_model`。只有当 `@deepseek-ai/dsh-llm-pi-ai` 发布明确兼容 `@earendil-works/pi-ai 0.86.x` 的版本后，才升级 DSH adapter/runtime 依赖树，并完成 typecheck、catalog/迁移测试、DSH host smoke、thinking effort、流式请求和 provider catalog 回归。

## 兼容代码移除规则

兼容代码不能仅因“过了一段时间”删除。删除前必须同时满足：

1. PiDeck 明确提高最低支持 Pi 版本；
2. 安装/诊断数据或发布观察确认旧版本占比已低于项目设定阈值；
3. 对应的旧版本回归测试已改为最低版本测试；
4. 发布说明记录迁移影响；
5. 删除后跑 `npm run typecheck` 和对应针对性测试。

所有临时兼容分支应在代码中写明 `TODO(remove-compat)`，并在本文件同步写出移除条件，便于后续检索。
