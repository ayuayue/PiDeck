> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md`

## 7 动作：运行时 21 个，记录层 8 个

两套东西别混：**运行时动作**动的是活着的进程，**记录层动作**只改会话记录。改记录不会让正在跑的进程换模型，停进程也不会删掉记录。

### 7.1 运行时动作：`/api/sessions/<id>/runtime/<action>`

全部 21 个，从源码 `WebApiRuntimeRoutes.ts` 的路由正则逐条抄出：

| action | 额外 body 字段 | 作用 |
|---|---|---|
| `activate` | 无（body 传 `{}`） | 冷会话拉起进程 |
| `stop` | — | 停进程，会话记录留着 |
| `abort` | — | 只中止当前回合，进程留着 |
| `restart` | — | 停完接着启；等待期间每 2 秒回一次心跳 |
| `compact` | `prompt?` | 压缩上下文 |
| `state` | — | 读运行时状态 |
| `commands` | — | 列该运行时的命令 |
| `models` | — | 列可用模型 |
| `model` | `provider` `modelId` `modelName?` | 给活着的进程换模型 |
| `thinking` | `level` | 换思考档 |
| `permission` | `preset` | 换权限预设 |
| `edit-message` | `messageId` `newText` | 改历史里某条消息 |
| `delete-message` | `messageId` | 删历史里某条消息 |
| `prepare-resend` | `messageId` | 准备重发 |
| `clone` | — | 克隆运行时 |
| `fork` | `entryId` `mutationFork?` `branchMode?` | 从某一轮分叉出新会话 |
| `get-fork-messages` | — | 分叉点候选消息 |
| `rewind-list` | `limit?` `beforeTimestamp?` | 检查点列表，可翻页 |
| `rewind-diff` | `checkpointId` | 某个检查点改了什么 |
| `rewind-restore` | `checkpointId` `scope` | 回滚到某检查点 |
| `export-html` | — | 导出成 HTML |

`activate` 是唯一不要 target 的——它要做的正是「这个冷会话现在起来」，没有 target 可回传。其余 20 个都要 `body.target.sessionId` 与路径里的 id 完全相同，不一致返回 400 `webError.runtimeTargetRequired`。

`target.agentId` 在所有命令上都是真闸；`target.runtimeGeneration` 只在非 `stop` 的命令上是真闸（`stop` 用 live 绑定，见本节前面那段）。两个字段被拒时返回的不是同一个码：

`agentId` 给不存在的 uuid，或它与路径里的 sessionId 对不上，返回 `SESSION_RUNTIME_UNAVAILABLE`。`agentId` 对、`runtimeGeneration` 漏传或给错（实测给 999），返回 `SESSION_RUNTIME_CHANGED`。

依据是 `runtime/runtimeBinding.ts` 的 `requireBoundTarget`：它先核对 sessionId 与 agentId 的绑定，再比代号，两步抛的码不同。

**`agentId` 会随进程换，抓完立刻用。** 隔着几分钟拿旧 `agentId` 去请求，先撞的是第一步「绑定对不上」，返回 `SESSION_RUNTIME_UNAVAILABLE`。看起来像会话没了，其实是身份过期。

这两个码里 `SESSION_RUNTIME_CHANGED` 容易被读成「运行时代号变了」，实际意思是「你传的值不对」，别据此判断会话被重启过。三个字段都传当前值最稳，取法见第 6 节第 1 步。


```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

**`state` 是唯一能一次问清「它现在在干嘛」的动作。** 返回体套两层：`{result:{ok, value:{target, value:{...}}}}`，真正的字段在里层：

| 字段 | 读出来的意思 |
|---|---|
| `modelId` / `provider` / `thinkingLevel` | 它此刻实际在用的模型与思考档，不是记录里那份 |
| `isStreaming` / `isTurnActive` | 正在生成 / 有回合没结束 |
| `isExecutingTool` / `isCompacting` | 正在跑工具 / 正在压缩上下文 |
| `contextTokens` / `contextWindow` / `contextPercent` | 上下文用掉多少 |
| `toolStateSequence` | 工具状态序号，只在状态切换时跳变。判断「有没有在动」看两次读是否不同，别拿差值当调用次数 |



**换模型会把思考档重置成新模型的默认值。** 所以先 `model` 再 `thinking`；反过来的话等于没设。

**`permission` 在 pi 后端一定失败**：源码只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`。要改 pi 会话的权限，走记录层的 `update` 或界面。

**鉴权规则**：写操作（POST）只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。


### 7.2 记录层动作：改记录，不碰进程

`check-doc.mjs` 会同时比路径与方法：它抓「源码里没有这条完整路由」和「方法列写错」。源码里用模板串拼出来的路由切不出整条时，正则会在边界上截出残缺串（裸 `/api`、通配 `/api/*`、带中文标点的注释片段）——这些不进台账，`--update-routes` 会跳过它们并打印跳了几条。判据只保证「台账里有的路由，源码里还在」，别指望它替你发现残缺串。

| 端点 | 方法 | body / 查询 | 作用 |
|---|---|---|---|
| `/api/sessions` | POST | `projectId`（必填）`title` `model` `welcomeModel` `thinkingLevel` `backend` `agentPreset` `acpToolId` `sideTask` | 建一份草稿，返回 `{session}` |
| `/api/sessions/anonymous` | POST | `projectId` `title` `backend` `model` `thinkingLevel` | 不写会话文件的一次性运行时 |
| `/api/sessions/<id>/update` | POST | `title` `model` `thinkingLevel` `permissionPreset` `agentPreset` `backend` `acpToolId` `proxy` `sideTask` | 改会话记录 |
| `/api/sessions/<id>/delete` | POST | — | 删记录 |
| `/api/sessions/<id>/copy` | POST | — | 复制 |
| `/api/sessions/<id>/export-html` | GET | — | 导出 |
| `/api/sessions/<id>/reference-messages` | GET | — | 取被引用的消息 |
| `/api/sessions/<id>/security-level` | POST | `levelId`（字符串或 `null`） | 换安全等级，`null` 表示跟全局默认 |

`update` 把 `model` / `thinkingLevel` 传 `null` 当作「清掉覆盖、回到默认」。它**只改记录**：改标题立刻生效（下一次 `/api/state` 就能看到），但改模型对已经活着的进程不起作用，要换活进程的模型得用 7.1 的 `model`。

**首条消息会改写标题。** 新会话建好时标题是你给的那个，第一轮对话结束后 pi 的命名扩展会用模型重新起一个（`titleOrigin` 字段记录「这条标题是谁取的」）。所以拿标题认会话会认错，认会话只认 id。

**删除不等于停进程。** `delete` 删的是记录，界面上那份条目要到下一次状态推送才消失，偶尔会看到几秒残影，刷新即无。
