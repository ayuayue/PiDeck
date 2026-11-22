# actions · 运行时动作与记录层（类型版）

> 索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5 `message.md` · §5.6 `collaboration.md` · §6 `restart.md` · §7 本文件 · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余 `endpoints.md`

## 7 动作：运行时 21 个，记录层 8 个

| 套 | 动什么 | 判据 |
| --- | --- | --- |
| 运行时动作（21） | 活着的进程 | `runtimeGeneration` / `isStreaming` 会变 |
| 记录层动作（8） | 会话记录 | 下一次 `/api/state` 能看到；进程不动 |

反例：以为 `update` 换了模型就等于活进程换了模型——它只改记录。

### 7.1 运行时动作：`POST /api/sessions/<id>/runtime/<action>`

| action | 额外 body 字段 | 作用 |
| --- | --- | --- |
| `activate` | 无（body `{}`） | 冷会话拉起进程 |
| `stop` | — | 停进程，记录留着 |
| `abort` | — | 只中止当前回合，进程留着 |
| `restart` | — | 停完接着启；等待期间每 2 秒回一次心跳 |
| `compact` | `prompt?` | 压缩上下文 |
| `state` | — | 读运行时状态 |
| `commands` | — | 列该运行时的命令 |
| `models` | — | 列可用模型 |
| `model` | `provider` `modelId` `modelName?` | 给活着的进程换模型 |
| `thinking` | `level` | 换思考档 |
| `permission` | `preset` | 换权限预设（pi 后端必失败，见下） |
| `edit-message` | `messageId` `newText` | 改历史里某条消息 |
| `delete-message` | `messageId` | 删历史里某条消息 |
| `prepare-resend` | `messageId` | 准备重发 |
| `clone` | — | 克隆运行时 |
| `fork` | `entryId` `mutationFork?` `branchMode?` | 从某一轮分叉出新会话 |
| `get-fork-messages` | — | 分叉点候选消息 |
| `rewind-list` | `limit?` `beforeTimestamp?` | 检查点列表，可翻页 |
| `rewind-diff` | `checkpointId` | 某检查点改了什么 |
| `rewind-restore` | `checkpointId` `scope` | 回滚到某检查点 |
| `export-html` | — | 导出成 HTML |

`activate` 是唯一不要 target 的（它要做的正是「这个冷会话现在起来」）。其余 20 个都要 `body.target.sessionId` 与路径 id 完全相同，不一致返回 400 `webError.runtimeTargetRequired`。

| 字段 | 谁是闸 | 传错返回 |
| --- | --- | --- |
| `target.agentId` | 所有命令都是真闸 | `SESSION_RUNTIME_UNAVAILABLE`（uuid 不存在，或与路径 sessionId 对不上） |
| `target.runtimeGeneration` | 除 `stop` 外都是真闸 | `SESSION_RUNTIME_CHANGED` |

依据 `runtime/runtimeBinding.ts` 的 `requireBoundTarget`：先核 sessionId/agentId 绑定，再比代号，两步抛不同码。

**`agentId` 随进程换，抓完立刻用。** 隔几分钟拿旧 `agentId` 请求，先撞「绑定对不上」→ `SESSION_RUNTIME_UNAVAILABLE`，看起来像会话没了，其实是身份过期。

`SESSION_RUNTIME_CHANGED` 容易被读成「代号变了」，实际意思是「你传的值不对」——别据此判断会话被重启过。三个字段都传当前值最稳。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

### `state`：唯一能一次问清「它现在在干嘛」

返回套两层：`{result:{ok, value:{target, value:{...}}}}`，字段在里层。

| 字段 | 读出来的意思 |
| --- | --- |
| `modelId` / `provider` / `thinkingLevel` | 此刻实际在用的模型与思考档，不是记录里那份 |
| `isStreaming` / `isTurnActive` | 正在生成 / 有回合没结束 |
| `isExecutingTool` / `isCompacting` | 正在跑工具 / 正在压缩上下文 |
| `contextTokens` / `contextWindow` / `contextPercent` | 上下文用掉多少 |
| `toolStateSequence` | 工具状态序号，只在状态切换时跳变；判断「有没有在动」看两次读是否不同 |

**换模型会把思考档重置成新模型的默认值**：先 `model` 再 `thinking`，反过来等于没设。

**`permission` 在 pi 后端一定失败**：源码只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`。改 pi 会话权限走记录层 `update` 或界面。

**鉴权规则**：写操作（POST）只认请求头。`?token=` 只对 GET 与 SSE 开放（浏览器 EventSource 不能自定义头）；写操作开这个口子会把令牌漏进代理日志与浏览器历史。

### 7.2 记录层动作：改记录，不碰进程

| 端点 | 方法 | body / 查询 | 作用 |
| --- | --- | --- | --- |
| `/api/sessions` | POST | `projectId`（必填）`title` `model` `welcomeModel` `thinkingLevel` `backend` `agentPreset` `acpToolId` `sideTask` | 建草稿，返回 `{session}` |
| `/api/sessions/anonymous` | POST | `projectId` `title` `backend` `model` `thinkingLevel` | 不写会话文件的一次性运行时 |
| `/api/sessions/<id>/update` | POST | `title` `model` `thinkingLevel` `permissionPreset` `agentPreset` `backend` `acpToolId` `proxy` `sideTask` | 改会话记录 |
| `/api/sessions/<id>/delete` | POST | — | 删记录 |
| `/api/sessions/<id>/copy` | POST | — | 复制 |
| `/api/sessions/<id>/export-html` | GET | — | 导出 |
| `/api/sessions/<id>/reference-messages` | GET | — | 取被引用的消息 |
| `/api/sessions/<id>/security-level` | POST | `levelId`（字符串或 `null`） | 换安全等级，`null` = 跟全局默认 |

`update` 把 `model`/`thinkingLevel` 传 `null` = 清掉覆盖回到默认。改标题立刻生效（下一次 `/api/state` 可见）；改模型对活进程不起作用。

**首条消息会改写标题**：第一轮对话结束后 pi 的命名扩展用模型重新起标题（`titleOrigin` 记录谁取的）。**认会话只认 id**。

**删除 ≠ 停进程**：`delete` 删记录，界面条目要到下一次状态推送才消失，偶尔几秒残影。

`check-doc.mjs` 同时比路径与方法：抓「源码里没有这条完整路由」与「方法列写错」。模板串拼出的路由切不出整条时会在边界截出残缺串（裸 `/api`、通配 `/api/*`、带中文标点的注释片段），这些不进台账，`--update-routes` 跳过并打印条数。判据只保证「台账里有的路由源码里还在」。

## 规则（依赖类型理论：四件缺一不算规则）

| # | 命题 | 引入（命令 → 期望） | 消去（第二入口） | 反例 |
| --- | --- | --- | --- | --- |
| A1 | 运行时动作改的是活进程，记录层动作只改记录 | POST 某个 runtime 动作后读 `/api/state` → `runtimeGeneration` 变大 | 读 `/api/sessions/runtimes` 里同一会话的 `agentId` → 同时变 | 以为记录层 `update` 换了模型就等于活进程换了模型 |
| A2 | `activate` 是唯一不要 target 的动作 | POST `runtime/activate` 不带 target → `ok:true` | 带一个与路径不一致的 target → 400 | 给 activate 硬塞 `target.sessionId` |
| A3 | 其余动作的 target 必须与路径 id 相同 | 路径写 A、body 写 B → 400 | 换成同一个值 → 非 400 | 只改一处就发出去 |
| A4 | 写操作只认请求头，`?token=` 只对 GET/SSE 开放 | POST 带 `?token=` → 401 | 同一请求改成 `Authorization` 头 → 非 401 | 把令牌放 query 发 POST，漏进代理日志 |
