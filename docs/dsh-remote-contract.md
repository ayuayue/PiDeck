# DSH Typert Remote 集成契约

> 本文是**仍生效的集成契约**，原提取自 0.1.5 迁移文档（`dsh-0.1.5-typert-migration.md`，迁移叙事部分已删，需要考古看 git 历史）。
> 0.2.0 的增量变化（PTC 后端、预设 registry、V3→V4 会话格式、事件投影 V4 等）见 `dsh-0.2.0-migration.md`；两文叠加 = 当前完整契约。

## 架构分层（HTTP ApiProxy → Typert Remote）

0.1.5 起 `dsh-host-apiproxy` 止步废弃，传输改为载体无关的 Typert Remote：

| 层 | 包 | 角色 |
|---|---|---|
| RPC 注册表 | `dsh-client-connection`（node 半） | 载体无关 RPC：`ctx.connection: HostConnectionHandle`，`createSharedFetchHandler('/api')` 产出 fetch handler；`RpcId`/`ClientRequest`/`ServerResponse`/`ConnectionRpcResult` 契约在此包 |
| 传输挂载 | `dsh-host-webserver`（可选） | /api HTTP 挂载；不用 webserver 也能跑（载体无关是官方设计） |
| 网关 | `dsh-api-gateway` | `ctx.typertGateway.invoke({namespace,method,args})` / `.stream()` / `wireStream.open(endpoint,payload,signal)`（WebSocket mux 与 local Host transports 共用的 carrier adapter） |
| BFF 组装 | `dsh-api-remotes` | 把应用选定的 Host 能力装配为 Remote；`API_REMOTE_FORWARDED_EVENTS` |
| 领域控制器 | `dsh-api-session-controller` / `dsh-api-settings-controller` / `dsh-api-workspace-controller` / `dsh-api-workspace-files` | 端点实现 + zod 校验描述符（typert.host.js） |
| 客户端 | `dsh-client-connection/client` | `createWebConnectionRpc(doFetch?, openStream?)` → `ClientConnectionRpc.call(channel, endpoint, payload, signal): Promise<ConnectionRpcResult<T>>`；`ClientTransportHooks` 供拥有不同物理传输的 shell（如 worker postMessage tunnel）提供 fetch + openStream 两个 half |

返回值统一为 `RemoteResult<T> = {ok:true,value}|{ok:false,error}`。PiDeck 的 MessagePort fetch 桥（dshHostBridge 协议）与官方 `RpcFetch` 形态一致，unary 直接复用；流式走 Gateway wireStream 载体。

## 端点映射（channel 统一 `/api`，payload 为描述符命名参数）

| 领域方法 | endpoint | 备注 |
|---|---|---|
| sessions.list | `session/list` | |
| sessions.history | `session/page` | **分页语义**，见下节 throughSeq 契约 |
| sessions.prompt / selectModel / create / cancel / rename / fork / attachment / search | `session/*` | |
| events.mux | `session/follow`（流）/ `session/control`（流） | 流经 Gateway wireStream |
| respond(client-response) | approval 域端点 | `approval/request`/`asked`/`decided` |
| subagents.list/history | ~~`subagent/catalog` / `subagent/descriptor`~~ | **0.2.0 起 `subagents/list` 端点删除**，改从 `session/projections` + `session/list` 读目录/状态 |
| skills.list | `skills/list` | |
| goals.* | `goals/*` | |
| settings.* | `settings/describe` / `update` / `mutate` / `openSettingsDocument` | |
| llm.providers/models/discoverModels | `llm/listProviders` / `llm/discoverModels` / `llm/listConfigurableProviders` | 0.2.0：host 目录不再携带会话当前模型选择，从会话投影冷读 next/lastUsed |
| credentials.set/unset/describe | `credentials/*` | |
| agentPresets.list/remove | `agentPresets/list` / `agentPresets/deletePreset` | 0.2.0：PiDeck 已移除 deletePreset 的 UI/preload/IPC/host/remote 入口，不代写文件删除 |

## throughSeq 契约（session/page）

`session/page` 的 `throughSeq` 是**包含式日志切点**：

- 必须 ≤ 该会话当前 cursor，超出直接 `gateway/bad-request`；
- PiDeck 实现经 pideck-session-bridge 的 `sessionQuery.observeSession` **冷读** observation cursor（不激活冷会话；语义同为最后事件 seq），
- 任何对 throughSeq 语义的误用（`MAX_SAFE_INTEGER`、负数等）会让历史读取**静默变空**——守卫见 `tests/dshSessionBridge.test.mjs` 与 `DshAgentManager.historyPage` 注释。

## PiDeck 传输设计

### host 侧（utilityProcess / hostEntry.ts）

- fetch handler：`ctx.connection.createSharedFetchHandler('/api')`（不再是 toFetchHandler(ctx.apiProxy)）。
- 流载体：父端口收到 `{type:"stream-open", endpoint, payload, streamId}` → `ctx.typertGateway.wireStream.open(endpoint, payload, signal)` → 逐值以 `{type:"stream-chunk", streamId, data}` 回传，结束/出错回 `stream-end`/`stream-error`（协议在 dshHostBridge.ts）。
- 挂载行（0.1.5 落地差异）：组合行含 file-upload（提供 fileUploads 服务，session-controller 前置）；base 自带 storage 四行，hostEntry 不得重复 insert；agent-presets 行不配 roots；shippedPresetRoot 指向 `dsh-agent-presets/presets`。

### client 侧（主进程）

- unary：bridgedFetch（fetch 帧桥原样），对 handler fetch 后解 ConnectionRpcResult 信封。
- stream：stream-open 帧桥产出 AsyncIterable。
- `DshRemoteClient` 实现旧 AbstractApiClient 的领域方法签名（内部转 endpoint 调用），`DshAgentManager` 调用面改动最小化；类型 `RpcId` 从 `@deepseek-ai/dsh-client-connection` 取，`SessionId` 从 `dsh-session/types` 取。

## 打包入口清单（pack-dsh-runtime.mjs / check-dsh-asar.mjs）

`manifest.requiredPackages`：`@deepseek-ai/dsh-base` / `dsh-app-boot` / `dsh-cmdline` / `dsh-client-connection` / `dsh-api-gateway` / `dsh-api-remotes`（以 hostEntry 实际 resolve 的包为准）；闭包收集按整个 `@deepseek-ai` scope，天然覆盖新包。

## 长期限制：老日志 v2 descriptor 无法迁移

0.1.1-rc.1 及更早写出的 `subagent/descriptor` **v2** 事件无法迁移（0.1.5+ 的迁移要求 descriptor v3，拒绝时抛 `SessionFormatUnsupportedError: subagent/descriptor N uses unsupported descriptor version 2`，原始日志保持不变）。受影响会话 `session/list` 仍能列出（只读 header/投影缓存），但 `session/page` 读不到——PiDeck 侧显示明确错误，不静默返回空。修复需上游补 v2 迁移；2026-09 实测 79 个会话中 7 个命中（0.1.1-rc.1 时代写入）。
