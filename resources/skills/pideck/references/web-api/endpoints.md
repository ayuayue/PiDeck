> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

# 其余端点

会话之外还有一批端点，此前没有覆盖：项目、智能体、模型、用量、DSH 面板与插件、全文检索、EasyTier、UI 询问。**它们都是 200 加一个对象，错误用 `{"code":"webError.xxx"}`。** 「不可用」常被设计成 200 加空值而不是 5xx，因为前端据此降级而不是弹错——**看到空数组不等于端点坏了**。

源码位置：这批大多数在 `WebApiReadRoutes.ts`，插件的写操作与 `ui-response`、EasyTier 在 `WebApiSessionRoutes.ts`。以源码为准。

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

## 会话内检索

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/sessions/<id>/search` | GET | `?q=` 上限 256 字 | `{result}` | 索引没就绪、查询为空或超长，一律 `{result:null}`，不报错。这是「可降级」不是故障 |

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

## 杂项

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/health` | GET | — | 200 | 唯一不需要令牌的探活 |
| `/api/ui-response` | POST | `{sessionId, requestId, agentId, runtimeGeneration, response}` | `{ok:true}` | 回答目标的 UI 询问。四个字段缺一个就 400；绑定过期是 409 `webError.runtimeTargetRequired` |
| `/api/easytier/config.toml` | GET | — | TOML 文件 | 含网络密钥，所以留在鉴权链内；没生成时 404 `easytier-config-missing` |

## 口径

- 这份表是**端点清单**，不是行为手册：每条只写形状与一个最容易读错的地方，展开要读源码或对应的那份参考。
- 判据覆盖：`check-paths.mjs` 逐段验这里的 `/api` 路径在源码里存在；`check-fields.mjs` 验反引号里的标识符在源码里出现。**两条都只判「存在」，不判「用法对」**——形状写错它们抓不到。
- 60 条路由的全集台账在 `scripts/skills/pideck/check-doc-routes.json`，由源码生成，不手改。要打印就跑 `node scripts/skills/pideck/check-doc.mjs --update-routes`（写操作，rc=0 只表示写成功）。
