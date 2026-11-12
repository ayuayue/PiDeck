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
| W4 | `main/index.ts` registerIpc | — | ≤3900 | ⏳ 6 个 stack 已外移（1877 行） |
| W5 | `main/index.ts` 窗口/生命周期 | — | ≤2800 | ⏳ `window/tray.ts` 178 行，index 7308→7199 |
| W6 | `main/index.ts` 收尾 | — | ≤1500 | 未开工 |
| W7 | `renderer/src/App.tsx` JSX | 4065 | ≤3600 | ✅ 3461 行（4 个 workbench 组件） |
| W8 | `renderer/src/App.tsx` 剩余域 | — | ≤1600 | 未开工 |
| W9 | `pi/AgentManager.ts` | 7268 | ≤4500 | ⏳ 6386（3 个协作者：toolMessageAssembler 392 / runtimeHistoryLoader 420 / compactionRunner 382） |
| W10 | `ipc/sessionIpc.ts` | 1885 | ≤400/文件 | ✅ 563 行（12 个域文件） |
| W11 | `ipc/systemIpc.ts` | 1234 | ≤400/文件 | ✅ 达标 |
