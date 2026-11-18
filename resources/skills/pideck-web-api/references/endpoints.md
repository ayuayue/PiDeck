# 只读端点与全量路由

主干（`SKILL.md`）只写了日常要用的十几条。这里补齐其余端点，以及一张 60 条全量表用于对源码。

**绝大多数返回是 200 加一个对象，错误用 `{"code":"webError.xxx"}` 表达。** 「不可用」常被设计成 200 加空值而不是 5xx，因为前端据此降级而不是弹错——所以看到空数组不等于端点坏了。

## 项目

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/projects` | POST | `{path}` | `{project}` | `path` 必填，缺了 400 `webError.projectPathRequired` |
| `/api/projects/<id>/delete` | POST | — | `{deleted}` | 内置 chat 项目删不掉，返回 400 `webError.chatProjectProtected` |
| `/api/projects/<id>/sessions` | GET | — | `{sessions}` | 该项目下的会话 |
| `/api/projects/<id>/sessions/catalog` | GET | — | `{sessions}` | 目录侧的投影，与上面不是同一份 |

## 智能体、模型、用量

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/agents` | GET | — | `{agents}` | 目录未装配时 503 `webError.agentsUnavailable` |
| `/api/agents/<id>/use` | POST | `{projectId}` | `{session, agent}` | 先建草稿再绑人设；绑定失败会把草稿删掉，返回 400 `webError.agentBindFailed` |
| `/api/models` | GET | `?force=1` 绕过缓存 | `{models}` | 每次调用会 fork 一次 `pi --list-models`，别高频调 |
| `/api/usage/<provider>` | GET | `?backend=dsh` | `{result}` | 探针没开时是 `{success:false, disabled:true}`，这是正常态不是故障 |

## 会话内的只读面板

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/sessions/<id>/todo` | GET | — | `{todo}` | 未装配时 503 `webError.stripsUnavailable`；没 todo 时是 `null` |
| `/api/sessions/<id>/subagents` | GET | — | `{subagents}` | 同上 503 |
| `/api/sessions/<id>/search` | GET | `?q=` 上限 256 字 | `{result}` | 索引没就绪、查询为空或超长，一律 `{result:null}`，不报错 |
| `/api/sessions/<id>/stream` | GET | — | SSE | 推该会话的消息帧；不存在的 id 也会先给一帧全局 `event: state` |
| `/api/sessions/<id>/messages` | GET | 不吃 `?before` | `{messages, total, windowStart, truncated}` | 有界窗口 |
| `/api/sessions/<id>/messages/page` | GET | `?pageSize=&before=` | 7 键（`nextBefore` 不为 null）/ 6 键 | 判据只看 `nextBefore` |

## DSH 后端专用

只有 DSH 后端的会话有这些面板数据。**没有活跃 runtime 时返回空集合，不是 404。**

| 端点 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/api/sessions/<id>/dsh/subagents` | GET | — | `{subagents: []}` |
| `/api/sessions/<id>/dsh/subagents/<childId>/history` | GET | `?beforeSeq=&maxMessages=` | `{messages, hasMore}` |
| `/api/sessions/<id>/dsh/skills` | GET | — | `{skills: []}` |
| `/api/sessions/<id>/dsh/goal` | GET | — | `{goal}`，没有就是 `null` |
| `/api/dsh/plugins` | GET | — | `{dynamic, static}` |
| `/api/dsh/plugins/install` | POST | `{sessionId, ...}` | `{receipt}`；缺 sessionId 返回 400 `webError.pluginInstallRequired` |
| `/api/dsh/plugins/<id>/run` | POST | `{sessionId, packageId}` | `{ok, value}` |
| `/api/dsh/plugins/<id>/stop` | POST | `{sessionId, packageId}` | `{ok, value}` |
| `/api/dsh/plugins/<id>/uninstall` | POST | `{sessionId, packageId}` | `{ok, value}` |

## 全局与杂项

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/health` | GET | — | 200 | 唯一不需要令牌的探活 |
| `/api/state` | GET | 支持 `If-None-Match` | 状态快照 | 未变时回 304；载荷含全部会话投影，500 条约 228 KB |
| `/api/events` | GET | — | SSE `event: state` | 只推全局快照，不推消息文本，没有心跳帧 |
| `/api/chat` | POST | `{id, messages[]}` | SSE | 见主干 3.2 |
| `/api/sessions/<id>/prompt` | POST | `{requestId, message}` | `{result:{accepted}}` | 见主干 3.1 |
| `/api/ui-response` | POST | `{sessionId, requestId, agentId, runtimeGeneration, response}` | `{ok:true}` | 回答目标的 UI 询问。四个字段缺一个就 400；绑定过期是 409 `webError.runtimeTargetRequired` |
| `/api/easytier/config.toml` | GET | — | TOML 文件 | 含网络密钥，所以留在鉴权链内；没生成时 404 `easytier-config-missing` |

## 全量路由台账

60 条路由的精确清单**不在正文里**——它在同目录的 `check-doc-routes.json`，由源码生成。正文再抄一份就是第二真源：改了源码忘了改文档，两份就漂，而且没人知道哪份对。

要看全集：

```bash
node check-doc.mjs --update-routes   # 写操作：从源码重生成台账，并打印这次增删了哪几条
cat check-doc-routes.json            # 或者直接读
```

`--update-routes` 是写操作，rc=0 只表示写成功，不是判据通过。

**这条台账只有一个用途**：源码里少了一条台账里有的路由，说明 PiDeck 改过而这份文档没跟上。源码新增路由只提示不判红——否则每改一次源码都会红，这条判据就没人用了。

判法 `node check-doc.mjs`。它抓不到模板串拼出来的路由（源码用模板拼路径时切不出整条），也不判「文档漏写某条」——那由 5.1/5.2 两张表的行数守卫兜着。

参考：`<id>` 在源码里写的是 `([^/]+)`，不是真的叫 id。

