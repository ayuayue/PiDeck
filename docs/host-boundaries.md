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
- 常驻单进程多 run：新 run 打断旧 run、显式 cancel、boot/run 超时、进程意外退出都在服务层结算（每 run 回调恰好一次）；渲染层按 scopeKey 隔离，切会话作废进行中的 run，结果只回填发起方输入框。入口 `enhance:run` / `enhance:cancel` / `enhance:on-event`（`src/main/ipc/enhanceIpc.ts`；provider/modelId 只挡空白/控制字符/超长，`builtin:`、`https://`、`a/b` 形态必须放行）。
- 常驻进程的启动指纹（node / 助手脚本 / SDK 入口 / 代理 env）在**每次受理时**重新求值，任一变化即重建进程：env 在 spawn 时定格，不重建会让用户「改了代理设置却还是旧出口」。代理按 `proxyModel` 走与 pi 会话同一套名单语义（`applyPiProxyModeWithProvider` + `computeGenProxyKey`），因此名单模式下换模型会在「走代理」和「直连」之间切换进程；未传模型时跟随全局开关（pi-auth 侧车即此情形）。
- 目标模型优先级见 `src/shared/enhanceModelPreference.ts`：设置固定模型（`settings.enhanceModel`）> 会话记录 > 引导页点选 > 部署/主进程默认；默认跟随会话模型。
- **三个消费者必须各用独立实例**（服务的单飞语义是「新 run 打断旧 run」，共用会互相打断）：
  - 输入框增强：`EnhancePromptService` 主实例（logger 默认命名空间），hook `usePromptEnhance`。
  - 智能体一次性调用：`src/main/agents/AgentInvokeService.ts` 注入另一个实例（logger / 退出清理名 `agent-invoke`）。入口 `agent-profiles:invoke` / `invoke-cancel` / `invoke-event`。`systemPrompt` 只能由主进程按 `agentId` 从 `AgentProfileStore`（`<userData>/agent-profiles.json`）解析，**渲染层不得传**（只传短 instruction、目标语言与 provider/modelId）。
  - 输入预测：第三个实例（logger / 退出清理名 `prompt-suggestion`）。入口 `suggest:run` / `suggest:cancel` / `suggest:event`；`systemPrompt` / `userText` 由主进程常量（`src/main/pi/enhance/promptSuggestion.ts`）注入，渲染层禁传，并带 `purpose: "suggest"`。
- 三者的边界：一次性、无工具、不碰会话文件；事件按 runId 配对，终态恰好一次；fail-safe 与 pi-auth 一致（sidecar 起不来只是按钮置灰/toast，不影响 pi 会话）。禁止扩展成通用模型 API 桥，禁止把 `agent-profiles:invoke` 做成任意 systemPrompt 直通。
- 输入预测的展示：ghost 文案是绝对定位视觉层，**不得写进 ProseMirror 文档**（不参与撤销/发送判定）；Tab / → 采纳时整体回填草稿，Esc 忽略，失败静默。开关 `settings.promptSuggestionEnabled`（缺省开，只有字面 false 能关）。
- 智能体本身是 PiDeck 层预设：会话绑定存 `AgentMarketSettings.sessionAgentBindings`（只能经 `agent-profiles:bind-session` 改）；发送时 `sessionIpc` 用 `composeAgentInstruction` 把角色设定拼进 `SendPromptInput.agentMessage`（DSH 拒绝该通道，退化为可见前缀）。PiDeck 不替 pi 写系统提示。

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

## 侧车通用规则

- 所有随包 sidecar 必须列进 `extraResources`，stdout 只放协议数据（日志走 stderr 或主进程 logger）。
- 宿主侧必须结算：boot 超时、单 run 超时、进程意外退出、显式 cancel——每个请求的回调恰好一次。
- 每个 sidecar 在退出清单里登记清理名；stop / restart / 删会话 / 应用退出都要有对应注销路径。
- 新增例外通道或新增 `pideck-cua` 工具，必须**先改本文档**（用途、审批归属、禁止项、守卫测试），再改代码。
