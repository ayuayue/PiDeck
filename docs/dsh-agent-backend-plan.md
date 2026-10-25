# DSH 双 Agent 后端接入对照计划

> 目标：在 PiDeck 中把 DeepSeek Harness（DSH）作为**第二个 agent 后端**接入，与 pi 后端并列，同一项目下两种 agent 会话可自由创建、切换、浏览；DSH 侧采用**深融合（无 `dsh web`）**路线：进程内 `boot()` 引导完整 host，通过官方 `ApiProxy` 契约驱动，传输形态从 stdio 演进到 utilityProcess + IPC 桥。
> 非目标：不做「同一会话中途换引擎」（pi 会话文件与 DSH session log 格式不同，迁移=重放）；不导入 DSH 历史会话为只读浏览源（一期不做 scanner，走 `session.list` 实时映射）；不把 DSH 的 Web GUI / 浏览器 UI 搬进 PiDeck。

**状态：** 已全部落地（2026-08-15 快照）：v2 utilityProcess 传输为当前形态；P0（D01–D12）全通；P1 按能力声明缺失（D13 编辑/删除历史、D14 图片附件、D15 命令列表未做，D16 思考档位已实现）；P2 中 plan 模式与 agent-preset 已提前落地，goals/subagents UI 与动态插件管理仍后置。pi 零回归，typecheck + 全量单测绿，`npm run pack` 打包验证通过。落地细节、模块清单与计划偏差见 §12。  
**范围：** 桌面端；pi 现有链路零改动  
**原则：** DSH 契约（`ApiProxy`）传输无关，传输载体可替换；PiDeck 架构规则（session-first / Jotai / IPC 注册式 / 单向依赖）继续生效；DSH 的事由 DSH 做，PiDeck 只做进程、映射与 UI。

---

## 1. 为什么接入 DSH

| 现状 | 诉求 |
|------|------|
| PiDeck 只管理 pi RPC Agent（stdio JSON-RPC） | 用户希望同一桌面同时使用 pi 与 DSH 两种 agent，可随意切换 |
| DSH 是独立的 Cordis harness（CLI `dsh`，web GUI `dsh web`） | 不希望「第二个 GUI / 后台常驻 HTTP 服务 / 依赖用户另装 dsh」的割裂体验 |

DSH 官方包（`@deepseek-ai/dsh` rc.6）自带程序化引导 API 与传输无关的 JSON-RPC 契约，深融合在技术上是官方预留形态（见 §2 证据 3）。

---

## 2. 调研结论（DSH rc.6，全部基于已装包源码核查）

> 证据路径：`node_modules/@deepseek-ai/*`（版本 0.1.0-rc.6，`@deepseek-ai/cordis@4.0.1` 纯 JS ESM，无 engines 限制）。完整文件索引见 §11。

### 2.1 程序化引导 API

`@deepseek-ai/dsh-app-boot` 导出：

```ts
boot(binName, absoluteConfigPath, patches?, prepare?, bareModuleBaseUrl?): Promise<Context>
```

- 返回 settled 的 Cordis Context，`ctx.agents` / `ctx.apiProxy` / `ctx.sessions` / `ctx.subagents` / `ctx.tools` 全部可直取（`ApiProxyService.inject` 声明了 agents/llm/sessions/subagents/...）。
- **launcher 职责需嵌入方自备**（boot 不负责）：
  - `ctx.cmdlineArgs` + `ctx.appExit`：须在 `prepare` 里调 `@deepseek-ai/dsh-cmdline` 的 `provideCmdline(ctx, { exit })`，否则 headless/web-startup 类插件解析报错。
  - `.env` 分层加载（可复用 `loadLayeredEnv`）、`installFailLoud` 失败守卫（可选）、DSH_HOME 解析（复用 `resolveDshHome`）、显式 `ctx.fiber.dispose()` 优雅退出。
  - `launchEnvironment` 可选（缺省回退 `process.env`）。

### 2.2 官方客户端与传输抽象

`@deepseek-ai/dsh-host-apiproxy`：

- `ApiProxyService`：Cordis 插件，提供 `ctx.apiProxy`——**注意：不在 base 组合里**。base 的 `typert-gateway` 行是 Typert 远程分发器（走 connection 传输，非本契约）；`ApiProxyService` 由 web 补丁的 `api-gateway` 行（`@deepseek-ai/dsh-host-apiproxy`）挂载。内嵌组合需自补：`api-gateway` + `workspace`（`dsh-workspace`，提供 workspaceRegistry，`session.create` 必经）+ `storage`/`storage-json`/`storage-domain` 三层 + 一个本地 `directoryPicker` stub（`capability()` 返回 `{ kind: "none" }`，host.* 目录方法优雅降级）——**PoC 已按此组合验证**（boot 约 800ms，见 §8 阶段 0）。
- `InProcessApiClient(toFetchHandler(ctx.apiProxy))`：同进程零网络直连，类型完整的领域客户端。
- `AbstractApiClient`：唯一传输接缝是虚方法 `doFetch(input, init)` 与 `resolveBase()`（Node 下返回假 authority `http://dsh.internal`，桥可喂假 URL）。unary 走 `postJson`，流走 `readSse`（`response.body` 的 `getReader()`）。**自定义 IPC/stdio 桥只需子类化覆写 `doFetch`。**
- 四象限信封：`client-request` / `server-response` / `server-request`（下行流帧）/ `client-response`（`respond`），rpcId 由发起方 mint、响应必回显。
- 领域方法（wire 路径）：`session.list/search/create/history/models/selectModel/rename/fork/prompt/attachment/updateQueue/cancel`、`subagent.*`、`goal.*`、`settings.*`、`credentials.*`、`llm.*`、`events.mux` / `events.host`（流 opener）。
- 审批可外部自动化：mux 流推 `approval/requested`（稳定 rpcId）→ `POST /api/respond` 回 `{ approvalId, outcome: 'allowed-once' | 'rejected' }` → `approval/resolved`。提问同理（`question/requested` ↔ `question/resolved`，`AskUserQuestionItem[]` 批量，应答 `{ answer: { answers: [{ id, selected, custom? }] } }`）。
- 事件形状（PoC 实测）：`SessionEvent = { type, seq, time, data }`，正文在 `data`：`assistant/chunk.data.chunk` 是 `StreamChunk` delta（`text-delta`/`reasoning-delta`，与 pi 的 thinking/text delta 同构）；`assistant/message.data.message.content` 是组装后内容块；`turn/end.data.reason.kind === 'error'` 表示回合失败（如 MISSING_CREDENTIAL）。

### 2.3 官方背书：深融合是预留形态

`dsh-host-webserver/lib/index.js` 头注释原文：

> "Web shape only — **Electron loads dist over `file://` and carries fetch over an IPC bridge.**"

即 DSH 团队明确设计过「Electron 内嵌、不走 HTTP、用 IPC 桥承载 fetch」的形态。

### 2.4 无 web 也能跑完整 host（现成证明）

`dsh-headless` profile = `dsh-base` + 40 行补丁，注释原文 "It mounts no Host, HTTP server, Web runtime, or browser plugin"，runner 直接 `agents.create()` + `agent.followup()` 驱动到 quiescence。**`dsh-base` 自带进程级 agent 平面（`ctx.agents`），不依赖 web 层的 `agent-presets` 行**（该行仅 web-app 补丁引入，`default: standard`）。

### 2.5 原生依赖面（硬依赖）

| 原生依赖 | 所在子包（base 行） | 加载方式 | 处置 | 落地（2026-08-15） |
|---|---|---|---|---|
| `node-pty@^1.1.0` | `dsh-subprocess-local`（`subprocess`） | boot 即静态 import | disable 行，或 electron-rebuild（PiDeck 已有 node-pty 经验：asarUnpack + fix-pty-permissions） | ✅ base 行保留（未 disable），host 在 utilityProcess 内加载；持久 pwsh 插件亦自含 node-pty |
| `sharp@^0.35.3` | `dsh-attachment-local`（`attachment-local`） | boot 即加载 | disable 行（失去 DSH 图片附件），或 rebuild | ⚠️ 原生绑定随包打包兼容（asarUnpack + `patch-sharp-index.js`），但 attachment-local 能力未启用（桥不支持字节载荷，见 §12.4 #3） |
| `koffi@^3.1.0`（win） | `dsh-fs-local` / `dsh-session-persistence-jsonl` / `dsh-sandbox-windows-acl` | 仅 Windows 特定路径**动态 import** | 包可安装即可；触发路径可接受 | ✅ 随包（win32 asarUnpack）；另用于 Windows 隐藏控制台治理（§12.4 #7） |
| `node-addon-landlock-run`（linux） | `dsh-sandbox-local` | linux 原生 | disable 或 rebuild | ⚠️ Linux 侧按需验证（未在 Windows 开发环境核查） |
| `node:sqlite`（Node 内置） | `dsh-session-query-sqlite` | 动态 `await import`，base 默认 `openAt: never` | 零风险；要求 Node ≥22.5（Electron 43 满足） | ✅ Electron 43 满足 |

`dsh-terminal` 本身是纯注册表接口；`cordis` / `cosmokit` / `schemastery` 纯 JS。loader 的 N-API 定制加载器在 Electron 下失败会退回 ambient import，不硬崩。

### 2.6 模块解析与打包

- 子包按包名互相 import，node_modules 平铺即可；bundle 解析「安装目录优先」，内嵌到 PiDeck 的 node_modules 后自然成立。
- `boot(..., bareModuleBaseUrl)` 的 `bareModuleBaseUrl` 正是为「宿主（而非配置项目）持有完整插件集」设计——内嵌场景用它，无需 profile 目录 symlink 机制。

---

## 3. 方案决策

### 3.1 选型：深融合，不用 `dsh web`

| 对比项 | web sidecar（弃） | 深融合（选） |
|---|---|---|
| 进程 | 额外 spawn `dsh web`，占用端口 | host 内嵌（utilityProcess / stdio 子进程） |
| 依赖 | 用户需另装 `dsh` CLI（或打包，体积更大） | dsh 包进 PiDeck 依赖，版本锁定 |
| 体验 | 后台 HTTP 服务 + 端口 | 无端口无浏览器，完全原生 |
| 可控性 | 只能消费 /api | 可自定义组合、禁用插件、注入 PiDeck 专属 Cordis 插件行 |
| 代价 | 0 | 打包体积 +200~400MB、原生 ABI、版本锁 rc.6 |

### 3.2 传输形态演进（(c) → (b)，官方注释预告的形态）

| 阶段 | 形态 | 说明 | 落地 |
|---|---|---|---|
| PoC | 独立 Node 脚本同进程 `boot()` + `InProcessApiClient` | 验证组合与全流程，不碰 Electron | ✅ `scripts/dsh-embed-probe.mjs`（`npm run probe:dsh`） |
| v1 | **(c) 无 web 的 stdio sidecar** | PiDeck 自写 30 行入口（`boot()` + stdio JSON-RPC 循环），`ELECTRON_RUN_AS_NODE` 或系统 node spawn；与 pi 的 `PiRpcClient` 模式同构，最稳落地 | 未实施（被 v2 直接取代） |
| v2 | **(b) utilityProcess + 薄桥** | `AbstractApiClient` 子类覆写 `doFetch` 走 `postMessage`，host 侧 `toFetchHandler(api).fetch` 当处理器；复用四象限信封与 SSE 帧 | ✅ 当前形态（`hostEntry.ts` + `DshApiClient` + `dshHostBridge.ts`） |
| （不推荐） | (a) 主进程内嵌 | 原生 ABI + 崩溃面 + 启动时间全压主进程，仅 PoC 用 | ❌ 未采用 |

**关键：v1→v2 是纯传输替换**，`DshAgentManager` 面对同一个 `ApiProxy` 契约，PiDeck 侧代码不变。

---

## 4. 硬契约（合并门禁）

1. **pi 链路零回归**：`AgentManager` / `PiProcess` / `PiRpcClient` 不改行为；现有 pi 会话、IPC、测试全绿。
2. **类型向后兼容**：`SessionRecord` / `AgentTab` 新增 `backend?: AgentBackend`，**缺省 `"pi"`**；旧 catalog 数据无需迁移。禁止复用 `source` 字段表达运行时后端（`source` 语义是历史导入来源）。
3. **网关接口能力集化**：`SessionAgentGateway` 拆出 `capabilities: Set<...>`；DSH 不支持的 pi 专属能力（edit/delete 历史消息等）必须显式声明缺失，Coordinator/渲染层按能力禁用 UI，禁止硬造等价物。
4. **单向依赖**：新增 `src/main/dsh/` 只依赖 `shared/` 契约与官方 dsh 包；渲染层只经 preload/IPC 访问；禁止 renderer 直接 import Node/Electron 或 dsh 包。
5. **IPC 注册式**：新通道一律进 `shared/ipc.ts` + `main/ipc/*Ipc.ts` + preload 三处同步；现有 `sessions:runtime-*` 通道语义保持后端无关，尽量复用。
6. **事件按 session 隔离**：runtime 事件必须带 `sessionId + agentId + runtimeGeneration`，沿用现有 Coordinator 机制；拒绝旧 runtime 迟到结果。
7. **生命周期配对**：DSH host 进程（stdio/utilityProcess）必须登记进退出清理清单；`boot()` 的 ctx 显式 `dispose()`。
8. **安全边界**：DSH 的审批/提问必须经用户确认（复用 `agents:ui-request` 弹窗链路）；自动放行默认关闭。
9. **测试门禁**：`npm run typecheck` + `npm test` 全绿；事件投影等纯函数必须有单测；PoC/探针脚本不入产品构建。

---

## 5. 明确不做

- 同一会话中途切换引擎（pi 文件 ⇄ DSH session log 重放迁移）
- DSH Web GUI / 浏览器端 UI 搬运；`dsh web` 端口与静态服务
- DSH 历史会话文件扫描导入（一期只做运行时映射；`session.list`/`session.history` 已覆盖浏览）
- 飞书桥接 / PIDECK_* 安全扩展注入到 DSH（pi 扩展机制不适用于 DSH，DSH 用自己的 permission/approval）
- DSH 动态 Cordis 插件管理 UI（`cordis-host-runner` 保留可运行，管理界面后置；当前仅提供 agent-loop/shell/web-search 配置分区，见 §12.4 #6 与 §12.8）
- 会话级 agent-presets 管理（一期用 base 进程级 agent 平面；部署级默认预设（`agent-presets.default`）已实现，见 §7 D19）

---

## 6. PiDeck 侧架构设计

### 6.1 类型层（`src/shared/`）

```ts
// types/agent.ts
export type AgentBackend = "pi" | "dsh";
// types/session.ts：SessionRecord / AgentTab / CreateAgentInput 增加
backend?: AgentBackend;   // 缺省 "pi"，旧数据天然兼容
```

`SessionSource` 不变（导入来源维度）；渲染层 badge/过滤在现有 `SessionSourceBadge` 模式上新增 `dsh` 呈现。

### 6.2 网关层：能力集化 + 按 backend 路由

- `SessionAgentGateway`（`SessionRuntimeCoordinator.ts`）保留现有方法，新增 `backend` 与 `capabilities` 字段、统一 `onOutput(listener)` 事件出口（替代 `main/index.ts` 对 `agentManager.onOutput` 的硬编码）。
- 新增 `CompositeAgentGateway implements SessionAgentGateway`：按 `AgentTab.backend` 路由到 `AgentManager`（pi）或 `DshAgentManager`；能力缺失 → `SessionCommandError("SESSION_COMMAND_FAILED")`。
- `main/index.ts` 装配：`new SessionRuntimeCoordinator(catalog, new CompositeAgentGateway(piAgentManager, dshAgentManager), ...)`，事件桥接走 gateway.onOutput。
- 若网关接口中 pi 专属方法过多导致 DshAgentManager 大面积空实现，则按能力拆成可选项/`capability` 分派，禁止「省 import 塞回大文件」。

### 6.3 新模块 `src/main/dsh/`（对标 `src/main/pi/`）

> 计划模块名与最终落地的差异见 §12.2；以下为当前实际文件。

```
src/main/dsh/
├── DshHost.ts               # 深融合宿主：懒启动 utilityProcess、桥接客户端、settings/credentials/models/presets 管理、DSH_HOME 解析
├── DshHostProcess.ts        # utilityProcess 生命周期：fork hostEntry、host-ready 健康信号、崩溃限次重启（3 次）、退出清理
├── hostEntry.ts             # utilityProcess 入口：boot() 自组组合（base patch + overlay）、fetch 桥循环、Windows 控制台治理、slash 桥/持久 pwsh 插件
├── DshApiClient.ts          # AbstractApiClient 子类：doFetch 走 MessagePort 桥（fetch-request → stream/chunk），pending 表 + abortAllPending
├── dshHostBridge.ts         # 桥协议纯函数（fetch-request/response/chunk/end/error + abort；body 一律字符串）
├── DshAgentManager.ts       # 实现 SessionAgentGateway：create/attach/restart/sendPrompt/abort/rename/compact/fork/history/models/setModel/setThinking/setPermission/ui-response
├── dshEventProjector.ts     # 纯函数：SessionEvent → ChatMessage / ThinkingUpdate / ToolEventView / permission-preset / plan-mode
├── dshRuntimeControl.ts     # 纯函数：回合 running/idle、abort 抬 cancelGeneration、迟到流丢弃
├── dshApprovalBridge.ts     # approval/question server-request 帧 ↔ agents:ui-request 通道互转、respond 载荷构造
├── dshModels.ts             # host 模型目录 → AvailableModel（透传 reasoningEfforts）
├── dshDefaultModel.ts       # 解析 settings.yaml 的 agent-default-model 段（provider/model/reasoningEffort）
├── dshCredentials.ts        # 凭证 ref 校验 + .credentials.yaml 明文解析
├── dshPresetComposition.ts  # agent-presets 组合行（default standard，随包 system 根 + 用户根）
├── （持久 pwsh 已抽成独立包 packages/dsh-tool-pwsh-persistent）
├── hideChildConsoles.ts     # Windows 控制台治理：host 隐藏控制台 + windowsHide 兜底 + runner preload 注入
├── runnerConsolePreload.ts  # 沙箱 runner（GUI 进程）自建隐藏控制台的 preload
└── js-yaml.d.ts             # js-yaml 类型声明
```

### 6.4 事件映射（DSH → PiDeck 模型）

| PiDeck 概念 | DSH 来源 | 说明 |
|---|---|---|
| `ChatMessage` user | `user/message` 事件（`'user-rpc'` source 带 rpcId，与发送请求对账） | 发送即乐观回显，比 pi 的 message_start 占位更简单 |
| `ChatMessage` assistant | `assistant/chunk` 累加；`turn/end` 结算 | 逐 chunk 推送，渲染层现有 streamdown 直接消费 |
| `thinking` / `ThinkingUpdate` | assistant chunk 的 reasoning 内容块 | 渲染层已是 deepseek-harness ReasoningRow 折叠模式，直接受益 |
| 工具消息 / `toolRuntimeState` | `tool/call` + `tool/result` + `ToolEventView` | host 已算好渲染意图（ToolCallView/ToolResultView） |
| `stopReason` | `turn/end` / `turn/aborted` / 错误事件 | 投影时归一化 |
| `AgentRuntimeState` | `session/models`（routable/groups）+ 事件流 | 模型选择随 `session.selectModel`（可带 reasoningEffort） |
| abort | `session.cancel` | runtimeGeneration/streamGate 机制照用，与后端无关 |
| 图片 | `PromptContentPart` image（attachment-local 行启用时） | 一期可 disable 该行，图片能力随行声明 |

### 6.5 审批与提问桥

`approval/requested`（含 `toolName/callId/reason`）→ 复用 `agents:ui-request` 通道（trust/ask 弹窗同链路）→ 用户选择 → `respond({ approvalId, outcome })`。`question/requested` 批量提问直接映射现有 `AgentUiBatchQuestion` tab 渲染。设置项「DSH 审批自动放行」默认关闭。

### 6.6 会话持久化与映射

DSH 会话由 DSH 自己持久化（`$DSH_HOME`，session log 事件流，`session-persistence-jsonl` 行）。PiDeck `SessionCatalog` 对 DSH 会话只存一条映射记录：`SessionRecord.id`（PiDeck mint）↔ DSH `sessionId` + `backend: "dsh"` + `cwd`；历史浏览走 `session.history`（分页、`projections` 块给标题基线），**不**复用 `SessionScanner`（那是 pi 文件扫描）。

**落地补充（与 §9 原「默认隔离」决策不同，见 §12.4）：** DSH_HOME 一律使用用户真实 `~/.dsh`（与 `dsh` CLI 行为一致，配置/凭证/会话全在同一处，不复制；目录不存在时自动创建）。早前版本还有「仅当 `~/.dsh` 不存在才回退应用私有 `userData/dsh-home`」的兜底，已由 commit `3b975e21` 移除——避免出现两套数据目录漂移。重启后通过 catalog 中的 `dshSessionId` 映射 attach 旧 host 会话并重放历史尾部，`dshSessionId` 不换绑（restart/fork 后同步更新映射）。

### 6.7 UI 层

- 新建会话：后端选择器（Pi / DSH），记入 `SessionRecord.backend`——同项目下两种会话并存、随时来回操作。
- 侧栏/列表：badge + 过滤（现有 `sessionSourceFilter` 模式扩展）。
- 设置页：DSH 配置（host 形态选择、`$DSH_HOME` 路径、审批策略、可禁用行开关）。
  - 落地：`$DSH_HOME` 路径切换 ✅、审批策略（自动放行开关）✅、DSH 配置管理页 8 分区（概览/模型/预设/插件/安全/认证/设置/源文件）✅；host 形态选择 ❌（仅 v2 utilityProcess 一种形态）、可禁用行开关 ❌（组合行由 hostEntry 固定，见 §12.4）。
- runtime 面板：模型/状态/工具卡沿用现有组件，数据源换成 DshAgentManager 投影结果。

### 6.8 生命周期与安全

- host 进程登记退出清理清单（AGENTS.md 要求）；崩溃自动重启（限次）。
- 启动失败可诊断：`appLogger` 关键节点留痕（对齐窗口创建/pi 启动的规范）。
- 审批默认人工确认；`$DSH_HOME` 可由设置指定（默认用户 home，与 CLI 共享会话，或隔离到 userData 下可选）。

---

## 7. 能力对照表（Parity）

### P0 — 等价能力（DSH 后端必须提供，验收后才算可用）

> 状态列：✅ = 已落地（含 e2e/单测验证）；代码证据见 §12.2。

| ID | 能力 | pi 实现 | DSH 实现 | 验收 | 状态 |
|----|------|---------|----------|------|------|
| D01 | 创建会话/agent | spawn pi + session 文件 | `session.create({ cwd, sessionId? })` | PoC 跑通 | ✅ |
| D02 | 发送消息（流式） | `send_prompt` + message_start/delta/end | `session.prompt({ mode: 'queue' })` + mux 流 `session/event` | 流式 UI 与 pi 一致 | ✅ |
| D03 | 中止 | `abort` + streamGate | `session.cancel` | 回归 | ✅ |
| D04 | 历史分页浏览 | 会话文件 JSONL 解析 | `session.history({ beforeSeq, maxMessages })` | 翻页一致 | ✅ |
| D05 | 模型列表/切换 | `get_available_models` / `set_model` | `session.models` / `session.selectModel` | 类型映射单测 | ✅（含思考档位，见 D16） |
| D06 | thinking 展示 | thinking_delta | chunk reasoning 块 | 折叠单行模式 | ✅ |
| D07 | 工具调用展示 | tool start/update/end | `tool/call` + `ToolEventView` | 卡片一致 | ✅ |
| D08 | 审批/提问 | pi 扩展 ask_question/trust | `approval/requested` + `question/requested` → respond | 弹窗链路手测 | ✅ |
| D09 | 重命名 | `session_rename` | `session.rename` | 冒烟 | ✅ |
| D10 | fork | `fork`（entryId 裁剪） | `session.fork({ atSeq })` | 冒烟 | ✅ |
| D11 | compact | `compact` RPC | 发送 `/compact` slash 命令（host 侧命令注册表执行） | 手测 | ✅（slash 桥） |
| D12 | 并发多会话 | 每会话一个 pi 进程 | 单 host 多 agent（in-process fiber） | 双会话并行 | ✅ |

### P1 — 降级/可选项（能力声明缺失，UI 隐藏）

| ID | 能力 | 说明 | 状态 |
|----|------|------|------|
| D13 | 编辑/删除历史消息 | DSH 无对应（`session.updateQueue` 只改 pending 队列项）→ 能力缺失 | ✅ 按计划缺失（`capabilities` 不含 editMessage/deleteMessage，UI 隐藏） |
| D14 | 图片附件 | 依赖 `attachment-local` 行（sharp）→ 一期 disable，能力随行关闭 | ✅ 仍不支持（桥 body 仅字符串，字节载荷一期不支持） |
| D15 | `/commands` 列表 | DSH 命令注册表存在，wire 上无显式 list 方法 → 二期经 host 侧自定义桥或文档化命令集 | ⏳ 仍后置（`getCommands` 未声明；已实现的是命令*执行*桥，非列表） |
| D16 | 会话级模型/thinking 持久偏好 | `session.models.current` + selectModel 已覆盖；thinkingLevel 无显式 API → 映射到 reasoningEffort | ✅ 已实现（`session.selectModel` + `reasoningEffort`，按模型 `reasoningEfforts` 过滤档位；草稿期写 catalog，激活时 applyPreferences） |

### P2 — DSH 特有加分项（后置）

| ID | 能力 | 说明 | 状态 |
|----|------|------|------|
| D17 | 动态 Cordis 插件 | `cordis-host-runner` 保留，PiDeck 内可运行 `@pluginId` 插件（管理 UI 后置） | ⏳ 部分：配置页提供 agent-loop/shell/web-search 插件分区（dsh-web 同源命名空间），无插件安装/管理 UI |
| D18 | goals / plan-mode / skills / subagents | DSH 原生能力；`goal.*` / `subagent.*` API 已就绪，UI 呈现后置 | ⚠️ plan-mode 已提前落地（`/plan` + plan/mode 事件 → `planModeActive`）；goals/subagents 的 UI 呈现仍后置 |
| D19 | 会话 agentPreset | `agent-presets` 行（default: standard）是 web 特有；自建组合时可注入 preset 目录 | ✅ 已实现（`dshPresetComposition` 注入随包 system 根 + `$DSH_HOME/.agent-presets` 用户根；配置页「预设设置」列出 standard/code/minimal/cordis 并支持设为默认） |

---

## 8. 落地路线（阶段与验收门禁）

| 阶段 | 内容 | 验收门禁 | 状态 |
|---|---|---|---|
| **0. PoC**（不动产品代码） | `scripts/dsh-embed-probe.mjs`：组装 base 组合 → `boot()`（prepare 注入 `provideCmdline`）→ `InProcessApiClient` → `session.create` → `session.prompt` → mux 流式输出 → 模拟 approval → `respond` → `session.history` → `dispose()` | 控制台全流程跑通；不依赖网络外的外部服务 | ✅ |
| **1. 契约层** | `AgentBackend` 类型、gateway 能力集、`CompositeAgentGateway`、catalog `backend` 字段兼容迁移 | `npm run typecheck` + 现有单测全绿；旧会话无迁移即工作 | ✅ |
| **2. v1 运行时（stdio sidecar）** | `DshHostProcess`（spawn 入口脚本）+ `DshApiClient`（stdio carrier）+ `DshAgentManager` + 事件投影 | 投影纯函数单测；双后端同项目并存手测 | ✅（以 v2 直接取代，未单独发布） |
| **3. UI** | 后端选择器、badge/过滤、设置页、runtime 面板适配 | 手测双后端切换无状态串扰 | ✅ |
| **4. v2（utilityProcess）** | host 移入 utilityProcess，carrier 换 MessagePort；打包验证（asarUnpack 原生模块） | `npm test` + `npm run pack` smoke；退出清理清单核对 | ✅（当前形态；另含 Windows 控制台治理、崩溃限次重启、hostEntry 独立产物 asarUnpack） |
| **5. 打磨** | 错误恢复、日志、DSH_HOME 策略、文档（README/CHANGELOG） | 发版流程合规 | ⚠️ 进行中（README/CHANGELOG 已随功能更新；文档 §12 本附录为现状快照） |

---

## 9. 风险与对策

| 风险 | 对策 | 落地 |
|---|---|---|
| 打包体积 +200~400MB（150+ 子包） | 依赖树瘦身（按需禁用行）、native 模块 asarUnpack；若验收不过退回 stdio sidecar 复用用户环境（代码不变，仅传输/定位差异） | ✅ 已控制：依赖显式锁定 19 个 `@deepseek-ai/*` 子包 + `check-dsh-asar.mjs` 打包回归校验；sharp/koffi/node-addon-require-builtin 已 asarUnpack（见 §12.6） |
| 原生 ABI（node-pty/sharp/koffi/landlock） | v1 先 disable 原生重行；v2 在 utilityProcess 内单独 rebuild，主进程零污染 | ✅ host 在 utilityProcess 内加载原生模块；sharp 打包经 `patch-sharp-index.js` 修复（DLL 与 .node 同目录）；Windows 控制台治理见 §12.5 |
| 版本锁定 rc.6 | DSH 升级跟随 PiDeck 发版；信封 schema drift 由 `clientRequestSchema` zod 校验层兜底报错而非静默错位 | ✅ 锁定 `^0.1.0-rc.6` |
| DSH host 崩溃 | utilityProcess/子进程可重启（限次）；主进程内嵌形态禁用 | ✅ 崩溃限次重启（3 次）+ `abortAllPending` 中断悬挂请求（会话静默断开已修复） |
| `$DSH_HOME` 与用户 CLI 会话冲突 | 默认隔离（userData 下）可选共享；双 host 同目录并发不做支持 | ⚠️ 策略已调整：默认直接用 `~/.dsh`（与 CLI 共享），仅全新用户回退 userData/dsh-home（见 §12.4）；双 host 同目录并发仍不支持 |
| 双后端状态串扰 | 事件严格带 `sessionId+agentId+runtimeGeneration`，沿用现有 Coordinator 门禁 | ✅ 沿用（DSH agentId = `dsh:<sessionId>`） |
| rc 期 API 变动 | 协议面收窄到 `ApiProxy` 契约（官方声明稳定）；投影层集中隔离映射差异 | ✅ 投影/桥协议均为纯函数单测覆盖 |

---

## 10. 测试策略

- 新增单测（`tests/*.test.mjs`，行为不测实现）：
  - `dshEventProjector` 纯函数：SessionEvent/MuxFrame → ChatMessage/ThinkingUpdate/工具卡（含 rpcId 对账、turn/end 结算、reasoning 块拆分）。
  - `CompositeAgentGateway`：按 backend 路由、能力缺失错误码。
  - `SessionRecord.backend` 兼容：旧数据缺省 pi 的往返序列化。
  - stdio carrier：信封 marshal/SSE 帧解析（用内存管道模拟，不依赖真实 DSH 进程）。
- 主进程集成：mock DSH 侧协议（参照现有 mock-pi RPC 的 E2E 基建）。
- 门禁：任何合并前 `npm run typecheck` 与 `npm test` 全绿；不放松断言、不注释失败测试。

> 落地后的实际测试清单见 §12.7（单测文件与 e2e spec 名称均以代码为准）。`CompositeAgentGateway` 专项单测已落地（`tests/compositeAgentGateway.test.mjs`：按 backend 路由 + 能力缺失拒绝）；「stdio carrier 用内存管道模拟」随 v1 形态取消，由 `tests/dshApiClientBridge.test.mjs`（MessagePort 桥 + `dshHostBridge` 纯函数）覆盖。

---

## 11. 参考（证据文件索引）

> 以下为调研时核查的 DSH rc.6 源码位置（npx 缓存内的安装树，仅作证据留存；产品实现以 PiDeck 依赖锁定版本为准）。

- 引导 API：`@deepseek-ai/dsh-app-boot/lib/index.js`（`boot` L1166、`mountRootInclude` L963、profile 工具集 L308+）
- 客户端/契约：`@deepseek-ai/dsh-host-apiproxy/lib/index.js`（`AbstractApiClient` L5307、`InProcessApiClient` L5538、`toFetchHandler` L4983、`ApiProxyService` L5590）；`lib/types/api/`（`rpc.d.ts` 四象限、`sessions.d.ts`、`events.d.ts`、`approvals.d.ts`、`rpc-map.d.ts`）
- 官方 IPC-bridge 背书：`@deepseek-ai/dsh-host-webserver/lib/index.js` L11-12
- 无 web 证明：`@deepseek-ai/dsh-headless/cordis.patch.yml`、`lib/index.js`（runner L63-99、appExit 依赖 L106-107）
- 组合构成：`@deepseek-ai/dsh-base/cordis.patch.yml`（base 行全集）、`@deepseek-ai/dsh-web-app/cordis.patch.yml`（web 专属行）
- 原生依赖：`dsh-attachment-local`（sharp）、`dsh-subprocess-local`（node-pty）、`dsh-fs-local`/`dsh-session-persistence-jsonl`（koffi）、`dsh-session-query-sqlite`（`node:sqlite`，`openAt: never`）
- launcher 职责：`@deepseek-ai/dsh-cmdline`（`provideCmdline`）、`@deepseek-ai/dsh-home-paths`（`resolveDshHome`）

---

## 12. 落地现状与偏差（2026-08-15 快照）

> 本节是 §1–§10 计划落地后的**现状快照**，代码为准；计划正文保留为设计记录，与本节冲突处以本节为准。
> 依据：`src/main/dsh/`、`src/shared/types/agent.ts`、`src/shared/ipc.ts`、`tests/dsh*.test.mjs`、`e2e/dsh-*.spec.ts`、`package.json`、`electron.vite.config.ts`。

### 12.1 总体结论

- 深融合（无 `dsh web`）已按 §3.2 形态 (b) 落地：host 运行在 **utilityProcess**（`serviceName: pideck-dsh-host`），主进程通过 `AbstractApiClient` 子类（`DshApiClient`）走 **MessagePort fetch 桥**访问同一 ApiProxy 契约；v1 stdio sidecar 被 v2 直接取代，从未单独发布。
- 懒启动：首个 DSH 会话创建时才 `utilityProcess.fork` + `boot()`（约 800ms），不拖慢应用启动。
- P0（D01–D12）全部通过（含 e2e：`dsh-models`、`dsh-restart`、`dsh-security-plan`、`dsh-title-diag`）。
- 超出 P0 提前落地：**权限预设**（`/permission`）、**plan 模式**（`/plan`）、**agent-presets**（D19）、**模型/思考档位全链路**（D16）、**持久化 pwsh**（应用侧插件）。
- 仍未做（按能力声明缺失，UI 隐藏）：编辑/删除历史消息（D13）、图片附件（D14）、`/commands` 列表（D15）、goals/subagents UI 呈现（D18 后半）、动态插件管理 UI（D17 后半）。

### 12.2 模块清单（实际，与 §6.3 计划对照）

见 §6.3 更新的实际文件树。计划名与落地名的差异：

| 计划模块 | 落地对应 | 说明 |
|---|---|---|
| `DshLocator.ts` | `DshHostProcess.resolveHostEntryPath` + `createRequire` 解析 | 定位逻辑并入 host 进程管理与 `hostEntry`（dev/打包/e2e 三种路径） |
| `dshComposition.ts` | `hostEntry.ts` 内联组合 + `dshPresetComposition.ts` | 组合在 utilityProcess 入口内完成（base patch + overlay：storage/workspace/api-gateway/directory-picker/slash-bridge/tool-pwsh-persistent/agent-presets；disable hmr、session-telemetry-otel） |
| `DshApiClient.ts` | 同名 | v2 MessagePort carrier（未实现 v1 stdio carrier） |
| 新增（计划未列） | `dshHostBridge.ts` / `dshRuntimeControl.ts` / `dshModels.ts` / `dshDefaultModel.ts` / `dshCredentials.ts` / `hideChildConsoles.ts` / `runnerConsolePreload.ts`；持久 pwsh 见 `packages/dsh-tool-pwsh-persistent` | 桥协议、运行态控制、模型目录/默认模型/凭证解析、Windows 控制台治理、独立 pwsh 插件 |

### 12.3 类型与 IPC（§6.1 落地形态）

- `src/shared/types/agent.ts`：`AgentBackend = "pi" | "dsh"`；`AgentGatewayCapability = compact | fork | getForkMessages | editMessage | deleteMessage | getCommands | exportHtml`；`AgentRuntimeState` 增 `permissionPreset` / `planModeActive`；`AvailableModel` 增 `reasoningEfforts`；`CreateAgentInput` 增 `dshSessionId`。
- `src/shared/types/session.ts`：`SessionRecord` / `AgentTab` 增 `backend`、`dshSessionId`（缺省 pi，旧数据零迁移）。
- `src/shared/ipc.ts`：DSH 专用通道 `dsh:list-models / list-providers / get-status / config-describe / config-update / open-document / restart-host / credential-describe / credential-set / credential-unset / credential-read / agent-presets / default-model`；会话运行通道复用通用 `sessions:runtime-*`，事件复用 `agents:*`。
- `DshAgentManager.capabilities = { fork, getForkMessages, compact }`；`editMessage/deleteMessage/getCommands/exportHtml` 接口不实现，调用方经 capability 检查拒绝。

### 12.4 与原计划的偏差

| # | 计划表述 | 落地事实 |
|---|---|---|
| 1 | §9「`$DSH_HOME` 默认隔离（userData 下）可选共享」 | **改为默认直接用用户真实 `~/.dsh`**（与 `dsh` CLI 共用配置/凭证/会话，无复制）；设置页可切换 DSH_HOME（`dsh:restart-host` 重启生效）。注：早前版本还留有「仅当 `~/.dsh` 不存在才回退 `userData/dsh-home`」的兜底，已由 commit `3b975e21` 移除（新用户也统一 `~/.dsh`）；`src/shared/types/settings.ts` 的 `dshHomeDir` 注释现已与 `DshHost.resolveDshHomeDir` 实际行为一致（此前的注释漂移已修）。共用默认目录的覆盖风险提示见 §12.4 第 13 项。 |
| 2 | §3.2 先 v1（stdio sidecar）再 v2 | v1 未单独发布；直接以 v2 utilityProcess 形态交付。 |
| 3 | §2.5/§7 D14 图片附件「一期 disable」 | 仍不支持：桥 body 一律字符串（`dshHostBridge.ts` 注释「字节载荷（图片附件等）一期不支持」），attachment-local 行禁用兜底。sharp 仅作为原生依赖打包兼容（asarUnpack + `patch-sharp-index.js`），不代表图片附件已启用。 |
| 4 | §7 D11 compact「手测」 | 经 **slash 桥**（`pideck-slash-bridge.js` 插件）实现：以 `/` 开头的单条用户消息在 `agent/pre-step` 拦截 → `ctx.commands.execute`；命中则 reject 步骤（命令事件落盘、消息不进模型不上时间线），未知命令放行给模型。`/permission`、`/plan` 同链路。 |
| 5 | §7 D18 plan-mode「后置」 | plan 模式已提前落地（`plan/mode` 事件 → `planModeActive`，Composer 模式选择器切换）；goals/subagents UI 仍后置。 |
| 6 | §7 D19 agentPreset「web 特有，后置」 | 已落地：`agentPresetsRow` 注入随包 system 根（`<dsh 包>/config/agent-presets`，default standard）+ `$DSH_HOME/.agent-presets` 用户根；配置页「预设设置」tab 列出 standard/code/minimal/cordis，「设为默认」写 settings.yaml 的 `agent-presets.default`。 |
| 7 | 计划未提 | **Windows 控制台治理**：utilityProcess 无控制台，`installHostHiddenConsole`（koffi AllocConsole + SW_HIDE）给 host 分配隐藏控制台使整棵进程树零弹窗；失败退回 windowsHide 注入兜底；沙箱 runner（GUI 进程不继承控制台）经 `NODE_OPTIONS=--require=runnerConsolePreload` 自建隐藏控制台。 |
| 8 | 计划未提 | **持久化 pwsh**（独立包 `dsh-tool-pwsh-persistent`）：DSH 会话内复用常驻 pwsh（自包含 node-pty，仿 `dsh-tool-bash-persistent`），避免每次调用 ~350ms 冷启动。可单独发给其他 DSH 用户。 |
| 9 | 计划未提 | **重启 attach 语义**：restart 改为 attach 同一 host 会话（`$DSH_HOME` 持久化数据不换），仅当 host 中已不存在该会话（DSH_HOME 被清/更换）才退回新建；catalog 的 `dshSessionId` 保持不变。修复了「重启后原会话消息丢失」用户 bug（`e2e/dsh-restart.spec.ts` 回归）。 |
| 10 | 计划未提 | **消息串行化**：同一 DSH 会话的发送按序串行（一次一个回合），队列消息自动排队。 |
| 11 | 计划未提 | **标题同步**：attach/restart 三处 + 事件桥为 DSH tab 补写 `dshSessionId`，侧栏标题随 host 会话标题同步（`e2e/dsh-title-diag.spec.ts` 回归）。 |
| 12 | §6.8「启动失败可诊断」 | `appLogger` 关键节点留痕（host fork/boot/ready/error/exit、崩溃重启计数）。 |
| 13 | 计划未提 | **共享 `~/.dsh` 的覆盖风险提示（#189）**：默认 home 与 dsh CLI 共用同一份配置/凭证/插件状态，而 DSH 官方约束「同一 DSH_HOME 只允许一个 host」。PiDeck 不能阻断外部 dsh 进程（CLI 不遵守 PiDeck 锁文件），因此只做「说清楚 + 给官方隔离手段」：`dshHomeSharing.ts` 判定 `sharesCliHome`（默认目录未隔离）与 `externalHostPid`（锁文件里另一个仍存活的 PiDeck host），经 `dsh:get-status` 的 `sharing` 字段透出，配置页概览渲染 `DshHomeSharingNotice`（冲突优先于共享；提示命令行侧 `DSH_HOME` 隔离）。判定用注入 homeDir/selfPid/isAlive 的纯函数，不在模块内读环境或文件。 |

### 12.5 生命周期与稳定性（落地形态）

- 启动：`utilityProcess.fork(hostEntry.js, argv)`（`--dsh-home` / `--dsh-config` / `--dsh-node-modules`）；host-ready 信号后建桥；mux 泵带指数退避重连。
- 崩溃：限次重启（maxRestarts = 3）；host 退出 → `abortAllPending` 中断悬挂请求（修复会话静默断开）。
- 退出清理：`DshHost.dispose` 注册进主进程退出清单；`DshHostProcess.kill` + 5s 兜底强杀。
- 安全：审批/提问经 `agents:ui-request` 桌面 Ask 弹窗；「DSH 审批自动放行」默认关闭（`dshApprovalAutoAllow` 运行时即时生效）；`danger-full-access` 权限预设切换需二次确认。

### 12.6 打包与依赖

- `electron.vite.config.ts` 主进程多入口：`index` / `hostEntry` / `runnerConsolePreload` / `pideckPluginBridge` / `pideckCommandsBridge`；`@deepseek-ai/*` 与 `dsh-tool-pwsh-persistent` external（`tests/dshMainExternalize.test.mjs` 守护该契约，`dshPeerDepsPackaged.test.mjs` 守护 peerDep 进 asar）。
- `asarUnpack`：`out/main/hostEntry.js`、`@img/sharp-win32-x64`、`@koromix/koffi-win32-x64`、`node-addon-require-builtin-win32-x64-msvc`；`npmRebuild: false`。
- `scripts/check-dsh-asar.mjs`：校验 19 个 `@deepseek-ai/*` 依赖已进 app.asar（打包回归）。
- `scripts/dsh-embed-probe.mjs`（`npm run probe:dsh`）：深融合 PoC 探针，不入产品构建。
- 依赖：`@deepseek-ai/dsh@^0.1.0-rc.6` + 18 个显式子包（cordis-plugin-group、dsh-bash-local、dsh-sandbox、dsh-subprocess、dsh-session-title-llm、dsh-workflow 等）+ `@deepseek-ai/cordis-plugin-group`。

### 12.7 测试覆盖（`tests/dsh*.test.mjs` + `e2e/dsh-*.spec.ts`）

- 单测：`dshAgentManager`（会话文件路径编码）、`dshEventProjector`、`dshRuntimeControl`、`dshApiClientBridge`、`dshHostBridge`、`dshApprovalBridge`、`dshCredentials`、`dshHomeDir`（DSH_HOME 解析优先级）、`dshModels`、`dshDefaultModel`、`dshSchema`、`dshPresetComposition`、`dshPresetDisplay`、`dshCredentialRef`、`dshMainExternalize`、`dshPeerDepsPackaged`、`hideChildConsoles`、`pideckPwshPersistent`（协议测 `packages/dsh-tool-pwsh-persistent`）、`compositeAgentGateway`（按 backend 路由 + 能力缺失拒绝）。
- e2e（真实 DSH host，临时 DSH_HOME 隔离，不触碰用户 `~/.dsh`）：`dsh-models`（模型列表/切换/思考档位草稿→激活全链路）、`dsh-restart`（重启保留原消息并可续聊）、`dsh-security-plan`（权限预设切换、plan 模式、配置页三分区）、`dsh-title-diag`（标题同步）。

### 12.8 已知缺口与后续

- 能力缺失（按计划保持，UI 隐藏）：编辑/删除历史消息（D13）、图片附件（D14，桥需支持字节载荷）、`/commands` 列表（D15，命令*执行*桥已就绪，列表接口二期）。
- UI 后置：goals / subagents / skills 的专项呈现（D18 后半）、动态 Cordis 插件管理（D17 后半，目前仅有 agent-loop/shell/web-search 配置分区）。
- 双 host 同 `$DSH_HOME` 并发运行不支持（与 CLI 同目录并发同理）。
- 文档待跟进：`src/shared/types/settings.ts` 的 `dshHomeDir` 注释与 `DshHost.resolveDshHomeDir` 实际行为不一致（见 §12.4 #1）；README/CHANGELOG 的 DSH 条目随发版流程维护。
