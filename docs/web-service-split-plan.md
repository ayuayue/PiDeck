# Web 服务域拆分计划（WebServiceManager.ts）

状态：已完成（Wave 1-6 落地，151/151 测试绿；manager 2165 → 551 行）
起点：`src/main/web/WebServiceManager.ts` 2165 行（`AGENTS.md` 红线：目标 ≤400 行，超 600 行必须评估拆分）
目标：按域抽出协作者模块，**行为零变化**（不改状态语义、不改路由契约、不改响应帧格式），目标文件行数单调下降。

## 为什么拆

`WebServiceManager` 同时是：HTTP 响应/请求体工具库、A1 兜底页模板、静态产物与 dev 代理、令牌鉴权、状态 SSE 推送、35 个 API 路由分支、远程访问编排入口。
任何一处改动都要在全文件里找上下文，单文件承载了 7 个域。

## 域表（能力 parity 表）

| 目标模块 | 迁出内容（原文件符号） | 对外面 | 状态 |
| --- | --- | --- | --- |
| `WebHttpResponders.ts` | `MAX_JSON_BODY_BYTES`/`HARD_BODY_ABORT_BYTES`、`WebBodyTooLargeError`、`WebInvalidJsonError`、`serializePublicWebPayload`、`readBoundedFile`、`readJson`、`sendJson`/`sendError`/`sendHtml`/`sendFile`/`sendNoContent`/`contentType` | 无状态纯函数；manager 保留同名私有薄包装转发 | ✅ Wave 1 |
| `webPageTemplate.ts` | `renderPage()`（A1 vanilla 兜底页 SVG/CSS/JS 模板 517 行） | `renderLegacyWebPage(): string` | ✅ Wave 1 |
| `WebStaticAssets.ts` | `serveRenderer`、`loadWebEntryHtml`、`proxyDevRenderer`、`proxyDevWebSocket`、`rendererRoot`/`devRendererUrl`/`webEntryHtmlCache`/`hijackedSockets` | `serve()`/`proxyWebSocket()`/`destroyHijackedSockets()` | ✅ Wave 2 |
| `WebTokenAuth.ts` | `applyTokenPolicy`、`computeTokenExpiresAt`、`refreshTokenRuntime`、`setTokenPolicy`、`rotateToken`、`isAuthorized`、`safeTokenEqual`、`authToken`/`tokenGeneratedAt`/`tokenExpiresInMs` | `WebTokenAuth` 状态机类 + `persistToken`/`onChange` 回调 | ✅ Wave 3 |
| `WebStateEventHub.ts` | `handleStateEvents`、`scheduleStatePush`、`pushStateSnapshot`、`stateEventClients`/`statePushTimer`/`lastStatePushJson`/`stateTickTimer` | `handle()`/`schedule()`/`push()`/`dispose()`/`startTick()` | ✅ Wave 4 |
| `WebSessionStream.ts` | `handleStream`、`writeStreamError` | `openSessionStream(router, sessionId, request, response, options)` / `writeSessionStreamError(response, errorText)` | ✅ Wave 6 |
| `WebApiRoutes.ts` | `handleRequest` 中全部 `/api/*` 业务分支（projects/sessions/messages/prompt/export/`/api/chat`/dsh/runtime）+ `extractChatImages` + `CHAT_IMAGE_MAX_*` | `handle(url, request, response): Promise<boolean>`，port 注入 12 个宿主能力 | ✅ Wave 5（原计划的三个 routes 模块合并为一个，保持原路由顺序即优先级） |
| `WebServiceManager.ts` | 生命周期（applySettings/restart/start/stop/getStatus）、HTTP server 装配、顶层路由分派（OPTIONS/health/鉴权/events/工作区兜底）、`getState`、`normalizeWebHost`、port 适配器 | 对外 API 不变（`main/index.ts` 只拿 `WebServiceManager`） | 收口 551 行 |

## 接线点（不可破坏）

1. `src/main/index.ts:4853` `new WebServiceManager({...58 个 deps})` —— deps 契约一字不改。
2. `main/index.ts:442` 只 import `WebServiceManager`。
3. `manager` 的其他被调用面：`workspaceRoutes` 属性注入（`WebWorkspaceRoutes`）、`applySettings`/`restart`/`stop`/`getStatus`/`setTokenPolicy`/`rotateToken`。
4. 测试直接访问的运行时面（private 仅 TS 层）：`manager.current.token`、`manager.start(...)`、`manager.getState()` —— 拆完后必须仍可用。
5. 远程访问 `remoteAccess/RemoteAccessManager.ts` 反向依赖 manager 的 `getPort`/`stop` 语义，不迁。

## 受影响测试（源码契约改读新模块）

| 测试 | 断言锚点 | 新目标 |
| --- | --- | --- |
| `tests/webServiceHardening.test.mjs` | `sendError` headersSent、`WebInvalidJsonError` 哨兵、`serveRenderer` 前缀边界、内嵌页 `escapeHtml` 插值 | `WebHttpResponders.ts` / `WebStaticAssets.ts` / `webPageTemplate.ts` |
| `tests/webServiceAuth.test.mjs` | `private isAuthorized(` 时序安全块 | `WebTokenAuth.ts`（改成方法签名） |
| `tests/webServiceWebEntry.test.mjs` | `loadWebEntryHtml(webEntry)`、`sendHtml(...)` 调用形状 | `WebStaticAssets.ts` |
| `tests/webServiceDefaultHost.test.mjs` | `normalizeWebHost(` 出现在 manager | 不变（host 归一仍在 manager） |
| `tests/zhTwCopy.test.mjs` | 注入脚本 `replace(/_/g,"-…")`、`hant` | `webPageTemplate.ts` |
| `tests/webEventStream.test.mjs` | `/stream` 端点、协议头、内嵌页渲染脚本 | `WebServiceManager.ts`（注册）+ `WebSessionStream.ts` + `webPageTemplate.ts` |
| `tests/webDshChannelStream.test.mjs` | `bindChannelSource(`/`unbindChannelSource`/`scheduleStatePush` 相邻性 | `WebServiceManager.ts` + `WebStateEventHub.ts` |
| `tests/webServiceSessionRoutes.test.mjs` | `getSessionRuntimeMessages` 零残留 | 不变 |
| `tests/queuedPromptQueue.test.mjs` | `sendJson(response, { result })` / 禁 `sendError(...,409, result.error)` | `WebApiRoutes.ts` |
| 行为测试（auth/bodyLimit/devProxy/stateEvents/dsh/sessionRoutes） | `loadTsCommonJs("src/main/web/WebServiceManager.ts")` | 不变（公共面保持） |

## 合并门禁

- `npm run typecheck` 0 错（唯一语法门禁，测试转译对语法错误容错）。
- 每个 wave 后跑该域针对性测试全绿：`node --test tests/webService*.test.mjs tests/webEventStream.test.mjs tests/webDshChannelStream.test.mjs tests/webSessionRoute.test.mjs tests/queuedPromptQueue.test.mjs tests/zhTwCopy.test.mjs tests/expandedRefBlocks.test.mjs`
- `npx biome format --write` 该目录文件；`wc -l src/main/web/WebServiceManager.ts` 单调下降：2165 → 1518 → 1334 → 1160 → 630 → 551。
  - 收口 551 行，**未压到 ≤400**：剩余内容全是「进程级生命周期门面」（start/stop/applySettings/restart、server 字段、对 6 个协作者的装配与 port 适配）与 44 行的顶层分派。再往下只能把 server/current 所有权挪走，而测试有 36 处直接读 `manager.current`、26 处调 `manager.start`，收益低于回归风险；551 < 600 已满足 `AGENTS.md` 的硬评估线。
- 反例守卫：拆完 grep 确认旧符号在 manager 零残留（除薄包装与 re-export）。

## 落地结果（Wave 1-6 实测）

| 模块 | 行数 | 说明 |
| --- | --- | --- |
| `src/main/web/WebServiceManager.ts` | 551 | 生命周期门面 + 顶层分派 + port 适配 |
| `src/main/web/WebApiRoutes.ts` | 598 | 全部 `/api/*` 业务路由（保持原顺序） |
| `src/main/web/webPageTemplate.ts` | 525 | A1 兜底页模板 |
| `src/main/web/WebStaticAssets.ts` | 210 | 静态产物 / dev 代理 / upgrade 转发 |
| `src/main/web/WebApiRoutes.ts` 依赖的 `WebHttpResponders.ts` | 165 | 无状态响应工具 |
| `src/main/web/WebStateEventHub.ts` | 142 | `/api/events` 快照推送 |
| `src/main/web/WebSessionStream.ts` | 130 | SSE 出口（协议头/心跳/错误收口） |
| `src/main/web/WebTokenAuth.ts` | 116 | 令牌状态机 |

验证：`npm run typecheck` 0 错；16 个相关测试文件 151 pass / 0 fail；`npx biome check` 干净。

### 拆分中发现的坑（给下一个 wave 的提醒）

1. **python 脚本必须先删后算索引**：先切 `extractChatImages`（位于文件前部）再拿早先算好的 `a`/`b` 偏移去切路由块，偏移会整体错位 `dx` 字符，直接把 `handleRequest` 从中间劈开（本次靠对比 `git show HEAD:` 的段落重建修复）。索引只在**当次字符串**上算，或切完重算。
2. doc 注释用 `rfind("/**")` 定位会留下只剩 tab 的空行，落盘后需 `re.sub(r"
[ 	]+
","
",s)` 跑两遍再 `re.sub(r"
{3,}","

",s)`。
3. 源码契约测试的断言跟着符号搬家走：`streamMatch` → WebApiRoutes，SSE 头 → WebSessionStream，`sendJson(response,{result})` → WebApiRoutes，模板脚本 → webPageTemplate，`rendererRootPrefix` → WebStaticAssets。
