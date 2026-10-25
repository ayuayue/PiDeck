# PiDeck MCP 服务（API v1）

PiDeck 可作为本机 MCP 服务，向 pi 和其他兼容客户端开放**明确授权项目的会话数据与定时任务**，以及**宿主自身的配置摘要、内置扩展加载状态、智能体目录元信息与本机收藏**（后几项不属于任何项目）。读取默认可全量开放；写能力必须由用户逐项单独开启：中止正在生成响应的会话、管理智能体（创建/编辑/删除/绑定会话）、管理定时任务（创建/编辑/删除/立即运行/中止）、管理收藏（新增/删除，含任意文本）。它与宿主插件共用会话读取实现，但有独立的授权和生命周期，不借用插件身份、不启动 pi 会话；关掉写开关时对应工具**不注册**，客户端连看都看不到。

智能体的**角色设定（systemPrompt）只写不读**：创建/编辑工具可以写入它，但任何工具（包括 `agents_list` / `agents_get`）都不会返回它，也不开放模型调用——外部客户端只能按 id 使用智能体，角色设定始终留在 PiDeck 主进程内解析。

服务已列入 PiDeck 的 MCP 推荐服务目录，**首次使用默认关闭**：不监听端口、不创建令牌、不自动改写 pi 的 `mcp.json`。这里的“公共服务”指公开的调用接口，不是公网服务。

## 启用与接入

1. 在 PiDeck 的 MCP 配置页，选择推荐服务中的 **PiDeck（本地 MCP 服务）**。
2. 勾选允许读取的项目（列表上方有“全选 / 全不选”，只作用于当前列表），或勾选 **“所有项目（含今后新建）”** 改用通配授权，然后点击“授权并启用本地服务”。授权不跟随当前选中的项目或标签变化：默认是显式白名单，**不会自动覆盖今后新建的项目**，新增项目后需重新进本页勾选并应用；勾选通配后才对今后新建的项目自动生效（新增项目不必再进本页，令牌也就不会因此轮换）。两种模式互斥：勾了通配就不再按项目列表展开。
3. 按需开启写能力（默认全部关闭，对应工具都不会出现在工具列表里）：
   - 勾选“允许停止正在生成的响应” → 注册 `sessions_abort`；
   - 勾选“允许创建/编辑/删除智能体并绑定会话” → 注册 `agents_create` / `agents_update` / `agents_delete` / `agents_bind_session`（角色设定只写不读）；
   - 勾选“允许创建/编辑/删除定时任务、立即运行与中止” → 注册 `automation_task_create` / `automation_task_update` / `automation_task_delete` / `automation_task_run_now` / `automation_run_abort`（立即运行会真实启动会话并消耗模型额度）；
   - 勾选“允许新增/删除本机收藏（含任意文本）” → 注册 `favorites_add` / `favorites_remove`（收藏列表 `favorites_list` / `favorites_get` 始终可用）。
4. 接入 pi：点击“添加到当前 pi 配置（禁用）”。仅新增 `pideck` 条目，保留其他服务和配置；已存在本地或继承的同名条目时不覆盖。随后界面会直接落到该条目页：在「连接与认证」里点「启用」（与下方「启用」开关等价），由 **pi 原生 MCP 客户端**建立连接；新建或重启会话后生效。
5. 接入其他客户端：点击“复制连接配置”，按客户端要求填写 **Streamable HTTP URL** 和 `Authorization` 请求头。`enabled`、`exposure` 是 pi 配置项，其他客户端可能不接受它们。

导出结构示例（端口与令牌必须使用应用生成的值）：

```json
{
  "mcpServers": {
    "pideck": {
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "enabled": false,
      "exposure": "codemode"
    }
  }
}
```

- 授权后，服务会随 PiDeck 启动恢复，端口与令牌保持不变。退出 PiDeck 后服务不可用。
- 修改授权项目、切换通配、开关写能力或重新启用都会更新令牌，旧令牌立即失效。需重新复制连接配置，手动更新已有客户端配置。
- 通配授权在**请求时求值**：项目列表增加会立即变为可读，项目从工作区移除会立即失效，两者都不需要重新应用，也不必更新客户端配置。
- “关闭服务并撤销令牌”会关闭监听和在途连接，并持久化关闭状态。只禁用 pi 的客户端条目**不等于**关闭 PiDeck 服务，其他持有令牌的客户端仍可访问。
- 端口占用时不会自动切换到新端口或降级为无认证服务，界面显示 `listen-failed`；可关闭服务撤销已保存的授权。配置写入失败时当前监听停止，但保存的授权可能仍存在，解决磁盘问题后应重试关闭。
- 此入口只在本地桌面主窗口可管理，Web/LAN 界面和插件 guest 无权启用或导出凭据。WSL、容器、远程客户端不保证能访问宿主 `127.0.0.1`；服务不自动扩大监听地址。

## 数据与权限边界

**任何持有令牌的客户端都能读取全部已授权项目中的可见会话，包括今后新增的会话。** 不是“仅授权当前一条会话”，也不是逐客户端授权。勾选通配时“已授权项目”等于工作区里的全部项目，且今后新建的项目自动进入范围——这个开关的授权面会随时间自己变大。会话正文可能包含密钥、路径、个人信息，客户端还可能把数据发送给模型；只授权必要项目，不分享或提交连接配置。

- 服务仅绑定 IPv4 `127.0.0.1`，强制 Bearer 令牌；校验精确 Host，拒绝带 `Origin` 的浏览器请求，不提供 CORS 或 Cookie 认证。
- 只接收 `/mcp` 上的 POST，使用无状态 Streamable HTTP（JSON 响应）；握手、工具发现和 JSON-RPC 由官方 MCP SDK 处理。
- 项目只输出 `id`、`name`；会话元信息不暴露磁盘文件名。历史投影去掉 `cwd`、`parentSession`、`sessionFile`、`filePath` 字段与图片块中的二进制/引用，但**不是通用脱敏器**，不会清洗用户文字、工具结果中嵌入的秘密或路径。
- 项目删除、会话归属改变或撤权后拒绝继续访问；异步历史读取返回前再次校验授权。fork 祖先沿用宿主插件的同项目校验，不合并其他项目的源文件。
- 服务自身不执行终端命令、不读任意路径、不修改会话内容、不访问网络、不读取插件私有存储。没有启用服务、扩大权限或导出令牌的 MCP 工具；写能力只有用户显式开启的三类：中止正在运行的会话、管理智能体（含会话绑定）、管理本机收藏（新增/删除），且写工具在开关关闭时都不注册。
- 收藏工具（读 + 可选写）：收藏是本机快照，读接口只返回**未关联项目**或**已授权项目**的条目，避免借收藏绕过项目授权；`favorites_add` 可保存任意文本（不要求会话），`sessionId`/`projectId` 只是可选来源链接——关联会话找不到时仍保存成功，`sessionTitle` 为 `null`，界面显示「无关联会话」。
- `settings_get` / `extensions_list` / `agents_list` / `agents_get` 描述宿主自身，**不受项目白名单影响**（设置、内置扩展与智能体目录不属于任何项目）：只要服务处于授权状态就能读。它们只输出 `src/main/mcp/piDeckMcpViews.ts` 里的显式允许清单——不含令牌、代理 URL（可能带凭据）、pi/DSH/git 等可执行文件路径、自定义镜像地址、`acpTools` 环境变量、用户自写文本（快速消息）与任何插件私有存储；设置页/智能体新增字段默认不可见。它们也不跑 `pi` 进程、不扫扩展目录、不访问网络，只读保存的设置快照、内置清单常量与智能体元信息。
- 智能体写能力（默认关）的边界：可创建/编辑/删除智能体、把**已授权项目**的会话绑定到智能体；角色设定只写不读；不开放模型调用（不产生 token 成本）、不读任意文件、不改会话正文与绑定表之外的设置。内置智能体一律不可删除。
- 定时任务工具（读 + 可选写）按项目授权：`automation_tasks_*` / `automation_runs_*` 的每个请求都先校验 `projectId`，任务不存在与不属于该项目统一返回 `automation-task-not-found`；任务提示词只在 `automation_tasks_get` 的详情里返回（项目范围内可见），列表不含。写能力可创建/编辑/删除任务、立即运行（会真实启动会话、消耗模型额度）与中止运行；删任务保留运行历史。
- 返回的是保存的历史条目投影，不是模型请求上下文重建。历史中的用户文字、工具输出等均为不可信数据，不应当作客户端的新指令。对 `context_edit`、compaction 等条目的解释不能等同于“这是模型当前收到的消息”。

授权文件位于应用 `userData/pideck-mcp.json`，与 pi 客户端配置独立。文件仅由 `src/main/config/piDeckMcpConfig.ts` 读写，原子替换；POSIX 权限为 `0600`，Windows 依赖用户数据目录 ACL。损坏、格式不匹配或超过 256 KiB 时拒绝启动，不在读取阶段覆盖原文件。令牌不进入状态快照或日志。

## 工具契约

只读工具带 `readOnlyHint: true`、`destructiveHint: false`；`sessions_abort` 标 `readOnlyHint: false`（客户端据此决定要不要弹确认），但同样不是破坏性操作。所有工具带 `idempotentHint: true`、`openWorldHint: false`。项目和会话 ID 必须来自列表结果，不能传文件路径代替；对象入参拒绝未声明字段。

`settings_get` 与 `extensions_list` 是**宿主级**工具：不接收 `projectId`，也不受项目白名单影响，只要求服务处于授权状态。`extensions_list.builtIn[].enabled` 表示“按当前设置是否会通过 `-e` 注入 pi 进程”（含用户移除与 opt-in 判定，与 `listActiveBuiltInExtensionPaths` 同口径），但**不检查扩展文件是否实际存在**；`injectionDisabled`（`piRpcNoExtensions`）为真时整批内置扩展都不注入，此时 `enabled` 只是配置状态而非生效状态。

成功同时返回 MCP `content`（JSON 文本）和 `structuredContent`：

```json
{ "apiVersion": 1, "data": "<各工具的返回值>" }
```

| 工具 | 参数 | `data` |
| --- | --- | --- |
| `agents_list` | 无；`arguments` 可省略或传 `{}` | `[{ id, name, description, icon, category, builtin, model, backend, usageCount, lastUsedAt, createdAt, updatedAt }]`；宿主级，**不含 systemPrompt** |
| `agents_get` | `agentId` | 单个智能体元信息（同上；不存在返回 `agent-not-found`） |
| `agents_create` | `name`、`systemPrompt`（只写），可选 `description` / `icon` / `category` / `model` / `backend` | 新建后的元信息；**只在智能体写开关打开时注册** |
| `agents_update` | `agentId` + 任意可改字段（含只写的 `systemPrompt`）；`model: null` / `backend: null` 表示清除 | 更新后的元信息；空 patch 返回 `agent-patch-empty` |
| `agents_delete` | `agentId` | `{ agentId, deleted: true }`；内置智能体返回 `agent-not-deletable`；删除会像界面一样清掉该智能体的划词默认值与会话绑定 |
| `agents_bind_session` | `projectId`、`sessionId`、`agentId`（`null` = 解绑） | `{ projectId, sessionId, agentId }`；会话必须属于已授权项目（否则 `session-not-authorized`），不回显绑定表 |
| `automation_tasks_list` | `projectId` | `{ tasks: [{ id, name, projectId, schedule, enabled, backend, model, thinkingLevel, mode, permissionPreset, budget, createdAt, updatedAt, lastScheduledAt, nextRunAt }] }`；**不含 prompt** |
| `automation_tasks_get` | `projectId`、`taskId` | 任务详情（元信息 + `prompt`）；不存在或不属于该项目返回 `automation-task-not-found` |
| `automation_runs_list` | `projectId`，可选 `taskId`、`limit`（默认 20，1–100） | `{ runs: [{ id, taskId, taskName, trigger, status, scheduledFor, sessionId, queuedAt, startedAt, endedAt, durationMs, inputTokens, outputTokens, costUsd, stepCount, changedFiles, error, skippedReason, budgetReason }] }`；按排队时间倒序，`error` 截断到 2000 字符 |
| `automation_task_create` | `projectId`、`name`、`prompt`、`schedule`（`{type:"cron", expression}` 或 `{type:"manual"}`），可选 `enabled` / `backend`（`pi`/`dsh`）/ `model` / `thinkingLevel` / `mode`（`normal`/`plan`/`goal`）/ `permissionPreset` / `budget` | 创建后的任务详情；**只在定时任务写开关打开时注册**。`budget` 省略时用默认上限（30 分钟 / 20 万 tokens / 2 美元 / 200 步），字段传 `null` = 不限 |
| `automation_task_update` | `taskId` + 任意可改字段（不能改 projectId）；`budget` 按字段合并、`null` 解除该上限；空 patch 返回 `automation-patch-empty` | 更新后的任务详情 |
| `automation_task_delete` | `taskId` | `{ taskId, deleted: true }`；运行历史保留 |
| `automation_task_run_now` | `taskId` | 一次运行的结果投影（status 通常为 `queued`）；会真实启动会话并消耗模型额度 |
| `automation_run_abort` | `runId` | `{ runId, aborted }`；已结束的运行返回 `aborted:false` |
| `favorites_list` | 可选 `kind`（`message`/`selection`）、`query`、`limit`（默认 50，1–200） | 收藏快照数组（按收藏时间倒序）；只含未关联项目或已授权项目的条目，关联会话失效时 `sessionTitle` 为 `null` |
| `favorites_get` | `favoriteId` | 单条收藏快照；不存在或不可见返回 `favorite-not-found` |
| `favorites_add` | `text`（任意文本，必填），可选 `kind` / `role` / `sessionId` / `projectId` / `messageId` / `model` / `partial` | 新建的收藏快照；**只在收藏写开关打开时注册**。`projectId` 必须在授权范围内；关联会话找不到时仍保存，`sessionTitle=null` |
| `favorites_remove` | `favoriteId` | `{ favoriteId, deleted: true }`；不可见/不存在返回 `favorite-not-found`；**只在收藏写开关打开时注册** |
| `projects_list` | 无；`arguments` 可省略或传 `{}` | `[{ id, name }]`，仅授权项目 |
| `runtime_status` | 无；`arguments` 可省略或传 `{}` | `{ authorizedProjectCount, activeProjectCount, runningCount, runtimes: [{ sessionId, projectId, runtimeGeneration, status, busy, createdAt }] }`；只有活着的运行时，不含路径 |
| `sessions_abort` | `sessionId`，可选 `expectedRuntimeGeneration`（整数 0–1000000） | `{ sessionId, aborted: true }`；**只在写开关打开时注册**，语义等同界面的“停止响应” |
| `settings_get` | 无；`arguments` 可省略或传 `{}` | `{ app, agent, workspace }`，PiDeck 自身配置摘要；宿主未就绪时为 `null` |
| `extensions_list` | 无；`arguments` 可省略或传 `{}` | `{ builtInVersion, injectionDisabled, builtIn, removedBuiltInExtensions, disabledExtensions }`；宿主未就绪时为 `null` |
| `sessions_list` | `projectId`，可选 `offset`（默认 0，整数 0–100000） | `{ sessions, nextOffset }`，每页最多 100 条，按更新时间倒序 |
| `sessions_get` | `projectId`、`sessionId` | 单个会话元信息 |
| `sessions_search` | `projectId`、`query`（1–500 字符），可选 `limit`（默认 20，1–100） | 会话元信息数组；标题的不区分大小写子串搜索，**不是全文搜索** |
| `sessions_entries` | `projectId`、`sessionId`，可选 `cursor` | `{ entries, nextCursor, version, truncated }` |

会话元信息：`id`、`projectId`、`title`、`createdAt`、`updatedAt`、可选 `model`、`readable`。时间戳为毫秒。列表仅包含对应项目中已保存、未被替代的会话；草稿不在列表中。DSH 会话可有元信息，但 `readable: false`，不会通过此接口读取历史。

`runtime_status` 反映**当前活着的运行时**（与 `SessionRuntimeCoordinator` 同口径），不落盘：会话在两次调用之间结束就直接从列表消失，`busy` 表示是否正在生成响应。它用于在 `sessions_abort` 前确认代次，不适合当作历史统计。

`sessions_abort` 是唯一写操作，语义等同界面上的“停止响应”：只中断当前这一轮生成，会话、历史与 pi 进程都保留，之后再发一条消息即可继续。它**不能**停止/重启运行时、改配置或删除数据。两个已知边界：桌面输入框里排队待发的消息不会被取消；MCP 触发的停止**不会**像界面按钮那样抑制排队消息自动续发（两者是不同链路），需要抑制时请在界面上操作。停止按代次校验：传入 `expectedRuntimeGeneration` 后，若期间发生过重启（应用启动时自动重启会话等）会返回 `runtime-changed`，而不是误停新的一轮。

### 历史分页

`sessions_entries` 读取保存文件的活动分支，**先返回最新一页，每页内部按时间顺序**。继续向前读取时把 `nextCursor` 原样传给 `cursor`，不要自行生成：

```json
{
  "projectId": "<PROJECT_ID>",
  "sessionId": "<SESSION_ID>",
  "cursor": { "before": 100, "version": "<OPAQUE_VERSION_FROM_RESPONSE>" }
}
```

- 每页最多 100 条，原始条目读取字节预算 1 MiB，单条最多 256 KiB。
- 超大条目以 `{ id, type, parentId, omitted: "entry-too-large" }` 代替，`truncated: true`。图片载荷不会返回；不要把 `truncated: false` 理解为完全未经投影的原始文件。
- 历史索引预算为含 fork 祖先在内的 **64 MiB / 100000 条**，超限拒绝而不是退化成全量读取。
- `nextCursor: null` 表示没有更早的一页。文件追加或改写会使游标失效，收到 `stale-cursor` / `history-changed` 后从不传游标的新读取开始。
- HTTP 请求体最多 64 KiB，同时最多 4 个请求/读取操作、32 个连接。拒绝批量 JSON-RPC；断开连接不会提前释放仍在读取的 IO 名额，避免不断取消绕过预算。

### 错误处理

领域错误以 `isError: true` 和 `content[0].text` 中的 JSON `{ "code": "..." }` 返回：

| 错误码 | 含义 / 处理 |
| --- | --- |
| `access-revoked` | 服务关闭或本次授权已失效；停止请求并检查授权 |
| `project-not-authorized` | 项目不在授权范围或已移除 |
| `session-not-authorized` | 会话不存在、不属于指定项目或不可见；不泄露其他项目存在性 |
| `history-unavailable` | 无可读保存文件（例如 DSH） |
| `session-not-running` | 该会话当前没有活着的运行时（已结束或从未启动）；先调 `runtime_status` |
| `agent-not-found` | `agentId` 不存在（或已被并发删除）；重新调 `agents_list` |
| `agent-not-deletable` | 目标是内置智能体：只能编辑或恢复内置设定，不能删除 |
| `agent-write-disabled` | 请求期间用户关掉了智能体写开关；写工具已不可用 |
| `agent-patch-empty` | `agents_update` 没有带任何可改字段 |
| `automation-task-not-found` | 任务不存在，或不属于指定项目（不泄露其他项目是否存在） |
| `automation-run-not-found` | 运行记录不存在或不属于已授权项目 |
| `automation-write-disabled` | 请求期间用户关掉了定时任务写开关；写工具已不可用 |
| `automation-patch-empty` | `automation_task_update` 没有带任何可改字段 |
| `automation-invalid-schedule` | cron 表达式非法（五段本地时间；创建/更新前校验） |
| `favorite-not-found` | 收藏不存在，或所属项目未授权（不可见） |
| `favorite-write-disabled` | 请求期间用户关掉了收藏写开关；写工具已不可用 |
| `runtime-changed` | 期间重启过，调用方拿到的代次已失效；重新读取 `runtime_status` 再决定是否中止 |
| `history-too-large` | 超出历史索引预算 |
| `stale-cursor` / `history-changed` | 历史版本变化；丢弃旧游标重新读取 |
| `invalid-offset` | 分页偏移不合法 |
| `operation-failed` | 其他错误；不向客户端返回路径、堆栈或原始异常 |

协议/参数格式错误由 MCP SDK 返回。HTTP 层可能返回 401（凭据无效）、403（Host/Origin 不被允许）、413（请求体超限）、429（并发已满）。关闭/撤权也可能直接断开请求；客户端不能无限立即重试。

## 客户端组合示例

以下代码用于已有 `@modelcontextprotocol/sdk` 的 Node 客户端。URL/令牌从客户端自己的安全配置注入，不能写入仓库；同样不要把读取到的正文直接写进公共日志。

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-pideck-integration", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PIDECK_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.PIDECK_MCP_TOKEN}` } },
  }));
  const result = await client.callTool({ name: "projects_list", arguments: {} });
  if (result.isError) throw new Error("PiDeck tool rejected the request");
  // 使用 result.structuredContent.data 中的项目 ID 调 sessions_list / sessions_entries。
} finally {
  await client.close();
}
```

用户可在客户端构建标题搜索、会话汇总、知识整理等工作流。首版**不动态加载用户自定义服务端代码**；新增内置工具的维护入口是 `src/main/mcp/piDeckMcpTools.ts` 的注册函数，必须复用独立授权、严格参数校验、安全错误和资源预算，并同步 API 文档与针对性测试。新增写能力或权限不是“注册一个工具即可”，必须另行设计授权。

## 实现与验证入口

- `src/main/mcp/PiDeckMcpService.ts`：授权、令牌、启动/关闭与重启恢复。
- `src/main/mcp/PiDeckMcpHttpServer.ts`：回环 HTTP、认证、请求限额。
- `src/main/mcp/piDeckMcpTools.ts`：API v1 工具；会话行为复用 `HostPluginSessions`。
- `src/main/mcp/piDeckMcpViews.ts`：`settings_get` / `extensions_list` 的允许清单投影（纯函数，不产生副作用）。
- `src/main/ipc/piDeckMcpIpc.ts`：只允许桌面主窗口主帧管理。
- `src/renderer/src/config/PiDeckMcpPanel.tsx`、`src/renderer/src/hooks/usePiDeckMcp.ts`：显式授权与敏感配置交接。

```sh
node --test tests/piDeckMcp.test.mjs tests/piDeckMcpHostViews.test.mjs tests/piDeckMcpIpc.test.mjs tests/piDeckMcpUi.test.mjs tests/mcpServiceCatalog.test.mjs
```

测试使用隔离临时目录、真实 MCP SDK 客户端和本机临时端口，不读写用户配置、不调用模型或连接外部服务。
