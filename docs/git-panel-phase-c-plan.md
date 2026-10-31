# 任务 G：Phase C —— Git provider / 面板接入 ProjectGitService

Status: **Active（G 实施中）**。基线：`dev`（I0 集成提交组，`git log --oneline 24529c394..dev`），工作树干净。
S 契约已冻结（[remote-project-parallel-handoff.md](remote-project-parallel-handoff.md) §8.2），`services/projectGitService.ts` 已移交 G。
本文件只记录 G 的能力 parity、实施分片、验证与待接线项；不改变任何公共契约语义。

## 1. 能力 parity 表（G 完成后）

「前」= I0 基线（远端 Git 写/强刷/同步/恢复全部 `PROJECT_SERVICE_UNSUPPORTED`）。

| 操作 | 本机 provider | 远端 provider（前 → 后） | 能力位 | 门禁点（UI → 控制器 → provider → main） |
|---|---|---|---|---|
| status（事实缓存读） | `git:status` | 同左（main 按位置路由）→ 同左 | `git.read` | 面板禁用 → controller 拒调 → provider 走公共通道 → main 复验 |
| 强刷（越过事实缓存） | 直接 spawn status | **unsupported → 纯事实强刷**（`git:remote-snapshot` force，provider 自持授权） | `git.forceRefresh`（+ `git.read`） | 刷新按钮 / effect → controller → provider → main |
| workspace diff | `git:workspace-diff` | 同左 | `git.diff` | 行点击 → controller → provider |
| history | `git:history-page` | 同左 | `git.history` | 历史区展开 → controller → provider |
| refs | `git:refs` | 同左 | `git.refs` | 引用区展开 / 轮询 → controller → provider |
| compare | `git:compare-refs` | 同左 | `git.compare` | 对比按钮 → controller → provider |
| repos（仓库发现） | `git:repository-list` | 同左 | `git.repos` | 范围选择器 → hook → provider |
| branches（当前分支+本地分支） | `git:branches` | **unsupported → 由 remoteRefs 派生** | `git.branchRead` | 分支栏 → controller → provider |
| aheadBehind | `git:ahead-behind` | **unsupported → 由 syncFacts 派生** | `git.aheadBehind` | 角标 → controller → provider |
| stage / unstage | `git:stage`/`unstage` | **unsupported → 令牌经纪（provider 持 mutationToken）** | `git.write` | 行按钮 → controller → provider → main 令牌复验 |
| commit | `git:commit` | **unsupported → commitToken** | `git.write` | 提交按钮 → controller → provider → main |
| discard（可恢复） | `git:discard-files` | **unsupported → discardToken + recoveryRef** | `git.write` | 确认条 → controller → provider → main |
| createBranch / checkout | `git:create-branch`/`checkout` | **unsupported → branchToken/switchToken** | `git.branchWrite`（mode: both） | 引用区按钮 → controller → provider → main |
| fetch / pull / push（显式） | `git:fetch`/`pull`/`push` | **unsupported → fetch/pull/pushToken** | `git.sync` | 同步栏按钮（含确认） → controller → provider → main |
| syncFacts | 本机 unsupported（沿用） | **unsupported → `git:remote-sync-facts`** | `git.syncFacts` | 同步栏事实 → controller → provider |
| recovery list/restore/drop | 本机 unsupported（无恢复存储） | **unsupported → `git:remote-recovery-*`（restore/drop 带令牌）** | `git.recovery` | 恢复区 → controller → provider → main |
| init | `git:init` | **unsupported → `git:remote-init`** | `git.init` | 非仓库提示 → controller → provider → main |
| deleteFiles | `git:delete-files` | 保持 unsupported（归文件服务回收站路径） | `git.deleteFiles` = false | 面板不提供 |
| worktree* | `git:worktree*` | 保持 unsupported（远端无本机 .git 目录） | `git.worktree` = false | 面板置灰 + `remoteGit.worktreeUnsupported` |
| 自动 status 轮询 | 有本机 watcher | 有界 5s 轮询（**只读，不含 fetch**） | `git.statusPoll` | effect 闸门：能力 + 可见性 + 非在途写 |
| 自动 refs 轮询 | 本机 watcher | 有界 15s 轮询（**只读，不含 fetch**） | `git.refsWatch` | effect 闸门：能力 + 展开 + 可见性 |
| 自动 fetch | 本机 `autoFetch` | **永不**（显式同步才 fetch） | `git.autoFetch` = false | 无任何 effect 调用 fetch；测试锁定 |

三条硬边界（贯穿全部行）：**能力只决定 UI 入口，不替代 main 的逐操作授权**；**unknown 不重放**；**显式同步不得变成自动 fetch**。

## 2. 实施分片

| 片 | 范围 | 文件（G ownership） | 验收 |
|---|---|---|---|
| **G1** | 纯事实 status、真正的强刷、diff/history/refs/compare、branches/aheadBehind/syncFacts 派生 | `services/projectGitService.ts` | provider 单测：强刷越过事实缓存；失败不冒充空；仓库 scope 断言 |
| **G2** | stage/commit/discard（远端令牌经纪，provider 自持 grant） | 同上 | 单测：无 grant 不发写；`GIT_WRITE_RESULT_UNCONFIRMED` → outcome=unknown 且不重放 |
| **G3** | branch（create/checkout/mode）、显式 sync（fetch/pull/push）、recovery（list/restore/drop）、init | 同上 | 单测：授权拒绝（trust/ready）在触达 helper 前失败；只读方法零令牌 |
| **G4** | 能力表翻新 + 面板/状态/effect 门禁 + 能力置顶展示 | `services/projectServiceCapabilities.ts`（仅 Git 位）、`utils/remoteGitPanelApi.ts`（新增）、`utils/remoteGitViewState.ts`、`hooks/useRemoteGitView.ts`、`components/workspace/RemoteGitPanel.tsx`、`components/workspace/RemoteGitCapabilityBanner.tsx`（新增）、`components/app/GitPanel.tsx`、`components/workspace/GitDrawerHost.tsx` | 能力门禁测试（可用/不可用/拒绝）、effect 门禁测试、断线/重绑/root 失效后能力更新、项目切换不串结果 |
| **G5** | 验证与交付 | 本文 + 测试 | typecheck 0；本域测试全绿；三层同步与 i18n 需求精确列出 |

### 分片依赖

```text
G1 ─┬─ G2 ─ G3        （同一文件，按序）
    └─ G4-transport  （bridge + controller + hook：消费 G1 契约面）
G4-panel             （banner + RemoteGitPanel + GitPanel：消费 transport 的返回值）
```

## 3. 面板接线约定（G4）

- **唯一能力来源**：`useProjectServices(project).capabilities.git`（S 冻结，S/I 单写判定逻辑）；面板/状态机不新增第二套「主机 ready ⇒ 可用」。
- **唯一数据入口**：`ProjectServices.git`；`utils/remoteGitPanelApi.ts` 把服务结果标准化为既有 `{ok,code}` 信封供 controller 使用，**不再向渲染层暴露授权令牌**。
- **契约缺口**（不自行扩通道，登记给集成者）：`remoteCommitDetail`、`remoteRefFileDiff`、`cancelRemoteReads` 三个只读/取消入口在冻结契约中没有对应方法；过渡期由 `remoteGitPanelApi.ts` 直接走既有 preload 通道并做代数围栏，等集成者扩契约后删除。
- **代数围栏**：hook 的 controller key 含 `services.generation`；换代即重建控制器，旧实例的迟到结果不发布。
- **事实订阅**：不再直订 `onProjectFactsChanged` / `onStateChange`（互相退订风险，见交接 §8.8 第 4 条）；统一由 services runtime 重建 services，hook 按新实例重读。
- **副作用闸门**：status 轮询 = `statusPoll`；refs 轮询 = `refsWatch`；**没有任何自动 fetch**（`autoFetch` 远端恒 false）。

## 4. 三层同步需求（纯事实强刷零授权副作用）

### 4.1 问题

`git:remote-snapshot` 的 `force` 确实越过事实缓存，但 handler 在入口处 `tokens.revoke(sender, projectId)` 并随后重签 10 类令牌：

```ts
// src/main/ipc/remoteGitReadIpc.ts:283-299（现状）
tokens.revoke(event.sender.id, typeof projectId === "string" ? projectId : "");
const readSnapshot = (await readFacts(event, projectId, repoPath, force === true)).facts;
...
snapshot.mutationToken = tokens.issue(event.sender.id, projectId, writeExpectation);
```

后果：任何一次「强刷」（面板刷新按钮、5s 状态轮询）都会撤销正在被写操作持有的 grant，并白白签发一批没人会用的令牌。G 的 provider 已把新令牌收进自持快照并按写序列化复用（不丢弃），但**"纯事实强刷"要做到零授权副作用，必须有一条只返回事实、不碰令牌的主进程入口**。渲染层改不出来。

### 4.2 精确变更（三个文件，缺一不可）

**① `src/main/ipc/remoteGitReadIpc.ts`（P 已释放，可由集成者改）**

给既有 `gitRemoteSnapshot` handler 增加一个**受校验的第 5 个参数** `mode?: "snapshot" | "facts"`（不新增通道，避免再加一条 IPC）：

```ts
ipcMain.handle(ipcChannels.gitRemoteSnapshot,
  async (event, projectId: unknown, repo: unknown, force?: unknown, mode?: unknown): Promise<GitReadSnapshotResult> => {
    try {
      if (force !== undefined && typeof force !== "boolean") throw new Error("GIT_RESULT_INVALID");
      if (mode !== undefined && mode !== "facts" && mode !== "snapshot") throw new Error("GIT_RESULT_INVALID");
      const repoPath = validateRemoteGitRepoPath(repo);
      const factsOnly = mode === "facts";
      // facts 模式：只读事实，既不撤旧令牌，也不签发新令牌。
      if (!factsOnly) tokens.revoke(event.sender.id, typeof projectId === "string" ? projectId : "");
      const readSnapshot = (await readFacts(event, projectId, repoPath, force === true)).facts;
      const { writeExpectation, commitExpectation, /* ...其余 expectation */, ...snapshot } = readSnapshot;
      if (factsOnly) return { ok: true, snapshot };   // 无任何 token 字段
      // …原有签发表保持不变…
    } catch (error) { return { ok: false, code: remoteGitFailureCode(error) }; }
  });
```

不变式：
- `mode` 缺席或 `"snapshot"` → 与今天**逐字节同义**（旧调用方零变化）；
- `mode: "facts"` 仍然走 `guardRead` + `verifyFactsBoundary`（sender/项目/trust/ready/压力边界一条不少），只跳过令牌撤/签；
- 事实缓存语义仍由 `force` 决定（`force:true` 才是"越过已完成缓存"，facts 模式不改变这一点）。

**② `src/preload/index.ts`**

在 `git` 命名空间新增**可选**方法（可选是为了 `createBrowserApi`/`createPreviewApi` 与旧装配不必同步实现）：

```ts
/** 纯事实强刷：越过事实缓存，但不撤/不签授权令牌（G 的 provider refresh 用）。 */
refreshRemoteGitFacts?: (projectId: string, repo?: string) =>
  ipcRenderer.invoke(ipcChannels.gitRemoteSnapshot, projectId, repo, true, "facts") as Promise<GitReadSnapshotResult>,
```

**③ `src/renderer/src/services/projectGitService.ts`（G 已实现 fallback）**

```ts
const factsOnly = api.git.refreshRemoteGitFacts;
const result = factsOnly
  ? await factsOnly(projectId, repoScope)        // 零授权副作用
  : await api.git.refreshRemoteSnapshot(projectId, repoScope); // 兼容：返回新令牌，provider 收进自持快照，不丢弃
```

### 4.3 验证要求（集成者合并前必须全绿）

1. **越过缓存**：`remoteGitReadIpc` 测试里对同一 scope 连续两次 facts 强刷 → 两次都调用 helper（不命中已完成的事实缓存），返回新 groups。
2. **旧 grant 仍可用**：先 `gitRemoteSnapshot`（拿 mutationToken），再 facts 强刷，再 `gitRemoteMutateIndex` 用旧 token —— **成功**（facts 模式没有 revoke）。
3. **零签发**：facts 模式返回的 snapshot 不含任何 `*Token` 字段；令牌表条目数不增。
4. **边界不松**：trust 撤销 → `GIT_TRUST_REQUIRED`；sender 已销毁 → `REQUEST_CANCELLED`；同 sender 并发读超限 → `TOO_MANY_REQUESTS`；非法 `mode` → `GIT_RESULT_INVALID`（零 SSH 排队）。
5. **失败不吃掉缓存**：facts 强刷失败后，下一次普通读仍会重新装载而不是返回被污染的值。
6. **旧语义**：`force=true` 且无 `mode` 时行为与今天一致（令牌照旧撤/签）。
7. **接线门禁**：`npm run check:ipc-wiring` 退出码 0（若改用新通道而不是扩参数，必须同时补 `shared/ipc.ts` + `gitIpc` 常量 + preload 三处）。
8. **provider 侧**：存在 `refreshRemoteGitFacts` 时 `refresh()` 走它（断言没有 `revoke` 语义依赖、没有二次 `remoteSnapshot`）；不存在时回落到 `refreshRemoteSnapshot` 并复用其令牌。

### 4.4 落地后的能力语义

`capabilities.git.forceRefresh` 才真正等于契约注释里的「纯事实强刷（不签/撤令牌）」。在那之前，G 的实现是「越过事实缓存 + 令牌自持复用」，**不得**对外宣称已做到零授权副作用。

### 4.5 i18n 需求（集成者单写，G 只用既有 key 兜底）

当前能力条用既有 key 渲染。建议补齐下列 key（zh-CN + en-US + `node scripts/genZhTwCopy.mjs`）：

| key | zh-CN | en-US |
|---|---|---|
| `remoteGit.capabilityTitle` | 能力状态 | Capabilities |
| `remoteGit.capabilityRead` | 读取 | Read |
| `remoteGit.capabilityWrite` | 暂存与提交 | Stage and commit |
| `remoteGit.capabilityBranch` | 分支 | Branches |
| `remoteGit.capabilitySync` | 同步 | Sync |
| `remoteGit.capabilityRecovery` | 恢复 | Recovery |
| `remoteGit.capabilityForceRefresh` | 强制刷新 | Force refresh |
| `remoteGit.capabilityAvailable` | 可用 | Available |
| `remoteGit.capabilityBlocked` | 不可用 | Unavailable |
| `remoteGit.capabilityRootNeedsAttention` | 项目根需要复核 | Project root needs review |

补齐后把 `utils/remoteGitCapabilityView.ts` 的兜底映射换成这些 key（判据不变，只换文案）。

### 4.6 落地状态（2026-10-31 已实现并验证）

| 层 | 变更 | 证据 |
|---|---|---|
| main | `remoteGitReadIpc.ts`：`gitRemoteSnapshot` 增加受校验的第 5 参 `mode?: "snapshot" \| "facts"`；facts 模式既不 `tokens.revoke` 也不签发令牌，返回体只含事实；guardRead / verifyFactsBoundary / sender / trust / 压力边界一条不减 | `tests/remoteGitFactsOnlyForce.test.mjs`（6 例） |
| preload | 新增 `git.refreshRemoteGitFacts`（`invoke(..., true, "facts")`）；对外类型里是**可选成员**（Web / 预览桩不必实现，provider 用可选链做特性检测） | 同一测试 + `check:ipc-wiring` 退出码 0（未新增通道） |
| provider | `refresh()` 优先 facts-only（零授权副作用，已确认快照桶保持可用）；旧装配回落 `refreshRemoteSnapshot` 并整份收下新令牌 | `tests/projectGitServiceRemote.test.mjs` 新增 2 例 |

§4.3 的验证要求逐条对应：越过缓存 ✔、旧 grant 仍可用 ✔、零签发 ✔、边界不松（非法 mode / trust / 已销毁 sender）✔、失败不污染事实缓存 ✔、旧 `force`（无 mode）语义不变 ✔、IPC 接线 0 ✔、provider 两条路径 ✔。
剩余：真实远端上的验收（未授权），以及 Web/预览桩未实现该方法（类型上可选，provider 已回落）。

## 5. 未完成 / 交回项

- 真实远端、Electron、E2E 未跑（本任务未授权）。
- `GitPanel` 与 `RemoteGitPanel` 的**组件合并**（ADR Phase C 第 1 步）未在本批完成：本批先把能力/数据入口/门禁接到共用 provider，合并留待能力 parity 全绿后单独开片；不得据本文件宣称合并已完成。
## 6. 本任务内的 ownership 记录

- 2026-10-31（G 实施期，协调者决定）：能力位翻转必然使两个 S ownership 测试的 Phase A 阶段性预期失效，临时移交 G 修改**仅相关断言**：`tests/projectServiceSeam.test.mjs` 的「远端 Git 写与纯事实强刷：显式 unsupported」用例、`tests/projectServiceCapabilities.test.mjs` 的「远端 ready + trust approved + 完整 helper」用例。约束：同文件其它用例不动；worktree*/deleteFiles/本地 syncFacts·recovery 仍 unsupported、授权拒绝路径仍关闭，均须保留断言。
- `services/projectServiceCapabilities.ts` 仅改 `REMOTE_PROJECT_SERVICE_METHODS` 的 git 位 + 5 处 `hostWriteBlock` 门禁（S 文件，G 最小改动，交由集成者复核）。后者修正了一个真实缺口：降级主机上 `git.write/branchWrite/sync/recovery/init` 之前会宣布可写，与「写面只在 ready 打开」不一致。
- 2026-10-31（G 收尾，协调者代集成者执行）：按 §4 改 `src/main/ipc/remoteGitReadIpc.ts`（facts-only mode）与 `src/preload/index.ts`（可选 `refreshRemoteGitFacts` + 对外类型槽），并按 §4.5 补 i18n（zh-CN / en-US + 重跑 zh-TW 生成）。这些属集成者单写范围，实施由 G 的协调者代做，合入前仍应由集成者复核。
- `tests/projectServiceSeam.test.mjs` 的其余部分、`projectFileBackendConformance`、`remoteProjectDirFacts` 等仍归 S/I。

---

## 7. G 实施记录（2026-10-31，未提交）

### 7.1 落地内容

| 片 | 结果 |
|---|---|
| G1 | 远端 provider 补全 `branches`（remoteRefs 派生）/`aheadBehind`（syncFacts 派生）/`syncFacts`/`refresh`（真强刷：`git:remote-snapshot` force 越过事实缓存；新令牌整份收进 provider 私有桶，**不丢弃**，按 (projectId, repoPath) 序列化复用） |
| G2 | `stage/unstage/commit/discard` 远端令牌经纪：写前现取/复用 grant；缺 token = unsupported 且零写；unknown → `outcome:"unknown"` 且只调用一次；写后作废桶 |
| G3 | `createBranch(create / create-and-checkout)`、`checkout`、`fetch/pull/push`（显式；`syncFacts` 解析 remote，>1 remote 或 detached HEAD 显式 unsupported）、`recovery list/restore/drop`、`init` |
| G4a | 新增 `utils/remoteGitPanelApi.ts`（ProjectServices → 面板信封，渲染层不再接触令牌）；`remoteGitViewState.ts` 重写为能力门禁 + 无令牌快照 `{groups, branch}`；`useRemoteGitView.ts` 唯一入口 `useProjectServices`、控制器 key 含 `services.generation`、删除直订 preload 的 facts/host 订阅、effect 按能力闸门；新增 `setUnavailable` / `setUncertain` |
| G4b | `RemoteGitPanel` 能力条置顶 + 全入口/effect 门禁（刷新/提交/暂存/丢弃/分支/同步/恢复/历史/引用/对比/初始化/refs 轮询），保留四条确认流程与 unknown 文案；`GitPanel` 获得可选 `gitCapabilities` 门禁（刷新/写/同步/init/refs watch/statusPoll/commit 快捷键/图谱写菜单/compare），缺省零行为变化；`GitDrawerHost` 透传 |

**unknown 跨代保留（G 追加）**：写在进行中时断线/重绑/root 失效会换控制器代。hook 以**不含连接代**的 identity key 记录"在途写/未知写"，由新代控制器 `setUncertain()` 在首次读之前发布 `GIT_WRITE_RESULT_UNCONFIRMED`；只有一次成功的事实读能解除，失败读不解。新增 `tests/remoteGitUncertainWriteCarry.test.mjs` 锁定。

### 7.2 验证（本机，Windows；未提交）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 退出码 0，0 error |
| G 域测试（41 文件） | 见 §5 命令 + 本批新增文件 | **345 tests / 316 pass / 0 fail / 29 skip**，退出码 0（V 修复后） |
| 新增 provider 测试 | `node --test tests/projectGitServiceRemote.test.mjs` | 17/17 |
| 新增 bridge / 轮询门禁 / 面板门禁 / 跨代 unknown / facts-only 强刷 | `remoteGitPanelApi` 13、`remoteGitPollingCapabilityGate` 7、`remoteGitPanelCapabilityGate` 14、`gitPanelCapabilityGate` 7、`remoteGitUncertainWriteCarry` 4、`remoteGitFactsOnlyForce` 6 | 全绿 |
| 测试形态 | `npm run check:test-shape` | sourceOnly 411（基线 411，新增 0），退出码 0 |
| IPC 接线 | `npm run check:ipc-wiring` | 795 通道，退出码 0（本任务未新增通道） |
| 格式化 | `npx biome format`（本任务 19 个文件） | 无待修正 |

skip 构成：25 个 Linux-only helper 用例（`remoteGitDiscard` 16 / `remoteGitRecovery` 9）+ 4 个 Linux-only 端到端 harness（`remoteGitStability`）。**`remoteGitStability` 已按新服务栈迁移（provider + bridge + 真实 IPC handler），但本机只能确认 skip，未真实执行**——合入前须在 Linux CI 跑一次。

### 7.3 仍未完成 / 需集成者

1. **DrawerSurface 接线**：远端继续挂 `RemoteGitPanel`（props 未变，无需改动）；`GitDrawerHost` 新增可选 `gitCapabilities`，需集成者在 `DrawerSurface.tsx` 从 `useProjectServices` 取值透传，共用的 `GitPanel` 才会对受限项目真正置灰（本批缺省全可用，零行为变化）。
2. ~~i18n~~ **已完成**：15 个能力 key + 3 条同步完成文案已加入 zh-CN / en-US 并重跑 `node scripts/genZhTwCopy.mjs`；能力条改为**双态**（全可用时给出可用入口清单，有阻塞时逐条列出原因），同步完成改用无参完成文案（不虚构 up-to-date / 快进 / 合并）。
3. ~~三层同步~~ **已完成（见 §4.6）**：facts-only 强刷已按三层接全，`capabilities.git.forceRefresh` 现在名副其实；未覆盖真实远端验收。
4. **冻结契约缺口（3 个只读/取消入口）**：`commitDetail` / `refFileDiff` / `cancelRemoteReads` 仍由 `utils/remoteGitPanelApi.ts` 直连既有 preload 并做代数围栏；扩契约后删除该段（建议扩 `ProjectGitService` 或明确这些仍属面板私有面）。
5. **同步结果语义变窄**：`ProjectGitService` 的 fetch/pull/push 返回 void，面板不再显示 "updated:N / fast-forward / new"（服务层只回完成）。若需恢复，扩契约让动词返回既有 outcome 形状。
6. **每次刷新多一次 branches 读（已优化）**：静默 5s 轮询现在只读事实（`{ branch: false }`），分支沿用上次确认值；显式刷新仍读 facts + branch 两跳（展示需要），契约若能给 facts+branch 同帧可再合并。
7. **`utils/remoteGitFactsSubscription.ts` 已无生产消费者**（仅其单测引用）：建议 owner 决定删除或标注；本批不删以免影响其它并行线。
8. **面板组件合并（ADR Phase C 第 1 步）未做**：本批把数据入口/能力/门禁统一到 provider，组件合并留待单独开片。
9. **未跑**：真实远端、Electron、E2E、全量 `npm test`、全量 build（本任务未授权）。

## 8. V 只读审查（2026-10-31，已按结论修复）

审查报告与逐条处理见 [v-review-2026-10-31.md](v-review-2026-10-31.md)。结论：无阻断、无高危。

| 编号 | 结论 |
|---|---|
| M1 能力位与实际 helper 依赖不匹配 | 已修（`branchRead` 加 `git.refs`、`aheadBehind` 加 `git.syncFacts`、`gitWrite` 含 `git.discard`），三例负向测试 |
| M2 事实通知链路失效（runtime 同代早退） | 已修（hook 经 `acquireProjectFactSubscription` 只重读本仓库 status） |
| M3 checkout 读回失败被报成失败 | 已修（读回失败返回 null，不重放已确认的切换） |
| M4 共用面板刷新手势含 fetch | 已修（`sync && autoFetch` 双闸 + 行为测试） |
| L1 / L2 / L5 / L8 | 已修（序号推进、取 grant 入 try、轮询只读事实、契约注释） |
| L3 / L4 / L6 / L7 | 接受现状或部分缓解，理由见审查报告；L4 的三态分支显示等待 i18n key |
