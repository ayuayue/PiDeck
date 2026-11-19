> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

# 其余端点

会话之外还有一批端点，此前没有覆盖：项目、智能体、模型、用量、DSH 面板与插件、全文检索、EasyTier、UI 询问。**它们都是 200 加一个对象，错误用 `{"code":"webError.xxx"}`。** 「不可用」常被设计成 200 加空值而不是 5xx，因为前端据此降级而不是弹错——**看到空数组不等于端点坏了**。

源码位置：会话相关的在 `WebApiReadRoutes.ts`，插件的写操作与 `ui-response`、EasyTier 在 `WebApiSessionRoutes.ts`，文件和 git 面板在 `WebWorkspaceRoutes.ts`，提示词模板在 `WebPromptTemplateRoutes.ts`。最后两份挂在 `startup/webService.ts`，**不以 `WebApi` 开头**，所以按 `WebApi*` 前缀扫源码的判据长期把它们漏在外面。以源码为准。

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
| `/api/ui-response` | POST | `{sessionId, requestId, agentId, runtimeGeneration, response}` | `{ok:true}` | 回答目标的 UI 询问。四个字段缺一个就 400 `webError.requestIdRequired`；绑定过期是 409 `webError.runtimeTargetRequired` |
| `/api/easytier/config.toml` | GET | — | TOML 文件 | 含网络密钥，所以留在鉴权链内；没生成时 404 `easytier-config-missing` |

## 工作区：文件与 git

这五条挂在 `startup/webService.ts` 的 `WebWorkspaceRoutes` 上，供桌面端文件抽屉与 git 面板用。

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/git/status` | GET | `?projectId=` | `{repo:false}` 或 `{repo:true, branch, groups}` | 不是 git 仓库时 200 加 `{repo:false}`，**不是错误**。项目不存在是 404 `webError.projectNotFound` |
| `/api/git/diff` | GET | `?projectId=&group=&path=` | `{diff}` | `group` 只认 `merge`/`index`/`workingTree`/`untracked`，`path` 必须是仓库内相对路径；绝对路径或含 `..` 一律 400 `webError.invalidRequest` |
| `/api/git/log` | GET | `?projectId=&limit=` | `{commits}` | `limit` 默认 20、钳到 1–50。**参数缺失回默认，不会被钳成 1** |
| `/api/files` | GET | `?projectId=&dir=` | `{nodes}` | 只列一层，节点带 `hasChildren` 供展开；`dir` 含 `..` 是 400。节点只有 `name`/`relativePath`/`type`/`hasChildren`——**宿主绝对路径被剥掉了** |
| `/api/file-content` | GET | `?projectId=&path=`，可带 `sessionId`、`confirm=1` | 见下 | 三个 403 码各不相同，先看码再决定重试 |

`/api/file-content` 的返回不是一个形状，**四条是 200 加标志，不是错误**：

| 情况 | 状态 | body |
|---|---|---|
| 正常文本 | 200 | `{content, size}` |
| 二进制（扩展名黑名单或含 NUL） | 200 | `{binary:true, size}` |
| 超过 512KB | 200 | `{truncated:true, content, size}` |
| 超大且拿不到文件句柄 | 200 | `{tooLarge:true, size}` |
| 项目内越界、相对路径逃逸 | 403 | `webError.fileOutsideProject` |
| 安全策略拒绝 | 403 | `webError.fileAccessDenied` |
| 安全策略要求确认 | 403 | `webError.fileAccessNeedsConfirm` |
| 文件不存在 | 404 | `webError.fileNotFound` |

**`confirm=1` 只能把 `ask` 降为放行，`deny` 永远不降级。** 对着被拒路径反复重试不会变可读——那正是它和 `ask` 的区别。

## 提示词、模板、技能、扩展

| 端点 | 方法 | 参数 | 返回 | 注意 |
|---|---|---|---|---|
| `/api/prompts` | GET | `?search=&category=&page=&pageSize=` | `{categories, prompts, total, page, pageSize}` | 云端提示词库；每条的宿主 `path` 被剥掉 |
| `/api/prompts/<slug>` | GET | `?category=` 必填 | `{detail:{title, description, promptContent}}` | `category` 缺了 400 `webError.invalidRequest`；找不到 404 `webError.promptNotFound` |
| `/api/prompt-templates` | GET | `?projectId=&search=` | `{templates, globalDir, projectDir}` | pi 文件模板，**与上面那个云端库不是一回事**；项目同名模板覆盖全局 |
| `/api/prompt-templates/<name>` | GET | `?projectId=` | `{detail:{name, description, content, scope}}` | 404 `webError.promptNotFound`；超限 413 `webError.fileTooLarge`——**全套路由里唯一用 413 的地方** |
| `/api/skills` | GET | — | `{locations, skills}` | 列表剥掉 `path`/`dir` |
| `/api/skills/toggle` | POST | `{name, enabled, sourceId}` | `{skill}` | `sourceId` 只认 `pi-global`/`agents-global`/`pideck-global`/`project-pi`/`project-agents`；找不到 404 `webError.skillNotFound` |
| `/api/extensions` | GET | — | `{extensions, conflicts}` | `conflicts` 恒有，可能是空数组 |
| `/api/extensions/toggle` | POST | `{source, enabled, scope, path?, projectId?}` | `{ok:true}` | `scope` 只认 `user`/`project`/`unknown`；`scope:"project"` 时**必须**带 `projectId`，缺了 400 |

**这几组列表都把宿主绝对路径剥掉了**，前端拿不到真实路径，只能用 `name` + `sourceId`（技能）或 `source` + `scope`（扩展）反查。两个 toggle 的 body 字段看起来别扭，原因就在这里。

服务未装配时统一 503，但码各不相同：`webError.filesUnavailable`、`webError.gitUnavailable`、`webError.promptsUnavailable`、`webError.promptTemplatesUnavailable`、`webError.skillsUnavailable`、`webError.extensionsUnavailable`。

## 错误码速查

全 43 个，从 `src/main/web/*.ts` 的 `sendError` 逐条抄出。**判据要求全部覆盖，新增码不写会红**——所以这张表是穷举的，不是节选。

| 状态 | 码 | 什么时候出现 |
|---|---|---|
| 400 | `webError.invalidRequest` | 参数缺了或形状不对。最常见的一个，`message` 字段会说是哪个参数 |
| 400 | `webError.invalidJson` | 请求体不是合法 JSON |
| 400 | `webError.projectIdRequired` | 该带 `projectId` 却没带 |
| 400 | `webError.projectPathRequired` | 建项目时 `path` 缺了 |
| 400 | `webError.requestIdRequired` | `ui-response` 缺 `requestId`/`sessionId` |
| 400 | `webError.messageRequired` | 发消息时正文是空的 |
| 400 | `webError.chatProjectProtected` | 内置 chat 项目不能删 |
| 400 | `webError.agentBindFailed` | 绑人设失败；`/api/agents/<id>/use` 会把已建好的草稿删掉再返回这个 |
| 404 | `webError.agentNotFound` | 智能体 id 不存在 |
| 404 | `webError.sessionNotFound` | 会话 id 不存在 |
| 404 | `webError.projectNotFound` | 项目 id 不存在。文件和 git 面板大量用它 |
| 404 | `webError.skillNotFound` | 技能名 + `sourceId` 组合找不到 |
| 404 | `webError.promptNotFound` | 提示词或提示词模板找不到 |
| 404 | `webError.apiNotFound` | 路由没命中。**看到它说明是路径拼错了，不是服务坏了** |
| 400 | `webError.pluginInstallRequired` | 插件安装缺 `sessionId` |
| 400 | `webError.pluginActionRequired` | 插件动作缺 `packageId` 之类 |
| 400 | `webError.pluginUnavailable` | 插件服务没装配 |
| 400 | `webError.pluginInstallFailed` | 装了但失败了。**注意是 400 不是 500** |
| 400 | `webError.pluginActionFailed` | 动作执行失败。同样是 400 |
| 400 | `webError.securityLevelInvalid` | 安全等级值不合法 |
| 400 | `webError.securityLevelUnknown` | 等级名认不出 |
| 400 | `webError.securityUnsupportedBackend` | 该后端不支持安全等级 |
| 400 | `webError.securityUpdateFailed` | 写入失败。**400 不是 500** |
| 409 | `webError.runtimeTargetRequired` | `target` 绑定过期或不匹配，要重新读运行时再发一次 |
| 413 | `webError.bodyTooLarge` | 请求体超过 64KB |
| 413 | `webError.fileTooLarge` | 文件或模板超过读取上限 |
| 503 | `webError.agentsUnavailable` | 智能体目录没装配 |
| 503 | `webError.filesUnavailable` | 文件服务没装配 |
| 503 | `webError.gitUnavailable` | git 服务没装配 |
| 503 | `webError.promptsUnavailable` | 云端提示词库没装配 |
| 503 | `webError.promptTemplatesUnavailable` | pi 模板读取器没装配 |
| 503 | `webError.skillsUnavailable` | 技能服务没装配 |
| 503 | `webError.extensionsUnavailable` | 扩展服务没装配 |
| 503 | `webError.stripsUnavailable` | 子 agent / todo 能力没装配 |
| 503 | `webError.securityUnavailable` | 安全等级服务没装配 |
| 503 | `webError.runtimeUnavailable` | 运行时不可用 |
| 500 | `webError.internal` | 未分类的抛错，`message` 是异常原文 |
| 500 | `webError.internalError` | 提示词模板读取失败 |

**三处反直觉的地方，都是踩过的：**

- **码名带 NotFound 的不都配 404**，码名带 Failed 的不都配 500——插件与安全等级的 `*Failed` 全是 400，因为那是参数问题不是服务问题。按码名猜状态会猜错。
- **`webError.apiNotFound` 是路径拼错的信号。** 拿到它先回头查路径，不要去查服务状态。
- **401 只有 `webError.unauthorized` 一个。** 令牌错、令牌过期、令牌没带，都是它，用 `message` 区分。

## 会 503 的那一对

上游 `read.md` 用 curl 列出 `/subagents` 与 `/todo`，但没写它们会 503。**它们和 `/dsh/` 前缀下的同名端点不是一回事：**

| 端点 | 能力未装配时 | 无活跃 runtime 时 |
|---|---|---|
| `/api/sessions/<id>/subagents` | 503 `webError.stripsUnavailable` | 照常返回 |
| `/api/sessions/<id>/todo` | 503 `webError.stripsUnavailable` | 照常返回 |
| `/api/sessions/<id>/dsh/subagents` | 200 `{subagents: []}` | 200 `{subagents: []}` |

同一个「拿不到」，一组回 503、一组回空数组。**原因是调用方不同**：不带前缀的是桌面 IPC 同源数据，拿不到就是装配错误，该报；带 dsh 的是面板轮询，拿不到只该让面板空着。写客户端时按上表分流，别统一按 503 重试。

## 口径

- 这份表是**端点清单**，不是行为手册：每条只写形状与一个最容易读错的地方，展开要读源码或对应的那份参考。
- 判据覆盖：`check-paths.mjs` 逐段验这里的 `/api` 路径在源码里存在；`check-fields.mjs` 验反引号里的标识符在源码里出现。**两条都只判「存在」，不判「用法对」**——形状写错它们抓不到。
- 60 条路由的全集台账在 `scripts/skills/pideck/check-doc-routes.json`，由源码生成，不手改。要打印就跑 `node scripts/skills/pideck/check-doc.mjs --update-routes`（写操作，rc=0 只表示写成功）。
