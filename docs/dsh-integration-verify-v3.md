# DSH 接入方案核对版 V3（评审对照底稿）

> 状态：**核对完成（2026-09-12）**。用途：两份方案文档（`docs/dsh-backend-integration-review.md`、
> `docs/dsh-native-plugin-parity-plan.md`）逐条对照官方源码后的评审底稿；每条结论带证据行号，可复核。
> **本文件是这组方案的权威入口**：`docs/dsh-embed-research.md`（调研稿）的硬伤已在 §7 完整标注，
> 引用时以本文件为准。
>
> 依据（三方）：
> - 官方实装包 `node_modules/@deepseek-ai/*`（0.1.5-rc.1，PiDeck 锁定版本）；
> - 上游仓库快照 `C:/tmp/pi-github-repos/deepseek-ai/deepseek-harness`（HEAD `c291e79`，2026-09-10，即 rc.2 发布日）；
> - PiDeck `dev` 分支源码（`src/main/dsh/**`、`scripts/**`）。
>
> 复核方法：实跑 `node scripts/dump-typert-endpoints.mjs`、对 22 个 `typert.host.js` 描述符统计
> `namespace/method` 对、对 `dsh-web-app`/`dsh-base` 的 `cordis.patch.yml` 做集合差、逐条核对官方
> `dsh-app-boot` / `dsh` / `profile-boot` 源码行号。

## 0. 结论先行

| 文档 | 总体判定 | 需要修正的地方 |
|---|---|---|
| `dsh-backend-integration-review.md` | **基本属实**。84 端点、19 事件白名单、8 个缺失 host 行、`window.__ModuleLoader__` 首行、重复解析、不 watch——全部复现一致 | 3 处：① "27 个端点"实为 **30**；② `session/turnOutline` 是**投影单元不是端点**；③ "23 行 / 已挂 13"算术自洽性差（缺失行**集合**是对的） |
| `dsh-native-plugin-parity-plan.md` | **源码级属实**。`initProfile` L379、`watchUserPatches` L1109、`healProfilesModuleFallback` L657、`dsh-base/cordis.patch.yml:286`、`shell: win32`、退出码 127、`["]` 只在缺失时写——**连行号都精确命中** | 2 处行号漂移：`hostEntry.ts:112` hmr → 实际 **121**；`PROFILE_TEMPLATES` L331 / `DEFAULT_PROFILE_PATCH_RELOAD` L377 → 实际 **L328 / L359**（文档引的是注释行）。无事实错误 |
| `Downloads/dsh-embed-research.md`（上一份） | 方向属实但引用有硬伤 | 两处不存在文档的路径引用、`ClientTransportHooks` 归因错误、`dsh-host-desktop-carrier` 不在当前 master——见 §7 |

**实施顺序建议不变**：S1/S2 桥减法（低风险）→ P1 配置热应用（低风险）→ P2 profile 化（架构级，需 spike）。
P2 之前必须有 `dsh-plugin-parity-probe`（parity 文档 P0 spike）的结论。

## 1. 勘误表（相对两份源文档）

| # | 出处 | 原文 | 核实结果 | 修正 |
|---|---|---|---|---|
| 1 | review §1 / §5.1 | "PiDeck 手写 **27** 个端点" | `DshRemoteClient` 实际 **30 个 unary**（26 字面量 + 4 个 `goalRefAction` 变量端点）+ 2 条流（`session/follow`、`$events`）+ `$events/result` 瀑布应答 | 见 §2.2 全表；"27" 是把 `rpc.call("` 的**调用次数**（27，含 `session/page` 两处）误当作**唯一端点数** |
| 2 | review §7 | `session-turn-outline` → "`session/turnOutline`（投影）" | `turnOutline` 是**投影单元**：`ctx.sessionProjections.register(turnOutlineProjectionDefinition)`（上游 `packages/session/session-turn-outline/src/index.ts:28`），**84 端点里没有** `session/turnOutline`；它经 `session/control` 流 / 投影 baseline 下发 | 表述改"`turnOutline` 投影单元（非端点）" |
| 3 | review §7 段首 | "dsh-web-app 相对 dsh-base 多挂 **23** 行（ui-* 与 web 载体除外）。已挂其中 **13** 行" | 实际：web-app 94 行 − base 84 行 = 68 行；剔除 ui-*/web 载体/客户端运行时后 **host-ish 22 行**；PiDeck 已挂同 id 官方行 11（其余以自建行实现），未挂 11 中 **8 个是真实功能缺失**、3 个有等价/豁免（directory-picker→stub、locale/resources→浏览器面资源）（review 表列 7 行 = 把 session-reference+file-reference-local 并了一行，缺失集合完全正确） | 数字改 22 / 11 / 8（+3 豁免）；缺失集合不变 |
| 4 | parity §1 | "`hmr` 行显式 `disabled`（`hostEntry.ts:112`）" | `hostEntry.ts:121`：`patches.push({ id: "hmr", disabled: true })`；base 里 hmr 行 `disabled: true`（`dsh-base/cordis.patch.yml:21-26`） | 行号改 121，事实不变 |
| 5 | parity §2.1 | "`PROFILE_TEMPLATES`（L331）… `DEFAULT_PROFILE_PATCH_RELOAD`（L377）" | `PROFILE_TEMPLATES` 实际 **L328**、web=`"live"` 在 **L335**；`DEFAULT_PROFILE_PATCH_RELOAD` 实际 **L359**（L377 是 `initProfile` 的 `@param` 注释行） | 行号修正，事实不变 |
| 6 | parity §8 | "`runtime:pack` 的 `requiredPackages` 补 `cordis-plugin-hmr`、`cordis-plugin-timer`" | `scripts/pack-dsh-runtime.mjs:239` 的 `requiredPackages` 数组确实没有这两包（grep 0 命中）；但 `seedDirs` 覆盖全部 `node_modules/@deepseek-ai/*`，闭包从 `@deepseek-ai/dsh`/`dsh-base` 传递包含 hmr/timer（二者均声明依赖），**产物闭包已含** | 无需改 pack 逻辑；只需同步 `check-dsh-asar.mjs` 的 `REQUIRED`（L44）清单作显式断言 |

## 2. 端点面（唯一权威口径）

### 2.1 官方 84 端点（已复算，可复现）

方法：实跑 `node scripts/dump-typert-endpoints.mjs` → `endpoints: 84`；等价手工口径 =
对 `node_modules/@deepseek-ai/**/typert.host.js`（22 个文件）提取 `namespace:/method:` 对去重。

> 注意：`typert.host.js` 中同一端点可能出现在 host + client 两个 face 的产物里，**必须去重**；
> 按出现次数统计会虚高（如 `dynamicCordisRunner` 24 次出现 → 实际 12 个）。

| 命名空间 | 端点数 | 端点 |
|---|---|---|
| session | 16 | attachment, cancel, canOpenWorkspacePath, control, create, follow, fork, list, modelCatalog, openWorkspacePath, page, prompt, rename, search, selectModel, updateQueue |
| dynamicCordisRunner | 12 | getClientCode, inventory, invoke, reportClientGuardFailure, reportRenderFailure, resolveInspectQuery, resolveRequestRun, runHostHalf, settleUserRun, stopFromPanel, syncInspectManifest, undefineFromPanel |
| goals | 7 | clear, complete, create, edit, get, pause, resume |
| settings | 7 | canOpenAgentPresetDirectory, describe, mutate, openAgentPresetDirectory, openSettingsDocument, replace, update |
| workspace | 7 | archiveSession, create, delete, follow, insertBefore, insertSessionBefore, rename |
| workspaceFiles | 7 | changes, list, read, readAll, readBytes, readRelated, stat |
| agentPresets | 5 | copy, deletePreset, list, read, select |
| directoryPicker | 3 | createDirectory, list, pick |
| credentials | 3 | describe, set, unset |
| llm | 3 | discoverModels, listConfigurableProviders, listProviders |
| messageFeedback | 3 | delete, list, put |
| subagents | 3 | interruptByParent, list, prompt |
| commands | 2 | execute, list |
| fileReferences | 1 | list |
| fileUploads | 1 | upload |
| pluginInventory | 1 | list |
| sessionFeedback | 1 | record |
| sessionReferenceResolver | 1 | candidates |
| skills | 1 | list |
| **合计** | **84** | |

### 2.2 PiDeck 实际使用的端点（30 unary + 2 流 + 1 瀑布应答）

`src/main/dsh/dshRemoteClient.ts` 全量（无遗漏，含变量端点）：

| 端点 | 方法 | 行号 | | 端点 | 方法 | 行号 |
|---|---|---|---|---|---|---|
| session/list | sessionsList | 96 | | settings/describe | settingsDescribe | 458 |
| session/page | sessionsHistory | 113 | | settings/update | settingsUpdate | 462 |
| session/prompt | sessionsPrompt | 143 | | settings/mutate | settingsMutate | 470 |
| session/cancel | sessionsCancel | 157 | | settings/openSettingsDocument | settingsOpenDocument | 478 |
| session/rename | sessionsRename | 161 | | credentials/describe | credentialsDescribe | 482 |
| session/create | sessionsCreate | 170 | | credentials/set | credentialsSet | 486 |
| session/fork | sessionsFork | 181 | | credentials/unset | credentialsUnset | 490 |
| session/attachment | sessionsAttachment | 190 | | llm/listProviders | llmProviders | 494 |
| session/search | sessionsSearch | 196 | | llm/discoverModels | llmDiscoverModels | 504 |
| session/modelCatalog | sessionsModelCatalog | 201 | | agentPresets/list | agentPresetsList | 516 |
| session/selectModel | sessionsSelectModel | 210 | | agentPresets/deletePreset | agentPresetsRemove | 520 |
| goals/create | goalsCreate | 378 | | workspace/create | workspaceCreate | 524 |
| goals/pause | goalsPause | 392 | | subagents/list | subagentsList | 410 |
| goals/resume | goalsResume | 396 | | session/page（复用） | subagentsHistory | 427 |
| goals/complete | goalsComplete | 400 | | skills/list | skillsList | 452 |
| goals/clear | goalsClear | 404 | | | | |

字面量 26 + `goalRefAction` 变量端点 4（`dshRemoteClient.ts:388`，调用点 392/396/400/404）= **30 个 unary**。

流 / 瀑布（`DshApiClient` 侧）：
- `openStream("session/follow", …)` —— `dshRemoteClient.ts:230-231`（会话事件流）；
- `openStream("$events", …)` —— `dshRemoteClient.ts:309`（审批/提问事件瀑布）；
- `POST /api/$events/result` —— `DshApiClient.ts:59`（`REMOTE_EVENT_RESULT_ENDPOINT`，瀑布应答）。

**"27 个端点"的统计偏差**：`rpc.call("` 在 `dshRemoteClient.ts` 出现 27 次**调用**（`session/page` 被
`sessionsHistory` 与 `subagentsHistory` 各用一次），但**唯一字面量端点 26**；加上 `goalRefAction` 的
4 个变量端点（`dshRemoteClient.ts:388`，调用点 392/396/400/404）共 **30 个 unary**。
两份源文档的 "27" 是误把调用次数当端点数；后续引用一律改 30。

## 3. 官方 host 行差集核实

### 3.1 统计口径（复算一致）

- `dsh-web-app/cordis.patch.yml`：94 行（含 `- id:` 顶层与 base 风格 4 空格缩进，按 trim 后 `- id:` 统计）
- `dsh-base/cordis.patch.yml`：84 行
- 差集：web-app 独有 68 行；剔除 `ui-*`（客户端 UI）、`web-*`/`webserver`（web 载体）、
  `client-hmr`/`modules`/`connection`/`cordis-client-runner`（客户端运行时）→ **host-ish 22 行**
- PiDeck 已挂：connection, api-remotes, file-upload, workspace, session-controller, session-stats,
  settings-controller, workspace-controller, plugin-inventory, cordis-host-runner
  （`hostEntry.ts` 行 145-190 区间）+ 2 个**自建等价行**：`agent-presets`（`dshPresetComposition.ts:68`）、
  `subagent-model-selection-settings`（`:90`）、`directory-picker` 用 `pideck-directory-picker` stub 替代
- **缺失：8 个官方 host 行 id**（下面逐行核实）

### 3.2 缺失行逐行核实表

| 行 id（web-app） | 包（已核对） | 官方能力 | 用户可见影响 | PiDeck 现状 |
|---|---|---|---|---|
| message-feedback | `@deepseek-ai/dsh-message-feedback` | 端点 `messageFeedback/{list,put,delete}` | 助手消息 👍/👎 反馈缺失 | 无对应实现 |
| workspace-files | `@deepseek-ai/dsh-api-workspace-files` | 端点 `workspaceFiles/{list,read,readAll,readBytes,stat,changes,readRelated}` | 官方文件树/预览走 host 投影 | PiDeck 自读盘（行为可能漂移） |
| session-reference | `@deepseek-ai/dsh-session-reference` | `sessionReferenceResolver/candidates` + `fileReferences/list`（`@` 引用候选由 host 算） | 自建引用，等价但行为独立 | 自建实现 |
| file-reference-local | `@deepseek-ai/dsh-file-reference-local` | 同上（本地文件引用后端） | 同上 | 同上 |
| session-turn-outline | `@deepseek-ai/dsh-session-turn-outline` | **`turnOutline` 投影单元**（非端点！`ctx.sessionProjections.register`，上游 `session-turn-outline/src/index.ts:28`） | 官方轮次大纲 | 自建 turn 逻辑 |
| session-log-download | `@deepseek-ai/dsh-session-log-export` | host 行：`GET/HEAD /api/session.export` + `/export` 命令（ZIP，上游 README L53/L76） | 官方「下载会话日志」 | 自有导出入口（dshSessionHtmlExport） |
| open-in-app | `@deepseek-ai/dsh-host-open-in-app` | host 行（无端点，服务外部打开） | 「在外部应用打开」 | 自有编辑器/系统打开 |
| code-runtime | `@deepseek-ai/dsh-code-runtime-worker-thread` | host 行（代码块执行，偏 client 半区） | 客户端代码块执行 | 无 |

（每个 id → 包的映射已与 `dsh-web-app/cordis.patch.yml` 逐行核对；上表"影响的端点"列已按 §2.1
修正 `session/turnOutline` 为投影单元。）

**豁免说明**：`locale` / `resources` 在差集里但**不算缺失**——它们是 dsh-web-app 的浏览器面
资源/本地化行，PiDeck 有自己的 i18n 与资源管线，不适用。

### 3.3 与 review 文档数字的差异

review 文档"23 行 / 已挂 13 / 未挂 7 行"：集合正确（7 个表行 = 8 个 id），但分母/已挂数偏一位。
建议评审时引用精确口径：**host-ish 独有 22 行 = 已挂同 id 11 + 未挂 11（真实缺失 8 + 豁免 3）**；
其中豁免 3 = `directory-picker`（PiDeck 用 `pideck-directory-picker` stub 等价替代）、
`locale` / `resources`（浏览器面资源，PiDeck 自有 i18n/资源管线）。

## 4. S1–S3 桥减法核验

| # | 桥（现状） | 官方等价端点 | 核验结果 | 前置 / 风险 |
|---|---|---|---|---|
| S1 | `pideck-command-bridge`（`/pideck-command/rpc`，`pideckCommandsBridge.ts:25`；行 `commands` 由 base 自带，`dsh-base/cordis.patch.yml:286`） | `commands/list`（已注册，§2.1） | **成立**。桥注释自己写明：存在是因为旧 ApiProxy wire 没有命令列表，PiDeck 只有 api-proxy 通道——Typert 迁移后理由消失 | 桥枚举 `ctx.commands.list(agent)` 带 live Agent 上下文，官方端点同样收 `agentId`，语义等价；删前补 e2e 回归 |
| S2 | `pideck-plugin-bridge`（`/pideck-plugin/rpc`，`pideckPluginBridge.ts:31`；服务是 `ctx.dynamicCordisRunner` + `ctx.pluginInventory` 的薄包装，文件头注释自述） | `pluginInventory/list` + `dynamicCordisRunner/{inventory,invoke,runHostHalf,stopFromPanel,undefineFromPanel,settleUserRun,…}` | **成立**。官方端点已含面板手势语义（`stopFromPanel`/`undefineFromPanel`），桥只是把这些服务按 PiDeck 视图重新包装 | 桥另有「按会话归属、面板手势免审批」语义要与官方端点对齐确认；`mergeStaticPluginViews` 展示归并留渲染层 |
| S3 | `pideck-slash-bridge`（`agent/pre-step` 拦截 `/` 消息，`hostEntry.ts:178` 生成的 `pideck-slash-bridge.js`） | `commands/execute`（dsh-web 客户端即直接调它） | **方向上成立**，但改动面最大：涉及命令执行时序、失败提示、审批语义，且 slash 目前不只走官方命令（缓存/提示回退 `DSH_COMMAND_SUGGESTIONS`） | review 文档自己也标注"评估后"；建议放 S1/S2 之后单独做 |

三桥删除的**共同结构性前提**：PiDeck 的 `DshRemoteClient`/`DshApiClient` 已实现官方 Connection wire
（`hostEntry.ts:348` `ctx.connection.createSharedFetchHandler("/api")`），新增端点调用只是加两个方法，
无新传输面。`pideck-directory-picker`（stub）与 `pideck-minimal-tool-filter` **保留**（无官方等价物）。

## 5. P1 配置热应用核验

官方机制（全部源码级确认）：

| 官方实现 | 行号 | 说明 |
|---|---|---|
| `composeLive = () => structuredClone([…bundlePatches, …profile.patches, …homePatches, …overlays])` | `dsh/lib/profile-boot-*.js:305` | 每次重应用前重组分层快照 |
| `if (composed.profile.patchReload === "live" …) { loader.create(timer) ; loader.create(hmr,{config:{root:[]}}) ; watchUserPatches ×2 }` | `profile-boot-*.js:321-337` | **运行时按需挂** hmr，不依赖组合行 |
| `watchUserPatches(ctx,…)` = `hmr.registerConfig(file, () => entry.update({config:{…patches: compose(loadOptionalPatches(file))}}))` | `dsh-app-boot/lib/index.js:1109-1115` | 事务性重应用；坏补丁不砸树 |
| base 里 hmr 行 `disabled: true`（注释：Module reload is opt-in per profile…watch-only fallback） | `dsh-base/cordis.patch.yml:21-26` | **disabled 不妨碍** `loader.create` 方式的热应用 |

PiDeck 改造点（与 parity 文档一致，标注证据）：
1. `hostEntry.ts:121` 的 `{id:"hmr",disabled:true}` **保留**（照 CLI 语义走运行时 create）；
2. boot 后仿 `profile-boot-*.js:321-337`：`loader.create(timer)` + `loader.create(hmr,{root:[]})` + 对
   `$DSH_HOME/cordis.patch.yml` 的 `watchUserPatches`（当前 `hostEntry` 无任何 watch，已确认）；
3. `hmr/config-update-failed` 事件 → 主进程日志 + 渲染层提示。

**runtime 依赖——新证据（修订 parity §8）**：`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-base` 均声明依赖
`cordis-plugin-hmr`、`cordis-plugin-timer`，而 `scripts/pack-dsh-runtime.mjs:179-196` 的 `seedDirs` =
**全部** `node_modules/@deepseek-ai/*`，闭包传递包含 → **已打包产物必然已含这两包**。
所以 P1 **不需要重打 runtime**；只需把 `check-dsh-asar.mjs:44` `REQUIRED` 数组同步补上显式断言。

## 6. P2 profile 化核验

### 6.1 根因（源码确认）

`mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)`（`dsh-app-boot/lib/index.js:1322`）：
`bareModuleBaseUrl` 传入时，裸包名走 `internal.import(specifier, bareModuleBaseUrl, {})`
（L1323-1343）——**父级目录查找被跳过**。这就是"树外插件解析不到"的根因，与 parity §2.3 完全一致。
官方注释原话："optional installed-host base for bare package names; relative names continue to resolve
beside the configuration file"。

### 6.2 官方 API 清单（行号核对）

| API | 行号 | 备注 |
|---|---|---|
| `PROFILE_TEMPLATES`（web=`live`，acp/headless/sdk=`startup`） | L328 / L335-347 | parity 文档引 L331，偏离 3 行 |
| `DEFAULT_PROFILE_PATCH_RELOAD = "live"` | L359 | 文档引 L377（注释行） |
| `initProfile(dir, bundles, patchReload = "live")`：写 `dsh-profile-<name>` package.json + `pnpm-workspace.yaml`（`nodeLinker: hoisted` / `autoInstallPeers: false`） | L379 / L368-369 | **精确命中** |
| `prepareProfile`：每次 boot 重写 `cordis.yml` 空根（防 Loader 写回 bake） | `dsh/lib/profile-boot-*.js:206-209`、`PROFILE_ROOT_CONFIG` L124 | **精确命中**；PiDeck 只在缺失时写（`hostEntry.ts:234` `if (!existsSync(configPath))`）——差距如文档所述 |
| `resolveBundleDir`：installAnchor 优先于 profile 目录 | L826 | **精确命中** |
| `loadProfileDirectory`（应用自有 profile，不出现在 CLI 查找） | L843 | 与 Electron desktop 的用法一致（上游 `apps/desktop-host/src/index.ts` 也走 `loadProfileDirectory` + `boot`） |
| `healProfilesModuleFallback`：`$DSH_HOME/profiles/node_modules` + `withFileLock` + symlink(junction)/ESM proxy（`dsh.moduleFallback.targets`）；非 pkg 环境 `ensureSymlink`，pkg 环境 `ensureModuleProxy` | L657 / L407 / L548 | **精确命中** |
| `watchUserPatches` | L1109 | 见 §5 |
| `reconcilePlugins`（安装态驱动 bundles；非 bundle 依赖告警 "installed as a plain dependency"；pnpm ENOENT → stderr 提示 + `return 127`） | `dsh/lib/plugin-*.js:46-122` | **精确命中**（提示文案与 127 逐字一致） |
| `dsh plugin` = `spawnSync("pnpm", args.map(anchorPathSpec), {cwd: dir, shell: process.platform === "win32"})` | `plugin-*.js:109` | **精确命中** |
| `dsh.moduleFallback` ESM proxy 记录 | app-boot L548-570 | pkg 打包环境专用 |

### 6.3 提议启动序列 ↔ 官方 API 对照

parity §4 的序列（`initProfile` → 重写 `cordis.yml` → `loadProfileDirectory` → `healProfilesModuleFallback`
→ 官方层序 compose → `boot` 不传 `bareModuleBaseUrl` → `enableLivePatchReload`）每一步都能映射到
§6.2 的官方 API，且与官方 desktop host（`apps/desktop-host/src/index.ts`）的装载形态同构。
**唯一未实证点**：Electron utilityProcess（非 `process.pkg`）下 Include 沿 `profiles/node_modules`
junction 解析裸名（parity 风险 S1）——这是 P0 spike 的第一验收项，其余假设（S2 热应用对运行中
agent 的影响、S3 Windows junction 权限、S4 无包管理器降级）均按文档所列实验设计执行即可。

### 6.4 决策 D1–D6 状态

| 决策 | 建议 | 核对状态 |
|---|---|---|
| D1 profiles 根：私有 `.pideck/profiles` vs 共享 | 私有 | 与上游 `healProfilesModuleFallback` 的"按当前安装世代改写 `profiles/node_modules`"语义一致（§6.2），共享根确实会跨安装世代互相 heal 抖动——**建议成立** |
| D2 去掉 `bareModuleBaseUrl` | 去掉 | §6.1 根因确认；但**必须以 spike S1 绿为前提**，否则退到"单锚点 + 绝对路径插件" |
| D3 层序（PiDeck overlay 最高） | 改 | 行为变化真实存在（home 层将不能再覆盖 `pideck-*` 行），需 CHANGELOG + kill switch |
| D4 包管理器 pnpm→npm 探测 + 本地兜底 | 采纳 | 官方就是 pnpm 转发（§6.2），本地安装不依赖包管理器——与 runtime 自包含（pack-dsh-runtime 头部注释）互不冲突 |
| D5 默认 `--ignore-scripts` | 采纳 | 官方 `allowBuilds` 指引存在（plugin-*.js ENOENT 分支的提示文案），有对齐锚点 |
| D6 热应用优先 / 重启兜底 | 采纳 | P1 机制（§5）先行，天然支持 |

## 7. 与 `Downloads/dsh-embed-research.md` 的关系（硬伤归因）

该文档的两处硬伤源于对这两份原始文档的**转写错误**，不是原始文档的问题：

1. **路径引用**：research 文档说"配套：`docs/dsh-backend-integration-review.md`、
   `docs/dsh-native-plugin-parity-plan.md`"——实际这两份在 Downloads（仓库 `docs/` 下不存在，全仓 grep 0 命中
   且 git 历史无该文件名）。review 文档自己引的配套是 `docs/dsh-native-plugin-parity-plan.md` +
   `docs/dsh-compat-gap-analysis.md`，即使入库也应对应 `docs/dsh-*` 系列命名。
2. **`ClientTransportHooks` 归因**：review 文档（§5.5）的正确表述是"官方对**自带物理载体的 shell** 的
   扩展点"，且候选 G 明确说主进程不能直接 import 官方 client（首行 `window.__ModuleLoader__.load`）。
   research 文档把它升格为"0.1.5 给**宿主**的正式扩展点、PiDeck 的 MessagePort 桥正好落在这里"——
   PiDeck 实际用的是 host 半 `createSharedFetchHandler('/api')`（`hostEntry.ts:348`）+ 自写 `DshApiClient`
   （`DshApiClient.ts:59` 起），与 `ClientTransportHooks`（页面全局、client 半）无关。
3. **`dsh-host-desktop-carrier`**：research 文档称"仓库里已有"——当前 master（c291e79）只有
   `apps/desktop-host`（`@deepseek-ai/dsh-desktop-host`）；`packages/host/desktop-carrier` 只出现在
   discussion #4628（2026-08-26，当时 desktop 版本线 0.1.0-rc.12），发布后已重构。该说法只可标注为
   "社区讨论引用的历史形态"。

## 8. 测试与门禁现状

现有（评审时作为回归基线）：
- `tests/dsh*.test.mjs` **47 个** + `tests/pideck*.test.mjs` 2 个（`pideckDshHome`、`pideckPwshPersistent`），
  含 `dshCommandsBridge`、`dshPluginBridge`、`dshSessionBridge`、`dshRemoteClientWire`、`dshHostBridge` 等；
- e2e：`dsh-models` / `dsh-restart` / `dsh-security-plan` / `dsh-title-diag` / `session-manager-dsh-archive`。

parity §8 提案的新测试文件（`dshPatchReload` / `dshProfile` / `dshPluginReconcile` / `dshPluginManager`、
e2e `dsh-plugins.spec.ts` + fixture `dsh-plugin-hello/`）**当前均不存在** → 与两份文档"未实施"状态一致。

门禁（沿用 AGENTS.md）：每阶段 `npm run typecheck` + 针对性单测；S1/S2 删桥需先补 `dshCommandsBridge` /
`dshPluginBridge` 行为等价的端点化单测 + e2e 回归；P2 合并前全量 `npm test` + `npm run runtime:check`。

## 9. 复现命令（任何评审人都可重跑）

```sh
# 1. 84 端点
node scripts/dump-typert-endpoints.mjs                          # endpoints: 84

# 2. PiDeck 端点（注意区分“调用次数”与“唯一端点”）：
grep -c 'rpc.call("' src/main/dsh/dshRemoteClient.ts            # 27 次调用（含 session/page 两处），唯一字面量 26
grep -n 'goalRefAction("' src/main/dsh/dshRemoteClient.ts       # 4 个变量端点（392/396/400/404）
# 唯一 unary = 26 + 4 = 30；两处源文档的 "27" 是误把调用次数当端点数

# 3. 官方 host 行差集（94 − 84 = 68；host-ish 22；缺失 8）
node -e "
const fs=require('fs');
const top=f=>fs.readFileSync('node_modules/@deepseek-ai/'+f+'/cordis.patch.yml','utf8')
  .split('\n').map(l=>l.trim()).filter(l=>l.startsWith('- id: '))
  .map(l=>l.replace(/^- id: /,'').replace(/^[\"']|[\"']$/g,''));
const web=top('dsh-web-app'), baseSet=new Set(top('dsh-base'));
const extra=web.filter(r=>!baseSet.has(r));
const host=extra.filter(r=>!r.startsWith('ui-')&&!r.startsWith('web-')
  &&!['webserver','client-hmr','modules','connection','cordis-client-runner'].includes(r));
const mounted=new Set(['workspace','session-stats','session-controller','settings-controller',
  'workspace-controller','plugin-inventory','cordis-host-runner','file-upload','api-remotes',
  'agent-presets','subagent-model-selection-settings']);
console.log('extra:',extra.length,'host-ish:',host.length,
  '| missing:',host.filter(r=>!mounted.has(r)).join(' '));
"

# 4. 19 事件白名单
node -e "…"   # dsh-api-remotes/lib/index.js:17 起的 API_REMOTE_FORWARDED_EVENTS 数组

# 5. 桥 / 关键行号
grep -n 'PATHS\|SERVICE' src/main/dsh/pideck*Bridge.ts
grep -n 'const ctx = await boot\|createSharedFetchHandler.\|id: "hmr"\|existsSync(configPath)' src/main/dsh/hostEntry.ts
```

上游侧（`C:/tmp/pi-github-repos/deepseek-ai/deepseek-harness`）：
`packages/session/session-turn-outline/src/index.ts:28`、`apps/desktop-host/src/index.ts`（loadProfileDirectory
+ boot + framed pipes）、`docs/api-gateway.md`。注意该克隆是 depth=1，历史类结论以 GitHub discussion/release
API 为准（#4628、`dsh-v0.1.5-rc.1/rc.2` release notes）。