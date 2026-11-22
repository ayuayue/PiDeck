# 宿主边界与例外通道

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 改 `src/main/pi/**`、`resources/*.mjs`、`resources/extensions/**`、MCP host、spawn 侧车或新增「宿主 ↔ pi」能力前读本文。
> 总原则：**pi 的事不要替它做，UI 的事 pi 也不要做**。二者只经既有通道通信；每一条例外只允许一种用途，**禁止扩成通用桥**。

## 例外一：认证通道（`pi-auth`，只允许认证用途）

- pi 的供应商登录只存在于交互层，RPC 没有 auth 入口。主进程以子进程运行 `resources/pi-auth-host.mjs`（import pi 的 `ModelRuntime`）完成「列供应商 / 登录 / 答问 / 取消 / 登出」。
- **凭据由 pi 写进自己的 `auth.json`，PiDeck 不碰**。代码归属：`src/main/pi/auth/piAuthHostLaunch.ts`（WSL 不支持，提示改用终端 `/login`）、`PiAuthService.ts`（NDJSON 协议）、`resources/pi-auth-host.mjs`（stdout 只放协议数据）。
- 必须列进 `extraResources`。渲染层只能经 `pi-auth:*` IPC 访问，不得直接 import pi SDK；禁止扩展成通用 pi API 桥。

## 例外二：模型请求快照端点（`pi-deck-model-trace`，只允许模型请求快照）

- `resources/extensions/pi-deck-model-trace.ts` 随包分发、`-e` 注入，在 `before_provider_request` / `after_provider_response` 把请求帧 POST 给主进程端点。
- 端点只绑 `127.0.0.1`（`src/main/pi/modelTrace/ModelTraceServer.ts`）；每个 agent 一份 token，spawn 时注入 `PIDECK_MODEL_TRACE_URL` / `PIDECK_MODEL_TRACE_TOKEN`；路径形如 `/trace/<token>`，强校验请求头 `x-pideck-model-trace-token`。
- 唯一路由只承载模型快照。完整请求体落 `userData/logs/model-traces/`，时间线只留摘要 + traceId（存储侧 `src/main/logging/ModelTrace.ts`，只读入口 IPC `rpc-logs:get-model-trace`）。
- 线格式唯一来源 `src/shared/types/modelTrace.ts`；扩展是自包含 `.ts`（只能 `import type`），契约由 `tests/modelTraceExtension.test.mjs` 兜底。
- fail-safe：端点起不来 → 不注入 env → 扩展不注册任何 handler；扩展抛错/写失败只丢追踪，不影响 pi 会话。生命周期配对：`registerModelTraceSession` ↔ `unregisterModelTraceSession`（stop/restart/删会话/退出都要注销）。

## 例外三：standby 运行时池（预热 + 只读命令预览）

- 一次 pi RPC 激活约 8.5s（2026-10 实测：node/pi boot ≈0.5s + 用户 npm 扩展 ≈5s + 内置 16 个 TS 扩展 ≈2.4s），全部发生在 spawn→握手段。池的用法只有「提前起进程」：草稿创建/激活完成后 `AgentManager.ensureStandbyAgent(projectId)` 后台起一个完成握手的进程待命。
- `src/main/pi/StandbyAgentPool.ts`：单槽位、容量 1、`STANDBY_TTL_MS = 3min` 自动回收（待命进程 RSS 数百 MB，TTL 只覆盖「打字→认领」窗口）。新会话激活经 `SessionRuntimeCoordinator.claimStandbyAgent` 认领，之后照常走 applyLatestPreferences / mergePendingPermissionSettings。
- 只服务新会话（noSession / 恢复历史会话不认领）。spawn 输入指纹（`src/main/pi/standbyFingerprint.ts`：扩展根/内置技能根/禁用集/offline/noExt/noSkills/customPiPath/WSL/代理/launchArgs）任一变化即丢弃回退普通 spawn；信任走 `resolveTrustWithoutPrompt`，资源未决策不池化（绝不后台弹 trust 弹窗）。
- 已知限制：池化进程不带 `PIDECK_SESSION_ID`，安检门按默认档工作，per-session 安全覆盖对认领会话要重启才生效；池化 agent 对 `agents:list` / `agent:state-changed` 不可见。
- 开关 `settings.standbyRuntimeEnabled`（默认开；设置 → 通用 tab）。启动耗时探针 `scripts/probePiStartup.mjs`（`JITI_DEBUG=1` 出逐模块 trace）。
- 只读借用（Issue #316）：草稿会话斜杠命令预览 `AgentManager.draftCommands` 经 `StandbyAgentPool.peek(projectId)` 查同项目池进程的 `get_commands`（不认领、不消费、进程须 idle、指纹须新鲜）；链路 `sessions:draft-commands` IPC → 渲染层优先预览、空/失败回退本地技能/提示词发现；dsh/browser/preview 模式返回 null。

## 例外四：一次性补全侧车（`pi-enhance-host.mjs`）

只允许「一次性单条补全请求」：提示词增强 + 智能体一次性调用 + 输入预测。

- 主进程经常驻单进程 sidecar：`resources/pi-enhance-host.mjs`（stdout 只放 NDJSON，载入 `PIDECK_PI_SDK_ENTRY` 指向的 pi `dist/index.js` 建 `ModelRuntime`）。宿主收口 `src/main/pi/enhance/EnhancePromptService.ts`，启动参数定位复用 `piAuthHostLaunch` 的 `resolvePiAuthHostLaunch`；必须列进 `extraResources`。
- 常驻单进程多 run：新 run 打断旧 run、显式 cancel、boot/run 超时、进程意外退出都在服务层结算（每 run 回调恰好一次）；显式 cancel 还须作废已经排队或正在等 boot 的请求，在下发 `complete` 前核对取消代数，不能等受理返回后才补取消。渲染层按 scopeKey 隔离，切会话作废进行中的 run，结果只回填发起方输入框。入口 `enhance:run` / `enhance:cancel` / `enhance:on-event`（`src/main/ipc/enhanceIpc.ts`；provider/modelId 只挡空白/控制字符/超长，`builtin:`、`https://`、`a/b` 形态必须放行）。
- 常驻进程的启动指纹（node / 助手脚本 / SDK 入口 / 代理 env）在**每次受理时**重新求值，任一变化即重建进程：env 在 spawn 时定格，不重建会让用户「改了代理设置却还是旧出口」。代理按 `proxyModel` 走与 pi 会话同一套名单语义（`applyPiProxyModeWithProvider` + `computeGenProxyKey`），因此名单模式下换模型会在「走代理」和「直连」之间切换进程；未传模型时跟随全局开关（pi-auth 侧车即此情形）。
- 目标模型优先级见 `src/shared/enhanceModelPreference.ts`：设置固定模型（`settings.enhanceModel`）> 会话记录 > 引导页点选 > 部署/主进程默认；默认跟随会话模型。
- 增强系统提示词默认取内置常量 `src/shared/enhanceSystemPrompt.ts`（设置页用它展示「当前生效模板」）。用户可在设置里保存自定义模板到 `settings.enhanceSystemPrompt`，由主进程在受理时读取并注入；渲染层仍**不能**经 `enhance:run` 传 systemPrompt。智能体一次性调用 / 输入预测 / 记忆学习各自带主进程角色设定，优先级高于用户自定义模板，不受该设置影响。
- **三个消费者必须各用独立实例**（服务的单飞语义是「新 run 打断旧 run」，共用会互相打断）：
  - 输入框增强：`EnhancePromptService` 主实例（logger 默认命名空间），hook `usePromptEnhance`。
  - 智能体一次性调用：`src/main/agents/AgentInvokeService.ts` 注入另一个实例（logger / 退出清理名 `agent-invoke`）。入口 `agent-profiles:invoke` / `invoke-cancel` / `invoke-event`。`systemPrompt` 只能由主进程按 `agentId` 从 `AgentProfileStore`（`<userData>/agent-profiles.json`）解析，**渲染层不得传**（只传短 instruction、目标语言与 provider/modelId）。
  - 输入预测：第三个实例（logger / 退出清理名 `prompt-suggestion`）。入口 `suggest:run` / `suggest:cancel` / `suggest:event`；`systemPrompt` / `userText` 由主进程常量（`src/main/pi/enhance/promptSuggestion.ts`）注入，渲染层禁传，并带 `purpose: "suggest"`。
- 三者的边界：一次性、无工具、不碰会话文件；事件按 runId 配对，终态恰好一次；fail-safe 与 pi-auth 一致（sidecar 起不来只是按钮置灰/toast，不影响 pi 会话）。禁止扩展成通用模型 API 桥，禁止把 `agent-profiles:invoke` 做成任意 systemPrompt 直通。
- 输入预测只消费已完成的问答：当前会话存在用户消息，且末条为非空、`stopReason: "stop"` 的助手回复；新会话首发前、流式中、工具中间回复、失败/中断/截断或结束态未知均不调用，首轮正常回复完成后允许预测。不能把预热/激活的 `starting → idle` 当作回答完成；守卫 `tests/usePromptSuggestion.test.mjs`。
- 输入预测的展示：ghost 文案是绝对定位视觉层，**不得写进 ProseMirror 文档**（不参与撤销/发送判定）；Tab / → 采纳时整体回填草稿，Esc 忽略，失败静默。开关 `settings.promptSuggestionEnabled`（缺省开，只有字面 false 能关）。
- 智能体本身是 PiDeck 层预设：会话绑定存 `AgentMarketSettings.sessionAgentBindings`（只能经 `agent-profiles:bind-session` 改）；会话**首次**发送时 `sessionIpc` 用 `composeAgentInstruction` 把角色设定拼进本轮 prompt（pi 走隐藏 `agentMessage`；DSH/ACP 都没有该通道且会拒收整条 prompt，退化为可见前缀）。角色设定随第一条用户消息留在历史里，之后轮次不重复注入。PiDeck 不替 pi 写系统提示。

## 例外五：运行时控制扩展（`pi-deck-runtime.ts`，只允许 `/reload`）

- RPC 模式不执行 pi 的 builtin `/reload`，也没有原生 reload RPC；pi 只把 `ctx.reload()` 暴露给扩展命令。内部扩展 `resources/extensions/pi-deck-runtime.ts` 只注册一个 `reload` 命令：`ctx.isIdle()` 时调用 `ctx.reload()`，不注册工具、不提供其他宿主控制。
- 注入走 `INTERNAL_BUILT_IN_EXTENSIONS`（当前含 `pi-deck-runtime.ts` 与 `pi-deck-shell-proxy.ts`；始终随 RPC 注入，`piRpcNoExtensions` 除外；不上设置页、不参与用户移除）。写入 `extensions-manifest.json`，热更新覆盖层按整份快照分发。
- 宿主唯一入口：`sessions:runtime-reload-resources` → `SessionRuntimeCoordinator.reloadResources` → `AgentManager.reloadResources`。后者先 `get_state` / 挂起 UI 请求校验 idle，再按 `sourceInfo.path` 确认命令来自 `pi-deck-runtime.ts`，最后直接发 RPC prompt；**禁止复用 `sendPrompt`**（它会在 RPC 前写乐观用户消息）。重载后重新 `get_commands` 返回新命令表，渲染层刷新 `/` 菜单与时间线命令 chip。
- 只对 pi 提供：running / compacting / 有排队消息 / 挂起 Ask 时拒绝热重载；DSH 与 ACP 没有会话级 reload，头部工具条与重载菜单项一律不渲染，操作只走 Tab ⋯ / 右键菜单。扩展缺失、重载失败、命令未被 `handled` 都返回结构化错误 + toast，不影响会话本身。禁止扩展成通用命令执行桥。

## 例外六：本地 MCP 工具端点（`pideck-cua` host）

- 主进程内 StreamableHTTP MCP Server（127.0.0.1、每次启动随机 bearer token、写 `~/.pi/agent/mcp.json` 的 `pideck-cua` 条目）把宿主能力以工具形式暴露给 pi：CUA 桌面输入注入（`cua_*`）与内置浏览器操作（`browser_*`，`src/main/browser/`）。工具调用走 pi 标准 tool_call → tool_result JSON-RPC，不构成第二条 pi↔PiDeck 通道；审批经进程内 IPC（`cua:approval-*`）。
- 能力各自有独立开关（`cuaEnabled` / `browserAgentEnabled`，默认都关）、独立 gate 与独立 autoApprove（默认自动放行，可关闭改为逐次确认）。host 只在任一能力启用时监听并写 mcp.json，两者都关时停监听并注销。工具按开关条件注册：**host 存活 ≠ 能力启用**。
- 只读工具免审批；写工具 fail-closed（无 approval handler / 超时 / 拒绝即不执行）。页面与屏幕内容是不可信输入；工具输出不得包含凭据，日志不得写页面文本或截图内容。
- 禁止扩展成通用宿主控制通道：不得暴露任意 JS 执行、文件系统、shell、任意 HTTP 代理、会话/模型控制。内置浏览器工具不得绕过 `isAllowedBrowserPanelUrl`、不得注入 preload / 放开 allowpopups、不得改 webview 安全档位。
- 与 `pideck`（对外 MCP 服务，见 `docs/pideck-mcp.md`）是两个独立端点：CUA/浏览器工具只服务 pi；ACP 调用（`acp_tools_list` / `sessions_create` / `sessions_send` / `sessions_wait` / `sessions_messages` / `sessions_stop`）只存在于 `pideck`，由独立开关 `allowAcpInvoke` 约束，**不在本端点扩展**。
- 详见 `docs/archive/plans/browser-agent-plan.md`（工具面、快照契约、风险与合并门禁）。

## 例外七：会话分组宿主数据（`sessionGroups.*`，只允许分组读写）

- 会话分组是 PiDeck 自己的本地数据（`<userData>/session-groups.json`，主进程 `SessionGroupStore` 持有与原子落盘），消费方两处：侧栏「分组」树（只读）与会话分组插件页（读写）。插件经专属 preload 的 `pideck.sessionGroups.list/save/delete/reorder` 访问，需 manifest 声明 `sessionGroups.manage`；请求走 `hostPluginRequest` 同一条通道，broker 逐方法验权，不做前缀推断。
- **写入是整体替换式**（按 group id upsert），不做字段级合并；保存/删除/排序成功后 store 广播 `session-groups:changed`，桌面帧据此刷新侧栏。插件不是唯一写入方时的竞态由「启动时一次性迁移 + 单写方约定」收敛：v2 插件私有 storage 只在首次启动被导入一次（只读不删），之后一律以宿主 store 为准。
- 禁止扩成通用存储桥：不得在此通道上夹带任意键值、会话正文、文件路径或设置读写；会话 id 只是引用，失效引用由消费方按 catalog 过滤，宿主不追删、不校验会话存在性。

## 例外八：本地 stdio MCP 记忆服务器（`pideck-agent-memory`）

- 与例外六/七不同：**服务器不在主进程内**，是 `resources/agent-memory/server.mjs`（随包进 `extraResources`）由各后端以 `ELECTRON_RUN_AS_NODE=1 <electron> server.mjs` 拉起，stdin/stdout 跑 MCP 2024-11-05。挂载三处：pi 写 `~/.pi/agent/mcp.json` 的 `pideck-agent-memory` 条目；ACP 经 `AcpHandshakeDeps.mcpServers(cwd)` 填 `session/new` / `session/load` 的 `mcpServers`；DSH 未接。
- 用途只有两件：读写 Markdown 记忆文件（`<userData>/agent-memory/`），以及检索**已落盘的**会话历史。不提供会话控制、模型调用、任意文件系统、shell、任意 HTTP。
- 数据真值是 Markdown（用户可编辑），`memory.db` 是可用重建的索引；索引不可用时读写与检索退化为子串匹配，不报错。
- 采集只读：只读已落盘的响应文件，跳过 system 消息与工具结果，单文件 64MB / 单会话 2000 条上限，不跟随符号链接、不访问网络。
- 写入必须过注入扫描（不可见字符 / 指令覆盖句式 / 疑似凭据），命中即拒绝；项目作用域缺 `projectId` 时拒绝而不是静默写全局。
- 禁止扩成通用宿主控制通道：不得暴露会话控制、设置读写、任意 JS/FS/shell。会话来源只能由宿主通过 `PIDECK_AGENT_MEMORY_SOURCES` 注入，服务器不得自行扫描用户目录。
- 注册失败不影响启动（记忆是增强项）；`mcp.json` 形状不对时跳过写入而不是覆盖用户配置。详见 `docs/agent-memory.md`；守卫测试 `tests/agentMemoryMounts.test.mjs`、`tests/agentMemoryServer.test.mjs`。

## 例外九：关联会话端点（`pi-deck-linked-sessions`，只允许关联会话的开、发、列）

- 用途：让一个 pi 会话的 agent 开出**完整的**子会话（用户能在侧栏点开、直接对话、停掉），给关联会话追发消息、列出子会话状态；子会话每轮结束由宿主把回报送回父会话。对标 Claude Code 桌面版的子对话管理。
- 链路：随包扩展 `resources/extensions/pi-deck-linked-sessions.ts`（`-e` 注入，用户可在设置里移除）注册 `start_session` / `send_to_session` / `list_linked_sessions` 三个工具，POST 给主进程回环端点 `src/main/linkedSessions/LinkedSessionServer.ts`（只绑 `127.0.0.1`，路径 `/linked/<token>`，强校验头 `x-pideck-linked-token`）。token 每 agent 一份，spawn 时注入 `PIDECK_LINKED_SESSIONS_URL` / `PIDECK_LINKED_SESSIONS_TOKEN`，与模型快照同一套生命周期（`AgentManager` 注册/注销）。**调用方身份只认 token → agentId → 会话绑定**，不信请求体里的任何会话 id 作为调用方。
- 宿主侧 `LinkedSessionService` 只做三件事：建草稿并发首条 prompt（`SessionCatalog.createDraft` → `SessionRuntimeCoordinator.send`，与自动化同链路）、向关联会话发消息（同一 `send`，忙时 `followUp`）、读 `agents:state` / `agents:runtime-state` 判子会话回合结束并把回报以 `followUp` 发给父会话。关联关系存 `<userData>/linked-sessions.json`（原子落盘），键是 `SessionRecord.id`。
- 发起方式：`user_asked` 立即开；`offer` 在父会话时间线出卡片，工具调用挂起到用户点「新会话 / 在此做」或 10 分钟超时；`own_initiative` 只登记提议卡片（7 天过期），用户点开才建会话。卡片按钮走 `linked-sessions:*` IPC。
- 会话生命周期：子会话就是普通会话，删除 / 归档走侧栏原有菜单。清理挂在 `SessionCatalog.onRowsRemoved` 这一个集中点上（`remove` / `removeWithDescendants` / `removeByProjectId` / `mergeScanned` 的外部删除清理都会触发），不在 IPC 里逐条打补丁：会话行一消失就清掉它的全部关系和它作父会话挂着的提议，另一端回到普通会话。归档后恢复出来是新 id 的普通会话，所以归档与删除同样处理，不留孤儿。
- 防空转：父会话被回报自动续跑的连续轮数有上限（`MAX_AUTO_CONTINUE`）；被父会话拒绝的投递不占额度；清零挂在 `SessionRuntimeCoordinator.onPromptSubmitted`（所有入口的消息都经 `send`，requestId 带 `linked-` 前缀的是本服务自己的回报 / 转发，其余都算用户侧输入）。超限后回报只记在关联表里（`list_linked_sessions` 可读），不再自动续跑。父会话没有活着的运行时也不会被回报拉起。
- 禁止项：只能对**与调用方直接关联**的会话（自己的子会话或自己的父会话）发消息；不暴露删除会话、改设置、读任意会话正文、跨项目建会话；不用于 DSH / ACP / 远端 SSH 会话（远端快照标 `local-only`，端点未就绪或 env 缺失时扩展不注册任何工具）。回报文本是不可信数据，原样转交、不解析成指令。
- 守卫测试：`tests/linkedSessionsExtension.test.mjs`（env 缺失不注册、帧字段与共享类型对齐）、`tests/linkedSessionStore.test.mjs`（提议状态机、防空转计数、落盘可重入）、`tests/linkedSessionReview.test.mjs`（回合文本基线、额度退还、每回合只报一次、回滚）、`tests/sessionCatalogRowsRemoved.test.mjs`（会话行移除的集中通知）。

## 侧车通用规则

### SSH 配置 helper 的固定文件域

配置编辑只走既有 SSH helper 控制连接：`config.read` / `config.patch` / `config.replace` 仅接受 models/settings/trust/mcp 文件键，不接受路径或代码。`config.replace` 与 patch 使用同一版本检查、脱敏、大小上限、原子替换及读回确认；源文件编辑的密钥保留/同文件位置复制在远端完成，密钥原值不回传。`config.readAuth` 只回派生认证状态；专属 `config.replaceAuth` 按版本提交条目集合，允许新 API key、主机内保留/复制和删除，禁止返回原凭据或录入 OAuth token，auth 不加入通用文件白名单。模型清单复用 pinned SSH 的固定 `pi --list-models` 命令，不增加 pi 宿主桥。守卫见 `remoteConfigDocument`、`remotePiConfigBackend`、`remoteConfigContract`、`remoteConfigEditor` 与 `remoteAuthEditing` 测试。

### SSH 用户资源管理

技能、提示词和扩展管理复用既有 SSH 控制连接的专属 `resources.*` 域，每一层只管理自己的固定根：

- **全局层**（默认，`scope` 缺省）：`~/.pi/agent/skills`、`~/.agents/skills`、`~/.pi/agent/prompts`、`~/.pi/agent/extensions`（该主机本身）。
- **项目层**（`scope: "project"` + 已登记 `projectId`）：`<项目根>/.pi/skills`、`<项目根>/.agents/skills`、`<项目根>/.pi/prompts`、`<项目根>/.pi/extensions`，项目根就是该 helper 进程启动时的 `--root`。

- **作用域必须显式**：`scope` 是请求字段而不是从路径推断；漏传即全局层。同一 `{ root, path }` 引用在两层指向不同文件，因此「项目页误写全局文件」是不成立的（2026-11 项目管理弹窗曾把远端项目送进本机项目资源管理器，四个页签均报 UNSUPPORTED_PROJECT_LOCATION）。
- **项目 id 不是路径**：主进程只接受已登记项目 id，经项目 catalog 解析出 host + canonical root，并复核 host 与 locator 一致；路径、兄弟项目、主机全局层都不能由渲染层指定。项目层请求走 `withProjectSession`（整段持主机锁），两个项目不会在帧之间串根。
- **项目设置同源**：项目层读写 `<项目根>/.pi/settings.json`，复用同一份 config scope（同一套版本校验、原子替换、密钥脱敏）；`resources.toggleInherited` 只写该项目的 `±<绝对路径>` 原生规则，不碰主机全局设置。内置扩展启停（`resources.builtin`）与 Pi 包操作（`packages` / `skillsInstall`）是主机级动作，项目层直接拒绝。
- 资源正文读写、创建、改名、删除与启停均校验资源引用、链接、大小和版本；删除移入该主机受控回收目录。Pi 包操作只能由主进程构造固定的 list/install/remove/update argv，使用已探测的主机 Node/Pi 与 pinned SSH，带时限、脱敏和结果核验；用户点击安装/卸载/更新即授权该次动作，禁止后台安装或自动重放不确定写入。本机随包资源和宿主更新器不在远端页面暴露；任何远端失败都不得转向本机管理器。
- **远端 MCP 也分两层**：主机层管理 `~/.pi/agent/mcp.json`，项目层管理 `<项目根>/.pi/mcp.json`。config 域在项目层**只**接受 `mcp` 这一个文件键（models/settings/trust/auth 是主机文件，项目层返回 `CONFIG_PATH_UNSUPPORTED`）；`pi mcp list/login/logout` 以项目根为 cwd 执行，凭据仍落主机 `~/.pi/agent`；项目 id 未知、跨主机或与当前页不符一律拒绝并给可读引导（`REMOTE_MCP_PROJECT_SCOPE_UNSUPPORTED`），不回退主机全局层。配置页与项目管理页共用同一套 MCP 表单（本机 / SSH 主机 / 远端项目三种作用域），只有 WSL 仍按文件编辑——发行版里的 `pi mcp` 只能在该发行版内运行。
- 范围与门禁见 `ssh-config-management-plan.md`，守卫为冻结资源 helper、主进程路由和远端资源编辑行为测试（项目层见 `tests/remoteProjectResources.test.mjs`）。

- 所有随包 sidecar 必须列进 `extraResources`，stdout 只放协议数据（日志走 stderr 或主进程 logger）。
- 宿主侧必须结算：boot 超时、单 run 超时、进程意外退出、显式 cancel——每个请求的回调恰好一次。
- 每个 sidecar 在退出清单里登记清理名；stop / restart / 删会话 / 应用退出都要有对应注销路径。
- 新增例外通道或新增 `pideck-cua` 工具，必须**先改本文档**（用途、审批归属、禁止项、守卫测试），再改代码。
