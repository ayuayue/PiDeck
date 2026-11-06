# 远端/本地 UI 统一 · 第三批重构计划（T4 / T5 / W5）

> Status: **待执行**。基线：`dev`（2026-11-07 合并 origin/dev 之后，约 844 IPC 通道）。
> 前置阅读：`docs/remote-file-tree-and-git-unification-plan.md`（§4.1 波次进度、§10.7 任务卡、§10.8 兼容壳清点）、`docs/engineering-standards.md`、`AGENTS.md`。
> 本文件只写**第三批**（T4 收口、T5 路径语义、W5 共用状态机）的现状、验收与顺序，不重复前两批已完成的结论。

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
