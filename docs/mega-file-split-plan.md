# 巨文件拆分方案（2026-11）

> 状态：**方案 + Wave 0 门禁已落地**，W1–W11 未开工。基线数据 2026-11-12。
> 前三次拆分（`main-index-split-plan.md` / `app-tsx-split-plan.md` / `agent-manager-split-plan.md`）的波次已并入本文排期，那三份保留作历史勘界图，不再单独排期。
> 门禁：`npm run check:file-size`（`scripts/check-file-size.mjs` + `scripts/fileSizeBaseline.json`）。

## 结论

**能拆，但要按「文件形状」排序，不能按行数排序。** 三个判断：

1. **必须先上机械门禁，否则拆了必回涨**——上一次盘点（2026-10-27，7382 行）到今天 16 天，`main/index.ts` +925 行（7382→8307，同期 156 次提交）、`App.tsx` 3790→4065、`AgentManager.ts` 7139→7304。没有 CI 守卫，任何拆分都会在两周内被回流的新逻辑吃掉。
2. **1:1 转发表和组合根值得拆**：`preload/index.ts`（2157 行 / 81 个命名空间 / 年 509 次提交）、`previewApi.ts`（2409 行 / 年 555 次提交）、`main/index.ts`（8307 行 / 年 776 次提交）是「加任何功能都得碰」的文件，拆完直接减少并行冲突与上下文成本。
3. **大类（状态机）放最后、按需拆**：`AgentManager` / `SessionCatalog` / `SessionRuntimeCoordinator` / `DshAgentManager` 的体量来自共享状态跨几十个方法流动，搬迁的风险（时序、字段所有权、事件重入）明显高于收益，年提交数也只有 `index.ts` 的 1/2–1/8。它们继续按 `architecture.md`「不得净增长」管着，谁改到哪块就拆哪块。

预计总代价：**10–12 个专注会话**（每波独立可验证、可回滚），其中 3 波低风险可并行。

## 现状（2026-11-12）

`src/` 下 2359 个源文件：> 2000 行 18 个、1000–2000 行 25 个、600–1000 行 68 个、400–600 行 129 个。

| 文件 | 行数 | 年提交 | 读它源码的测试 | 形状 |
|---|---:|---:|---:|---|
| `src/main/index.ts` | 8307 | 776 | 120 | 组合根：`whenReady` 装配体 ~2600 + `registerIpc` 1961 + `createWindow` 382 + 单实例 370 |
| `src/main/pi/AgentManager.ts` | 7304 | 386 | 86 | 单类 208 方法：`handlePiEvent` 513、`loadMessages` 258、`upsertToolMessage` 217、`compact` 188 |
| `src/renderer/src/App.tsx` | 4065 | 884 | 118 | 单组件：1–3502 是 213 个 hook 调用与 handler，3503–4065 是 JSX 装配 |
| `src/renderer/src/ConfigModal.tsx` | 3690 | 192 | 27 | 单组件 + 各 Tab 内联表单 |
| `src/main/sessions/SessionCatalog.ts` | 2972 | 96 | 48 | 单类 83 个顶层声明：`assignTitleOrigin` 303、`mergeScanned` 272 |
| `src/main/ipc/sessionIpc.ts` | 2891 | 183 | 49 | 134 个 handler：sessions 69 / dsh 40 / 导入器 20 |
| `src/main/dsh/DshAgentManager.ts` | 2863 | 81 | 13 | 单类 99 方法：`dispatchMuxFrame` 340 |
| `src/renderer/src/hooks/useSessionComposerController.ts` | 2767 | 157 | 32 | 单 hook 巨状态 |
| `src/main/sessions/SessionRuntimeCoordinator.ts` | 2759 | 110 | 20 | 单类 165 个顶层声明：`activate` 167、`sendOnce` 131 |
| `src/main/ipc/systemIpc.ts` | 2722 | 162 | 39 | 130 个 handler：config 42 / app 24 / pi 13 / rpc-logs 9 |
| `src/main/pi/SessionHistoryReader.ts` | 2633 | 52 | 25 | 解析函数群，最大 114 行（本来就不算"巨型单块"） |
| `src/main/sessions/SessionScanner.ts` | 2475 | 84 | 40 | 同上，最大 219 行 |
| `src/renderer/src/previewApi.ts` | 2409 | 555 | 30 | 1:1 转发表的 mock 版：`createPreviewApi()` 一个巨型对象字面量 |
| `src/renderer/src/hooks/useSessionTimelineController.ts` | 2391 | 129 | 25 | 单 hook 巨状态 |
| `src/main/feishu/FeishuBridge.ts` | 2349 | 46 | 9 | 单类，churn 低 |
| `src/main/cloudSync/CloudSyncManager.ts` | 2267 | 16 | 8 | 单类，churn 极低 |
| `src/renderer/src/atoms/session-atoms.ts` | 2213 | 94 | 26 | atom 家族集合 |
| `src/preload/index.ts` | 2157 | 509 | 78 | 1:1 转发表：81 个命名空间 857 处通道引用 |

「读它源码的测试」= `tests/` 里出现该文件名的文件数（多数是 `readFileSync` 后正则断言源码形态）。这一列就是拆分的主要成本，**每波的第一个动作是把它归零，而不是逐文件改断言**（见 §每波固定手法）。

## 为什么前三份计划都回涨

| 计划 | 最低点 | 现在 | 回涨 |
|---|---:|---:|---:|
| `main/index.ts` | 4556（Wave 1 后） | 8307 | +82% |
| `AgentManager.ts` | 5543（Wave 4 后） | 7304 | +32% |
| `App.tsx` | 3092（Wave 3 后） | 4065 | +31% |

三条原因，逐条都有对策，也就是本方案的三个前提：

1. **规则只写在文档里**（`architecture.md`「存量巨文件不得净增长」）→ 没有机械执行点，日常 PR 无人对照 `wc -l`。→ **Wave 0 门禁**：CI 跑 `check:file-size`，改大一行就红。
2. **拆分只做到「大部分」** → 三份计划都留了「Wave 2+（未做）」，剩下的部分继续当垃圾桶。→ 每波写清**目标行数与终止条件**，没达成就不能算完成；`--update` 把额度永久收紧到新值，回涨立刻发现。
3. **契约测试扇出太大**（改一个路径要动 100+ 测试文件）→ 后人为了省事直接把新逻辑写回大文件。→ **聚合读取 helper**：把「读 `src/main/index.ts`」换成「读 `src/main/index.ts + ipc/** + startup/**`」，一次改造，后续每波零测试改动（`tests/helpers/mainIpcSources.mjs` 已验证这个模式可行，目前只有 4 个测试在用）。

## Wave 0：门禁（已完成）

- `scripts/check-file-size.mjs` + `scripts/fileSizeBaseline.json`（hard 111 条、soft 129 条）。
  - 基线内文件**不得净增长**（>基线值即红）；非基线文件 **> 600 行即红**（先写拆分计划）、400–600 行提示一次。
  - `--update` 把额度按「取更小者」收敛，拆完一波立刻锁死。
  - 豁免 `/i18n/`（词典与生成物，见 `architecture.md`）。
- `npm run check:file-size`，已接进 `.github/workflows/ci.yml` 的 `Check structural invariants` 步骤。
- 自检：gate 四类分支（增长 / 新增超线 / 新增提示 / 收紧）在隔离 fixture 上验过；对当前仓库 `rc=0`。

## 波次

排期原则：**低风险、能立刻开工的先做**（当前 `src/main/index.ts`、`src/main/pi/AgentManager.ts`、`src/preload/index.ts` 上有并行未提交改动，动它们会撞车）。

### W1 `previewApi.ts` ✅ 2409 → 38（2026-11-12 完成）

- 落地形态：`src/renderer/src/preview/` 下 15 个域文件（platform/settings/remote/workspace/sessions/sessionSources/git/runtime/app/resources/config/cloudSync/chat/integrations + fixtures），每个导出 `create<i>Preview(): Pick<PiDesktopApi, "…">`；`createPreviewApi()` = 14 个工厂的 spread 组装 + 声明返回类型 `PiDesktopApi`。
- **为什么是工厂而不是模块级 const**：`previewSettings`（settings.update / editors.redetect 会重新赋值）与 `previewImportKinds`（Map）是实例内可变状态，提成模块级 slice 会让同页两个实例互相串；行为零变化优先于「组装层只有 spread」的字面整洁。返回类型约束保留原形态（不加 `as PiDesktopApi`），才能保证 84 个命名空间一个不漏。
- 契约：新增 `tests/helpers/previewApiSources.mjs`，30 个测试改读聚合源码，断言零改动（usageStatsIpcContract / webServiceDefaultHost 需重构读取表，期望值不变）。
- 结果：`previewApi.ts` 38 行，最大域文件 364（sessions.ts）；typecheck 0 error，30/30 绿，已移出基线。

### W2 `preload/index.ts` ✅ 2157 → 56（2026-11-12 完成）

- 15 个域文件在 `src/preload/api/`（sessions 369 / config 255 / platform 207 / integrations 200 / workspace 169 / remote 146 / git 137 / runtime 110 / resources 104 / app 100 / chat 82 / sessionSources 67 / cloudSync 63 / settings 47 / sessionGroups 28），`index.ts` 只剩 import + 15 行 spread + `contextBridge`（含失败上报分支）。
- 类型靠 `typeof api` 派生（`export type PiDesktopApi = Omit<typeof api, "git"> & { git: … }`）：漏一个命名空间 typecheck 直接红，不需要手写 84 条镜像。
- 契约：`tests/helpers/preloadSources.mjs` 聚合 `index.ts` + `api/*.ts`，并把域文件里深一层的 `"../../…"` 归一化成 `"../…"`（源码正则按拆分前的单文件口径断言，拆分不改变断言含义）；77 个测试改读聚合，断言零改动。
- 结果：typecheck 0 error、`check:ipc-wiring` ok（851 通道齐备）、受影响的 159 个测试文件 1433 pass / 0 fail。

### W3 `main/index.ts` 启动装配 ⏳ 8288（2026-11-12 首刀：仅 resourceStores 41 行）

> **实测结论（真实约束，后续波次必须按此执行）**：启动装配体**不能按注释块整块搬**。`whenReady` 体内读写约 150 个模块级 `let` 单例，且赋值与块内语句交错（`appLogger = new AppLogger()` 落在 importers 之后、`settingsStore` 夹在 importers 与 securityStore 之间），闭包还会跨块惰性读（`DirectorySessionImporter.onError` 读 `appLogger?`、`listKnownFilePaths` 读 `sessionCatalog`）。整块剪切必然改变执行时序。
> 真正可搬的先决条件是「accessor 型 `StartupContext`」：把模块级 `let` 收成 `getXxx/setXxx` 访问器对，块内语句才能安全外移。这本身是一波独立工作（牵动 ~150 个 let），不要和搬迁混在一起做。**因此顺序改为：W4（registerIpc）→ W5（createWindow）→ 最后才是 W3 的 accessor 化 + 装配体外移。**

- 首刀已落地：`src/main/startup/resourceStores.ts`（41 行，prompt / skill 两个 store updater + `registerContentStoreIpc`，`StartupContext = { getSettings }`），`index.ts` 8307 → 8288。
- 后续可搬的分块（需先建 accessor context）：`installWindowsPathFresh`、`createServices`（importers / scanner / catalog / coordinator）、`startSidecars`（session-index / file-index / session-store）、`installResourceStores`（extensions 部分）、`installAuthAndEnhance`、`installUsageAndCatalog`、`installWindowsAndTray`、`installBridges`（feishu / wechat / sound / announcements）、`installWebRemoteAccess`。
- 形态：`export async function startXxx(ctx: BootContext): Promise<void>`，`BootContext` 是显式窄接口（只放该步骤真用到的单例），**保持语句原始顺序**，纯搬迁不改逻辑。
- 契约（已完成）：`tests/helpers/mainIpcSources.mjs` 已聚合 `index.ts` + `ipc/**`（递归）+ `startup/**`（递归）；110 个测试改读 `mainIpcSource`，另有 `mainAssemblySource`（不含 `ipc/**`）给 3 条「入口文件不得直接 `ipcMain.handle`」的边界断言用（`gitIpc` / `sessionRuntimeTargetBoundaries` / `remoteChannelGate`，否则聚合会读到 ipc 域自己的 handler）。**之后拆 main/index.ts 不用再动测试。**
- 验证：`typecheck` + `npm run dev` 冷启动冒烟（启动顺序敏感）+ `tests/` 里 index 相关批次全绿。
- 目标：`index.ts` ≤ 5800。

### W4 `main/index.ts` registerIpc ⏳ 8288 → 7308（2026-11-12，6 个 stack 已外移）

- 已落地 `src/main/startup/ipcStacks/`：`agentsStack` 269（usageStats/piAuth/enhance/promptSuggestion/agentProfile/favorites/sessionGroups/linkedSessions/agentInvoke/selectionTool/acp/dataEnv/channelSwitch/automation/editors/backgrounds/wallpaperEngine/themes，20 个注册）、`hostServicesStack` 344（localServices/hostPlugins/piDeckMcp/agentMemory/projects/resourceImport/scratchPad/pasteFiles/noticeHistory/security）、`mediaStack` 294（vision/whisper/voiceTranscription/localImage/imageGen）、`mediaSessionStack` 324（远端会话根/历史/模型目录/归档删除/目录投影/videogen/sessionShareExport）、`systemStack` 357（systemIpc 的 49 项 deps）、`platformStack` 289（store/webRemoteAccess/backup/terminal/files/clipboard/cloudSync/shellMenu）。合计外移 1877 行。
- ctx 形态：窄接口 + `getXxx()` 访问器（`getMainWindow` / `getTray` / `getPetSystem` / `getCuaService` / `getIsQuitting` + `setIsQuitting`），模块级单例仍由 `index.ts` 拥有，未复制第二份。
- **剩余**：`registerIpc` 里 sessions / git / catalog / remote 等注册段仍在内联（约 1000 行），下一刀继续。
- 每个 stack = `registerXxxStack(ctx: IpcStackContext): void`，**只搬不重排**；`index.ts` 留 8 行调用。
- 目标：`index.ts` ≤ 3900（当前 7308；本波未达，见上方剩余项）。

### W5 `main/index.ts` 窗口与生命周期 ⏳ 7308 → 7199（2026-11-12，只搬了托盘）

- 已落地 `src/main/window/tray.ts` 178 行：`setupTray` / `refreshTrayContextMenu` / `checkForUpdatesFromTray` / `notifyFromTray` + `tray` / `trayRegistrationVerify` 实例 + `getTray()`；`TrayDeps` 用 15 个 `getXxx()` 访问器，`markQuitting` 是唯一的写入口（替换原闭包内的 `isQuitting = true`）。
- **卡点（实测）**：`createWindow` / `gotSingleInstanceLock` / focus 家族是**读时闭包**——它们在自己的函数体里惰性读 `mainWindow`、`sessionCatalog`、`agentManager` 等模块级 `let`，外移后要么把整个 `whenReady` 装配体一起搬（见 W3 的结论：必须先 accessor 化），要么给每个读点加访问器；同时 `customTitlebarChrome` / `bootPreferences` / `restartWindowResync` 等契约测试按源码形态扫 `index.ts` 里的建窗块。因此这一波只做了「状态少、写点唯一」的托盘。
- 下一刀的前提：先做 W3 的 accessor 化（把模块级 `let` 收成 `get/set` 访问器对），窗口/单实例/focus 才能整块外移。
- 目标：`index.ts` ≤ 2800（当前 7199）。

### W6 `main/index.ts` 收尾 → 装配层（低风险）

- 剩余模块级 `let`、`sessionMessageSearchInFile`、`replaceAgentSession`、`setupLinkedSessions` 等 helper 下沉到 `src/main/sessions/` 或 `startup/`；`index.ts` 只留 import + `boot()` 主序 + `app.on(...)` 钩子。
- 目标：`index.ts` ≤ 1500（下限 ≈ 800：主进程入口的装配顺序本身就是信息）。

### W7 `App.tsx` JSX 装配 ✅ 4065 → 3461（2026-11-12 完成）

- 落地：`components/workbench/` 4 个组件 —— `WorkbenchShell` 332（FileLinkBaseProvider → AppShell 全 props：simpleShell、compactContent（mini-overlay / quickTask 双分支）、三栏尺寸、drawerRail / drawerFooter / drawerContent、窗控 + children / rootDialogs 槽）、`WorkbenchFileOverlays` 242（文件右键菜单 + ProjectResourcesModal + RenameModals）、`WorkbenchAppOverlays` 301（环境/DSH 引导、远端项目登记、WSL 选择器、SessionActionOverlays、图片预览、代理对话框、11 个 ImportOverlayHost、SelectionToolHost、AskPanel、插件面板、公告历史、外置编辑器）、`WorkbenchDialogs` 54（命令面板 + 数据模式/环境 + CUA 审批）。
- props 按「identity / chrome（list·drawer·panes 三个子桶）/ events / children / rootDialogs」分组传递，子组件只在顶部解构，JSX 体内零改动。
- DOM 零变化核验：把 HEAD 的 3500–4065 段 555 行逐行（trim 后）与新文件做多重集比对，只差 2 行——一处 props 由 `quickTask` 对象改传 `quickTaskActive: quickTask.active`，一处是引用了已删代码的过时注释。
- 契约：`tests/helpers/rendererAppSources.mjs` 聚合 `App.tsx` + `components/workbench/*.tsx`（目录缺失容忍），99 个测试改读聚合，断言零改动。

### W8 `App.tsx` 剩余域 → hooks（中风险）

- 1–3502 区间里还没抽的大块（session 运行控制残块、文件树操作、面板/抽屉接线）按 owner 继续抽 hook；213 个 hook 调用里那批 `useSetAtom×43` 的散装接线最后收成一个装配 hook。
- 目标：`App.tsx` ≤ 1600。

### W9 `AgentManager.ts` ⏳ 7268 → 6625（2026-11-12，两个协作者已落地）

- 已落地：`pi/toolMessageAssembler.ts` 392（`upsertToolMessage` + `upsertAssistantMessage` + `readAskField` + 工具全文 LRU 两字段，宿主接口 12 项；`toolMessageIds` / `messages` / `activeAssistantMessageIds` 因跨域写点留在宿主）、`pi/runtimeHistoryLoader.ts` 420（`tryReadRuntimeTurnPage` + `loadMessages` + `reloadMessagesAfterCompaction` 及其单飞锁，宿主接口 24 项）。
- 契约：`tests/helpers/agentManagerSources.mjs` 聚合宿主 + 两个协作者，55 个测试改读聚合；未迁移的 37 个测试断言都打在留在宿主的代码上，全绿（313 条）。
- 已落地（第三刀）：`pi/compactionRunner.ts` 382（`compact` 180 + 压缩 owner 探测 46 + `routeCompactToOwner` 47 + 命令名列表），宿主接口 22 项；`compact()` 与 `resolveSessionCompactionOwnership()` 保留同名薄包装（后者被测试用实例属性替换，故实现名为 `probeSessionCompactionOwnership`，经宿主回调进入）。
- **剩余**：`create*` / `reattachProcess` / `handlePiEvent`（513）仍然不拆（编排本身，抽出只会得到空转发层）。
- 手法沿用 `agent-manager-split-plan.md` 已验证的四波纪律（协作者不反向 import、依赖构造注入、`clearAgentState` 这类跨域编排留在 Manager）。
- `create*` / `reattachProcess` / `handlePiEvent`（513 行）**不拆**：它们是编排本身，抽出只会得到空转发层。
- 目标：`AgentManager.ts` ≤ 4500（当前 6625，下一刀 `compact`）。

### W10–W11 IPC 巨文件（低-中风险）

落地一律**扁平文件**（`src/main/ipc/` 无子目录，`check-ipc-wiring` 与契约 helper 都按目录递归）：`registerXxxIpc(deps)` 原签名不变，新 registrar 只接窄接口。

- **W11 `systemIpc.ts` ✅ 2722 → 1234（2026-11-12）**：7 个扁平文件（systemPiIpc 273 / systemPiRuntimeIpc 290 / systemAppIpc 359 / systemLogsIpc 141 / systemConfigIpc 284 / systemConfigProviderIpc 248 / systemConfigTokensIpc 225），90 个 handle + 2 个 on 通道纯搬迁；共享闭包 `refreshPiModelCatalogs` 留在原文件回调下发，未复制第二份。36 个契约测试改读 `tests/helpers/systemIpcSources.mjs`。
- **W10 `sessionIpc.ts` ✅ 2891 → 563（2026-11-12）**：两轮共切出 11 个扁平文件 —— `sessionDshIpc` 320 / `sessionDshRuntimeIpc` 172 / `sessionImportersIpc` 336 / `sessionCatalogArchiveIpc` 245 / `sessionHistoryReadIpc` 127 / `sessionListIpc` 307 / `sessionCatalogWriteIpc` 366 / `sessionMessageReadIpc` 355 / `sessionMessageMutationIpc` 119 / `sessionRunIpc` 344 + 共用 `sessionIpcInputGuards` 48；`registerSessionIpc` 签名与 134 个通道的注册顺序不变（用 stub `ipcMain` 实测）。原文件只剩装配与 re-export。契约测试统一读 `tests/helpers/sessionIpcSources.mjs`。

## 每波固定手法（checklist）

每波开始记 `wc -l`，结束必须比开始小，否则这波不算完成。

1. **先降契约成本**：把测试的 `readFileSync("<大文件>")` 换到聚合 helper（新 helper 只列该域的目录，不递归全仓，否则断言会变成"哪都能命中"的噪声）。
2. **整块搬运**：函数/方法体逐字搬，不改名、不改行为、不重排启动语句；原文件留薄包装或注入位。
3. **依赖显式**：新模块只接构造/参数注入的窄接口，**不反向 import 大文件**（`AgentManager` 拆分纪律，`architecture.md` §长期重构纪律）。
4. **验证**：
   ```bash
   npm run typecheck
   node --test tests/<本域相关>.test.mjs        # 不跑全量
   npm run check:ipc-wiring                     # IPC / preload 波次
   npm run check:test-shape
   node scripts/check-file-size.mjs --update    # 收紧额度，锁住成果
   ```
   main 侧波次另加一次冷启动冒烟（`npm run dev` 起窗、开会话、发一条 prompt）。
5. **回填文档**：本文件的波次表勾状态，`architecture.md` 只需要守住行数规则，不复述。

## 不拆 / 缓拆

| 对象 | 决定 | 理由 |
|---|---|---|
| `src/**/i18n/**`（4 × ~8300 行词典） | **不拆** | `architecture.md` 明确豁免；按域拆 4 个 locale 的同步成本翻倍，且文案天然按 key 而非按域演进。合并冲突用「只追加到段尾」约定解决。 |
| `resources/**`、`*.zh-TW.ts`、manifest | **不拆** | 生成物 / 数据表。 |
| `SessionHistoryReader` / `SessionScanner` / `SessionCatalog` / `SessionRuntimeCoordinator` / `DshAgentManager` / `FeishuBridge` / `CloudSyncManager` | **缓拆** | 体量来自「很多 100–300 行的函数」而非单块；churn 低（年 16–110 次）。按需：谁在一个文件里第二次手工拼装同一批状态，才拆那一域。 |
| `ConfigModal.tsx` / `useSessionComposerController.ts` / `session-atoms.ts` | **缓拆** | 组件/hook/atom 已在正确层级，拆开只是搬家；等它们撞上并行冲突再动。 |
| `shared/ipc.ts` / `shared/types/settings.ts` | **不拆** | 纯契约单表；拆开会让「同一契约存在两处」的风险上升，行数由生成/追加纪律控制。 |

## 并行纪律

- 当前工作区已有未提交的远端会话改动，涉及 `src/main/index.ts`、`src/main/pi/AgentManager.ts`、`src/preload/index.ts`、`src/main/sessions/SessionRuntimeCoordinator.ts`。**W3/W4/W5/W9 必须等它落地**；W1（`previewApi.ts`）现在就可以开。
- 两个以上 agent 同时拆时，一个波次一个文件域：W1 与 W2 可并行（不同目录），W3–W6 串行（同一文件）。
- 每波结束按 `AGENTS.md`：列出本波未提交文件与验证结果，等用户决定提交；不清理、不暂存别人的改动。

## 风险与回滚

| 风险 | 触发场景 | 对策 |
|---|---|---|
| 启动时序改变 | W3/W5 搬装配块 | 纯搬运保序；每步只搬一块；冷启动冒烟；出问题单块 revert，不回滚整波 |
| 契约测试大面积变红 | 任一波 | 先换聚合 helper 再搬（顺序颠倒就会 100+ 文件同时红） |
| 新模块反而变大 | 拆出 3 个 500 行文件 | 每波目标行数写死在本文件；`check:file-size` 对新文件 > 600 直接红 |
| 拆完又回涨 | 无门禁 | `check:file-size` + `--update` 收紧（Wave 0 已落地） |
| 并行冲突 | 两 agent 同改大文件 | 见 §并行纪律：按波次分工，同一时刻只有一个写者 |

## 状态

| 波次 | 目标文件 | 现在 | 目标 | 状态 |
|---|---|---:|---:|---|
| W0 | 门禁 | — | `check:file-size` 上线 | ✅ 2026-11-12 |
| W1 | `renderer/src/previewApi.ts` | 2409 | ≤400 | ✅ 38 行 |
| W2 | `preload/index.ts` | 2157 | ≤400 | ✅ 56 行 |
| W3 | `main/index.ts` 启动装配 | 8307 | ≤5800 | ⏳ 8288（只搬了 resourceStores；装配体需先做 accessor 化） |
| W4 | `main/index.ts` registerIpc + 窗口 + 启动装配 | — | ≤3900 | ⏳ 10 个 stack + mainWindow + services/sidecars，index 6131 |
| W5 | `main/index.ts` 窗口/生命周期 | — | ≤2800 | ⏳ `window/tray.ts` 178 行，index 7308→7199 |
| W6 | `main/index.ts` 收尾 | — | ≤1500 | 未开工 |
| W7 | `renderer/src/App.tsx` JSX | 4065 | ≤3600 | ✅ 3461 行（4 个 workbench 组件） |
| W8 | `renderer/src/App.tsx` 剩余域 | — | ≤1600 | ⏳ 2762（6 个 hook 域） |
| W9 | `pi/AgentManager.ts` | 7268 | ≤5500 | ⏳ 5854（5 个协作者：toolMessageAssembler 392 / runtimeHistoryLoader 420 / compactionRunner 382 / runtimeStateReader 400 / processReattach 578） |
| W10 | `ipc/sessionIpc.ts` | 1885 | ≤400/文件 | ✅ 563 行（12 个域文件） |
| W11 | `ipc/systemIpc.ts` | 1234 | ≤400/文件 | ✅ 达标 |

## 第二轮并行波次（2026-11-12 晚，5 个子代理）

| 波次 | 目标文件 | 前 | 后 | 落地形态 | 备注 |
|---|---|---:|---:|---|---|
| W4b | `main/index.ts` | 7199 | **6711** | 新增 `ipcStacks/{sessionsStack 383, remoteStack 373, gitStack 33, contentStack 57}` + `startup/sessionCatalogPrewarm.ts 79` | 启动后续会被替换的绑定走 getter；`remoteHostServiceResolver` / `remoteProjectTrustService` / `remoteHostRebindIpc` 三个模块级写点由 stack 回填 setter |
| W8a | `renderer/src/App.tsx` | 3461 | **3106** | `hooks/app/useAppProjectActions 278` + `useSessionTabsAssembly 286` | 项目记录动作（10 个函数块）与会话 Tab 栏装配各成一个域；窄接口，不用扁平 props 袋 |
| W9d | `pi/AgentManager.ts` | 6386 | **6208** | `pi/runtimeStateReader.ts 400` | `hasActiveStreaming` / `getRuntimeState` / 缓存命中率 / 工具调用状态合成 / 运行态发布；过程集合留在宿主按引用注入 |
| 新 | `main/sessions/SessionCatalog.ts` | 2972 | **1778** | `sessions/catalog/` 6 个协作者（titleOwnership 289 / entryProjection 241 / fileStore 293 / storeCodes 7 / loadMigration 107 / scannedMerge 299）+ `catalogDraftCreate 141` | 宿主独占 entries / 墓碑 Set / 归档 Map / revision / writeQueue；协作者只拿窄端口 |
| 新 | `renderer/src/ConfigModal.tsx` | 3690 | **3491** | `config/configModal/useConfigPromptsEditing.ts 306` + 契约面 `tests/helpers/configModalSources.mjs`（27 个测试改读聚合） | **未达标**：只拆了提示词模板页，其余 Tab 仍在宿主；契约面已铺好，后续拆 Tab 不用再动测试 |

### 本轮得到的操作教训（写给下一次）

- **不要用脚本自动抽取 JSX/TS 块**：ConfigModal 那个子代理前 20 分钟全烧在写 `$TMP/extractPrompts.mjs` 上（脚本自身读写路径错、连挂 3 次），手工 `read` + `edit` 十几分钟就完成了同样的搬迁。
- **禁止管道**：`grep … | head` / `| cat` / `ls | head` 在此环境（rtk 包装）下会挂死，本轮又踩了两次。统一用 `grep -n/-c/-rl` 直出或 `node -e`。
- **子代理自验的 typecheck 不可信**：它有 41 个错误来自他人的在飞文件，于是漏报了自己引入的 6 个「调用私有方法」错误（`runtimeStateReader` 的 6 个方法需公开）。→ **父代理必须自己跑一次全量 typecheck**，不能采信「我的文件 0 error」。
- **契约断言随访问器形态演进**：`dshRuntimeIpc` 断言 `getDshRuntimeStatus: () => dshRuntimeStatus.getStatus()`，迁到 stack 后成了 `() => getDshRuntimeStatus().getStatus()`；断言改成「锁注入了哪个服务方法、不绑访问器写法」。


## 第三轮并行波次（2026-11-13，5 个子代理）

| 波次 | 目标 | 前 | 后 | 落地形态 |
|---|---|---:|---:|---|
| W4c | `main/index.ts` | 6711 | **6372** | `window/mainWindow.ts` 468 行 + `MainWindowDeps` 33 个成员（可变单例走 getter/setter，不可变依赖一次解构） |
| W8b | `renderer/src/App.tsx` | 3106 | **2939** | `hooks/app/useAppSidebarActions 299`（侧栏 5 组动作） |
| W9e | `pi/AgentManager.ts` | 6208 | **5854** | `pi/processReattach.ts 578`（重挂接 + 进程退出处理 + 启动失败文案） |
| 新 | `sessions/SessionRuntimeCoordinator.ts` | 2759 | **2406** | `sessions/runtime/{sessionRuntimeGateways 206, sessionRuntimePreferences 226}`；远端消息变更域因源码断言绑死相邻性主动留下 |
| 新 | `renderer/src/ConfigModal.tsx` | 3491 | **2696** | 4 个 Tab hook + `modelIdIndex`（超时收工，但比预期多拆） |

### 本轮的三条硬教训（都已落到规则/简报里）

1. **不要用 codemod / AST 脚本改代码**：负责 accessor 化的子代理写了基于 tsc 符号表的批量替换，`{ projectStore }` 简写属性没被识别，一次制造 **1019 个 `Cannot find name 'boot'`**，整波回滚（`git checkout` + 删 `bootState.ts`）。
2. **「accessor 化」不该作为独立波次**：真正要搬的块只读十来个单例，**随块搬迁时按需加 getter** 就够（`ipcStacks` 10 个 stack、`window/tray`、`window/mainWindow` 都是这么成的），不需要先把 150 个模块级 `let` 全量重塑。本文件中「W3 需要 accessor 化」的说法按此修正。
3. **bash 管道在本机会死锁**（rtk 包装不产生 EOF）：本轮 7 次挂起里 6 次是子代理自己写了 `| tail` / `| grep`。已把「bash 禁用管道」写进 `AGENTS.md`（会注入每个子会话上下文），比简报里反复叮嘱可靠。

另外两条运维事实：
- **子代理自验的 typecheck 不可信**：并行期间别人的在飞文件会污染全量 tsc，子代理因此漏报过自己的错误（`runtimeStateReader` 的 6 个 private 方法）。**父代理必须自己跑一次全量 typecheck**。
- **超时不等于没干活**：ConfigModal 的子代理 30 分钟超时，但落地了 4 个 Tab；反过来，顺利「完成」的子代理也可能带着未达标行数交付（`processReattach` 578 > 400 目标）。行数目标只能当参考，门禁与测试才是判据。

## 第四轮并行波次（2026-11-13，5 个子代理 + 1 次重试）

| 波次 | 目标 | 前 | 后 | 落地形态 |
|---|---|---:|---:|---|
| — | `main/index.ts` | 6372 | **6131** | `startup/services.ts 338`（30 个单例经返回值回填，唯一 owner 不变）+ `startup/sidecars.ts 183`（三个 Go sidecar + 提示词库双通道） |
| — | `renderer/src/ConfigModal.tsx` | 2696 | **2492** | 5 个文件：`ConfigAuthTab 158` / `ConfigSettingsTab 97` / `ConfigTrustTab 61` / `ConfigRawTab 105` / `ConfigEnvSwitch 206` |
| — | `renderer/src/App.tsx` | 2939 | **2762** | `useAppSessionPaneServices 260` + `useAppFileTreeTransfer 94` |
| — | `main/pi/SessionHistoryReader.ts` | 2633 | **2106** | `sessionReader/{sessionMessageProjection 221, sessionEntryParsing 231, sessionTurnWindow 149}` |
| — | `renderer/…/useSessionTimelineController.ts` | 2391 | **1813** | `hooks/session/timeline/{useTimelineScrollAnchor 487, useTimelineHistoryPaging 467}` |

**本轮的四条经验**

1. **「抽 hook」的行数回收率只有 ~1/3**：ConfigModal 搬走 400+ 行，宿主只减 204 行——每个 Tab 的 hook 调用要在父组件占 15–30 行。要真降到 ≤1800，下一波得改抽**子组件**（JSX 整块搬走、props 只留身份），而不是继续抽状态 hook。
2. **断言边界会反过来约束域边界**：timeline 的 4 个测试把两个域的正则钉死在源码文本上，正确解法是聚合 helper（`sessionTimelineControllerSources`）而不是改断言；若某条正则跨两个函数，就把这两个函数留在同一文件，域边界服从断言边界。
3. **嵌套引号的 grep 会挂死 bash**（不是管道问题）：`grep -rn "readFileSync(\"x.ts\")\|readFileSync('x.ts')"` 引号没闭合，bash 等续行永不返回。需要匹配带引号的代码时把模式写进 `.tmp/pat.txt` 再 `grep -f`。
4. **上游 merge 会让门禁「假红」**：`a16b7e704` 合入 origin/dev 后，`WebTimeline 935→990`、`webApi 777→790`、`WebEventStream 694→697` 与 `tests/webLayout` 新增的只读源码块全被门禁抓到。这是基线快照过期，不是本轮改动——已把这三条额度对齐当前值与 `testShapeBaseline` 刷新（在单独 commit 里注明）。

## 第五轮并行波次（2026-11-13 晚，5 个子代理）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `main/index.ts` | 6131 | **6019** | `startup/appUpdate.ts 188`（更新器/扩展热更/AtomGit bypass/交付分支），`updateService` 经 `ctx.assign` 回填 |
| `useSessionComposerController.ts` | 2767 | **1859** | `hooks/session/composer/` 四个子 hook：Generation 349 / SendInteraction 313 / DraftAssist 231 / Paste 337 |
| `SessionScanner.ts` | 2475 | **1575** | `sessions/scanner/` 七个协作者（摘要 388 / 标题探针 260 / 消息读 196 / 根枚举 142 / 路径推导 122 / 导出 73 / 信息追加 64） |
| `ConfigModal.tsx` | 2492 | **1899** | 改抽**子组件**：Shell / NavSidebar / Dialogs / McpTab / SkillsTab + `useConfigLoader` + `configModalStorage` |
| `DshAgentManager.ts` | 2863 | **2382** | `dsh/manager/`：runtime 86 / projectionFrames 166 / muxFrames 268 |

### 本轮的三个实测结论

1. **「抽 hook」vs「抽子组件」的回收率差 3 倍**：ConfigModal 第四轮抽 hook 搬走 400+ 行宿主只减 204 行；第五轮改抽子组件，同样搬走约 600 行宿主减了 593 行。**状态 hook 适合主进程/无 JSX 的域；带 JSX 的 Tab 一律抽子组件。**
2. **子代理写盘会带 CRLF**：`ConfigModal.tsx` 被写成 1899 行 CRLF（HEAD 是 LF，`.gitattributes` 要求 `eol=lf`），导致所有跨行正则（`\{\n`）全红，被误判成「断言漂移」。收尾时统一 `\r\n → \n` 后 1 个测试立刻恢复。**验收时要先查行尾**再改断言。
3. **超时 ≠ 没干活**：本轮 ConfigModal 的子代理 30 分钟超时，但实际把 2492 减到 1899（超出目标），typecheck 全绿；反过来 DshAgentManager 的子代理顺利「完成」但只到 2382（目标 2200）。**行数目标只是参考，门禁与测试才是判据。**

## 第六轮：首次用「关联子会话」跑拆分（2026-11-13）

用 `start_session` 开了两个用户可见的关联会话（而不是 fire-and-forget 的 worker 子代理），各领一波、按轮回报：

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `main/index.ts` | 6019 | **5570** | `startup/{weChatBridge 62, soundsAndAnnouncements 75, remoteAccess 67, webService 55, webServiceContext 91, webServiceDepsRuntime 146, webServiceDepsWeb 323}` |
| `pi/SessionHistoryReader.ts` | 2106 | **1471** | `pi/sessionReader/{sessionCardProjection 236, sessionDisplayPaging 327, sessionSubagentProjection 231}` |

### 关联子会话 vs 一次性子代理（实测对比）

- **更早暴露算术问题**：`index.ts` 那个会话在第一轮就回来说「四块原文只有 116 行、净减 82，离 5400 差 537」，并列出剩余可搬块、给出 (a)/(b)/(c) 三个选项让我裁决。worker 子代理通常只会默默做到超时。
- **可见可接管**：两个会话在侧栏里能点进去看进度、能直接接管；出问题时不用猜它卡在哪。
- **代价**：它们拿不到本会话上下文，简报必须自足（我这次每份都写了禁 codemod、禁管道、域内 tsc、边界清单）。
- **一条纪律仍然成立**：两个会话同时在跑时**不要再开第三个写者**。我这轮刻意没有自己动手搬代码，只做验证与提交。

### 本轮的三条经验

1. **源码契约会反向钉住搬迁位置**：飞书 IPC 注册最终**留在了 index.ts**——`tests/portableUserData.test.mjs` 断言 `registerFeishuIpc({` 出现在入口文件里（启动序语义）。子会话把微信搬走、飞书留下，并在新文件注释里写清了原因。这是对的：域边界服从契约边界。
2. **`check:format` 必须进每轮验证清单**：前几轮子代理用 `npx biome`（解析到 v10 错包）写盘，16 个文件不符合仓库 biome 2.3.11 的格式，CI 的 `check:format` 会红。本轮补了一个 `style:` commit 统一重排。以后门禁固定为：typecheck + check:ipc-wiring + check:test-shape + check:file-size + **check:format**。
3. **基线要为「已合并的他人增长」单独对齐**：`7ed47961e fix(sidebar)` 把 `AgentManager` +5、`SessionTree` +1 顶过基线。处理方式与上游 merge 相同——把这两条额度对齐当前值，并在 commit message 里注明来源提交，而不是放宽整个规则。

## 第七轮：关联子会话拆 FeishuBridge / CloudSyncManager（2026-11-13 深夜）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `feishu/FeishuBridge.ts` | 2349 | **1492** | `feishu/bridge/` 11 个协作者（`media 168` / `askCenter 161` / `sessionMirror 273` / `commands` / `bindings` / `outbound` / `bridgeLog` …），全部 ≤400 |
| `cloudSync/CloudSyncManager.ts` | 2267 | **1322** | `cloudSync/manager/` 6 个协作者（`providerOAuthFlows 343` / `backupTransfer 296` / `localIndexBuilder 240` / `sessionObjectTransfer 184` / `objectIo 173` / `githubDeviceFlow 87`） |

两个会话都先读了同目录的兄弟模块（feishu 已有 CardRenderer/CardStream/AskCard，cloudSync 已有 merge/EncryptionService/adapters），没有重复造轮子；FeishuBridge 那波顺带建了 `tests/helpers/feishuBridgeSources.mjs` 并迁移 5 个契约测试的读取行（断言未改），CloudSync 那波不需要新 helper。

### 关联子会话第 2、3 次使用的观察

- **两个会话并行、文件域完全不相交时，这条链路很稳**：两轮下来没有一次互相踩文件，也没有一次需要我在中途叫停。
- **它们会自己发现「哪些东西不能搬」**：Feishu 那轮把 `bridgeLog` 这种宿主与协作者共用的极小工具单独抽出来（18 行），而不是硬塞进某个域；CloudSync 那轮把 provider OAuth 流程整块切走（343 行，接近上限），说明「单文件 ≤400」这个约束被当成了硬边界而不是建议。
- 仍然成立的纪律：**并行会话期间主会话不写代码**，只做验证与提交；两个会话都 idle 之后才跑全量 tsc / 全量测试。

## 第八轮：index.ts 继续外移（关联子会话，2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `main/index.ts` | 5570 | **4964** | `startup/` 新增 `acpAgents`、`dshAgents`、`dshRuntime`、`cloudSync`、`sessionRuntime`、`selectionTools`、`resourceMigration` + `window/browserPanelHost`（8 个文件，全部 ≤420） |

**累计**：`index.ts` 8307 → **4964**（−40%），从全仓第 1 大降到与 `AgentManager 5859` 互换位置。

### 本轮唯一一次「微调新代码去迁就既有断言」

`tests/rpcLogViewer.test.mjs:426` 把这段钉成字面：
`mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);`

子会话于是在回调入口写成 `const mainWindow = currentMainWindow();` 再原样接上那句。**行为等价**（同一时机读一次窗口），我保留了它，只把当时写歪的注释改成真实原因。

判断标准写在下面，供后面几轮参考：
- ✅ **可接受**：加一行本地绑定/别名，让搬走的代码保持原有形态，行为完全不变。
- ❌ **不可接受**：为迁就正则去改生产结构（拆函数、改参数、加转发层）。那种情况必须**改测试**（断言锁语义不锁形态），而不是改代码。

### 现在的 `index.ts` 还剩什么

4964 行里约一半仍是 `app.whenReady().then(...)` 装配体（`createWindow` 之后的窗口/托盘/桥接/remote-access 已经搬走，剩下的是把各个 `startXxx` 串起来的顺序代码 + `registerIpc` 的 387 行 + 若干顶层 helper：`sessionMessageSearchInFile 220`、`resolveImSessionLaunchPreferences 219`、`replaceAgentSession 201`）。继续拆的收益开始递减——剩下的多是「装配顺序」本身，抽出去只会得到一层薄转发。下一轮更适合转 `AgentManager 5859` / `session-atoms 2213` / `GitPanel 1960`。

## 第九轮：AgentManager 创建域 + GitPanel 逻辑层拆分（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `pi/AgentManager.ts` | 5859 | **5259** | `agentFactoryHost 92`（窄接口，32 成员）+ `agentFactoryLocal 334` + `agentFactoryRemote 360` + `promptDispatch`；`createUnlocked` / `createRemoteUnlocked` 的实现搬走，宿主留同名薄包装（测试按实例属性替换它） |
| `renderer/components/app/GitPanel.tsx` | 1960 | **1191** | `components/app/git/` 新增 14 个文件（≤120 行）：`gitPaneLayout` / `GitPaneSash` / `gitPanelStorage` / `gitPanelToasts` / `changeGroupSpecs` + 8 个 `useGit*` hook |

### 本轮撞到的两道墙（都很典型，记下来）

1. **「真渲染型」契约测试会挡住组件搬迁**：`tests/gitPanelCapabilityGate.test.mjs` 用 `loadTsCommonJs` + `stubs` 真渲染 GitPanel，stub 的 key 是「相对 `components/app/` 的模块说明符」。JSX 一搬进 `app/git/`，说明符变成 `../../ui-shadcn/*`、`../AppParts`，stub 全失配 → vm 里去加载真实模块直接崩（`window is not defined`、TS 转译 `Debug Failure`）。叠加多条顺序敏感切片（分支栏要在 `<section` 之前、三个 toolbar 的先后、PaneHeader 切片要含 `changesViewToolbar`），JSX 层**搬不动**。
   → 应对：**逻辑层搬迁**——纯模块与 hook 搬走，JSX / DOM / testid / i18n / 依赖数组一字不动。新建的 helper 必须用**显式文件清单**，不能目录扫描整个 `git/`，否则 `GitGraph` / `GitResourceTree` 混进聚合面会打坏 `font-mono` 计数=1 那条断言。
2. **又一个「切片锚点失效」**：`agentHistoryLoadFreeze` 用 `private async createUnlocked` → `\n\tasync rename(` 切片；搬迁后宿主只剩**非 async** 的薄包装、实现在 `agentFactoryLocal.ts`，`indexOf` 返回 -1，`slice(-1, …)` 得到空串，断言报 `actual: ''`。
   → 修法：锚**实现**起点，再切到「下一个文件边界」（聚合面用 `// <path>` 分隔）。这类「切到下一个函数名」的断言在拆分语境下天然脆弱，以后一律改成文件边界切片。

## 第十轮：SessionRuntimeCoordinator 与 AgentManager 再切（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `pi/AgentManager.ts` | 5259 | **4785** | `bashCommandRunner` / `retryStatusMessages` / `sessionFileWriter` / `sessionMessageEditor` 四个域文件 |
| `sessions/SessionRuntimeCoordinator.ts` | 2407 | **2162** | `runtime/remoteMessageMutation`（远端消息变更 + 命令失败分类）、`runtime/runtimeBinding`（绑定与代数判定）、`runtime/sessionRuntimeCommandError`；与既有 `sessionRuntimeGateways` / `sessionRuntimePreferences` 并列 |

### 两条本轮学到的

1. **父代理给的「方法行数」只是参考，子会话按实读代码有权改方案**。我的扫描把字段声明算进相邻方法，于是 `hasActiveStreaming 285`、`constructor 263` 都不准（前者没那么大，后者是纯装配、无可抽初始化逻辑）。AgentManager 那个会话据此自选了 `bashCommandRunner` / `retryStatusMessages` / `sessionFileWriter` / `sessionMessageEditor` 四个中型方法组，并在报告里明确更正了我的前提。**结论：行数用来排优先级，不用来指定搬哪块。**
2. **Coordinator 只降到 2162（目标 1800，缺口 362）**：两个域搬走后，host 侧要新增薄包装与 host 接口成员，净减被吃掉一部分。剩下的质量集中在 `activate 167` / `sendOnce 131` / `restartSession 61` 这些编排方法上——**它们和 `AgentManager.handlePiEvent` 同性质，继续硬拆只会得到转发层**。建议该文件就停在 2162 这个量级，转而处理 `session-atoms 2213` / `DshAgentManager 2382`。

本轮两个会话都没有改动任何测试文件（只各改了自己的 helper 一行），全量 17384 条测试 0 失败——说明前面九轮铺的聚合 helper 网已经把「拆分就要改测试」这件事基本消掉了。

## 第十一轮：DshAgentManager 拆分 + 冒烟 e2e 的连带收获（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `dsh/DshAgentManager.ts` | 2382 | **1788** | `manager/` 新增 `dshRuntimePumps 256`（控制面泵）、`dshHistoryReads 190`（历史分页/子代理历史/进程事件）、`dshModelControl 157`、`dshImageHydration 84`、`dshRuntimeState`、`dshSessionExport`；与既有 `dshMuxFrames 268` / `dshProjectionFrames 166` / `dshAgentRuntime 86` 并列 |

### 本轮真正的收获不在行数上，而是冒烟 e2e 兑现了价值

「先冒烟一次再继续拆」这个决定直接换来三件事：

1. **发现一个存量一年多的用户可见缺陷**：预热历史接管时，父层会用「语义相同、字符串不同」的草稿 value 重渲染一次，`useTipTapComposerEditor` 的受控同步于是无条件 `setContent` + 光标兜底回文末 —— 用户在输入框中段打字会被追加到末尾。修复见 `665ccbaba`：**只有 editor 当前序列化 JSON 与目标 value 真的不同才重写内容**，文末兜底只在真重写后执行。守护测试是 `e2e/session-prewarm-history`。
2. **确认它不是重构引入的**：在隔离 worktree 里 checkout 到 `c19bdc678^`（composer 拆分之前）重新 build 跑同一 spec，一样红（而且红得更早）。这一步很关键——没有它就只能靠猜。
3. **把 CI 的 e2e 覆盖面从 1/133 提到 3 条整链路**（`ab776cf16`）：markdown 图片链路、启动→首发提升、预热历史+光标。本地实测 4 个 case / 26s。

**教训（值得单独记）**：仓库有 133 条 e2e，CI 只跑 1 条 —— 这就是那个光标 bug 红了大半年没人发现的**唯一原因**。拆分再勤，也补不上「整链路没人跑」这个洞。

## 第十二轮：session-atoms 与 App.tsx 收尾（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `atoms/session-atoms.ts` | 2213 | **896** | `session-atoms-types 129`（纯类型）、`session-cache-policy 136`（纯策略）、`session-state-atoms` / `session-message-cache-atoms` / `session-timeline-atoms` / `session-history-atoms` / `session-runtime-ui-atoms`（均 ≤400） |
| `renderer/App.tsx` | 2762 | **2169** | `hooks/app/` 新增八个域：useAppSessionCreation 177 / useAppSessionEntrypoints 290 / useAppSettingsMirrors / useAppHistoryMutations / useAppGitBranchActions / useAppActiveProjectSync / useAppProjectScanEffects / useAppStartupWiring |

### 本轮唯一容易致命的地方：atom 身份

atom / atomFamily **只能整体搬家**，入口文件用 `export { x } from "./..."` 转发。一旦在新文件里重新 `atom(...)` 一份同名 atom，就会出现「两套状态」：读写方各连一份，症状是「改了 A 处 B 处不刷新」，而且 100% 没有报错——这是这批文件里唯一不能靠 typecheck 兜住的错误类型。本轮所有 atom 均为整体搬迁，未新建任何 `atom` 调用。

### 十二轮之后的位置

`App.tsx` 4065 → **2169**（−47%）、`session-atoms` 2213 → **896**（−60%）。剩下的大头只剩两个并行的「编排内核」：`main/index.ts 4964`、`pi/AgentManager.ts 4785`——两者的剩余质量主要是装配顺序与事件编排，继续硬拆只会得到转发壳（`SessionRuntimeCoordinator` 停在 2162 就是这个结论）。**拆分主线到这里可以收了**；后续按 `AGENTS.md` 的「谁改到哪块就拆哪块」增量执行即可。

## 第十三轮：PiLocator 与 AppUtils（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `src/main/pi/PiLocator.ts` | 1464 | **885** | `piLocator/`：`piCustomPath`（自定义路径校验）、`piSearchDirs`（包管理器全局 bin / PATH / WSL 候选枚举）、`piWindowsShim 174`（`.cmd` 垫片识别、`node-direct` 还原、`cmd-shim` 回退、引号与 8k 命令行预算）、`piLaunchEnv`、`piVersionCheck 178` |
| `renderer/components/app/AppUtils.ts` | 1379 | **48** | `appUtils/` 十二个子模块（groupMessages 376 / suggestionItems 200 / renderTypes / toolArgs / textFormat / pathMatch / outline / reconcileRuns / renderEquality / commandMenu / composerTrigger / fileNodeDrag），入口只留 `export ... from` 转发 |

### 这两块的共性：都是「零风险的机械搬迁」

`PiLocator` 决定「用什么命令启动 pi」，`AppUtils` 是无状态纯函数，两者都没有隐藏的时序依赖，所以能用「搬定义 + 入口转发」的方式做到 import 说明符零改动：`AppUtils.ts` 留成纯 barrel、`PiLocator` 的五份实现被入口按需引用。目标文件从「实现体量」变成「域名录」。

### 顺带发现（未改，留记录）

`PiLocator.wslExePath` getter **零调用方**（`SessionScanner` 有一份自己的同名实现）。存量死代码，与拆分无关；清理与否另议——按「发现但不阻塞任务的问题记录后留在原处」处理。

### 一条经验：源码契约测试的引用面要跟着搬

`PiLocator` 有 29 个测试引用（多个直接读源码断言命令形状），`AppUtils` 有 17 个。两轮都靠「新建 `xxxSources.mjs` 显式文件清单 + 只改读取面 + 断言一字不动」过关。**搬函数必须同时搬「断言看得见的位置」**，否则就会为了迁就正则去改生产结构——那是上一批拆分踩过的坑。

## 第十四轮：RemoteHostConnectionService 与 ConfigModal（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `src/main/remote/RemoteHostConnectionService.ts` | 1821 | **1351** | `remoteHostConnectionGuards 93`（状态集 / HOST_ID / NONCE / 校验小函数）、`RemoteHostConnectionFacts 198`、`RemoteHostSecrets`、`RemotePiSessionFacts`、`RemoteProjectSessionBinding 128`、`RemoteSecurityPolicySnapshot` |
| `src/renderer/src/ConfigModal.tsx` | 1887 | **1386** | `configModal/` 新增 11 个：`useConfigSaveOrchestration 257`（保存/关闭/丢弃编排）、`useConfigDirtyMarks`、`useConfigWriteFlow`、`useConfigLoadEffects`、`useConfigPaneBridge`、`useConfigBackendPane`、`useConfigDeepLinkFocus`、`useConfigTargetAutoSelect`、`useConfigUiPreferences`、`useModelBaseUrlAutofix`、`ConfigStatusBlock` |

### 闭包工厂的拆分上限（本轮最值得记的一条）

`RemoteHostConnectionService` 是「所有状态在闭包里 + 对外类型靠 `ReturnType<typeof createRemoteHostConnectionService>` 推导」的形状。这类文件的拆法有天然上限：**只要还有方法要读同一批闭包状态，外提就得先给它们开 ctx，而 ctx 一开就动到返回对象的形状**——`ReturnType` 会跟着变，那是契约变更，不在「纯搬迁」允许范围内。

所以它停在 **1351**（目标 ≤1100）是对的取舍：再往下只有两条路——(a) 把 `ReturnType` 换成手写 interface 后再拆（契约变更，需要单独评估）；(b) 硬塞转发层（只得到壳）。**遇到同类形状（`ReturnType` + 巨型闭包）先看这一步，别把行数目标当硬指标。**

### 一个省事的细节

`tests/helpers/configModalSources.mjs` 用的是 `readdirSync(目录)` 而非显式清单，所以本轮新增 11 个文件**不用改 helper** 就自动纳入契约面。巨型「域目录」类目标优先用目录扫描；只有包含不该被断言的邻居文件（如 GitPanel 的 GitGraph）时才退回显式清单。

## 第十五轮：SessionFileEditor 与 useSessionTimelineController（2026-11-13）

| 目标 | 前 | 后 | 落地形态 |
|---|---:|---:|---|
| `src/main/pi/SessionFileEditor.ts` | 1496 | **940** | `sessionFile/`：`sessionFileEditorError 61`（错误码 + Error 类，做成叶子解开循环依赖）、`sessionFileJsonl 175`、`sessionFileEntryTargets`、`sessionFileStorage` |
| `renderer/hooks/useSessionTimelineController.ts` | 1813 | **1122** | `session/timeline/` 新增 4 个：`sessionTimelineControllerContract`、`timelineSurfacePolicy`、`useTimelineJumpNavigation`、`useTimelineScrollOwnership 363`（加上原有 `useTimelineHistoryPaging` / `useTimelineScrollAnchor`） |

### 本轮最有价值的一条：读写用户数据的搬迁要「差分验证」

`SessionFileEditor` 负责改写 **pi 正在使用的会话 JSONL**，行为差异会直接毁数据。这轮的做法是：拆完后用脚本把**旧实现（`git show HEAD:` 版）与新实现**同时跑 24 个场景，逐项比对**输出文件字节 / 备份文件名 / 错误码 / 错误消息**，全部一致才算过。

这比「测试绿」强得多——现有测试覆盖不到的组合（空文件、只有 header、重复 entryId、WSL 路径、写一半失败）正是差分脚本能兜住的地方。**以后任何「读写用户数据 / 落盘 / 迁移」类的搬迁，都该用这个动作收尾**，而不是只跑单测。

### 一条断言的处置方式（与「断言锁语义不锁形态」一致）

`scrollToLatestOnSend` 那条 gate 的源码断言差点逼着去改生产形状（把 store 引用改成闭包捕获）。子代理的处理是对的：**保持原形态——注入 `store` + atom keys**，一个字没动断言。反过来（为了迁就正则改生产结构）就是上一批拆分踩过的坑。
