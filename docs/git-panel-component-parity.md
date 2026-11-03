# GitPanel / RemoteGitPanel 组件 parity 与合并门禁

Status: **Wave 0–2 completed，部分合并（2026-11-03）**。本文是组件合并的逐项行为对照；只有表中“可安全共享”一项完成并以行为测试证明后，才允许删除对应旧实现。`RemoteGitPanel` 仍保留，不能据此文宣称两个面板已完全合并。

基线行为以当前代码和定向测试为准，不以旧计划中的行数或方法数推断等价。Wave 2 完成后的目标文件行数：`GitPanel.tsx` 1956、`RemoteGitPanel.tsx` 612、`RemoteGitCompareSection.tsx` 117、`DrawerSurface.tsx` 273；`ProjectGitDrawer.tsx` 为 26 行。

## 已合并 / 未合并

| 项 | 状态 | 证据 |
|---|---|---|
| Git 抽屉生产入口 | **已合并为一个 owner**：`DrawerSurface` 只挂 `ProjectGitDrawer`；远端/本地选择在该组件内完成，两个后端实现均保留。 | `tests/projectGitDrawer.test.mjs`、`tests/remoteGitDrawer.test.mjs` |
| 变更树与 diff 展示 | **已共享**：`GitResourceTree.FileTree`、`FileDiffViewer`。 | `tests/remoteGitHostComposition.test.mjs` |
| 能力条展示 | **已共享**：`RemoteGitCapabilityBanner`；能力判定仍按后端各自 owner。 | `tests/gitPanelCapabilityGate.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs` |
| 错误展示 | **已共享展示壳**：`GitInlineErrorNotice`；本地仍保留清洗后的 stderr，远端仍只映射闭集稳定码。 | `tests/gitErrorPresentation.test.mjs` |
| commit / sync / recovery / trust / init / history / graph / smart commit | **未合并**：这些仍有不同确认、授权、调度或结果语义，保留各自 controller 与区块。 | 下表逐项证据 |

Wave 1 将远端错误码映射与本地错误清洗收进 `utils/gitErrorPresentation.ts`，并把两种视觉变体收进 `GitInlineErrorNotice`；Wave 2 新增 `ProjectGitDrawer`，仅统一入口，不把远端状态机挂到 `GitPanel`。

| 能力 | 本地面板行为 | 远端面板行为 | 合并结论 / 门禁 | 证据 |
|---|---|---|---|---|
| 状态、刷新、同步事实 | `GitPanel` 自有 status/mutation 序号；显式刷新成功后可顺带本地 ahead/behind，`autoFetch` 与 `sync` 双闸控制 refresh 内 fetch；本地 status 轮询 5 秒、focus 补读、refs watch、5 分钟 fetch。 | `useRemoteGitView` 自有 controller epoch；显式 refresh 优先 facts-only force，随后单独 `loadSync`；5 秒 status 轮询只读事实且不 fetch，sync facts 只在首次/显式动作后读。 | **不可直接替换**。两边 generation、force、branch 与 sync facts 生命周期不同。先共享纯展示/错误呈现，不共享调度器。 | `tests/gitPanelCapabilityGate.test.mjs`、`tests/gitPanelPollingGuard.test.mjs`、`tests/remoteGitPollingCapabilityGate.test.mjs`、`tests/remoteGitFactsOnlyForce.test.mjs` |
| fetch / push / pull | 显式 push/pull 入口；fetch 也参与手动刷新与 5 分钟自动刷新；push 支持首次 upstream 引导。 | 必须先从 sync facts 得到 remote/upstream；fetch 可显式触发，push 二次确认，pull 直接触发；任何 effect 都不得 fetch；unknown 不重放。 | **远端专属交互保留**。共享候选只有 busy/error 基础展示；确认、upstream 判定和结果文案不得抽象成同一函数。 | `tests/gitPanelCapabilityGate.test.mjs`、`tests/remoteGitSyncBar.test.mjs`、`tests/remoteGitSync.test.mjs` |
| stage / unstage / commit | 支持单文件、目录、全部、smart commit、AI 摘要、粘贴菜单、提交快捷键；成功后刷新并清该仓草稿。 | 单文件 stage/unstage；仅提交现有 index；消息有界、成功后清空，refusal/unknown 保留；不做 smart commit 或隐式 stage。 | **入口不合并**。可提取无业务决策的通用提交头/错误呈现；不得让共用按钮改变远端自动 stage 或本地 smart commit 语义。 | `tests/gitPanelUi.test.mjs`、`tests/gitPanelCapabilityGate.test.mjs`、`tests/remoteGitViewState.test.mjs`、`tests/remoteGitCommit.test.mjs` |
| discard / recovery | 单文件或目录批量丢弃，`ConfirmDialog`；`deleteFiles` 是独立系统回收站动作；本地无 Git recovery store。 | 单文件可恢复 discard，内联确认；记录 `recoveryRef`；独立恢复列表支持 restore/drop，drop 二次确认。 | **远端专属实现保留**。拒绝把 delete 映射成 discard，也不为 parity 伪造本地恢复能力。 | `tests/gitPanelUi.test.mjs`、`tests/remoteGitDiscard.test.mjs`、`tests/remoteGitRecovery.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs` |
| branch create / switch | 本地 create-and-checkout；脏工作区切换先确认；分支信息可按 repo scope 隔离并由宿主更新。 | 远端 create 与 switch 分离，`branchCreateMode` 决定入口；switch 只对已有分支，脏冲突由 helper 拒绝并显示稳定码。 | **入口不合并**。保留 `branchCreateMode` 和远端确认/错误语义，不把 create 隐式改成 checkout。 | `tests/gitDrawerRepoScope.test.mjs`、`tests/remoteGitBranch.test.mjs`、`tests/remoteGitViewState.test.mjs` |
| refs / history / compare / commit detail / ref file diff | 本地历史与图谱共用 `SourceControlGraph`，图谱含 lane、菜单和高级写；compare 为 merge-base/ahead-behind；commit detail/ref diff 走 `GitDrawerApi`。 | 历史是 HEAD-only 分页列表；无图谱/count/高级写；refs 含 tag；compare 为 trees，不伪造 ahead/behind；detail/ref diff 已收进 `ProjectGitService`。 | **部分共享展示**：`FileDiffViewer` 已共用；历史容器、图谱、compare 模式和详情交互仍不具行为 parity，保留两套入口。 | `tests/remoteGitHistoryPageView.test.mjs`、`tests/remoteGitCompareRefsView.test.mjs`、`tests/remoteGitViewState.test.mjs`、`tests/projectGitServiceRemote.test.mjs` |
| repo selector 与嵌套仓库门禁 | 多仓并排展示 changes，只有一个全局 Graph/Compare；scope 由宿主按 repo target 固定，支持嵌套仓读写。 | 单一活动 repo scope 的选择器；打开仓库后可读写该嵌套仓；只有 init 固定项目根，嵌套 scope 不提供 init。 | **布局与选择策略不可合并**。共享的是 repo scope 身份校验，不是选择器组件；远端继续单活动 scope。 | `tests/gitDrawerRepoScope.test.mjs`、`tests/gitRepoSwitcher.test.mjs`、`tests/remoteGitRepoScopeView.test.mjs`、`tests/remoteGitScopedWrite.test.mjs` |
| trust / init | 本地面板在 `GIT_NOT_REPOSITORY` 时直接提供 init；无 remote trust gate。 | `GIT_TRUST_REQUIRED` 显示 trust gate；根仓非仓库且 `init` 能力开启时才提供二次确认 init；嵌套仓没有 init。 | **远端专属区块保留**。trust/init 不能进入无位置语义的共用核心；能力条只解释不可用项。 | `tests/remoteGitTrustGate.test.mjs`、`tests/remoteGitInitView.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs` |
| capability banner 与所有能力门禁 | 可选 `gitCapabilities`；缺省全放行；刷新、read、write、sync、auto refresh、compare、init、图谱菜单与快捷键各自有双重守卫。 | 能力来自 `services.capabilities.git`；每个入口与按需加载 effect 先查对应能力；关闭时零调用；能力条列出阻塞原因。 | **已合并基础展示**：两边共用 `RemoteGitCapabilityBanner`。能力判定与业务动作仍是两套，不能只凭共用 banner 宣称组件完成合并。 | `tests/gitPanelCapabilityGate.test.mjs`、`tests/gitGraphCapabilityGating.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs` |
| polling / scheduling / unsubscribe | `useGitAutoRefresh` 统一注册 status/focus/refs/auto-fetch effect；能力关闭时不注册；refs watch 返回 id 并成对解绑。 | refs 轮询只在展开、可见、ready 且有已加载 refs 时运行；status 轮询由 controller/hook 管；所有 controller 读取按 epoch 围栏，dispose 取消远程读取。 | **策略不共享**。可共享纯计时 helper，但当前行为已由两个专用 hook 清晰拥有；合并前必须证明两者的调度与退订完全等价。 | `tests/gitPanelPollingGuard.test.mjs`、`tests/remoteGitPollingCapabilityGate.test.mjs`、`tests/remoteGitRefsPolling.test.mjs` |
| confirm / unknown 结果 | discard/delete/branch 切换使用本地 `ConfirmDialog`；写失败 toast；本地面板没有跨代 unknown 写携带。 | push/discard/init/recovery drop 都有显式确认；refusal 与 unknown 区分，unknown 保留告警、不自动重放，跨连接代由 identity 携带至成功事实读。 | **远端确认与 unknown 状态机保留**。共享展示不能吞掉确认或把 unknown 降级为 rejected。 | `tests/remoteGitUncertainWriteCarry.test.mjs`、`tests/remoteGitViewState.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs` |
| Git graph 菜单与快捷键 | 图谱右键菜单提交操作受 `write` 门禁；Ctrl/Cmd+Enter 提交仍消费按键但不越过能力门。 | 不渲染图谱或提交快捷键；历史行只打开 detail/ref diff。 | **本地专属**。保留 `SourceControlGraph` 与快捷键，不把其状态机塞入远端展示组件。 | `tests/gitGraphCapabilityGating.test.mjs`、`tests/gitPanelUi.test.mjs`、`tests/remoteGitHostComposition.test.mjs` |
| local and remote error copy | 优先清理 invoke/command 包装并展示 git stderr，空时用本地化 fallback；错误位于 changes 区。 | 只把稳定错误码映射为本地化分类文案，原始 stderr/远端路径不外传；不同区域有明确 role/alert。 | **已共享展示壳**：稳定码映射与内联错误呈现已抽出；本地 raw stderr 优先级和远端闭集码边界保持不变。仍未把本地/远端业务结果状态合为一体。 | `tests/gitErrorPresentation.test.mjs`、`tests/gitPanelUi.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs`、`tests/remoteGitViewState.test.mjs` |

## 合并门禁

1. 每个 wave 只能合并表中标记为“可安全共享”或已有行为一致证据的部分；每次先记目标文件行数，完成后目标文件不得净增长。
2. `RemoteGitPanel` 的 trust/init/sync/recovery/scope/confirm/unknown 薄包装在对应能力全部被共用实现覆盖前必须保留。
3. 生产入口只能有一个 owner；不得让旧包装与共用实现同时发包。
4. 行为测试必须覆盖能力关闭零调用、项目/仓库切换旧结果丢弃、unknown 不重放、refresh 不隐式 fetch、嵌套 repo scope 与本地缺省行为。
5. 缺任一行为证据时只能记为“未合并”，不得删除远端组件或宣称合并完成。
