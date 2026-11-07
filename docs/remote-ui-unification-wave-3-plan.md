# 远端/本地 UI 统一 · 第三批重构计划（T4 / T5 / W5）

> Status: **已执行（2026-11-07）**。基线：`dev`（9161f0519，87 个提交领先 origin/dev）。
> 前置阅读：`docs/remote-file-tree-and-git-unification-plan.md`（§4.1 波次进度、§10.7 任务卡、§10.8 兼容壳清点）、`docs/engineering-standards.md`、`AGENTS.md`。
> 本文件只写**第三批**（T4 收口、T5 路径语义、W5 共用状态机）的现状、验收与执行结果，不重复前两批已完成的结论。
> 执行结果见 §6；未跑项（SSH 真机 E2E）与残留项都写在 §6，不要读成“全部完成”。

## 0. 已完成、不要重做

- T1–T3：事实缓存围栏、连接身份、显式 refresh 门禁（`tests/remoteFactInvalidationRace.test.mjs`、`tests/remoteGitFactsBoundary.test.mjs`）
- T6 目录页（`files:directory-page`）+ 本机/远端共用 `lazyDirTree`
- T7 三个公共入口（`git:repository-list` / `git:history-page` / `git:compare-refs`）
- T8 文件树宿主组合、Git 自动刷新拆到 `useGitAutoRefresh`
- 第二批（2026-11-07）：远端文件进中央栏 Tab、`files:read-content/write-content` 远端分发、本机写入乐观锁、远端编辑器只读门禁、远端草稿安装前落盘

## 1. T4 收口：从「两份事实」到「一个 owner」

现状（有代码证据，先核对再动手）：
- 目录事实：`src/main/ipc/remoteProjectDirFacts.ts`（`RemoteFactCache` 实例 A）
- Git 事实：`src/main/ipc/remoteGitReadIpc.ts` 里的 `RemoteGitSnapshotFacts`（实例 B）
- 两处各自 invalidate、各自 generation；`src/main/remote/RemoteWorkspaceView.ts` 是当初设计的统一骨架，**至今未装配进生产**

目标：
1. 让目录事实与 Git 快照事实共享同一张 `RemoteWorkspaceView`（或等价的单一 owner），对外仍暴露现有的两个读入口；
2. invalidate 语义统一：写成功、unknown 写、helper 事件、断连换代、host 配置变更五条路径只标一次脏；
3. 保留 `afterWrite` 的现有调用点（`src/main/index.ts` 两处），不改变渲染层可见的行为。

验收：
- 新增/扩展单测：同一份 owner 下「目录写 → Git status 也脏」「Git 写 → 目录页不重读」两类断言；
- `node --test tests/remoteProjectDirFacts.test.mjs tests/remoteGitFactsBoundary.test.mjs tests/remoteFactsNotificationLoop.test.mjs` 全绿；
- 真机 `npx playwright test e2e/remoteSessionAcceptance.spec.ts -g "远端 Git G5b|远端文件管理"` 通过。

## 2. T5 路径语义：status/workspaceDiff/写面统一为项目相对

现状：
- `src/main/remote/RemoteGitService.ts` 的 `status`（约 :269）、`workspaceDiff`（:647）、写面（:615/:783）、`refFileDiff`（:941）仍按**仓库内路径**收发
- 归一化函数已经存在（`remoteGitRepoScope` / `projectFilePath` / `repoRelativeFilePath`，约 :231/:243），只是没有全量接上

目标：把上面五个入口的公共 target 改成**项目相对**（与 `git:repository-list` / `git:history-page` 一致），仓库内路径只在 helper 边界出现；兼容期允许 legacy controller 走旧形状，但必须显式标注并加测试。

验收：
- `tests/remoteGitTargetBoundary.test.mjs` 扩展：嵌套仓、同名前缀、跨仓拒绝、项目相对 ↔ 仓库内双向映射；
- 真机 `-g "远端 Git G5d|G5e"` 通过（嵌套仓读写是这条的验收面）；
- 渲染层不再出现「按前缀猜仓库」的代码。

## 3. W5：合并两套 Git 状态机

现状：`GitPanel.tsx`（约 1956 行，自带状态机 + 定时器）与 `remoteGitViewState`（约 811 行）并存；只共用了展示壳（`FileTree`/`FileDiffViewer`）与 `useGitAutoRefresh`。

目标（按片交付，每片独立可回滚）：
1. 把「取消/互斥/unknown/迟到读」四条规则抽成共用 controller，两侧都走它；
2. 自动 fetch/轮询策略继续走 `useGitAutoRefresh` 的能力位，不写 backend 分支；
3. 远端专属区块（history/compare/trust/init/sync/recovery）保持独立，不强行合并——它们的授权语义不同。

验收：
- 新增 controller 单测覆盖四条规则；
- 本机 E2E `e2e/git-panel.spec.ts` 通过；
- 真机远端正向用例 `-g "远端 Git"` ≥ 9 passed（允许 1 flaky）。

## 4. 收尾项（顺手做，不要单独开片）

- **Git ignore 修饰**：`ignored` 字段（`shared/types/projectFiles.ts`）渲染层零消费者；`git.checkIgnore`（`remoteGitReadIpc.ts:626`）只有 handler。要么接进文件树着色/置灰，要么把字段与 handler 标记为未消费并写进文档。
- **位置分派收口**：`projectServices.ts:64-65`、`projectFileService.ts:90/178`、`projectGitService.ts:80/215` 仍按位置选 provider；逐步把 create/rename/read/search 的分派收到 main（`filesIpc` 已经开了头：`remoteTextTarget()`）。
- **rebind UI**：目前只有 `HostRebindJournal` + `RepairPanel`，没有重新绑定界面。

## 5. 纪律

- 先写/改测试再改实现；禁止为消红弱化断言；
- 一次只动一片，片与片之间保持 `typecheck` + 定向测试全绿；
- 不跑全量 `npm run build`（除用户明确要求）；
- 不自动 `git add/commit/push`，交付时列出改动与验证命令；
- 与并行 agent 的分工按目录/文件段划分，公共汇聚文件（`src/main/index.ts`、`shared/ipc.ts`、i18n 词典）同一时刻只一个写者。

## 6. 执行结果（2026-11-07，本批实际交付）

| 片 | 状态 | 落地方式 | 证据 |
|---|---|---|---|
| A / T4 单一 owner | ✅ | `remoteProjectDirFacts` 成为工作区事实的**唯一 owner**：目录 `FactCache` 与 Git `SnapshotFactsCache` 同一实例、同一张连接代（`projectGenerations`）、同一条通知出口。五条失效路径（写成功、unknown 写、helper 事件、断连换代、项目/root 关闭）都在这里标脏，并且**一次事件一条通知**。`remoteGitReadIpc` 通过 `workspace` 端口读写同一份实例（缺省时自持缓存，仅旧装配/单测兼容）。 | `src/main/ipc/remoteProjectDirFacts.ts`、`src/main/ipc/remoteProjectIpc.ts`、`src/main/ipc/remoteGitReadIpc.ts`（`invalidateAfterGitWrite`）、`src/main/index.ts`；`tests/remoteWorkspaceFactsOwner.test.mjs`（4 例：目录写→status 也脏且只发一条通知、Git 写→零目录装载、断连/关闭一起作废、真实 Git 写通道走同一 owner） |
| B / T5 路径语义 | ✅ | `RemoteGitService` 的 `status` / `workspaceDiff` / 写面（`mutate`/`discard`/`recoveryRestore`）/ `refFileDiff`，以及同一份公共输出的 `commitDetail` / `compare` / `recoveryList`，公共 target 与 `path`/`displayPath` 全部改成**项目相对**；仓库内路径只在 helper 帧出现（`repoRelativeFilePath` 唯一转换点）。跨仓/同名前缀/无前缀一律 `GIT_RESULT_INVALID`，不做前缀猜测。legacy controller 不再走旧形状：它的 target 全部来自本服务的公共输出，因此不需要猜仓库。 | `src/main/git/RemoteGitService.ts`；`tests/remoteGitTargetBoundary.test.mjs`（新增 4 例：嵌套 status/写面双向映射、commitDetail/compare 项目相对、跨仓与同名前缀零帧拒绝）；`tests/remoteGitReadIpc.test.mjs` 按新契约更新 target 形状并断言 helper 帧只剩仓库内路径 |
| C / W5 共用状态机 | ✅（抽 + 两侧接线） | 新增 `createGitOperationGate`：取消（`retire`/`isCurrent`）、互斥（写单飞，写者在途由消费者自己的标志回答；读可 `exclusive` 不重叠）、unknown（持续码，只有成功事实读解除）、迟到读（写一开始在途读作废）。`remoteGitStatusPolling` 的静默轮询、`remoteGitViewState` 的代次/unknown/写单飞、`GitPanel` 的 status 请求与 mutation 单飞都改成走它；history/compare/trust/init/sync 的授权语义保持独立。 | `src/renderer/src/utils/gitOperationGate.ts`；`tests/gitOperationGate.test.mjs`（4 例，一条规则一例）；`tests/remoteGitStatusPolling.test.mjs`、`tests/remoteGitViewState.test.mjs`、`tests/remoteGitMutationView.test.mjs`、`tests/remoteGitUncertainWriteCarry.test.mjs`、`tests/gitPanelPollingGuard.test.mjs`、`tests/gitPanelUi.test.mjs` 全绿 |
| D / 收尾 | ◐ | Git ignore 修饰：**本机与远端都已接线**（远端 `probeIgnore`：最长仓库前缀归因、64 路径/批、能力门控；本机 `GitService.checkIgnore`：`check-ignore -z --stdin`、exit 1 视为无命中、非仓库不填；WSL 经同一 git 分派）→ 目录页 → 文件行/目录行置灰。位置分派：保持 provider 边界不变，未做跨层迁移；rebind UI：未做（产品级界面，不在本批）。 | `src/main/remote/RemoteDirectoryIgnore.ts`、`src/main/ipc/remoteGitReadIpc.ts`（`probeIgnore`）、`src/main/ipc/remoteProjectDirectoryReads.ts`、`src/renderer/src/utils/directoryPageNode.ts`、`src/renderer/src/components/session/FileTreeRows.tsx`；`tests/remoteDirectoryIgnore.test.mjs`（7 例）、`tests/localDirectoryIgnore.test.mjs`（4 例，含真实 git 仓库集成）、`tests/directoryPageIgnoreDecoration.test.mjs`（2 例） |

**真机验收（2026-11-07）**：远端 Git 10/10 + 文件管理 v1 全部通过，G6b soak 按 Linux-only 跳过；细节见下方「未执行 / 残留项」。

## 7. 后续：位置分派收口（片 1 / 片 2，2026-11-07）

目标：把 renderer 里“本机 vs 远端选通道”的分支逐步收到 main。已交付两片：

| 片 | 行为变化（用户可见：无/极小） | 落地 | 证据 |
|---|---|---|---|
| 1 搜索 | 无 | 新增公共 `files:search-page`（`Op<ProjectFileSearchPage>`）：本机索引/BFS、ssh 走 `remoteProjectIpc.searchProject`；两个 provider 都只调它，`kind:"other"` 只留在 `entries`、`truncated/scanned` 不丢。`files:search` 保留一版兼容 | `tests/filesSearchPage.test.mjs`（4 例）、`tests/projectServiceSeam.test.mjs`（搜索断言迁到 `files.searchPage`）、`check:ipc-wiring` 845 通道 |
| 2 新建/改名/移动/删除 | 无（失败码与收据不变） | `files:create` / `files:rename` / `files:move` / `files:delete` 在 main 内按位置路由：ssh 走 `remoteProjectEntries` 的 handle（同一套服务/令牌/事实失效），本机仍走 local backend；rename/move/delete 的乐观锁由 main 现读版本后立即提交，renderer 不再持令牌；delete 带回 trashId 收据 | `tests/filesWriteRouting.test.mjs`（6 例）、`tests/remoteProjectEntryIpc.test.mjs`（handle 5 例）、`tests/filesIpcRegistration.test.mjs`（源码断言：provider 不再调 remoteHosts 写面）、`tests/projectServiceSeam.test.mjs`（写面断言迁到 `files.create/rename/move/delete`） |

已知缺陷已修复（2026-11-07，详见 `remote-file-tree-and-git-unification-plan.md` §11）：远端目录页的 Git ignore 修饰曾因 helper `dispatch` 漏发 `git.checkIgnore`（能力声明了但派发表没有）而在真机失效；已补上并 bump 到 helper 1.26.1，新增“声明 ↔ 分派一致”回归测试，`e2e/remote-file-ignore.spec.ts` 与远端 Git 全组均已通过。

未收口（登记）：`projectServices` / `projectFileService` 的 provider 工厂仍按位置选择实现（这是“provider = 位置适配层”的既有边界）；`upload` / `download` 仍走远端传输通道（能力不同，不属文件写面）。

**验证命令与结果（本批实际执行）**：

- `npm run typecheck` → exit 0；
- `node --test tests/remoteWorkspaceFactsOwner.test.mjs tests/remoteProjectDirFacts.test.mjs tests/remoteGitFactsBoundary.test.mjs tests/remoteFactsNotificationLoop.test.mjs tests/remoteFactsTreeInvalidation.test.mjs tests/remoteGitSnapshotFacts.test.mjs tests/remoteFactInvalidationRace.test.mjs` → 63/63 pass；
- `node --test tests/gitOperationGate.test.mjs tests/remoteGitStatusPolling.test.mjs tests/remoteGitViewState.test.mjs tests/remoteGitMutationView.test.mjs tests/remoteGitUncertainWriteCarry.test.mjs tests/gitPanelPollingGuard.test.mjs tests/remoteGitPollingCapabilityGate.test.mjs tests/remoteGitStability.test.mjs tests/remoteGitRefsPolling.test.mjs tests/gitPanelUi.test.mjs` → 116/116 pass；
- `node --test tests/remoteGit*.test.mjs tests/gitPanel*.test.mjs …`（全部 `tests/*git*`、`*panel*`）→ 786 pass / 0 fail；
- `node --test tests/remote*.test.mjs tests/project*.test.mjs tests/lazyDirTree.test.mjs tests/fileTree*.test.mjs` → 2412 pass / 0 fail（272 skip 为真机/环境门禁；`remoteHelperContentSearchProbe.mjs` 为既有真机探针，与本批无关且无 SSH 环境）；
- `npx biome format <改动文件>` → No fixes applied。

**未执行 / 残留项（如实登记）**：

- **SSH 真机 E2E 已跑（2026-11-07，serve / Linux 主机，登录 shell node v24.11.0）**：
  `npx playwright test e2e/remoteSessionAcceptance.spec.ts -g "远端 Git|远端文件管理"` → **11 passed / 1 skipped**（G6b soak 为 Linux-only skip，9.4 分钟）。
  覆盖：G1 只读 SCM/双项目隔离/断开不重连、G2a/G2b 精确暂存与提交、G3a 历史/引用/两版本差异、G3b 分支创建与切换、
  G4a/G4b 丢弃与恢复区、G5a fetch/pull/push、G5b 引用对比与轮询、G5c 显式初始化、G5d/G5e 嵌套仓读写、文件管理 v1。
  flaky 记录：`远端文件管理 v1` 单独首跑时 `remote-trash-row` 断言一次未命中，retry 通过；随后全量运行一次通过（既有 UI 时序抖动，本批未改回收站链路）。
- **位置分派仍按位置选 provider**：`createProjectServices`（`projectServices.ts`）与两个 provider 工厂仍是 UI 侧唯一的位置判断点。下一步是把 create/rename/read/search 收到 main 的公共入口（`filesIpc` 的 `remoteTextTarget()` 是已有起点），那需要新的公共写面契约，不在本批范围。
- **rebind UI 未做**：目前只有 `HostRebindJournal` + `RepairPanel` 与主进程旅程；重新绑定界面需要先定产品交互（进入入口、步骤、取消语义），未在本批实现。
