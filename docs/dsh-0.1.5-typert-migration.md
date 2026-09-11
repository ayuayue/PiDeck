# DSH 0.1.1-rc.2 → 0.1.5-rc.1 迁移设计（Typert Remote）

> 状态：**迁移完成（2026-09-11）**。typecheck 0 错误；tests/dsh*.test.mjs 444/444 绿；
> runtime:pack 已重打（0.1.5-rc.1，791 包，77.5MB tgz）；runtime:check 与
> runtime:check:boot（真实 boot 插件树）均通过。后续做端到端冒烟（建会话/发消息/
> 审批/用量页）即可发版。落地差异 vs 下文设计：组合行新增 file-upload（提供
> fileUploads 服务，session-controller 前置）；base 0.1.5 自带 storage 四行，
> hostEntry 不得重复 insert；agent-presets 行不再配 roots（随包 system 根由
> 插件自带）；shippedPresetRoot 指向 dsh-agent-presets/presets。

## 1. 版本结论

- npm `@deepseek-ai/dsh` 最新：**0.1.5-rc.1**（dist-tags: latest/next 均指向它）。
- 子包（dsh-llm/dsh-session 等）同样发布到 0.1.5-rc.1，但 `latest` tag 未更新
  （停在 0.0.1-rc.x），**必须显式指定版本安装**。
- `@deepseek-ai/dsh-host-apiproxy` **止步于 0.1.1-rc.2，0.1.5 线不再发布**——
  这是本次唯一的架构级破坏性变更。
- 依赖侧已完成：22 个 `@deepseek-ai/dsh-*` 全部升至 0.1.5-rc.1；新增 peer 依赖
  `@deepseek-ai/dsh-brand`（dsh-anonymous-user-id 要求）；`dsh-bill` → ^0.14.0；
  本地包 `packages/dsh-tool-pwsh-persistent` 的 peerDependencies 放宽为
  `>=0.1.5-rc.1`（原 ^0.1.1-rc.2 会拖旧版本进树，导致 ERESOLVE）。

## 2. 架构变更：HTTP ApiProxy → Typert Remote

### 旧（0.1.1）
- host 侧：`dsh-host-apiproxy` 提供 `ctx.apiProxy`，`toFetchHandler(ctx.apiProxy)`
  产出 fetch 形态 handler；hostEntry 里以 `{id:"api-gateway"}` 行挂载。
- client 侧：`AbstractApiClient`（`doFetch` 抽象 + postJson/readSse + 领域方法
  sessions.*/goals.*/...），PiDeck 用 MessagePort 桥覆写 doFetch（DshApiClient）。
- 事件流：`client.events.mux()` 长连接 SSE。

### 新（0.1.5）
| 层 | 包 | 角色 |
|---|---|---|
| RPC 注册表 | `dsh-client-connection`（node 半） | 载体无关 RPC：`ctx.connection: HostConnectionHandle`，`createSharedFetchHandler('/api')` 产出 fetch handler；`RpcId`/`ClientRequest`/`ServerResponse`/`ConnectionRpcResult` 契约在此包 |
| 传输挂载 | `dsh-host-webserver`（可选） | /api HTTP 挂载；**不用 webserver 也能跑**（载体无关是官方设计） |
| 网关 | `dsh-api-gateway` | `ctx.typertGateway.invoke({namespace,method,args})` / `.stream()` / `wireStream.open(endpoint,payload,signal)`（"WebSocket mux 与 local Host transports 共用的 carrier adapter"） |
| BFF 组装 | `dsh-api-remotes` | 把应用选定的 Host 能力装配为 Remote；`API_REMOTE_FORWARDED_EVENTS` |
| 领域控制器 | `dsh-api-session-controller` / `dsh-api-settings-controller` / `dsh-api-workspace-controller` / `dsh-api-workspace-files` | 端点实现 + zod 校验描述符（typert.host.js） |
| 客户端 | `dsh-client-connection/client` | `createWebConnectionRpc(doFetch?, openStream?)` → `ClientConnectionRpc.call(channel, endpoint, payload, signal): Promise<ConnectionRpcResult<T>>`；`ClientTransportHooks` 官方注明供 "owns a different physical transport 的 shell"（如 worker postMessage tunnel）提供 fetch + openStream 两个 half |

**关键结论：PiDeck 现有的 MessagePort fetch 桥（dshHostBridge 协议）与官方
`RpcFetch = (input: URL, init: RequestInit) => Promise<Response>` 形态一致，
unary 部分基本可保留；流式（mux）需要新增 Gateway 流载体。**

## 3. 端点映射（old client 方法 → 新 endpoint）

channel 统一用 `/api`；payload 为描述符里的命名参数（见各包 typert.host.js 的
`parameters: [{name, wire}]`，zod 校验在 host 侧强制）。

| 旧调用 | 新 endpoint | 备注 |
|---|---|---|
| sessions.list | `session/list` | |
| sessions.history | `session/page` | **语义变化：全量数组 → 分页**（ClientSessionPageRequest），DshAgentManager.backfillHistory 需改分页拉取 |
| sessions.prompt | `session/prompt` | |
| sessions.selectModel | `session/selectModel` | |
| sessions.models | `session/modelCatalog` | |
| sessions.create | `session/create` | |
| sessions.cancel | `session/cancel` | |
| sessions.rename | `session/rename` | |
| sessions.fork | `session/fork` | |
| sessions.attachment | `session/attachment` | |
| sessions.search | `session/search` | |
| events.mux | `session/follow`（流）/ `session/control`（流） | 流经 Gateway wireStream，需新载体 |
| respond(client-response) | approval 域端点 | 精确名待核：`approval/request`/`asked`/`decided` 已确认存在，respond 端点在 dsh-user-approval/session-control 实现时确认 |
| subagents.list/history | `subagent/catalog` / `subagent/descriptor` 等 | 完整清单在 dsh-subagent client 实现 |
| skills.list | `skills/list` | |
| goals.create/pause/resume/complete/clear | `goals/*` | dsh-goal，另增 get/edit |
| settings.describe/update/mutate/openDocument | `settings/describe` / `update` / `mutate` / `openSettingsDocument` | |
| llm.providers/models/discoverModels | `llm/listProviders` / `llm/discoverModels` / `llm/listConfigurableProviders` | models→modelCatalog 待核 |
| credentials.set/unset/describe | `credentials/*` | |
| agentPresets.list/remove | `agentPresets/list` / `agentPresets/deletePreset` | |

返回值统一为 `RemoteResult<T> = {ok:true,value}|{ok:false,error}`（新），
旧代码里 `{ok:true,value}` 形态基本同构。

## 4. PiDeck 传输设计

### host 侧（utilityProcess / hostEntry.ts）
1. 挂载行调整（对齐 dsh-web-app@0.1.5 cordis.patch.yml 的 host 半）：
   - 删 `{id:"api-gateway", name:"@deepseek-ai/dsh-host-apiproxy"}`。
   - 增 `dsh-client-connection`（提供 ctx.connection + fetch handler）。
   - 增 `dsh-api-gateway`（typertGateway）、`dsh-api-remotes`。
   - 增 `dsh-api-session-controller`（session/approval/subagent 域）；
     settings/workspace 按需。
   - 保留 storage*/projection-cache/session-stats/workspace/presets/bill/pwsh/
     pideck 桥各行（0.1.5 下 id/name 兼容性以 boot 实测为准）。
2. toFetchHandler(ctx.apiProxy) → `ctx.connection.createSharedFetchHandler('/api')`。
3. 新增流载体：父端口收到 `{type:"stream-open", endpoint, payload, streamId}` →
   `ctx.typertGateway.wireStream.open(endpoint, payload, signal)` →
   逐值以 `{type:"stream-chunk", streamId, data}` 回传，结束/出错回
   `stream-end`/`stream-error`（协议加在 dshHostBridge.ts）。

### client 侧（主进程）
1. `DshApiClient` 重写为薄 Remote 客户端：
   - unary：沿用现有 bridgedFetch（fetch 帧桥原样），包一层
     `rpc.call('/api', endpoint, payload)` 语义（或直接对 handler fetch 后解
     ConnectionRpcResult 信封）。
   - stream：新增 stream-open 帧桥，产出 AsyncIterable。
2. 写适配层 `DshRemoteClient`：实现旧 `AbstractApiClient` 的 ~34 个领域方法
   （签名尽量保持），内部转 endpoint 调用——**DshAgentManager 调用点改动最小化**；
   仅 sessions.history → page 与 respond → approval 两处需调用点级修改。
3. 类型来源切换：`RpcId` 等从 `@deepseek-ai/dsh-client-connection` 取；
   `SessionId` 仍从 `dsh-session/types`（0.1.5 仍导出，已确认）。

### 打包脚本
- `pack-dsh-runtime.mjs`：manifest.requiredPackages 改为
  `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-app-boot","@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-api-gateway","@deepseek-ai/dsh-api-remotes"]`
  （以最终 hostEntry 实际 resolve 的包为准）；闭包收集按整个 @deepseek-ai scope
  的策略不变，天然覆盖新包。

## 5. 工作分解（建议顺序）

1. **hostEntry 组合改造** + host 侧桥适配 → `runtime:pack` → `runtime:check:boot`
   跑通（host 能独立 boot 是硬门槛）。
2. **dshHostBridge 协议扩展**（stream 帧）+ `DshApiClient` 重写。
3. **DshRemoteClient 适配层** + DshAgentManager 调用点适配（history 分页、approval）。
4. 测试：`dshApiClientBridge.test.mjs` 等改为描述符 stub（原测试 import 真实旧包，
   已失效）；`dshAgentManager.test.mjs` 断言跟随信封变化。
5. `pack-dsh-runtime.mjs` manifest 更新 + 重打 + `runtime:check`。
6. e2e 冒烟：建会话、发消息、审批、用量页。

## 6. 已知风险 / 待确认

- `session/page` 与旧 history 的 seq 补帧逻辑（D6 backfill）需重写。
- approval respond 的精确 endpoint 与 payload 待 boot 后实测。
- 非 web 部署下 `dsh-api-remotes` 是否要求额外必挂行（其 `inject` 为
  Gateway），以 boot 实测为准。
- `cordis.patch.yml` 各行 id 在 0.1.5 的增删（web-app patch 已确认 agent plane
  移入 presets 的行集，与 hostEntry 的 `dshWebAgentPlaneDisableRows()` 对齐检查）。
- dsh-bill 0.13→0.14 的 records.jsonl 落盘格式对用量页解析（dshBillLogParser）
  的影响待验证。
