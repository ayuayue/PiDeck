# DSH 后端接入复核：我们怎么接的、有没有更好的方法、还缺什么

> 触发问题：① PiDeck 引用 DSH 作为后端具体怎么做的？有没有更好的方法？② 我们和官方 dsh-web 是否
> 「只有前端不一样」，DSH 的特性我们具备没有？③ 0.1.5 大改版后官方给开发者留了什么新接口，
> 能否复用户 `~/.dsh` 里已有的东西？
>
> 依据：`src/main/dsh/**`、`scripts/dump-typert-endpoints.mjs` 的实跑输出（84 端点）、
> `scripts/check-dsh-wire-shapes.mjs`、`node_modules/@deepseek-ai/**` 实装包源码（0.1.5-rc.1）。
> 配套：`docs/dsh-native-plugin-parity-plan.md`（插件能力对齐计划）、`docs/dsh-compat-gap-analysis.md`。

**状态：复核结论（未实施）。** 其中 §6 的两条「变简单」建议会改动既有实现，需评审后执行。

---

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| 怎么接的 | 官方 **Typert Remote / Connection RPC** 契约 + PiDeck 自实现的**载体**（utilityProcess + MessagePort fetch 桥）。传输选型是官方明确背书的形态，不是绕路 |
| 有没有更好的方法 | 传输层没有更好的；**但有三个地方我们现在做得比需要的复杂**：两个自建桥在 0.1.5 之后已冗余、载荷契约缺少漂移门禁、官方客户端 caller 被我们手写重实现 |
| 「只差前端」 | 约 90% 成立。剩下的 10% 不是视觉差异而是**能力结构差异**：官方前端内含一个**客户端插件运行时**（`window.__ModuleLoader__` + `__DSH_BOOT__` + `dsh-client-ui-*` roster），PiDeck 的前端是静态 React，因此 Client 半区插件、官方 UI 贡献点我们结构性缺失 |
| DSH 特性具备没有 | 会话/工具/审批/计划/目标/子代理/技能/模型/配置/凭据/用量/归档等**主链路齐全**；**7 个官方 host 行我们没挂**（见 §7），其中 message-feedback、workspace-files、session-reference、session-log-download 有真实用户可见差异 |
| 0.1.5 新接口 | 有，而且是实质性的：**Typert 描述符 + 自动注册**（挂载即注册，84 个端点可枚举）+ `agentId` 作用域线格式 + 19 个转发事件白名单 + `ClientTransportHooks` 官方扩展点 |
| 复用 `~/.dsh` | 配置/凭据/会话/预设**已共享**（默认 `~/.dsh`，与 dsh CLI 同一个家）；**profiles 未共享**（用户用 dsh CLI 装的插件 PiDeck 看不到）；且主进程存在**重复解析**（settings.yaml / .credentials.yaml）应改为走 host RPC |

---

## 2. 我们现在到底怎么接的

```
┌─ PiDeck 主进程 ────────────────────────────────────────────────┐
│ DshHost          生命周期/懒启动/argv/锁/归档/配置读           │
│ DshHostProcess   utilityProcess.fork(hostEntry) + 桥帧收发     │
│ DshApiClient     连接层：POST /api/<endpoint> 信封 + stream 帧 │
│ DshRemoteClient  适配层：27 个端点的领域方法（旧 apiproxy 签名）│
│ DshAgentManager  会话/回合/事件投影/迟到流治理/审批提问        │
└───────────────┬────────────────────────────────────────────────┘
                │ MessagePort 帧（dshHostBridge 协议：fetch-request/response/chunk/end/error/abort + stream-*）
┌───────────────▼────────────────────────────────────────────────┐
│ hostEntry（Electron utilityProcess 内）                        │
│  boot() 自组组合 = dsh-base 补丁 + PiDeck overlay + home 用户层 │
│  ctx.connection.createSharedFetchHandler('/api')  ← 官方 RPC 半│
│  ctx.typertGateway.wireStream.open(...)          ← 官方流半    │
│  /pideck-plugin/rpc、/pideck-command/rpc          ← PiDeck 自建│
└────────────────────────────────────────────────────────────────┘
```

要点：

- **我们实现的是「载体」，不是「协议」**。协议（信封、流、事件瀑布、错误码）全部照官方 wire 走，
  `DshApiClient` 只把 `RpcFetch = (input: URL, init: RequestInit) => Promise<Response>` 换成
  MessagePort 帧。官方在 `dsh-client-connection/client` 里对这类宿主的原话是
  "owns a different physical transport 的 shell" 提供 fetch + openStream 两个 half —— 我们正是这个形态。
- **组合是自组的**：`patches = loadOverlayPatches(base) + PiDeck 自有行 + `$DSH_HOME/cordis.patch.yml``，
  组合文件落在 `<runtime>/pideck-host/cordis.yml`（`hostCompositionPath` 的 appRoot 硬约束，
  为了让 `dsh-agent-presets` 的 `packageInstalled` 沿 `ctx.baseUrl` 找到 node_modules）。
  官方则是 profile 目录（`$DSH_HOME/profiles/<name>/`）。**这是 npm 插件装不进来的根因**。
- **三处 PiDeck 自建 host 侧插件**（不在官方组合里）：
  `pideck-directory-picker`（无原生目录选择器的 stub）、`pideck-slash-bridge`（在 `agent/pre-step` 拦截以 `/` 开头的用户消息并交给 `ctx.commands.execute`）、
  `pideck-minimal-tool-filter`（minimal 预设剔除 PiDeck 全局扩展），外加两座 RPC 桥
  （`pideck-plugin-bridge`、`pideck-command-bridge`）。

---

## 3. 与官方 dsh-web 的真实差异（不止前端）

| 维度 | 官方 web | PiDeck | 性质 |
|---|---|---|---|
| 传输 | HTTP + WebSocket（`dsh-host-webserver`） | utilityProcess + MessagePort | **等价**（官方设计为可替换载体，无端口、无网络面，反而更收敛） |
| 部署形态 | profile（bundle 栈 + 两锚解析） | 自组 patch 列表 + 单锚点 | **能力差异**（插件生态） |
| 前端 | 客户端插件运行时：`window.__ModuleLoader__` / `window.__DSH_BOOT__`，`dsh.client` roster + `dsh-client-ui-*` | 静态 React（自己实现全部视图） | **能力差异**（Client 半区插件、官方 UI 贡献点） |
| host 行集 | base + web-app 23 个额外行 | base + PiDeck 选定行（**缺 7 个**，见 §7） | **能力差异**（部分特性缺） |
| 会话身份 | host 会话即身份 | catalog 映射（`dshSessionId` ↔ PiDeck sessionId） | 实现差异（为多后端/多项目服务） |
| 视图投影 | 消费 host 的 view/projection 部件 | 自己重建轨迹/上下文估算/工具卡 | 实现差异（复刻成本已付，行为需持续对齐） |

所以「只有前端不一样」的准确说法是：**协议与 Agent 能力一样，前端不一样，而前端不一样又导致
一部分后端能力用不上**（Client 半区、UI 贡献点），另外组合选行不同又少了 7 个 host 行。

---

## 4. 有没有更好的方法（候选评估）

| 候选 | 证据/代价 | 判断 |
|---|---|---|
| **A. 维持现状**（自组组合 + 自建桥 + 载体桥） | 已跑通全部主链路；缺 npm 插件与 7 个 host 行 | **保留为基线**，但按 §6 做减法 |
| **B. 迁到官方 profile 形态**（自组 → profile） | 官方 `initProfile`/`loadProfileDirectory`/`healProfilesModuleFallback` 全套可用；代价是换 host 地基 | **做**（插件计划 Phase 2）；这是 npm 插件与本地 bundle 插件唯一正解 |
| **C. 改用官方 SDK / ACP（stdio JSON-RPC）** | `dsh-sdk-protocol` 全集 = 3 个 request（`initialize` / `session/prompt` / `shutdown`）+ 4 个 notification（`session.event`/`session.status`/`subagent.started`/`subagent.finished`）；**无** 会话列表、历史分页、模型目录、settings/credentials、目标/技能/子代理目录、**无 abort/cancel**、无审批提问应答 | **否决**。它是「自动化驱动」薄协议（配 `dsh-headless` 场景），能力面远小于我们已用的 84 端点 Connection RPC。换成它 = 功能倒退 |
| **D. 主进程内嵌 boot（不 fork utilityProcess）** | 少一层进程与桥；但插件/renderer 崩溃会带走主进程，且失去限次重启 | **否决**（既有决策，安全与稳定性） |
| **E. 起 `dsh web` 子进程，PiDeck 当浏览器客户端** | 多一个端口/进程，需要 `dsh` CLI 在用户机器上，退化回「依赖用户自装」 | **否决**（深融合路线的初衷即此） |
| **F. 挂 `webserver` + 官方客户端运行时，渲染层加载 `dsh-client-modules`** | Electron 渲染进程是 Chromium，技术上可装载官方 client 模块（CJS factory + `__DSH_BOOT__`）；换来 Client 半区插件与官方 UI 贡献点。代价：等于把前端让给官方（S6 已以「绑定 client runtime、无法服务 pi 会话」为由否决）；且渲染层要新增一条到 host 的通道 | **暂缓**，列为唯一能补齐「Client 半区」的路线，需单独立项评估 |
| **G. 复用官方 caller `createWebConnectionRpc(doFetch, openStream)`** | 官方客户端半区是**浏览器模块**（`lib/client.js` 首行 `window.__ModuleLoader__.load({...})`），主进程不能直接 import；但它是纯 CJS factory，可用 ~10 行 shim（伪造 `window.__ModuleLoader__`）取出 `factory(require)` | **可选**：能删掉我们手写的关联/信封校验；风险是依赖官方内部打包形状（非公开契约）。`docs` 记为「值得验证的减法」 |

---

## 5. 0.1.5 之后官方给开发者的新接口（实证）

1. **Typert 描述符 + 自动注册**：`dsh-typert-loader` 的契约是
   "every package that mounts in a Loader composition automatically contributes its generated Typert reflection
   and schemas to the runtime registry"。即**挂载即注册**，包内 `lib/typert.host.js` 导出 descriptor 数组
   （`id/service/namespace/method/invocation/parameters[{name,wire,scope}]`）。
   跑 `node scripts/dump-typert-endpoints.mjs` 得到 **84 个端点**（我们已用 27 个）。
2. **`agentId` 作用域线格式**：参数可以声明 `wire: "agentId"`（如 `commands/list`、`dynamicCordisRunner/stopFromPanel`、
   `goals/get`），客户端只传 id 字符串，宿主侧解析成 live Agent —— **不再需要自建桥替我们做 `ctx.agents.get()`**。
3. **RPC 端点域已覆盖插件与命令**：`pluginInventory/list`、`dynamicCordisRunner/{inventory,runHostHalf,stopFromPanel,undefineFromPanel,...}`、
   `commands/{list,execute}`、`directoryPicker/{pick,list,createDirectory}`、`messageFeedback/{list,put,delete}`、
   `fileReferences/list`、`workspaceFiles/{list,read,readAll,readBytes,stat,changes,readRelated}`、`fileUploads/upload`、
   `sessionFeedback/record`、`goals/*`、`subagents/{list,prompt,interruptByParent}`、`skills/list`、`session/{updateQueue,control}`。
4. **19 个转发事件白名单**（`API_REMOTE_FORWARDED_EVENTS`）：含 `approval/request` 与 `user-questions/request`
   （waterfall）以及 `cordis/*`（插件面板手势）、`settings/document-updated`、`api-session/*` 等 —— PiDeck 的审批/提问桥走的正是这两条 waterfall。
5. **`ClientTransportHooks { fetch: RpcFetch; openStream?: RpcStreamOpen }`**：官方对「自带物理载体的宿主」的正式扩展点。
6. **客户端模块装载契约**：`window.__ModuleLoader__.load({id, factory})` + `window.__DSH_BOOT__`（`dsh-client-modules` 解析）。
   这是 Client 半区能力的唯一入口 —— 也是我们结构性缺失的那块。

---

## 6. 由 §5 推出的三条「可以做减法」

| # | 现状 | 依据 | 建议 |
|---|---|---|---|
| **S1** | `pideck-command-bridge`（`/pideck-command/rpc` 枚举 `ctx.commands.list`） | `commands` 行**由 dsh-base 自带**（`dsh-base/cordis.patch.yml:286`），端点 `commands/list` 已随挂载自动注册 | **删除该桥**，改用 `DshApiClient.call("commands/list", {agent: sessionId})` |
| **S2** | `pideck-plugin-bridge`（`/pideck-plugin/rpc`：install/run/stop/uninstall/staticInventory） | `plugin-inventory` 与 `cordis-host-runner` 是 PiDeck 自己挂的行 → `pluginInventory/list`、`dynamicCordisRunner/*` 端点已注册 | **删除该桥**，改用官方端点；`mergeStaticPluginViews` 这类展示归并留在渲染层 |
| **S3** | `pideck-slash-bridge`（`agent/pre-step` 拦截 `/` 消息） | `commands/execute` 是官方端点（dsh-web 就是客户端直接调它） | 评估后**用端点替代桥**：PiDeck 侧判断 `/` 命令 → 调 `commands/execute` → 不再发 prompt。少一个 host 插件，且命令语义与官方一致 |

> 注意：S1–S3 属于**行为可感知**的改动（命令执行的时序、失败提示、审批语义），需配 e2e 回归后再删桥。
> `pideck-directory-picker`（stub）与 `pideck-minimal-tool-filter` 无官方等价物，保留。

---

## 7. 能力缺口清单（官方 host 行未挂载）

`dsh-web-app` 相对 `dsh-base` 多挂 23 行（`ui-*` 与 web 载体除外）。PiDeck 已挂其中 13 行；**未挂**：

| 行 id | 包 | 影响的端点 | 用户可见后果 |
|---|---|---|---|
| `message-feedback` | dsh-message-feedback | `messageFeedback/{list,put,delete}` | 助手消息的 👍/👎 反馈（官方有，PiDeck 无） |
| `workspace-files` | dsh-api-workspace-files | `workspaceFiles/{list,read,readAll,readBytes,stat,changes,readRelated}` | 官方文件树/预览走 host 投影（PiDeck 自己读盘，能力等价但行为可能漂移） |
| `session-reference` + `file-reference-local` | dsh-session-reference / dsh-file-reference-local | `fileReferences/list`、`sessionReferenceResolver/candidates` | `@` 引用候选由 host 计算（PiDeck 自建引用，等价实现） |
| `session-turn-outline` | dsh-session-turn-outline | `session/turnOutline`（投影） | 官方轮次大纲（PiDeck 自建 turn 逻辑） |
| `session-log-download` | dsh-session-log-export | host GET 路由（会话日志 ZIP） | 「导出会话日志」入口（G10 的一个选项） |
| `open-in-app` | dsh-host-open-in-app | — | 官方「在外部应用打开」（PiDeck 有自己的编辑器/系统打开） |
| `code-runtime` | dsh-code-runtime | — | 客户端代码块执行（偏 client 半区） |

另有两项**结构性**缺口（非「忘挂行」）：

- **Client 半区插件**：无客户端运行时 → `dsh.client` 行、插件贡献的 UI、`typert.remote-client.js` 暴露的
  host→client 调用（如 `dynamicCordisRunner/invoke`、`reportRenderFailure`）全部不可达。
- **会话删除语义**：wire 无 `session.delete`（`workspace/archiveSession` 是官方的归档端点，PiDeck 已自建归档，
  可考虑换用它统一语义）。

---

## 8. 复用 `~/.dsh`（用户已有资产）现状

| 资产 | 官方落点 | PiDeck 现状 | 结论 |
|---|---|---|---|
| 配置 | `$DSH_HOME/settings.yaml` | 共享（`DSH_HOME` 默认 `~/.dsh`）+ 走 `settings/*` RPC；**但主进程另有一份行级解析**（`dshDefaultModel.ts`） | 已共享；**建议删掉重复解析**（E13） |
| 凭据 | `$DSH_HOME/.credentials.yaml` | 共享 + `credentials/*` RPC；**主进程另有一份明文解析**（`dshCredentials.ts`） | 同上 |
| 会话 | `$DSH_HOME/sessions/**` | 共享（catalog 只存映射；可导入外部会话） | ✅ |
| Agent 预设 | `$DSH_HOME/.agent-presets`（用户根） | ✅ 同一目录（dsh-web「复制预设」同源） | ✅ |
| Home patch 层 | `$DSH_HOME/cordis.patch.yml` | ✅ 已加载（但**不 watch**，改动需重启 host） | 由插件计划 Phase 1 补齐热应用 |
| **profiles（dsh CLI 装的插件）** | `$DSH_HOME/profiles/<name>/` | ❌ 不读不写 | 需 D1 决策（私有 vs 共享），见插件计划 §6 |
| skills / hooks / MCP / jobs / schedule / webhook | 各插件自动读 | 配置与会话层共享；**UI 呈现**缺（jobs/schedule/webhook/mcp/hooks 无入口） | 属「呈现补齐」，非接入问题 |

---

## 9. 建议优先级

1. **P0：S1/S2 减法**（删两座桥，改走官方端点）——净删代码、降低后续 DSH 升级的维护面，且为插件计划让路。
2. **P1：插件计划 Phase 1（配置热应用）+ 插件计划 Phase 2（profile 化）**——回答「DSH 原生能力」的核心。
3. **P2：补挂 7 个 host 行中真有价值的**（`message-feedback`、`workspace-files`、`session-reference`、
   `session-log-download`），逐行评估是否与 PiDeck 自建实现重复。
4. **P3：删重复解析**（settings/credentials 走 RPC），消除 E13 类格式漂移。
5. **P4（单独立项）**：Client 半区路线评估（候选 F）——唯一能补「插件 UI 贡献点」的路径，代价是把前端让给官方运行时。
6. **P5（可选验证）**：候选 G（shim 官方 caller）与描述符漂移门禁（把 `dump-typert-endpoints.mjs` 的输出
   固化成快照 + 测试，DSH 升级时 diff 出端点增删）。
