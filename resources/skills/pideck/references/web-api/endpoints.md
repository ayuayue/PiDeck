# endpoints · 其余端点（类型版）

> 索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5 `message.md` · §5.6 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 本文件

## 0 类型

`Γ ⊢ 调用成功 : 200 × 对象`。失败形状是 `{"code":"webError.xxx"}`。
**「不可用」常被设计成 200 加空值而不是 5xx**，因为前端据此降级而不是弹错——**看到空数组不等于端点坏了**。

源码：会话在 `WebApiReadRoutes.ts`；插件写操作、`ui-response`、EasyTier 在 `WebApiSessionRoutes.ts`；文件与 git 在 `WebWorkspaceRoutes.ts`；提示词模板在 `WebPromptTemplateRoutes.ts`。最后两份挂在 `startup/webService.ts`，**不以 `WebApi` 开头**，按前缀扫源码会长期漏掉它们。

## 1 项目

| 端点 | 方法 | 参数 | 返回 | 反例（错误码） |
| --- | --- | --- | --- | --- |
| `/api/projects` | POST | `{path}` | `{project}` | 缺 `path` → 400 `projectPathRequired` |
| `/api/projects/<id>/delete` | POST | — | `{deleted}` | 内置 chat 项目 → 400 `chatProjectProtected` |
| `/api/projects/<id>/sessions` | GET | — | `{sessions}` | — |
| `/api/projects/<id>/sessions/catalog` | GET | — | `{sessions}` | 与上行不是同一份投影，混用即错 |

## 2 智能体、模型、用量

| 端点 | 方法 | 参数 | 返回 | 反例 |
| --- | --- | --- | --- | --- |
| `/api/agents` | GET | — | `{agents}` | 目录未装配 → 503 `agentsUnavailable` |
| `/api/agents/<id>/use` | POST | `{projectId}` | `{session, agent}` | 绑定失败 → 草稿已删 + 400 `agentBindFailed` |
| `/api/models` | GET | `?force=1` 绕过缓存 | `{models}` | 高频调用——每次 fork 一次 `pi --list-models` |
| `/api/usage/<provider>` | GET | `?backend=dsh` | `{result}` | 探针没开时 `{success:false, disabled:true}` 是正常态，不是故障 |

## 3 会话内检索

| 端点 | 方法 | 参数 | 返回 | 反例 |
| --- | --- | --- | --- | --- |
| `/api/sessions/<id>/search` | GET | `?q=` 上限 256 字 | `{result}` | 索引未就绪／空查询／超长 → 一律 `{result:null}`；当成故障重试即错 |

## 4 DSH 后端专用

只有 DSH 后端有这些面板数据。**没有活跃 runtime 时返回空集合，不是 404。**

| 端点 | 方法 | 参数 | 返回 |
| --- | --- | --- | --- |
| `/api/sessions/<id>/dsh/subagents` | GET | — | `{subagents: []}` |
| `/api/sessions/<id>/dsh/subagents/<childId>/history` | GET | `?beforeSeq=&maxMessages=` | `{messages, hasMore}` |
| `/api/sessions/<id>/dsh/skills` | GET | — | `{skills: []}` |
| `/api/sessions/<id>/dsh/goal` | GET | — | `{goal}`，没有则 `null` |
| `/api/dsh/plugins` | GET | — | `{dynamic, static}` |
| `/api/dsh/plugins/install` | POST | `{sessionId, ...}` | `{receipt}`；缺 sessionId → 400 `pluginInstallRequired` |
| `/api/dsh/plugins/<id>/run` | POST | `{sessionId, packageId}` | `{ok, value}` |
| `/api/dsh/plugins/<id>/stop` | POST | `{sessionId, packageId}` | `{ok, value}` |
| `/api/dsh/plugins/<id>/uninstall` | POST | `{sessionId, packageId}` | `{ok, value}` |

## 5 杂项

| 端点 | 方法 | 参数 | 返回 | 反例 |
| --- | --- | --- | --- | --- |
| `/api/health` | GET | — | 200 | 唯一不需要令牌的探活 |
| `/api/ui-response` | POST | `{sessionId, requestId, agentId, runtimeGeneration, response}` | `{ok:true}` | 缺字段 → 400 `requestIdRequired`；绑定过期 → 409 `runtimeTargetRequired` |
| `/api/easytier/config.toml` | GET | — | TOML | 含网络密钥，留在鉴权链内；未生成 → 404 `easytier-config-missing` |

## 6 工作区：文件与 git

五条挂在 `startup/webService.ts` 的 `WebWorkspaceRoutes` 上。

| 端点 | 方法 | 参数 | 返回 | 反例 |
| --- | --- | --- | --- | --- |
| `/api/git/status` | GET | `?projectId=` | `{repo:false}` 或 `{repo:true, branch, groups}` | 非 git 仓库是 200 + `{repo:false}`，**不是错误**；项目不存在 404 `projectNotFound` |
| `/api/git/diff` | GET | `?projectId=&group=&path=` | `{diff}` | `group` 只认 `merge`/`index`/`workingTree`/`untracked`；`path` 绝对路径或含 `..` → 400 `invalidRequest` |
| `/api/git/log` | GET | `?projectId=&limit=` | `{commits}` | `limit` 默认 20、钳 1–50；**缺参数回默认，不钳成 1** |
| `/api/files` | GET | `?projectId=&dir=` | `{nodes}` | 只列一层；`dir` 含 `..` → 400；节点已剥掉宿主绝对路径 |
| `/api/file-content` | GET | `?projectId=&path=`，可带 `sessionId`、`confirm=1` | 见下表 | 三个 403 码各不相同，先看码再决定重试 |

`/api/file-content` 四种 200 是标志，不是错误：

| 情况 | 状态 | body |
| --- | --- | --- |
| 正常文本 | 200 | `{content, size}` |
| 二进制（扩展名黑名单或含 NUL） | 200 | `{binary:true, size}` |
| 超 512KB | 200 | `{truncated:true, content, size}` |
| 超大且拿不到句柄 | 200 | `{tooLarge:true, size}` |
| 项目内越界／相对路径逃逸 | 403 | `fileOutsideProject` |
| 安全策略拒绝 | 403 | `fileAccessDenied` |
| 安全策略要求确认 | 403 | `fileAccessNeedsConfirm` |
| 文件不存在 | 404 | `fileNotFound` |

**`confirm=1` 只能把 `ask` 降为放行，`deny` 永远不降级。** 对被拒路径反复重试不会变可读。

## 7 提示词、模板、技能、扩展

| 端点 | 方法 | 参数 | 返回 | 反例 |
| --- | --- | --- | --- | --- |
| `/api/prompts` | GET | `?search=&category=&page=&pageSize=` | `{categories, prompts, total, page, pageSize}` | 云端库；每条宿主 `path` 被剥掉 |
| `/api/prompts/<slug>` | GET | `?category=` 必填 | `{detail:{...}}` | 缺 `category` → 400；找不到 → 404 `promptNotFound` |
| `/api/prompt-templates` | GET | `?projectId=&search=` | `{templates, globalDir, projectDir}` | 与云端库不是一回事；项目同名覆盖全局 |
| `/api/prompt-templates/<name>` | GET | `?projectId=` | `{detail:{...}}` | 404 `promptNotFound`；超限 413 `fileTooLarge`（全套唯一用 413 的地方） |
| `/api/skills` | GET | — | `{locations, skills}` | 列表剥掉 `path`/`dir` |
| `/api/skills/toggle` | POST | `{name, enabled, sourceId}` | `{skill}` | `sourceId` 只认五个值；找不到 → 404 `skillNotFound` |
| `/api/extensions` | GET | — | `{extensions, conflicts}` | `conflicts` 恒有，可为空数组 |
| `/api/extensions/toggle` | POST | `{source, enabled, scope, path?, projectId?}` | `{ok:true}` | `scope:"project"` 必须带 `projectId`，缺 → 400 |

这几组列表都把宿主绝对路径剥掉了：前端只能用 `name`+`sourceId`（技能）或 `source`+`scope`（扩展）反查。两个 toggle 的 body 字段别扭，原因就在这里。

服务未装配时统一 503，码各不相同：`filesUnavailable`、`gitUnavailable`、`promptsUnavailable`、`promptTemplatesUnavailable`、`skillsUnavailable`、`extensionsUnavailable`。

## 8 错误码（穷举 47 个）

从 `src/main/web/*.ts` 的 `sendError` 逐条抄出。**判据要求全部覆盖，新增码不写会红**——这张表是穷举的，不是节选。

| 状态 | 码 | 出现条件 |
| --- | --- | --- |
| 401 | `webError.unauthorized` | 令牌缺或错；`WebServiceManager.ts:364` |
| 403 | `webError.fileAccessDenied` | 安全策略拒绝该路径；`WebWorkspaceRoutes.ts:358` |
| 403 | `webError.fileAccessNeedsConfirm` | 读该路径需要先确认；`WebWorkspaceRoutes.ts:362` |
| 404 | `webError.fileNotFound` | 工作区文件不存在；`WebWorkspaceRoutes.ts:346` |
| 400 | `webError.invalidRequest` | 参数缺或形状不对；`message` 会说是哪个 |
| 400 | `webError.invalidJson` | 请求体不是合法 JSON |
| 400 | `webError.projectIdRequired` | 该带 `projectId` 却没带 |
| 400 | `webError.projectPathRequired` | 建项目时 `path` 缺 |
| 400 | `webError.requestIdRequired` | `ui-response` 缺 `requestId`/`sessionId` |
| 400 | `webError.messageRequired` | 发消息正文为空 |
| 400 | `webError.chatProjectProtected` | 内置 chat 项目不能删 |
| 400 | `webError.agentBindFailed` | 绑人设失败；草稿已删 |
| 404 | `webError.agentNotFound` | 智能体 id 不存在 |
| 404 | `webError.sessionNotFound` | 会话 id 不存在 |
| 404 | `webError.projectNotFound` | 项目 id 不存在 |
| 404 | `webError.skillNotFound` | 技能名 + `sourceId` 找不到 |
| 404 | `webError.promptNotFound` | 提示词或模板找不到 |
| 404 | `webError.apiNotFound` | 路由没命中——**路径拼错，不是服务坏** |
| 400 | `webError.pluginInstallRequired` | 插件安装缺 `sessionId` |
| 400 | `webError.pluginActionRequired` | 插件动作缺 `packageId` |
| 400 | `webError.pluginUnavailable` | 插件服务没装配 |
| 400 | `webError.pluginInstallFailed` | 装了但失败（**400 不是 500**） |
| 400 | `webError.pluginActionFailed` | 动作失败（同为 400） |
| 400 | `webError.securityLevelInvalid` | 安全等级值不合法 |
| 400 | `webError.securityLevelUnknown` | 等级名认不出 |
| 400 | `webError.securityUnsupportedBackend` | 该后端不支持安全等级 |
| 400 | `webError.securityUpdateFailed` | 写入失败（**400 不是 500**） |
| 409 | `webError.runtimeTargetRequired` | target 绑定过期或不匹配 |
| 413 | `webError.bodyTooLarge` | 请求体超 64KB |
| 413 | `webError.fileTooLarge` | 文件或模板超读取上限 |
| 503 | `webError.agentsUnavailable` | 智能体目录没装配 |
| 503 | `webError.filesUnavailable` | 文件服务没装配 |
| 503 | `webError.gitUnavailable` | git 服务没装配 |
| 503 | `webError.promptsUnavailable` | 云端提示词库没装配 |
| 503 | `webError.promptTemplatesUnavailable` | 模板读取器没装配 |
| 503 | `webError.skillsUnavailable` | 技能服务没装配 |
| 503 | `webError.extensionsUnavailable` | 扩展服务没装配 |
| 503 | `webError.stripsUnavailable` | 子 agent／todo 能力没装配 |
| 503 | `webError.securityUnavailable` | 安全等级服务没装配 |
| 503 | `webError.runtimeUnavailable` | 运行时不可用 |
| 500 | `webError.internal` | 未分类抛错，`message` 是异常原文 |
| 500 | `webError.internalError` | 提示词模板读取失败 |
| 403 | `webError.fileOutsideProject` | 路径超出项目根目录（`WebWorkspaceRoutes.ts:341`） |

**三处反直觉，都是踩过的**：

| 反例 | 正确读法 |
| --- | --- |
| 按码名猜状态（`*NotFound`→404、`*Failed`→500） | 插件与安全等级的 `*Failed` 全是 400（参数问题不是服务问题） |
| 拿 `apiNotFound` 去查服务状态 | 先回头查路径 |
| 以为 401 有多个码 | 只有 `unauthorized` 一个；令牌错／过期／没带都是它，靠 `message` 区分 |

## 9 会 503 的那一对

| 端点 | 能力未装配 | 无活跃 runtime |
| --- | --- | --- |
| `/api/sessions/<id>/subagents` | 503 `stripsUnavailable` | 照常返回 |
| `/api/sessions/<id>/todo` | 503 `stripsUnavailable` | 照常返回 |
| `/api/sessions/<id>/dsh/subagents` | 200 `{subagents: []}` | 200 `{subagents: []}` |

同一个「拿不到」，一组 503、一组空数组。原因在调用方：不带前缀的是桌面 IPC 同源数据（拿不到是装配错误，该报）；带 dsh 的是面板轮询（拿不到只该空着）。**写客户端按上表分流，不要统一按 503 重试。**

## 10 口径

- 这份表是**端点清单**，不是行为手册：每条只写形状 + 一个最容易读错的地方。
- `check-paths.mjs` 验 `/api` 路径在源码里存在；`check-fields.mjs` 验反引号标识符在源码里出现。**两条只判「存在」，不判「用法对」。**
- 60 条路由台账在 `scripts/skills/pideck/check-doc-routes.json`，生成物，不手改。

## 规则（依赖类型理论：四件缺一不算规则）

| # | 命题 | 引入（命令 → 期望） | 消去（第二入口） | 反例 |
| --- | --- | --- | --- | --- |
| E1 | 失败形状是 body 里的 code 字段，不是只看状态码 | 请求一个不存在的 id → body 里有 code | 同码在 `WebI18n.ts` 里能查到 | 只看 HTTP 状态码，不读 body |
| E2 | 「不可用」常被设计成 200 加空值 | 请求未装配的服务 → 200 + 空数组 | 日志里对应一条 warn | 看到空数组就报端点坏了 |
| E3 | 路由文件按后缀 `*Routes.ts` 扫，不按前缀 `WebApi*` | `ls src/main/web/*Routes.ts` → 含非 WebApi 开头那两份 | 台账条数与源码条数相等 → 75 = 75 | 按 `WebApi` 前缀扫，长期漏两份 |
