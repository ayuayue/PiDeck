# 文件树与 Git 面板：本地/远端统一改造计划

> Status: **Active plan（2026-10-31 校准）**。T1–T9 已有分片交付，当前事实/保留项见 §10.7/§10.8；§1/§4.1 保留原审计背景，不代表所有缺陷仍未修复。此前“薄适配器直接换面板”的方案不作为实施依据。
>
> **本次核对基线：`dev / 24529c394`；原计划基线为 `c26dbb85d`。** 服务缝 Phase A 已落地，A0 纯 stat 已在工作树修复；B/C 仍需契约校准。开工前核对实际 HEAD 与工作区，保留其他人的改动。
>
> **本轮派工入口：[remote-project-parallel-handoff.md](remote-project-parallel-handoff.md)。** 按其中 P/S/T/F/G ownership 与依赖推进；§10 的旧任务卡用于对照已有行为，不从 T1 重跑已完成迁移。
>
> 相关：[架构](architecture.md)、[位置模型 ADR](project-location-architecture.md)、[远端 Git 计划](./archive/remote/remote-git-plan.md)、[远端文件管理计划](./archive/remote/remote-file-management-plan.md)、[远端协作交接](./archive/remote/remote-development-handoff.md)、[工程标准](engineering-standards.md)。
>
> **本文只治理统一层。** helper 线协议、bootstrap/pin/trust、令牌语义、远端终端与会话运行链路保持原边界。原始能力账本仍以 `remote-git-plan.md`（G1–G6c）与 `remote-file-management-plan.md` 为准。组件级合并状态与门禁见 [git-panel-component-parity.md](git-panel-component-parity.md)。

## 1. 根子问题（四条，互相咬合）

不是"文件树和 Git 各写了一份"，而是四件事叠在一起：

| # | 根问题 | 证据 |
|---|---|---|
| **A** | **远端事实没有唯一拥有者**：谁缓存、谁失效、谁合并、谁决定这次刷新花多少钱，每个界面自己定 | `useFileTreeGitStatus` 自己 listRepos + 每仓 status；`useGitRepoScope` 再读一遍 listRepos；面板再算一遍 status。刷新策略散在 4 个 hook（400ms 防抖 / 5s 轮询 / 15s refs / 手动） |
| **B** | **两套通道族 + 三套结果词汇** | `git:*`（33 handler，抛异常）vs `git:remote-*`（`{ok,code}` 信封）；`files:*`（抛）vs `remote:project-entry-*`（信封 + trashId）；`GitGenerateCommitMessageResult` 又是第三种 `{ok,code,message}` |
| **C** | **渲染层有两套数据层** | 本机 `GitPanel` 通过 props 注入调用，但内部仍有状态机、定时器和自动 fetch；远端 `remoteGitViewState`(674) + `RemoteGitPanel`(631) + `useRemoteGitView`(127) + compare/refs/repos ≈1600 行专用管线 |
| **D** | **身份与授权是"事故性"的**，不是写下来的策略 | `FileTreeNode.path` 既当本机绝对路径又当目录键；令牌按 (sender, project) 而非 (sender, project, repo, kind, revision)；`entry.stat` 是签发令牌的读。多仓互斥、热路径签令牌都由此"碰巧"发生 |

只修 A（加事实层）会把 B/C/D 留成永久债：合并后的通道里仍有三套词汇，渲染层仍有两套数据层，身份仍在两个语义之间反复。

### 1.1 已定结论（不再重复论证，需要时看证据）

- **文件域**：按 ISP 拆 `ProjectFileReader` / `ProjectFileWriter`；公共目录页返回 `{entries, truncated, revision, generation}`；`hasChildren: true|false|"unknown"`（本机精确、远端未知，不能伪装为空）；写入收据按原权威进入契约。
- **`stat`/`pathsExist` 不得路由到 `entry.stat`**：它是签发令牌的读，令牌表全局 FIFO 128 → 128 目标的批量会挤掉用户写授权。证据 `tests/remoteFileStatTokenPressure.test.mjs`。
  **但不需要新 helper 方法**：只读批量早就有——`RemoteWorkspaceReader` 的 `stat` / `statMany`（≤64 路径/帧、全有或全无）/ `list` / `readFile` / `search`，helper 1.22.0 已上线（`fs.*` 批次）。v5 初稿写的“新增 `entry.statMany`”是重复发明，已作废；`files:stat`/`pathsExist` 的 128 目标 = **2 帧**。
- **远端只读文件面已经实现且已逐字段校验**：`createRemoteWorkspaceReader({ port: sessionPort(session, hostId) })`，`remoteProjectIpc` 的 list/read/search 已经全部走它（`:255/:284/:315`）。所以重复不在 helper 层，而在**通道层**（`remote:project-*` vs `files:*`）——W3 直接建在这上面，不重写读实现。
- **公共目录页上限定为 2000**：远端 helper 原有 4096 上限不改。公共结果独立携带 `truncated`，不能把它塞进 revision 或用“刚好 2000 条”猜截断；helper 的超限拒绝仍是失败，不能伪装成完整空目录。
- **写面收缩**：先只合并 `create`/`rename`；`delete`/`move` 等契约能表达 revision + 回收站 + 三态结果再合。
- **忽略语义**：`.gitignore` 由 git 权威判定（`check-ignore`），条目带 `ignored` 修饰而非隐藏。非仓库声明无 Git ignore 能力，产品已有的保护性隐藏规则照常保留；不自己重写 gitignore 语义。
- **远端不堆叠**：令牌是"一窗口×一项目×一动作一份"，`GitDrawerHost` 的多仓并排与之物理冲突。证据 `tests/remoteGitMultiRepoTokenScope.test.mjs`。
- **远端门禁**：`remoteFeatureEnabled` 来自单一发布策略 `REMOTE_FEATURE_AVAILABLE = true`，正式包与 dev 包都装配；渲染层只读 `update:get-channel.remoteAvailable`。统一 dispatch 必须继续尊重各 IPC 的 `enabled=false` fail-closed 分支。
- **不做**：抄 ZCode 的绝对路径节点模型、抄它的常驻 host 部署形态、抄 60s 自动刷新补偿。

### 1.2 全生命周期盘点：同样的根病还有三处（R1–R3）

按**不变量**（而不是按界面）把远端链路走了一遍：主机接入 → 会话 → 终端 → 文件/Git → 会话历史 → 上传。结论是三处同类，其中一处**只能显式化、不能在本轮修**。

| 编号 | 根问题 | 证据 | 与 A–D 的关系 | 归属 |
|---|---|---|---|---|
| **R1** | **一个 host 同时只有一个活动 root**：helper 启动时 `--root` 固定，切 root 就 `discard` 整个会话重建；整台 host 一把 `operationLock` | `RemoteHostConnectionService` 的切 root/operationLock；旧扫描器借 helper 的问题已由 R1a 改为命令传输 | A 的物理版本：不是“谁缓存”，是“根本没有并行容量” | 独立 P 任务；采用 main 侧单 root helper 池化，无需先改 helper 协议，见池化 ADR |
| **R2** | **信封在每个 IPC 边界被拆开重建**：`withProjectSession` 返回 `{ok,code}` → handler `throw new Error(result.code)` → 自己再 `catch` 成 `{ok:false, code}`；`codeOf` 有 8 份独立实现，fallback 各不同 | 6 处 `if (!result.ok) throw new Error(result.code)`（`remoteGitReadIpc:72`、`remoteProjectEntryIpc:30`、`remoteProjectFileIpc:17`、`RemoteHostConnectionService:800,1118`、`createRemoteTerminalManager:35`）；`codeOf` 独立实现 8 份；`remoteProjectIpc.ts:10` 明写“两个域刻意互不 import …`codeOf` 在本文件重新声明” | B 的放大版：不是三套词汇，是**七套**（files/git/hosts/entry/transfer/trust/session 各一套） | **并入本轮 W2/W4** |
| **R3** | **“主机可用”有两个定义**：`ready \|\| degraded` vs `ready` | `ConnectionsTab.tsx:310`、`remoteConnectionProgressState.ts:97` 用前者；`useRemoteGitView.ts:28` 用后者；renderer 共 4 处订阅 `onStateChange` 各算一套 | A 的渲染层版本 | **并入本轮 W3**（`capabilities` 快照的前置） |

R1 的后果（写下来以免当成 bug 反复查）：

- 同 host 两个远端项目交替访问 ⇒ 每次切换 `discard` + 重建会话（探针 + 边界复验），不是慢一点，是**结构性重建**；
- 旧扫描器曾借会话根切走 helper；R1a 已对扫描/根解析的生产装配引入一次性命令，不能再当作待实现任务；
- Git 多仓并排：**不是** helper 做不到（`repo` 只是每帧参数），是令牌 revoke 作用域把多仓判死（证据 `tests/remoteGitMultiRepoTokenScope.test.mjs`）。
- 所以“远端不并排多仓”是对齐物理事实，不是偷懒。

**看过但不构成根问题（不改，只记一笔）**：连接状态机（`RemoteHostConnectionState` 是纯 reducer + generation 围栏）、`withProjectSession` 的会话钉定、会话文件写入（收敛在 `RemoteSessionHistoryWriter` + 一个 write guard）、远端模型目录（复用 live runtime，不重新探测 pi）、上传的 stdin 分块（argv 8 KiB 预算所致）、四个传输并存（helper NDJSON / 终端 PTY / stdin 分块 / 远端 pi rpc——**各有物理原因，统一它们才是错的**）。

### 1.2.1 R1a：既有资产，不重做

`RemoteSessionScanner` 的扫描/根解析通过注入的 `RemoteSessionScanSource` 命令传输运行；生产装配在 `src/main/ipc/remoteSessionIpc.ts` 与 `src/main/pi/remoteRuntimePort.ts`。兼容 helper 端口仍存在，不能据“文件里还能搜到 withProjectSession”判定生产扫描尚未迁移。

本轮 sessions 只迁结果信封，不改扫描/root 选择、title/register 的传输策略或会话写入。保护测试：`remoteSessionScanIsolation`、`remoteSessionRootIsolation`、`remoteSessionRootResolution`。helper 多 root 是独立产品变更，不是 W6 接线的前置。

### 1.3 审计口径：为什么以前会漏，以后怎么不再漏

以前的盘点按**界面**分组（文件树 / Git 面板 / 侧栏圆点），所以只找到了“同一份界面里”的重复；跨界面、跨传输、跨域的同一种病看不见。改成按**不变量**逐域问 5 句：

1. 这个事实（列表/状态/能力/版本）**谁拥有**？有没有第二处也算同样的值？
2. 成功与失败**几个词汇**？边界处是否把 `{ok,code}` 换成异常又换回来？
3. 同一个动作**几条通道**？能不能在一条通道上表达？
4. 授权按什么**定作用域**？作用域单位与 UI 的用法一致吗？
5. **物理容量是几**（一个 root？一把锁？128 个令牌）？UI 的用法超过它了吗？

第 5 问是这次才补的：R1 与“远端不并排多仓”都是它问出来的。

**未来梯子（本轮不做，写下来免得重复讨论）**

- **V1 helper 多 root**：帧里带 root，或每 root 一个 helper 进程。是否做取决于产品要不要“同 host 并行多项目”；扫描生产路径已有 R1a，不以此为本轮扩写 helper 的理由。
- **V2 主机级事实视图**：“这台 host 上正在跑什么”（终端 tab / agent 进程 / 活跃会话）现在分属三个 manager，没有单一视图。
- **V3 传输层生命周期词汇**：只统一“开始中 / 已开始 / 失败 / 失去”四个词，**不统一传输本身**（PTY / rpc / NDJSON / stdin 分块各有物理原因）。

## 2. 目标架构：两个边界、单通道族、单信封、单授权

```
┌─ renderer ───────────────────────────────────────────────────────┐
│  useProjectFiles(projectId)          useProjectGit(projectId)     │  ← 只有两个域 hook，不知道"位置"
│     读 snapshot(revision, generation) / 发 refresh(scope) / subscribe(scope)
│  能力与专属区块：trust / recovery / init 与 push 确认 / 连接状态   │
└──────────────────────────────────────────────────────────────────┘
        ▲  单一 IPC 面（通道名里没有 remote）+ 统一信封
┌─ main ───────────────────────────────────────────────────────────┐
│  RemoteWorkspaceView（每 project 一份）                            │
│    dirCache / repoCache / headFacts + revision/generation          │
│    在途合并 + 刷新预算 + 失效矩阵 + 计数器                          │
│  ProjectFileService / ProjectGitService（位置无关，含写面）          │
│    ├─ LocationBackend "local" → FileSystemService / GitService     │
│    └─ LocationBackend "ssh"   → helper 有界方法（W6 起 + 推送）      │
│  既有授权存储：Git / entry / text，统一作用域与结果语义            │
└──────────────────────────────────────────────────────────────────┘
        ▲  既有 NDJSON 有界方法与事件帧（本轮不改 helper 线协议）
```

四条硬规定：

1. **领域调用按位置分派收口在 main 的 backend 边界。** 共用展示组件只消费能力与状态，不判断 local/ssh；装配层可选择宿主布局和 trust/recovery/init 等专属区块，但不得再实现第二套 Git 规则（门禁 3）。
2. **一个信封**：本轮迁移的公共文件/Git 与 sessions 结果面返回
   ```ts
   type Op<T> = { ok: true; value: T } | { ok: false; code: string; outcome: "rejected" | "unknown"; message?: string };
   ```
   这是目标形状；实际 `shared/op.ts` 尚无 `message`，仅在迁移本地 Git 错误展示确有需要时增补这一可选字段。`outcome` 只按既有稳定码闭集推导，不按位置猜测；本地可读错误说明保留，远端原始 stderr 仍不得外传，说明文字不参与判定。
3. **一份能力快照**：`capabilities(projectId) → { files, git, terminal, session }`，按 generation 管理；信任、连接状态、功能门禁变化也使快照失效。有效能力是 backend 方法、当前权限、连接要求与 scope 策略的交集，不单凭 ready/degraded 标签推导。UI 只读快照决定渲染，实际操作仍由 backend 复验；禁止 `try { call } catch (UNSUPPORTED_*)` 决定 UI（门禁 8）。
4. **显式授权边界**：纯事实读不签发，显式 snapshot 授权仍由 main 现签；存储、动作 kind、消费规则和容量不重写。远端保留一个活动仓库与嵌套选择，策略由共享常量和测试表达（门禁 10）。

## 3. 形状细则

### 3.1 `LocationBackend`

```ts
type LocationBackend = {
  readonly kind: "local" | "ssh";
  files: ProjectFileReader & Partial<ProjectFileWriter>;
  git: ProjectGitService;
  capabilities(): Promise<ProjectCapabilities>;
  dispose(): void;
};
```
- 参数校验的**严格性跟着 backend 走**：ssh 侧继续拒绝未知字段、限制长度、折叠非闭集码；描述表只做形状归一，不削弱校验（门禁 15）。
- 优先扩展已有文件 backend/router 与 Git 服务边界；公共通道委托它们。`LocationBackend` 是职责示意，不要求先造一个大总管或按“33 → 4”改写全部 handler。旧 API 在兼容期只委托同一个服务，不保留第二份事实/业务实现。

### 3.2 `RemoteWorkspaceView`

```ts
type RemoteWorkspaceView = {
  listDir(dir): Promise<{ entries, truncated, revision, generation, hasChildren: "exact"|"unknown" }>;
  statPaths(paths): Promise<Array<{ exists, isDirectory }>>;
  repoList(): Promise<{ repos, truncated, revision }>;
  status(repoPath): Promise<{ groups, revision }>;
  headFacts(repoPath): Promise<{ branch, ahead, behind }>;
  checkIgnore(paths, repoPath?): Promise<boolean[]>;
  refresh(scope): Promise<{ served: "coalesced"|"remote"; calls: number }>;
  invalidate(scope, reason): void;
  watch(scope, onChanged): () => void;
};
```
- `revision` 沿用 main 事实缓存的单调数字版本，并随结果交给 renderer；相等只在同一 generation 内表示同份事实，不是内容哈希。helper 的 Git revision 与文本 version 是独立的写入期望/收据，不得互换。
- `generation` 在 host 断连/重连、locator 变更时 `++`；渲染层跨代数一律丢弃缓存。
- **与编辑器版本令牌划清边界**：`remote:project-text-open|save` 的 `version` 是"写授权收据"（一次编辑会话），`revision` 是"列表/状态新鲜度"（一次读取）。不合并、不互相替代。
- 失效矩阵（写 → 父目录；create/rename/delete → 源+目标；stage/commit → repo+head+受影响目录；checkout/fetch/push → 全目录惰性失效；断连 → generation++）。**失效只标记，不预读**。
- 合并与预算：同 `(project, scope-key, generation)` 的有效在途读合并；显式 refresh 越过已完成缓存，多个消费者响应同一次失效可共享一次刷新。`listRepos ≤1`、每仓 `git.status ≤1` 是单次刷新波的事实方法预算；hello、watch、授权等请求另按 W0 计数，不把这两项冒充总 SSH 帧数。

### 3.3 授权：统一边界，保留现有存储

- 保留 `RemoteGitMutationTokens`、文件 entry token 与 text version 的原有权威、容量、TTL、稳定码和一次性消费；本轮不新建跨域总令牌表。
- Git 的动作粒度是现有 `kind`，不能把 index/commit/branch/sync 全压成一个 `purpose="git-write"` 后互相覆盖。既有 revoke 仍按 sender/project，take 仍校验 repo/kind/身份。
- 纯事实读不签；显式 snapshot 可在当前权限与事实校验后现签。将读与签发组织成两个内部步骤，不等于允许写时偷偷重取 token、重放未知写入。
- main/helper 拥有 revision、expectedHead 与身份判定；renderer 只传 opaque token。远端单活动 scope 保留为策略，不把嵌套仓库功能删除。

## 4. 迁移波次（每波自带 parity 门禁与回滚点）

> **执行纪律**：交接默认单执行者按 §10 串行推进。跨 shared/preload/main/renderer 的契约切片同一执行者完成，每卡保持可验证；不重复实施已落地的 W0、W1 主体、R1a 或 helper 方法。公共汇聚文件按项目规则保持单写者。

| 波 | 内容 | 门禁（必须同时满足） | 回滚 |
|---|---|---|---|
| **W0** | 计数器：helper 每次 `request` 按 `(hostId, method)` 计数 + 快照/格式化 + `PIDECK_REMOTE_METER=1` 时低频日志——**已交付**：`src/main/remote/RemoteCallMeter.ts` 挂在 `RemoteControlClient` 的发帧路径上，`tests/remoteCallMeter.test.mjs` 5 例绿 | 单测覆盖计数/排序/上限/复位/只计发帧请求；typecheck 绿；不改任何行为 | 按原提交撤销自身计量接线与模块 |
| **W1** | 身份去双语义：`FileTreeNode` / `FileSearchResult` / `GitResource` 的 `path` 退役，一律 `relativePath + target`；拖拽负载改 target | typecheck 枚举全部调用点；树/编辑器/拖拽/搜索全绿 | 逐文件 |
| **W2** | 公共文件/Git 与 sessions 统一 `Op<T>`；已迁 entry/text/trust/project/transfer 不重做，hosts 保留归因例外；沿用 shared 唯一 code/outcome 判定 | 既有错误码断言不变；unknown 只由 `OP_UNKNOWN_CODES` 产生；旧兼容 API 集中适配，失败文案不回退 | 按域切换，sessions 最后 |
| **W3** | `RemoteWorkspaceView` + `watch` 形状（事实层只标脏，刷新由 T4 的单一调度者安排）+ 两份 conformance 首版 + `capabilities(projectId)` 快照（“主机可用”只留一个定义，替掉 renderer 的 4 处各自判定）+ 预算计数器接线；文件读直接落在既有 `RemoteWorkspaceReader`（`statMany` 分批 64） | 一次内容变化 `listRepos ≤1`、每仓 `status ≤1`；树与面板读同一 `revision`；W0 基线数字下降 | 整层可旁路（通道临时直连 backend） |
| **W4** | 公共文件/Git 通道委托现有 backend/service；旧 remote API 一版薄兼容，业务与事实只有一份 | 共用业务消费者不再调用 remote 传输面；SSH 校验/能力/结果语义完整；兼容入口另列清单，不宣称通道数已减半 | 按域切片，兼容壳保留一版 |
| **W5** | 渲染层收口：共享状态规则与展示区块；保留远端单活动 scope、嵌套仓选择及全部既有行为 | §4.2 parity 表逐项通过后才删除对应旧代码；不预估净删行数 | 视图区块级 |
| **W6** | helper 的 checkIgnore/watch/unwatch 已有；补主进程订阅身份、配对清理、能力协商、事实失效与 renderer 通知闭环 | 事件只触发失效；watcher/帧预算内；断连/销毁全清；不支持时显式降级且能读到新事实 | 能力协商关闭；保留有效的显式 refresh |

**依赖顺序**：W0/W1/W2 为统一基础；W3/W4 的事实正确性和 W6 的生命周期接线先过门禁，再做 W5。helper 方法已经存在，不能继续把 W6 写成 W5 完成后才开始的工作。

### 4.1 进度（滚动更新，每次合并时就地改）

| 波 | 状态 | 已落地面 |
|---|---|---|
| W0 | ✅ | `src/main/remote/RemoteCallMeter.ts` 挂在 `RemoteControlClient` 发帧路径；`tests/remoteCallMeter.test.mjs`（5 例） |
| W1 | ◐ 主体 | `fileTreeLazy`：`projectFileKey` / `parseFileTreeKey` / `fileTreeNodeKey`（不再退回本机绝对路径）/ `migrateExpandedDirKeys` / `isActiveFileTreeRow`；拖拽负载的 `path` 变可选、远端不再伪造本机路径；展开集旧键按树内 `path` 别名迁移（幂等）；`useProjectSync` / `useProjectFileTreeController` / `FileTreeRows` / `RemoteProjectPanel` 已跟随 |
| W2 | ◐ 大部分 | **entry / text / trust / project（7 类）/ transfer（上传下载）已 `Op<T>`**；`shared/op.ts` 提供 `Op` / `codeOf` / `OP_UNKNOWN_CODES` / `opFailFromCode`；`codeOf` 独立实现 **10 份 → 1 份**（`remoteHostInputValidation` 改 re-export）；`tests/envelopeSingleSource.test.mjs` 守不变量 |
| W3 | ◐ 目录族已接线 | `RemoteFactCache` / `RemoteWorkspaceView`（三族形状 + 失效矩阵 + `onChanged`）；`ProjectCapabilities` 下沉 shared 并替掉三处「已连接」判定（R3 已修）；**目录族已进生产**：`remoteProjectIpc.list` 走事实层并返回 `{entries, revision}`，entry/text 写成功后标脏（`tests/remoteProjectDirFacts.test.mjs` 7 例） |
| W4 | ◐ 原型已落地，前置门禁未过 | Git 事实与签发的代码已拆开，但缓存命中绕过读门禁、缺强制刷新与跨代失效，在途失效可丢失。共用 status/workspaceDiff/listRepos/refs 已有路由；refs 的 ProjectFileTarget scope、嵌套文件 target 与列表截断元数据仍有缺口，不能按“4 个已完整统一”验收 |
| W6 | ◐ helper/client 已有，主进程订阅未闭环 | helper 1.24.0 的 checkIgnore 与事件帧此前有真机记录；本次审核发现 session 包装对象被误当订阅身份，目录重载重复建 watcher；无配对 unwatch、未接能力门控，事件只标脏根目录，未接 Git 事实与 renderer 订阅。不得据此声称“界面 3 秒内更新” |
| W5 | ◐ 审核后待修前置 | 共用视图方向保留；GitDrawerApi 是可复用的注入口，不是已经满足远端语义的完整契约。先补下述行为矩阵、状态所有者与失效门禁，再逐片迁移；不预估适配器行数或承诺删除数量 |

**W2 的未完成项与理由（不是遗漏）**

- **sessions 域（scan / title / register）留到 T9 迁移**：结果面转 Op，保留 R1a 的生产传输、root 隔离与既有测试；不与 UI 状态迁移同片修改。
- **hosts 域（约 20 类）不按 `Op<T>` 迁移**，改为文档化例外：`RemoteHostOperationFailure` 带 `hostId` 回显（并发请求交错时的可归因性），而 `OpFailure` 刻意只有 `code` + `outcome`。强行迁移要么丢掉回显、要么把 `hostId` 塞进 value 让失败分支失去归属。hosts 域本来就已经信封化；保留归因信息，沿用共享错误判定。renderer 连接状态的统一不意味着放宽各 backend 的真实操作权限。

**W3/W4 的事实与授权边界**

- 缓存只能复用事实，不得复用一次性 token；当前 `git:remote-snapshot` 仍会在读取后现签 token，并不是“写时才授权”已经落地。
- `RemoteGitSnapshotFacts` 已被 snapshot 与共用 status 使用，但缺少显式强制刷新、外部变更、host/locator/trust 变化与 unknown 写结果的失效接线；现有缓存命中还跳过了 `read()` 和 service 的门禁。**现签 token 不能把旧事实变新，也不能替代逐次授权校验。**
- renderer 只能持 opaque token；`RemoteGitMutationTokens` 在 main 拥有期望身份，`RemoteGitService` 在实际发帧时注入期望条件。index/commit/discard/sync 等用 `expectedRevision`，create/switch branch 用 `expectedHead`；不能概括为“所有写都由 renderer 带 revision”。
- 同一项目仅一个活动仓库面板是令牌策略；**仍须保留选择嵌套仓库**。仓库列表不得在归一时丢失 `truncated`。

**建议后续实施顺序（本轮不执行）**

1. 修 W3/W4 前置：缓存命中仍经过身份/权限/生命周期检查；显式 refresh 真正重读；外部变化和 unknown 写标脏；在途结果按 generation 丢弃。详见 §4.2 的 F1/F2。
2. 修 W6 订阅生命周期与通知闭环；在推送覆盖范围不足时保留显式刷新，不把永远命中旧缓存的读取称为轮询降级。
3. 按 §4.2 行为矩阵固定公共语义；相同语义才归一，差异由能力或明确模式表达。共用 Git 通道族仍是 W4 目标，renderer 适配器不能作为完成 W4 的替代品。
4. W5 分片迁移共用展示与状态逻辑；覆盖全部既有远端行为后退役重复实现，保留兼容入口与专属区块。sessions 域信封归 W2/W4 留项，在 T9 单独验证，不与 UI 切片交叉改。

**并行约束（重要）**：`src/main/sessions/` 上还有别人的改动时不碰它；`src/main/index.ts` 是公共汇聚文件，只由装配相关的那一波改。

### 4.2 W5 / W6 审核与修订建议（本轮不实施）

**W6-a `git.checkIgnore`：已有能力，只接公共消费面**

helper 1.23.0 引入、当前 1.24.0 保留该方法，单批最多 64 路径；通过 argv 调用 `git check-ignore --no-index`，按请求顺序返回 boolean，exit 1 是正常无命中。`RemoteGitService.checkIgnore` 与 `remoteGitReadIpc.checkIgnore` 已有实现。T6 收尾已按这条接上线：`remoteGitReadIpc.probeIgnore`（最长仓库前缀归因、64 路径/批、能力门控）→ 远端目录页 → 渲染层置灰；不新增 helper 方法、不降版或重钉未改的 bundle。相关事实以当前源码和 `remoteHelperEntry` 既有方法测试为准。

**W6-b `fs.watch`：helper 已有，T2/T4 补全上层并做真机验证**

1. 帧形状：沿用既有请求/响应与**事件帧**（无 `id`，带 `watchId` 与 `paths`）；
   客户端按 `hostId + generation` 围栏，断开即丢。
2. 已有 `watch({paths})→{watchId}` / `unwatch({watchId})` 两个方法；watcher 数、路径数、
   事件频率都有上限，超限拒绝而不是排队。
3. 150ms 防抖在 helper 侧做（同一目录的连写合成一次事件），主进程只做失效——
   即 `RemoteWorkspaceView.invalidate`，**不重新装载**。
4. helper shutdown 已清理 watcher；主进程仍须补齐断连/销毁的登记清理与成对退订。
5. 降级：能力为 false 或订阅失败时，必须有可验证的显式刷新/有界只读轮询；当前尚无完整兜底接线，不把 catch 后静默返回称为已经降级（见 T4）。
6. 门禁（真机）：推送覆盖目录内改文件 3 秒内树更新、断开后无事件泄漏、watcher 上限生效、事件不触发装载风暴。

**W5 审核结论：方向可行，当前“薄适配器直接换面板”的方案不可直接实施**

审核基线：`c26dbb85d`。本次交接只保留治理文档；生产源码和测试已核对与基线一致，没有实现修复随交接交付，也没有提交。

`GitPanel` 通过 props 注入 Git 操作，这是已经核实的复用点；但它同时拥有定时器、状态机、自动 fetch、smart commit 和错误处理。`GitDrawerApi` 的 28 个方法是当前本地宿主的接口数量，**方法同名不等于行为等价**。不能从行数或方法数推出“150 行适配器”“净删 1200 行”，也不能取消 W4 的单通道目标。

**审核发现（P1 为迁移前阻断；P2 为需纠正的设计结论）**

| ID | 级别 | 已核实的问题与影响 | 代码证据（相对仓库根） |
|---|---|---|---|
| F1 | P1 | snapshot/status 的 cache hit 不执行正常 read 边界；暖缓存后撤销 trust、dispose IPC 服务仍能返回成功快照并重新签 token。写端仍重验 trust/身份，这不是已证明的越权写，但读与 grant 生命周期不符合契约 | `src/main/ipc/remoteGitReadIpc.ts`：`read`、snapshot、`status`、`dispose`；`src/main/git/RemoteGitService.ts`：`run` |
| F2 | P1 | 显式刷新仍读写前缓存；unknown 写不会触发成功分支里的 invalidate。Git 与目录两份缓存的在途 load 在 invalidate/clear 后都能重新写回旧值，旧 finally 还可能删除替代请求 | `src/main/git/RemoteGitSnapshotFacts.ts`、`src/main/remote/RemoteFactCache.ts`；`remoteGitReadIpc.ts`：`read(mutating)`；`remoteGitViewState.ts`：`refresh` |
| F3 | P1 | 当前共用面板挂载/非 silent refresh 后会 fetch，另有 5 分钟 fetch 和 5 秒 status 轮询；写失败没有远端 unknown 的持续状态，非仓库识别依赖 stderr 正则。直接接远端会引入自动网络写，并丢失持续告警、禁写与明确恢复条件 | `src/renderer/src/components/app/GitPanel.tsx`：`refreshAheadBehind`、`refresh`、timers、`act/runCommit`；对照 `remoteGitViewState.ts` 的 unknown/connection/dispose 状态 |
| F4 | P1 | 历史、比较、新建分支、批量写、删除并非仅字段不同；直接转发会改变行为或丢功能，详见下表 | `src/main/git/GitService.ts`、`RemoteGitService.ts`、`RemoteGitReadSource.ts`、`GitGraph.tsx` |
| F5 | P1 | “远端只有根仓”错误：现有 UI 支持根/嵌套仓选择且嵌套可写。共用 refs port 拒绝合法 ProjectFileTarget repo；嵌套 status 的 target 仍是仓库相对路径，不能直接交给按项目路径打开文件的入口；共用 listRepos 丢了截断标志 | `RemoteGitPanel.tsx` 的 repo selector；`remoteGitReadIpc.ts`：`refs/status/listRepositories`；`RemoteGitService.ts`：`readRemoteGitStatus`；`gitIpc.ts`：本地 target 装饰 |
| F6 | P1 | W6 用每次新建的 session 对象作为 watcher 身份，同一 helper 的根目录重载被误认成换会话；旧 watcher 未 unwatch，第四次变更后的重载申请第 5 个订阅失败，登记表已清，后续事件失效。事件也尚未通知 renderer/Git 缓存 | `RemoteHostConnectionService.ts`：`establishProjectSession` 返回新对象；`remoteProjectIpc.ts`：`ensureRootWatch/onHelperEvent`；`RemoteDirWatchRegistry.ts`：`ensure`；`index.ts` 的 `onHelperEvent` 装配 |
| F7 | P2 | 只给 GitPanel 加 capability 标志不够：图谱菜单仍会渲染可选回调的动作，缺回调时 optional call 仍走“成功”分支；commitCount 是图谱 load 的必调项。门控必须覆盖实际消费者与后台 effect | `src/renderer/src/components/app/git/GitGraph.tsx`：`load/runGitAction`、右键菜单；`GitPanel.tsx`：effects |
| F8 | P2 | 现有测试含远端宿主入口与同步区的源码形状断言。重构时可改为当前契约的行为验证，保留仍有效的授权/同步/恢复覆盖；真实职责未迁完的入口与专属区块继续保留，不用假壳迁就旧形状或修改断言骗绿 | `tests/remoteGitDrawer.test.mjs`、`remoteGitSyncBar.test.mjs`、`remoteGitRepoScopeView.test.mjs` |

**行为对照与保留条件**

| 能力 | 本地当前行为 | 远端当前行为 | 统一时的决策 / 配对验证 |
|---|---|---|---|
| 仓库发现与 scope | 多仓 changes 并排，history 选仓；repo 参数是 ProjectFileTarget | 根/嵌套可选，同一时刻一份活动 scope；列表带 truncated | 保留远端仓库下拉和截断提示；同项目两个嵌套仓互不污染，切换时取消旧读/撤销旧 grant；不得硬编码 `repoPath=""` |
| 文件身份与 workspace diff | target 相对项目 | 既有远端路径在嵌套 repo 下相对仓库 | 公共 target 统一为项目相对；在 main 边界转换 helper repo 相对路径；验证 `packages/a/file.txt` 打开、diff、写入只到该文件，避免前缀遗漏/重复 |
| status / refresh | 本地面板自行轮询 | snapshot 同时携带事实与 opaque tokens；读取有 host/trust 条件 | 区分读缓存与强制 refresh，按 scope/generation 有唯一事实 owner；先通过 F1/F2，再接共享状态 |
| history / count / graph | log 支持 ref/path/allBranches、topo-order、最多 500；图谱同时必调 count | HEAD 的有界 maxCount + skip 页，返回 hasMore；没有任意 ref/path/allBranches/count 或 topo-order 保证 | 共用历史列表支持显式分页/未知总数，远端保持 HEAD 模式；不能吞参数、虚构 count 或把普通分页当全分支拓扑图。100 条以上、失败页保留已有行要有用例 |
| commit detail / file diff | 返回 CommitDetail 与项目 target；rename 可读 originalTarget | oid-only、有界消息/文件；revision diff 由确定的两个 OID 取内容，根提交 base=null；现有 rename diff 按单 path 语义 | 确认边界后才做字段适配；保留根提交、rename、二进制/超限拒绝。Drawer 的 `onOpenCommitFileDiff/onOpenFile` 在 GitDrawerApi 之外，必须一并接线 |
| refs / compare | 分支比较 `diff A...B`（merge-base → B），有 ahead/behind；当前 CompareChanges 无逐文件打开回调 | heads/tags 全名，直接 `diff A B`；返回已解析 OID，可点文件开 diff，不返回 ahead/behind | 比较模式必须显式表达；保留远端 tag 选择与按结果 OID 打开。禁止换个字段就伪装为本地 BranchDiffResult，禁止填 0 冒充 ahead/behind |
| stage / unstage / discardFiles | 批量 target；目录操作、stage-all、smart commit 会调用 | 单文件 + resource group + 一次性 token；每写一次后必须读新事实 | 首轮仅开放原有单文件写；远端批量/目录/smart commit 显式缺席。不能循环消费同一个 token；不以隐式重取 grant 掩盖部分成功 |
| discard / deleteFiles | discard 与移入系统回收站的实际删除是不同动作；tracked 删除会留下 deleted 状态 | Git discard 对 tracked 还原到 index，对 untracked 备份后删除，并返回 recoveryRef；不是通用 tracked 删除 | 保留 recoveryRef 和恢复清单；远端通用 deleteFiles 无等价 Git 动词，若以后接文件域须遵守其独立授权。禁止把删除映射成还原 |
| createBranch / checkout | createBranch 使用 checkout -b，创建并切换 | createRemoteBranch 仅创建，不移动 HEAD；switch 独立动作；期望是 expectedHead | 以“仅创建 / 创建并切换”区分行为，不暗中追加第二次写。保留现有远端只建不切、冲突不丢文件 |
| commit | smart commit 可先批量 stage；面板 trim 消息 | 只提交当前 index、消息原样有界、成功才清草稿、unknown 保留 | 共用状态保留明确结果；远端不得自动 stage、重放或修改消息；每个写入点仍由 main/helper 校验 |
| sync | fetch 默认行为含后台定时；push/pull 简单 Promise<void> | 显式 fetch/push/pull，独立 kind grant，remote/branch/upstream 门控；push 二次确认；保留 outcome | 共享同步视图由策略区分手动与后台；远端挂载/计时/聚焦不发网络写，保留确认、无上游/dirty/冲突/未知结果及 outcome 文案 |
| trust / recovery / init / 断连 | 当前本地面板不能承载全部语义 | trust 门、恢复列表/还原/清理、根目录 init 确认、host 失效清事实、unknown 跨重连粘性保留 | 作为明确的专属区块与共享状态输入保留；“只剩 recovery/trust”不成立，不能删除 init/push 确认和连接状态围栏 |
| 高级写 / refs watch | cherryPick/revert/reset/dropCommit/AI summary；refs watch 可选 | 没有对应远端高级写；refs 用受可见性与 host 状态限制的只读轮询 | 能力缺席时按钮/菜单和 effect 都不运行；不传 no-op，不让缺回调操作显示成功；snapshot 的 grant 缺席仍须即时禁写 |

**建议修订的实施顺序（本轮不执行代码改动）**

1. **先修前置。** F1/F2/F5 覆盖缓存、身份与 scope；F6 覆盖稳定会话身份（不能只用 host store revision，重连不一定改变它）、订阅去重/unwatch、能力协商与失效通知。一个 watcher 可包含至多 32 个目录，helper 最多 4 个 watcher；不是最多只能监控 4 个目录。根层非递归监听不能保证深层文件或 .git 内部变化被发现。
2. **在现有 main Git 领域边界归一公共事实与结果。** 保留 `ProjectFileTarget`、分页/截断元数据、比较模式和 `Op<T>` 的 rejected/unknown。相同语义使用一份转换；不把远端所有动词强转成本地旧类型，也不为“对齐”扩写 helper 能力。
3. **先承接状态规则，再替换视图。** renderer 的共享 controller/hook 承接单活动 scope、读写互斥、迟到结果围栏、opaque grant 失效、unknown 告警和明确刷新；main 继续是 grant 与期望条件的权威。`remoteGitViewState` 的这些行为不是可删除的传输样板。
4. **以视图区块为单位共用。** 优先复用已存在的 FileTree/FileDiffViewer，再迁变更区、历史/比较、同步区与宿主布局；`GitDrawerApi` 可用作迁移期注入口，但需要收窄能力、移走面板内的副作用策略。让存量巨文件不净增长，不把所有新逻辑塞入 GitPanel。
5. **最后退役重复实现。** 上表每项必须有原行为与新路径的覆盖对照。仍有真实职责的 `RemoteGitPanel` 等入口和远端专属区块保留；共用状态/展示迁出后可留薄包装，旧 IPC 保留一版委托兼容。过时测试按新契约更新并说明覆盖变化，不造无效代码满足源码断言；不以物理删除三个文件为验收条件。净行数以完成切片后的 diff 测量。

**本次验证证据与未验证项**

- `npm run typecheck`：退出码 0。
- 定向 9 文件：`remoteGitReadIpc`、`remoteGitSnapshotFacts`、`remoteGitMutationTokens`、`remoteGitMultiRepoTokenScope`、`remoteGitMutationView`、`remoteGitRepoScopeView`、`remoteGitViewState`、`remoteProjectDirFacts`、`remoteDirWatchRegistry`（均为 `tests/<名称>.test.mjs`）：**89 pass / 0 fail / 0 skip**。这些是现状回归，不代表改造方案已通过。
- 离线探针（通过 `loadTsCommonJs` 加载生产 IPC/service/cache，transport 替换为内存应答；未连接远端）：
  - 同 scope 先读 branch=before，transport 改为 externally-changed，再调 snapshot：仍返回 before，status 装载计数仍为 **1**。
  - 暖缓存后 trusted=false 或 port.dispose()，再调 snapshot：均 **ok=true 且签新 token**，trust 检查计数不增加。
  - fake stage 改变后端状态后抛 REQUEST_TIMEOUT：写返回 **GIT_WRITE_RESULT_UNCONFIRMED**；随后 snapshot 仍返回写前 branch，status 装载计数仍为 **1**。
  - load 挂起时调用 invalidate 或 clear，再让旧 load 完成：下一次 read 均 **cached=true、facts=旧值**，新 loader 未执行。
  - refs 传 `{projectId:"p",relativePath:"nested"}`：**GIT_RESULT_INVALID**；同 scope status 结果 target 是 `tracked.txt`，未带 `nested/` 前缀。
  - 生产目录 IPC + 模拟同 helper（每次 task 使用新 session 包装，遵循真实 establishProjectSession）+ helper 的 4 watcher 上限：初读加 4 次变更重读共申请 **5** 次 watcher；第 5 次被拒后，再发旧 watcher 事件，装载数不再增加。
- 原生 Git 临时裸仓对拍（仅测试夹具，已清理）：从公共父提交左右各新增不同文件，禁用 rename 检测时两树 diff 得到左文件删除+右文件新增，三点 diff 仅右文件新增，证明比较语义不同。不是 UI 测试。
- **本次未跑 SSH 真机 / Electron E2E，也未实施上述修复。** 后续实现必须把上述探针场景变成行为回归；更换远端宿主前，再在专用 `serve` 夹具核对嵌套 scope、unknown、刷新和 watcher 生命周期。已有 helper 真机记录不能代替完整接线的验收。

## 5. 明确不重写（重写零收益，只有风险）

| 不重写 | 为什么 |
|---|---|
| helper 线协议与产物（NDJSON 帧、冻结 SHA、bundle） | 复用现有有界方法与事件，本轮无需改 helper 产物 |
| bootstrap / pin / 指纹 / trust / 会话恢复 | 安全面最贵的部分，与本主题正交 |
| 令牌**语义**（纯事实读不签、显式 snapshot 授权、单次消费、CAS、unknown 不重放） | 是资产；签发/期望权威仍在 main/helper。进一步拆出授权接口是 W4 待实现目标，不是当前事实 |
| 远端终端 / 会话 / 模型与配置链路 | 已是同一种"帧 + 推送"形态，W6 反而拿它当模板 |

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 合并通道弱化 ssh 校验 | 校验跟着 `LocationBackend` 走，不进描述表；W4 加"仍拒绝未知字段/超长/非闭集码"的负例门禁 |
| 统一信封把 `unknown` 拍成 `rejected` | `outcome` 为必填；`unknown` 仅由 `shared/op.ts` 的 `OP_UNKNOWN_CODES` 闭集产生（当前 7 个写面码），禁止再造第二份名单 |
| 事实层退化成"更大的陈旧缓存" | `revision` 必须可证伪：写后定向失效 + 显式 refresh + 计数器；禁止用 TTL 当正确性依据 |
| W5 删太快丢行为 | 先写 parity 表（远端每个可见行为 × 归属 × 证据），逐项勾销，不靠"看起来一样" |
| W2 面积大（本机也改信封） | files/Git 分卡；新公共入口用 Op，旧异常 API 集中用 opError 兼容，不机械改全库调用点 |

## 7. 质量门槛

| # | 判据 | 检查 |
|---|---|---|
| 1 | 文件树加载实现 = 1 | `childrenByDir` 只出现在 controller/`fileTreeLazy` |
| 2 | 产品内置过滤规则来源 = 1 | 产品名字表只在 `shared/fileTree`；Git ignore 则由 backend 的 Git 判定，渲染层不各写一份 |
| 3 | 位置分派有明确边界 | main 领域分派收口在 backend；共用展示组件不判断位置；装配层只组合已声明的能力/专属 UI，不另写 Git 规则 |
| 4 | Git 面板位置无关 | `GitPanel.tsx` 中 `remoteGit` 出现 0 次 |
| 5 | 不以迁移位置冒充收敛 | 完成切片的旧管线删除量与新增共享代码量分别实测；临时适配明确退役条件，存量巨文件不净增长 |
| 6 | 契约测试覆盖两实现 | 两个 conformance 文件 + 分歧账本被断言 |
| 7 | 有效安全边界覆盖保留 | `remoteGitMutationTokens`、`remoteProjectTrustIpc`、`remoteProjectReadConcurrency`、`remoteFileStatTokenPressure` 验证当前契约，测试演进不得遗漏仍有效的安全边界 |
| 8 | 能力显式缺席 | 能力缺席时按钮、菜单及后台 effect 均不可触发对应操作；运行时 grant 缺失立即禁写 |
| 9 | 令牌红线 | 远端 `list/stat/pathsExist/checkIgnore` 前后令牌数不变；树着色只走 `git:status` |
| 10 | 单活动 scope 是策略 | 策略常量被生产入口使用且有行为测试；远端同一时刻一个可写仓库，仍可切换根/嵌套仓 |
| 11 | 事实同源 + 预算 | 计数器断言：一次内容变化 `listRepos ≤1`、每仓 `status ≤1` |
| 12 | 订阅形状就位 | `watch/unwatch/onChanged` 被树与面板使用；刷新调度只有一个 owner；不支持推送时有界只读兜底，不自动 fetch |
| 13 | ignore 权威 | 无自写 gitignore 匹配逻辑；`ignored` 是修饰不是过滤 |
| 14 | **公共信封唯一** | 新公共入口统一 `Op<T>`，失败 outcome 必填；旧 API 的兼容返回与 hosts 归因例外单列，不进入共用业务状态 |
| 15 | **ssh 严格性未降** | 未知字段/超长/非闭集码的负例测试仍全绿 |
| 16 | **测量可用** | `RemoteCallMeter` 有单测；W3 起把它接进预算断言（数字来自代码，不来自人工统计） |

## 8. 实施决策（执行者无需重复拍板）

1. files 读面先于 Git 公共契约；写面只先归一 create/rename，delete/move 与回收站独立语义保留。
2. 本机 `hasChildren` 保留 exact；远端 unknown；公共目录页 2000 条且显式 truncated。
3. 远端一个活动仓库，保留根/嵌套选择；不改 token 的多仓撤销策略。
4. helper 现有 1.24.0 足以开始本轮；先修主进程生命周期，不重写 bundle 或借统一补高级 Git 能力。
5. 共用的是领域事实、状态规则与可复用视图区块；保留装配入口和专属 UI。公共业务调用转向统一通道，旧 preload/IPC 委托兼容一版，不承诺立即删除通道名。
6. 无法由相同输入产生相同语义的动作使用 §4.2 的显式模式/能力；禁止填假 count、假 ahead/behind、吞不支持参数或让 no-op 显示成功。

## 9. 证据与入口

| 用途 | 命令 / 路径 |
|---|---|
| 远端调用计数（W0） | `node --test tests/remoteCallMeter.test.mjs` |
| 文件 stat 令牌压力 | `node --test tests/remoteFileStatTokenPressure.test.mjs`（4 例） |
| Git 多仓令牌冲突 | `node --test tests/remoteGitMultiRepoTokenScope.test.mjs`（3 例） |
| 既有令牌/文案语义 | `node --test tests/remoteGitMutationTokens.test.mjs tests/remoteProjectEntryState.test.mjs` |
| 远端门禁现状 | `tests/remoteChannelGate.test.mjs`、`tests/remoteHostIpc.test.mjs`（发布策略、能力下发与入口可见性） |
| 参考实现（只读对照） | `F:/ZCode/packages/ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts`（仅参考订阅生命周期，不作为本仓完成证据） |
| 本仓推送先例 | `src/main/terminal/RemoteTerminalSessionManager.ts`（`emit(senderId, channel, payload)`）、`git:watch-refs` |

## 10. 小模型执行手册

### 10.1 开始前与每卡交付规则

- **本次交接只交付计划。** 下列 T1–T9 均待实施；不存在已接好的 `RemoteGitFacts.ts` 等新模块。先看 `git status --short` 与 HEAD；不清理、覆盖或暂存他人改动。
- 先读根 `AGENTS.md`，再按任务卡路由读架构/工程/Electron/UI 文档。只读所需调用者与测试，不做全仓扫改。
- 每卡先新增能复现该卡问题的行为测试，确认按预期失败；再实现并跑该卡门禁与 `npm run typecheck`。不改写/删除既有测试，不增加只扫描源码的测试。新文件名在下文标为“新增”。
- 代码变化按文件显式格式化；禁止全量 build、自动安装依赖、重启当前宿主或默认提交/push。已有审批范围内的下一卡直接继续，技术实现选择不反复问用户。
- 每卡在本文进度行记录：完成文件、用例结果、未验证项、下一卡。失败先定位；无法满足原安全断言时停止该卡，不用兼容猜测或放宽检查继续堆改动。
- **兼容策略**：公共业务使用新共同契约；旧导出/IPC 可保留一版委托。装配壳或远端专属 UI 不等于第二套数据层；两个独立缓存/控制器做相同规则才是未收敛。

### 10.2 顺序与文件范围

| 卡 | 依赖 / 完成目标 | 首选修改范围（新增文件只在确需拆分时创建） | 必须新增的行为证据 |
|---|---|---|---|
| T1 | 起点；两份缓存的在途失效正确 | `RemoteGitSnapshotFacts.ts`、`RemoteFactCache.ts` | 新增 `tests/remoteFactInvalidationRace.test.mjs`：见下文 R1–R4 |
| T2 | T1；main 有稳定 helper 身份，订阅不泄漏 | `RemoteHostConnectionService.ts`、`RemoteDirWatchRegistry.ts`、`remoteProjectIpc.ts`；必要的生命周期装配 | 新增 `tests/remoteDirWatchLifecycle.test.mjs`：同 helper 的新包装对象不重订、并发 ensure、换代/迟到订阅/关闭 |
| T3 | T1/T2；事实读取与授权逐次校验，refresh 真读 | `remoteGitReadIpc.ts`、`RemoteGitService.ts`、目录 list 的入口与事实协作者 | 新增 `tests/remoteGitFactsBoundary.test.mjs`、目录暖缓存门禁用例：见 R5–R10 |
| T4 | T2/T3；写/事件/重连 → main 事实失效 → 活跃订阅者重读 | `RemoteWorkspaceView.ts`、目录/Git 的共享事实 owner、`shared/ipc.ts`、`preload/index.ts`、对应 IPC 与 `main/index.ts` 装配 | 事件不直接装载；双消费者同 revision；退订/隐藏/断连后无读；无 watch 能力仍可刷新 |
| T5 | T3；公共 Git target 正确，旧远端调用仍正确 | `gitIpc.ts`、`remoteGitReadIpc.ts`、旧远端 API 注入边界、必要的纯路径转换函数 | 根仓 + 两个嵌套仓、rename oldTarget、双向 workspace/revision diff；同名前缀与跨仓目标拒绝 |
| T6 | T4/T5；公共文件读契约与 shared Op 完整 | `ProjectFileBackend.ts`、`LocalProjectFileBackend.ts`、`filesIpc.ts`、`RemoteWorkspaceReader.ts` 的调用端、相关 shared 类型、preload、文件树 hook | 新增 `tests/projectFileBackendConformance.test.mjs`；2000/2001、失败/截断、128 路径分 2 帧、stat 不签 token、显式刷新 |
| T7 | T4–T6；公共 Git 领域契约，位置差异不再靠 remote API 命名 | Git 服务/IPC、`shared/types/git.ts`、preload、`GitDrawerApi` 的调用边界 | 新增 `tests/projectGitBackendConformance.test.mjs`；按 §4.2 每组分别验证公共调用者与 local/ssh 实现；未知写不重放 |
| T8 | T6/T7；共享文件树/Git controller 与视图区块 | `useProjectFileTreeController.ts`、`useRemoteFileTree.ts`、`GitPanel.tsx`、`GitGraph.tsx`、`RemoteGitPanel.tsx`、`remoteGitViewState.ts`、相关 hooks/抽屉 | 新增公共路径的运行时/DOM 用例；远端挂载与定时不 fetch；完整保留 history/compare/recovery/trust/init/sync；既有宿主测试不改 |
| T9 | T8；收尾信封留项、调用预算与端到端验收 | `remoteSessionIpc.ts` 的 scan/title/register 结果及直接 shared/preload/renderer 消费者；相关测试/本文 | sessions 原能力不变；T1–T8 门禁复核；本地 Git E2E + 远端 Git/树定向验收；兼容清单与未验证项清楚 |

表中源码短名按仓库既有位置定位；不是让执行者新建同名第二份模块。T6–T8 面积较大，按下述内部顺序完成一个可验证子项再继续。

### 10.3 T1–T5 的实现约束与确定回归

**T1：以装载身份或 generation 围栏保护结果发布。** `invalidate/invalidateWhere/invalidateProject/clear/clearWhere` 都要覆盖“只有在途请求、尚无缓存值”的 key。失效退休旧请求，下一次读可建立新 flight；旧请求的成功、失败和 finally 都不能覆盖/删除新 flight。退休读返回既有 `REQUEST_CANCELLED`，不发布旧成功；保留 LRU、同代合并、失败不造空值。

| 回归 | 场景 | 必须结果 |
|---|---|---|
| R1 | load A 挂起 → invalidate → load B → A 成功/失败 → 第三个读加入 B | A 取消；B 不被 A.finally 删除；第三个读与 B 合并；装载总数 2 |
| R2 | load A 挂起 → clear/clearWhere → A 完成 | 旧值不重新入缓存；下一次读装载新值 |
| R3 | 仅有在途 load → invalidateProject/invalidateWhere | 仍能退休该 load；不因 entries 为空漏掉它 |
| R4 | 重复失效、其他项目、失败、LRU | 既有测试保持；失效本身装载数不增加 |
| R5 | 暖缓存后 trust 撤销、项目移除/locator 改变、sender 销毁、IPC dispose、host 离线 | 各自稳定拒绝；不返回缓存成功、不签新 grant；不恢复离线连接 |
| R6 | 同 host store revision，helper 重连/换 root 后再读 | 旧 generation 的缓存与迟到读均不可发布 |
| R7 | 外部改文件 → 用户 refresh | 越过已完成缓存；返回新事实；响应同次通知的其他消费者不重复读同 scope |
| R8 | 写已发出但超时/断连/答复畸形 | 保留 unknown；标脏但不自动读/重放；下一次明确核对读新事实 |
| R9 | 两个 sender 合并读，任意一人取消 | 取消者拿不到成功/token；另一个仍可完成；取消不得扩大为另一窗口的写/读撤销 |
| R10 | helper 给畸形 status 或非法 revision | 失败不缓存为事实；后续合法回复可以恢复；禁止缓存未校验原始响应后反复拒绝 |

**T2：身份来自真实 helper 生命周期。** 使用 manager 实例身份 + connection generation（或等价的稳定主进程 token）；同会话新 session 包装必须同 key，重连/换 root/换 manager 必须异 key。不能仅用 hostId、hostRevision 或 session 包装对象。先合并同 key 的 ensure；旧订阅迟到时不登记新代，清理也不能跨代关闭新 watcher。每个订阅有成对 unwatch/生命周期清理；断连、项目关闭、窗口销毁都有入口。

helper 上限是 **4 个 watchId，每个最多 32 路径**，不是 4 个目录。按实际 capability 决定订阅；空 watchId/失败不登记。目录读取成功不因 watch 失败改报失败；订阅请求保持有界，不把无约束异步请求带出锁后打到别的 root。新增行为测试需模拟真实 service 的“新包装、同 helper”方式，不再只重复传同一个假 session。

**T3：缓存不是权限旁路。** 调用方校验在共享结果之外，每个 caller 都有自己的取消/存活边界；helper 访问仍走原 service 的 locator/trust/连接/root/能力检查。把已校验事实的读取放进这个边界，返回/签发前确认身份仍有效；不在 IPC 外层直接缓存整个授权快照。共享读不得持有 host operationLock 再等待另一个也要获取该锁的 loader；用带真实串行锁的替身验证，避免仅在无锁 mock 下通过。

显式 refresh 与普通缓存 read 必须区分；并发消费者可合并同一次刷新，已经完成的旧缓存不能满足新的明确核对。写成功与 unknown 都使相关事实失效；unknown 告警只能由明确的新事实核对解除。没有稳定 helper 身份时禁用跨调用持久缓存，不能猜 identity。保留现有 Git `requireReady` 门禁，不根据泛化的“主机可读”标签放宽它。目录 list 也要逐次解析当前项目/连接，不只在 loader 内检查。

**T4：唯一事实 owner 与通知闭环。** dirs/repos/status 接到同一个项目事实 owner；授权仍单独现签。延用 `RemoteWorkspaceView` 的 scopes/onChanged，跨 IPC 事件至少携带 projectId、generation、被标脏 scopes；订阅绑定 sender/project，preload 返回 unsubscribe。新增通道必须常量/handler/preload 三处同步。

helper 事件与写操作仅标脏、发通知；只有活跃读者决定装载，隐藏/收起/关闭时退订。展开目录登记其真实路径，根层非递归 watch 不宣称覆盖深层文件或 .git 内部；未覆盖的可见 Git/目录 scope 使用单 owner 的有界只读刷新兜底（沿用 5 秒 status、15 秒 refs 的既有节奏，单飞且可停止），显式刷新始终有效。禁止后台 fetch，禁止兜底轮询切换其他项目的 helper root/自动重连。分别验证“支持推送”和“不支持/订阅失败”，后者不能只是吞异常。

**T5：public 与 legacy 路径分界要一次改全。** 公共 repo/file/oldTarget 一律项目相对；helper 与旧 remote controller 的仓库内路径在边界显式转换。尤其 `remoteGitViewState.openDiff` 已走公共 `workspaceFileDiff`，不能只改 main 就结束：在真实 API 注入边界前缀化其请求、按旧控制器契约适配响应，或同批迁移其所有输入输出。拒绝对同一个参数“有前缀就剥、没前缀也当合法”的猜测式兼容。纯转换函数之外，必须通过真实注册 IPC + 实际 renderer API 适配层测试嵌套仓。

### 10.4 T6–T9 的公共形状与迁移次序

**T6 文件域，顺序固定：** list/stat/pathsExist → read/search → create/rename → 共用 lazy controller。

- 复用现有 backend/router 和 `RemoteWorkspaceReader`；按 reader/writer 能力拆接口，未支持的 delete/move/copy 不实现 no-op，不伪造本地路径。
- 公共 list 成功载荷：`entries + truncated + revision + generation`，entry 含 `target/relativePath/type/hasChildren/ignored`；limit=2000。保留目录优先和现有隐藏系统/回收站规则；Git ignore 作为修饰，不与保护性隐藏规则混为一谈。
- 本地 exact、远端 unknown 的 hasChildren 如实声明；字典/DOM 不用“没有子项”冒充“尚未查”。stat/pathsExist 只走 fs 只读面，128 路径按 64 分批；任一批失败不得给部分成功伪装为完整数组。
- 统一信封直接引用 `shared/op.ts`；unknown 用唯一闭集。create/rename 保留原授权和 unknown，文本 version 与回收站不借此重写。旧通道薄委托，先迁直接消费者再删重复 loader。
- ignore 使用已有 `git.checkIgnore`，每批最多 64 路径；在需要显示的目录页按需批量计算并复用结果，不逐行发请求。该调用单列预算，不能藏在“一次 list”计数里；`.gitignore`/相关仓库事实变化后作废对应结果。

**T7 Git 域，按能力组迁移，不按方法数量机械映射：** repos/status/refs → history/detail/diff/compare → index/commit/branch → sync/recovery/init。

**增量公共入口（T6/T7 同一原则）**：不要把既有裸数组/异常接口原地改成对象/Op，让旧消费者在两卡之间失效。以下新增入口服务两种 backend；旧入口转发同一领域服务并适配原返回形状。新失败用 Op，旧异常兼容集中用 `opError`，不在调用者重新猜 outcome。

| 新公共 API / IPC | 成功载荷 | 旧兼容入口 |
|---|---|---|
| `files.directoryPage` / `files:directory-page` | 上述目录页与版本元数据 | 既有 files list 与 remote project list |
| `git.repositoryList` / `git:repository-list` | 仓库列表、truncated 与版本元数据 | `listRepos` / `remoteRepos` |
| `git.historyPage` / `git:history-page` | commits、hasMore、可选 totalCount | `commitLog` / `remoteLog` |
| `git.compareRefs` / `git:compare-refs` | 显式 mode、已解析 OID、文件与可选 ahead/behind | `branchCompare` / `remoteCompare` |

这些名字在交接基线尚不存在。其余同形方法优先复用已有入口；授权仍按 §3.3，不能因新增数据页而增加自动写。迁移完成后生产共用业务只用公共入口，兼容包装不包含新的业务分支或缓存。

- repos 公共结果保留 `{repos, truncated}`，不能继续用裸数组丢元数据；共享事实带 revision/generation。所有入口在本机 FS/Git 解析前分派 SSH，拒绝闭集/长度/路径负例仍成立。
- history 公共页为 `{commits, hasMore, totalCount?}`；远端 HEAD-only、无总数/过滤/拓扑保证时显式关闭对应能力。本地现有过滤/图谱功能保留，不能为对齐远端而删本地能力。
- compare 输入/结果显式带 `mode: "merge-base" | "trees"` 和确认的两端 OID；ahead/behind 可缺席，不能填 0。每种模式只给支持它的 backend；远端保留逐文件打开，branch 创建的“只建/建并切”同样显式。
- 写命令结果保留 rejected/unknown、recoveryRef、sync outcome、原消息与确认过程。远端仅单文件 stage/unstage/discard；批量/目录/smart commit 不开放；不得循环消费一个 token 或自动取新 token 重试。
- 纯 facts 与显式 grant 分步骤；授权表继续沿用既有 kind，旧 remote API 只委托同一服务。旧 API 兼容状态与“公共调用者已迁移”分别记账，不承诺通道名立即减半。

**T8 renderer，顺序固定：** 公共状态 controller/hook → 变更树/diff → history/compare → 宿主组装。

- 先把 `remoteGitViewState` 的取消、互斥、未知结果、迟到读、分页失败保留等规则承接到共用内核；用它已有的行为测试作对照。不能把它直接换成本地面板当前状态机。
- `GitPanel` 的自动 fetch、smart commit、轮询策略从共用展示中分离；保留本地原行为，远端由能力与策略禁用。门控到 `GitGraph` 菜单、count 调用和 effect，缺能力不调用、不显示成功。
- 保留 `DrawerSurface` 的位置装配入口；`RemoteGitPanel` 可成为“共用区块 + 远端专属区块”的组合，单活动仓库与 selector 继续存在；同步区固定几何、push/init 确认、trust/recovery 都是实际保留能力。
- `useRemoteGitView` / 旧 controller 导出可保留兼容包装，内部不再维护第二份同类状态。既有源码形状测试保护的真实专属 JSX 可留原文件；不搬空后塞注释/死码骗测试。物理删文件不是门禁。
- 两个文件树使用同一个 childrenByDir/expanded/loading 算法；保持旧键迁移、拖拽 target、编辑器活跃键、搜索 reveal 与失效范围。共用 UI 不判断 local/ssh，外层可装配不同能力。

**T9 留项与验收：** sessions 的 scan/title/register 迁 `Op<T>`，仅变结果封装与直接消费者，不改 R1a 传输或 JSONL；hosts 的 hostId 归因例外保留。逐项完成 §4.2 行为表后，清点兼容壳与旧业务调用；没有重复事实/状态 owner 才算统一，未跑的真机项必须明列。

### 10.5 每卡验证命令（先创建该卡新增测试，再执行）

所有卡完成代码后加 `npm run typecheck`；以下只列该卡直接相关套件。既有测试路径已核对存在；“新增”文件目前不存在，不是遗漏。

| 卡 | 针对性验证 |
|---|---|
| T1 | `node --test tests/remoteFactInvalidationRace.test.mjs tests/remoteGitSnapshotFacts.test.mjs tests/remoteFactCache.test.mjs tests/remoteWorkspaceView.test.mjs`（首个新增） |
| T2 | `node --test tests/remoteDirWatchLifecycle.test.mjs tests/remoteDirWatchRegistry.test.mjs tests/remoteProjectDirFacts.test.mjs tests/remoteProjectReadConcurrency.test.mjs tests/remoteProjectRootStatusIsolation.test.mjs`（首个新增） |
| T3 | `node --test tests/remoteGitFactsBoundary.test.mjs tests/remoteGitReadIpc.test.mjs tests/remoteGitRead.test.mjs tests/remoteGitMutationTokens.test.mjs tests/remoteGitMultiRepoTokenScope.test.mjs tests/remoteProjectReadChain.test.mjs tests/remoteProjectDirFacts.test.mjs`（首个新增，补目录新用例文件后同跑） |
| T4 | `node --test tests/remoteWorkspaceView.test.mjs tests/remoteControlClientEvents.test.mjs tests/remoteProjectDirFacts.test.mjs tests/remoteGitFactsBoundary.test.mjs` + 新通知/退订行为测试；动 IPC 后 `npm run check:ipc-wiring` |
| T5 | `node --test tests/remoteGitFactsBoundary.test.mjs tests/remoteGitRouting.test.mjs tests/remoteGitReadIpc.test.mjs tests/remoteGitRepoScopeView.test.mjs` + 新实际 API 路径配对测试 |
| T6 | `node --test tests/projectFileBackendConformance.test.mjs tests/projectFileAccess.test.mjs tests/projectFileTarget.test.mjs tests/filesIpcRegistration.test.mjs tests/remoteFileStatTokenPressure.test.mjs tests/fileTreeIdentity.test.mjs tests/fileTreeLazy.test.mjs tests/sharedOpEnvelope.test.mjs tests/envelopeSingleSource.test.mjs`（首个新增） |
| T7 | 新 `projectGitBackendConformance` + `remoteGitRouting`、`remoteGitReadIpc`、`remoteGitMutationIpc`、`remoteGitBranchIpc`、`remoteGitCompareIpc`、`remoteGitDiscardIpc`、`remoteGitRecoveryIpc`、`remoteGitSyncIpc`、`remoteGitInitIpc`（均为 `node --test tests/<名称>.test.mjs`） |
| T8 | `node --test tests/remoteGitViewState.test.mjs tests/remoteGitMutationView.test.mjs tests/remoteGitRepoScopeView.test.mjs tests/remoteGitDrawer.test.mjs tests/remoteGitSyncBar.test.mjs tests/remoteGitRefsPolling.test.mjs tests/fileTreeIdentity.test.mjs tests/fileTreeLazy.test.mjs tests/fileTreeLoadingPlaceholder.test.mjs tests/fileNodeDragRef.test.mjs` + 新公共 controller/DOM 测试 |
| T9 | `node --test tests/remoteSessionScanIsolation.test.mjs tests/remoteSessionScanner.test.mjs tests/remoteSessionRootIsolation.test.mjs tests/remoteSessionRootResolution.test.mjs tests/remoteSessionTitle.test.mjs tests/remoteSessionRegistration.test.mjs tests/sharedOpEnvelope.test.mjs tests/envelopeSingleSource.test.mjs`；最终按变更范围复跑前卡门禁 |

**端到端与预算：**

- 本地 UI：`npx playwright test e2e/git-panel.spec.ts`。远端 Git：`npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep "远端 Git"`；现有辅助脚本 `e2e/remote-git-*.ts` 不是可独立执行的 spec。
- 文件树 watcher 的“根/展开目录外部写 → main 失效 → UI 更新、重连、无能力降级”需新增定向 E2E；已有 helper 事件自测不能代替。推送覆盖的目录按 3 秒门禁；轮询降级按声明间隔，不伪称也是 3 秒。
- 真机使用既有授权的专用测试主机与隔离夹具；配置来源见 `e2e/remote-fixtures.ts` 的 `REMOTE_ACCEPTANCE_ENV`，不在文档/日志写真实凭据。凭据不足导致 skip 时不得称真机通过；不得运行与本任务无关的冷部署/移走 bundle 验收。
- E2E 前更新实际改动目标的构建产物。现有 `npm run build:main` 只建 main/preload；renderer 的临时子构建配置只导入 `electron.vite.config.ts` 的默认对象并导出 `{ renderer: base.renderer }`，不复制/漂移插件配置，再以 `npx --no-install electron-vite build --config <该临时配置>` 执行，结束删除自己的临时配置。`electron-vite --filter` 是日志筛选，不是目标筛选。禁止用 `npm run build` / `npm run test:e2e` 绕过范围限制；旧 out 产物不能证明新 UI。
- W0 计量验证一个刷新波：repos ≤1，每仓 status ≤1，失效动作本身为 0 读取；hello/watch 与事实调用分别记录。稳定展开重复读取命中、两个消费者合并、显式 refresh 重新装载、unknown 不重放均须有可重复的计数证据。

### 10.6 完成定义与可直接交给执行模型的指令

**完成定义**：T1–T9 对应行为门禁通过；§4.2 对照表逐项有新路径证据；共用事实/状态/展示规则已落地；本地能力与远端授权/确认/恢复/嵌套功能均保留；旧入口仅剩已登记的兼容委托或真实专属 UI。未执行的真机项明列，不能用单测替代。兼容 API 的物理移除按一版兼容策略另行安排，相关测试同步演进，保留有效行为覆盖。

> 新任务按 `docs/remote-project-parallel-handoff.md` 的对应提示词派发。先核对基线与 §10.7/§10.8 已有交付，不从 T1 重做；复用已有模块，保留有效行为与安全覆盖，不重写 helper，不直接把远端挂到本地 GitPanel。按任务 ownership 分片验证，记录未完成契约；不全量构建、不自动提交/push、不修改别人的工作。旧测试与真实契约矛盾时同步纠正并报告依据，文本保存按交接 T 的实施与验证范围处理，不吞错误或为消红弱化测试。

### 10.7 任务卡进度（滚动更新）

| 卡 | 状态 | 已落地 | 证据 / 未验证 |
|---|---|---|---|
| T1 | ✅ | `RemoteFactCache`：在途 flight 带退休标记，`invalidate/invalidateWhere/clear/clearWhere` 摘掉在途请求；旧 finally 只在身份相同时删除；退休读统一返回 `REQUEST_CANCELLED`。`RemoteGitSnapshotFacts`：`invalidate/invalidateProject/clear` 同样覆盖“只有在途、没有缓存值”的键。 | 新增 `tests/remoteFactInvalidationRace.test.mjs`（9 例，R1–R4）；改前旧实现 5 例失败，改后全绿。T1 套件 30 pass。 |
| T2 | ✅ | `RemoteProjectSession.connectionId` = manager 实例 token + 连接 generation；`RemoteDirWatchRegistry` 按连接身份换代、并发 ensure 合并、32 路径分片 / 4 watcher 上限、迟到订阅不登记新代、成对 unwatch、`releaseHost/releaseProject/closeProject/clearHost/releaseAll`；`remoteProjectIpc` 用 `connectionId` 订阅并暴露 `onHostDisconnected/closeProject/dispose`；`main/index.ts` 在断连、项目删除、退出时接线。 | 新增 `tests/remoteDirWatchLifecycle.test.mjs`（10 例）；改前旧实现 7 例失败。T2 套件 37 pass；typecheck 绿。未跑 SSH 真机。 |
| T3 | ✅ | Facts cache 加 generation 围栏 + `force` 显式刷新；`remoteGitReadIpc` 的 snapshot/status 先过调用者边界（enabled/disposed/sender/project/repo/压力），再逐次校验 locator+trust+连接身份与 ready；暖缓存不再绕过 trust/离线；共享装载不再继承单个调用者的取消；写成功与 unknown 都标脏；`RemoteHostConnectionService.connectionFacts(hostId)` 提供稳定身份；目录 list 逐次解析 target + 连接代；preload 新增 `refreshRemoteSnapshot`，控制器显式刷新走 force。 | 新增 `tests/remoteGitFactsBoundary.test.mjs`（8 例：R5–R10、目录暖缓存门禁、renderer force 接线）；改前旧实现 6 例失败、R10 已成立。T3 套件 67 例（45 pass / 22 skip，skip 为既有 ssh 真机用例）。未跑 SSH 真机。 |
| T4 | ✓ 单一 owner（2026-11-07 第三批） | `remoteProjectDirFacts` 收口成工作区事实的唯一 owner：目录 `FactCache` 与 Git `SnapshotFactsCache` 同一实例、同一张连接代、同一条通知出口；五条失效路径（写成功 / unknown 写 / helper 事件 / 断连换代 / 项目或 root 关闭）都在这里标脏，且**一次事件一条通知**。`remoteGitReadIpc` 通过 `workspace` 端口读写同一份缓存（缺省自持一份，仅旧装配/单测）；`main/index.ts` 的 afterWrite 调用点保留，但不再需要二次调用 Git 侧失效。 | 新增 `tests/remoteWorkspaceFactsOwner.test.mjs`（4 例：目录写→Git status 也脏且只发一条通知、Git 写→零目录装载、断连/关闭一起作废、真实 Git 写通道走同一 owner）；T4 相关 63 例全绿；typecheck 0。**仍有**：展开目录只登记根层非递归 watch（W6 范围）。 |
| T5 | ✓ 公共 target 项目相对（2026-11-07 第三批） | `RemoteGitService` 的 `status` / `workspaceDiff` / 写面（`mutate`/`discard`/`recoveryRestore`）/ `refFileDiff`，以及同一份公共输出的 `commitDetail` / `compare` / `recoveryList`，公共 target/path/displayPath 全部是**项目相对**；仓库内路径只在 helper 帧出现（`repoRelativeFilePath` 唯一转换点）。跨仓、同名前缀、无前缀一律拒绝，不做前缀猜测；legacy controller 的 target 全部来自本服务输出，因此不存在“旧形状”分支。 | `tests/remoteGitTargetBoundary.test.mjs` 扩到 7 例（嵌套 status、写面双向映射、commitDetail/compare 项目相对、跨仓与同名前缀零帧拒绝）；`tests/remoteGitReadIpc.test.mjs` 按新契约更新并断言 helper 帧只剩仓库内路径。 |

**T6–T9 在 T1–T5 交付时的后续任务摘要（后续落实情况见紧随其后的表格；不是新的开工指令）**

- **T6 文件域**：需要新增 `files:directory-page`（local + ssh 两种 backend）与公共 entry 形状（`target/relativePath/type/hasChildren/ignored`、2000 条上限、`truncated`、revision/generation、128 路径 2×64 stat、`git.checkIgnore` 分批）。本地侧现有 `ProjectFileBackend.list` 返回递归树，仍需一层“单目录页 + hasChildren”转换；SSH 侧可直接建在 `remoteProjectIpc` 的目录事实缓存上。
- **T7 Git 域**：`git.repositoryList` / `git.historyPage` / `git.compareRefs` 三个新公共入口与 `Op<T>` 结果；在 T5 的路径函数之上把公共 target 改为项目相对，同时用 preload/控制器适配旧接口（一次改全）；仓库列表补 `truncated`；写入仍按能力组逐组迁移。
- **T8 renderer**：把 `remoteGitViewState` 的取消/互斥/unknown/迟到读规则承接到共用 controller；`GitPanel` 的自动 fetch/轮询策略与展示分离并按能力门控；两个文件树共用 children/expanded/loading；消费 T4 的通知并在隐藏/收起/关闭时退订。
- **T9 收尾**：sessions 的 scan/title/register 结果迁 `Op<T>`（不改 R1a 传输/JSONL），复核前卡门禁，跑本地 Git E2E 与远端定向验收（真机/凭据不足时明列 skip），清点兼容壳。

| T6 | ◐ 公共文件读已落地 | 新增 `files:directory-page`（`ProjectDirectoryPage` Op：entries/truncated/revision/generation，2000 上限，本机 hasChildren 精确、远端 `"unknown"`）；本地 `FileSystemService.listTreePage` 截断而不报错；远端目录页复用目录事实缓存并支持 force 刷新；远端 `pathsExist` 走只读 `RemoteWorkspaceReader.statMany`（64/帧；批量全有或全无时退回逐项只读 stat），`files:paths-exist`/`files:stat` 对 ssh 目标改走该入口，不再经过 entry 令牌。 | 新增 `tests/projectFileBackendConformance.test.mjs`（7 例：本地/远端 2000/2001、hasChildren、失败不缓存、128 路径 2 帧、缺失路径、整次失败、显式刷新）；T6 套件 57 pass；`check:ipc-wiring` 绿。**2026-11-07 收尾**：Git ignore 修饰已接入**远端**目录页（`probeIgnore`：最长仓库前缀归因、64 路径/批、能力门控、失败即不填），渲染层按 `ignored` 置灰（文件行与目录行各一处）；**本机也已接**：`GitService.checkIgnore`（`git check-ignore --no-index -z --stdin`，exit 1 = 无命中、非仓库 = 不填）+ `filesIpc` 注入，WSL 经同一 git 分派。**2026-11-07 第三片**：本机/远端 read / search / create / rename / move / delete 已全部走公共 `files:*`（main 内按位置路由），文件 provider 合并为单一实现，位置差异只剩文本/传输端口注入。**仍未完成**：本地 revision 只是每次读递增的计数（设计限制）。 |
| T7 | ◐ 三个公共入口已落地 | 新增 `git:repository-list`（保留 truncated + revision/generation）、`git:history-page`（本地保留 ref/path/allBranches 与 totalCount，远端 HEAD-only 且过滤器显式 UNSUPPORTED_CAPABILITY）、`git:compare-refs`（本地 merge-base + ahead/behind，远端 trees 不填 0）；preload/previewApi 接线；`GitService.getCommitLog` 支持 skip，新增 `resolveRefOid`。 | 新增 `tests/projectGitBackendConformance.test.mjs`（3 例）；T7 套件 67 pass。**未完成**：公共 target 尚未统一为项目相对（status/workspaceDiff/写面仍按旧契约，避免与 legacy controller 冲突）；detail/diff/compare 文件 target 与 preload 适配未做；写面仍按能力组逐组迁移。 |
| T8 | ✓ 文件树与 Git 宿主组合已落地 | 新增 `lazyDirTree` 共用内核（按目录代次、迟到结果丢弃、失败清空、显式 refresh 带 force、reveal、事实 scope 只重读已加载目录、连接换代整树重读、dispose 围栏）；远端文件树改用 `files:directory-page` 并消费 `onProjectFactsChanged`（目录 scope），节点使用公共 `target`，`hasChildren` 对远端 "unknown" 映射为可展开；目录页的 `truncated` 进入 `truncatedDirs` 并在面板显式提示（i18n 三语）；`useRemoteGitView` 只在当前仓库 status 标脏时强制重读（`subscribeRemoteGitFacts`）；远端历史改用 `git.historyPage`（`authorTimeMs` 转秒，分页 skip 透传），比较改用 `git.compareRefs`（trees 映射回两端/文件，错配 ref 报 `GIT_RESOURCE_CHANGED`）；仓库选择器优先 `git.repositoryList`（`relativePath` 投影为 scope、保留 `truncated`），旧 `remoteRepos` 仅在 `UNSUPPORTED_CAPABILITY`/缺入口时回退；`remoteLog`/`remoteCompare` 仅作缺少新入口时的迁移期回退；`GitGraph` 的可选写回调缺席时不再显示成功，`commitCount` 缺席时不发请求（F7）。 | 新增 `lazyDirTree`（13 例）、Git 事实订阅（2 例）、历史页消费（3 例）、比较消费（3 例）、仓库列表投影（2 例）、GitGraph 门控（3 例）、自动刷新策略（14 例）、宿主组合（4 例）共 44 例；T8 门禁 158 pass；typecheck 0。**本机文件抽屉已迁 `lazyDirTree`**：逐层 `files:list`（maxDepth 0）、项目键持久化、legacy 绝对路径逐层迁移、refs 事件静默重载、折叠中间包 drill、失败目录 `hasChildren=false` 可重试。**W5-2 第一刀**：GitPanel 的 5 秒 status/focus、refs 推送、5 分钟 auto-fetch 已拆到 `useGitAutoRefresh`；`statusPoll`/`refsWatch`/`autoFetch` 三个能力位关闭时连 effect 都不注册，面板只传能力位不写 backend 分支。**宿主组合**：RemoteGitPanel 复用 `FileTree`/`FileDiffViewer`，事实/飞行状态只由 `useRemoteGitView` 持有；history/compare/trust/init/sync 作为远端专属区块保留（语义与授权不同，不强行合并）。隐藏/收起态退订由实际卸载/有界轮询保证。 |
| T9 | ✓ sessions 结果面已迁 Op；真机验收与兼容壳清点完成 | `remoteSessionIpc` 的 scan/title/register 改为 `Op<T>`（成功 value、失败带 outcome），preload 类型同步；renderer 的 `readScanResponse`/`readRegisterResponse`/`readTitleResponse` 在迁移期同时接受 Op 与旧扁平形状；scanner 内部与 R1a 传输/JSONL 未改。相关 IPC 断言按 T9 范围迁到新信封（行为断言保留）。 | T9 套件 162 pass；`npm test` **14485 tests / 14180 pass / 20 fail**；失败项仍为基线既有类别，新增项单独复跑通过；定向 T8 门禁 158/158。（跳过项均为无真机/环境门禁，不计通过）；typecheck 0；`check:ipc-wiring` 786 通道。**兼容壳清点**：renderer 仍消费 `remoteSnapshot`/`refreshRemoteSnapshot`（快照事实源）；`remoteRepos`/`remoteLog`/`remoteCompare` 各保留一版回退（当前装配不可达）；`listProject` 无生产消费者；`git.repositoryList`/`git.historyPage`/`git.compareRefs` 已由远端 Git 面板消费；本机文件树已由 `lazyDirTree` 独占 expanded/children；T9 时 `GitPanel`/`RemoteGitPanel` 仍分离，2026-11-03 的单一入口与共享展示状态见 [git-panel-component-parity.md](git-panel-component-parity.md)。§4.2 对照审计已落到 §10.8；兼容壳清点见 §10.8：`remoteRepos`/`remoteLog`/`remoteCompare` 各保留一版回退，当前装配不可达；`listProject` 无生产消费者；`remoteSnapshot`/`remoteRefs`/`remoteCommitDetail`/`remoteRefFileDiff` 是领域事实 owner，不是第二套壳。Git、文件管理与代码文件真机验收均已通过，soak 为环境 skip。本地 Git E2E `e2e/git-panel.spec.ts` 1/1 通过。真机 SSH：主机可连；验收脚本适配当前设置页后，**远端 Git 10 项全部通过**（G1/G2/G3a/G3b/G4a/G4b/G5a/G5b/G5c/G5d-G5e，7.3 分钟），G6b soak 1 项 skip（Linux-only）。远端文件管理 v1 真机通过（56.7s：新建/改名/跨目录移动/删除/回收站还原/清空/同名再建）；期间修复远端文件树行键（projectFileKey→controller 相对键）并补根目录按钮。远端代码文件验收通过（UI 保存/外部冲突草稿/双项目同名隔离/断开保草稿/Agent 真实 `node test.cjs`）；切换项目后的首读会短暂遇到 `SSH_HOST_NOT_READY`，已加有界退避重试（`remoteDirectoryPageRetry`），不再把瞬态画成“需要连接”。 |

**本轮（T6–T9 部分）验证汇总**：T6 套件 57 pass；T7 套件 67 pass；T8 门禁 158 pass（`lazyDirTree` 13 例、Git 事实订阅 2 例、历史页消费 3 例、比较消费 3 例、仓库列表投影 2 例、GitGraph 门控 3 例、自动刷新策略 14 例、宿主组合 4 例）；T9 套件 162 pass；`npm test` **14485 tests / 14180 pass / 20 fail**（均为基线既有类别）；`npm run typecheck` 退出码 0；`check:ipc-wiring` 786 通道齐备；本地 Git E2E 1/1 通过。真机 SSH：远端 Git 10/10、远端文件管理 v1、远端代码文件全流程（含 Agent 真实运行）均通过；G6b soak 为 Linux-only skip。

**T1–T5 卡完成时验证汇总（阶段性记录；最终验收见上）**：T1 套件 30 pass；T2 套件 37 pass；T3 套件 45 pass + 22 skip；T4 套件 31 pass + `check:ipc-wiring`；T5 套件 34 pass；renderer/宿主/信封相关 158 pass；`npm run typecheck` 退出码 0。该阶段未执行全量 `npm test`、全量 build、E2E 或 SSH 真机。

### 10.8 T9 §4.2 对照审计与兼容壳清点

状态口径：✓ = 生产消费者已走公共入口/单一领域 owner，且未发现行为回退；◐ = 入口已接但仍有明确保留的领域专属路径（无公共替身，不是重复 owner）；✗ = 未接。真机 SSH 已按 T9 验收执行：远端 Git 10/10、文件管理 v1、代码文件全流程均通过；仅 G6b soak 为 Linux-only skip。

| §4.2 能力 | 现状与证据 | 状态 |
|---|---|---|
| 仓库发现与 scope | 远端选择器优先 `git:repository-list`（truncated/relativePath）；旧 `remoteRepos` 只在 invoke 拒绝或 `UNSUPPORTED_CAPABILITY` 时回退，当前装配的 `repositoryListing` 两者都不产生；嵌套 scope 保留；本机多仓面板未动 | ✓ |
| 文件身份与 workspace diff | `RemoteGitService.status` 为每个资源生成**项目相对**的公共 `target`（2026-11-07 第三批 T5）：`path`/`displayPath`/`target`/`oldTarget` 同一形状；`openDiff` 原样把 `target` + 项目相对 repo scope 传给 `git.workspaceFileDiff`，`workspaceDiff`/写面/`refFileDiff`/`commitDetail`/`compare`/recovery 都用 `repoRelativeFilePath` 在 helper 边界转换一次。跨仓、同名前缀、无前缀一律 `GIT_RESULT_INVALID`，没有“有前缀就剥”的猜测 | ✓ |
| status / refresh | T1–T4 的边界/围栏/显式 refresh/通知已在单测覆盖；远端面板消费 status 通知强制重读；暖事实命中仍逐次校验同代连接 | ✓ |
| history / count / graph | 远端历史走 `git:history-page`（HEAD-only、hasMore）；count/graph 是远端不提供的能力，`GitGraph` 缺席回调不显示成功、`commitCount` 缺席不发请求（F7）；不是“已接但没迁” | ✓ |
| commit detail / file diff | 生产 renderer 经 `ProjectGitService.commitDetail` / `refFileDiff` 消费；服务复用既有 `remoteCommitDetail` / `remoteRefFileDiff` 通道和 `RemoteGitService` 路径校验，不复制业务逻辑。后者接收 `ProjectFileTarget` + repo scope 并返回 target。 | ✓ |
| refs / compare | refs 只有 `remoteRefs` 一个领域入口（带 repo scope）；compare 消费 `git:compare-refs`，mode/trees 显式、不填 ahead/behind；两者不共享可变状态 | ✓ |
| stage / unstage / discard | 远端仍单文件 + 单次 token；批量/目录/smart commit 未开放；本地能力未动 | ✓ |
| discard / delete | recoveryRef 与恢复清单保留；未把删除映射成还原 | ✓ |
| createBranch / checkout | 远端“仅创建”与独立 switch 保留，不追加隐式 checkout | ✓ |
| commit | 远端只提交 index、消息有界、unknown 不重放 | ✓ |
| sync | 显式 fetch/push/pull、确认与 outcome 保留；未加后台自动网络写 | ✓ |
| trust / recovery / init / 断连 | T2/T3/T4 的会话身份、缓存 fence、断连换代与既有 trust/init 区块保留 | ✓ |
| 高级写 / refs watch | 远端仍无 cherryPick/revert/reset/dropCommit；`GitGraph` 缺席回调不再显示成功、count 缺席不调用（F7）；refs 只读轮询受可见性/host 状态约束 | ✓ |
| 文件树 | 本机/远端已共用 `lazyDirTree`：逐层 target 读取、项目键持久化、legacy 迁移、refs 静默重载、失败重试；远端首读遇切换项目瞬态有有界重试（`remoteDirectoryPageRetry`）；本地 E2E 渲染预算通过 | ✓ |
| Git 宿主/展示 | 自动刷新策略已拆到 `useGitAutoRefresh`（能力位控制三个 effect）；`DrawerSurface` 的 Git 生产入口收为 `ProjectGitDrawer`，远端复用共用变更树/diff/错误展示，事实由 `useRemoteGitView` 独占；history/compare/trust/init/sync 为真实远端专属区块（授权语义不同，不合并）。**四条公共规则已统一**（2026-11-07 第三批 W5）：取消 / 互斥 / unknown / 迟到读 只由 `createGitOperationGate` 实现，`GitPanel`、`remoteGitViewState`、`remoteGitStatusPolling` 都走它；两套状态机其余部分（本地面板的自动 fetch/轮询策略、远端专属区块）仍各自持有。 | ◐（规则已合并，区块仍独立） |

#### 兼容壳与旧业务调用清点

“当前装配可达”指正式构建的 preload + main 组合；只有旧 main/旧 preload 才可能走到回退，不等于旧入口仍在生产使用。

| 入口 | 生产调用/用途 | 兼容触发 | 当前装配可达 | 结论 |
|---|---|---|---|---|
| `files.directoryPage` / `files:directory-page` | `useRemoteFileTree`（本机树仍走 `files:list`） | — | 是 | 公共目录读，远端树唯一入口 |
| `git.repositoryList` / `git:repository-list` | `useRemoteGitRepos` | `remoteRepos` 在 invoke 拒绝（旧 main 缺通道）或结果码为 `UNSUPPORTED_CAPABILITY` 时回退；普通失败不回退 | 否 | 保留一版兼容；当前 main 两者都不产生 |
| `git.historyPage` / `git:history-page` | `remoteGitViewState.readHistoryPage` | `remoteLog` 仅当 `historyPage` 方法不存在时回退 | 否 | 保留一版兼容；preload 始终有现值 |
| `git.compareRefs` / `git:compare-refs` | `remoteGitViewState.runCompare` | `remoteCompare` 仅当 `compareRefs` 方法不存在时回退 | 否 | 保留一版兼容；preload 始终有现值 |
| `remoteSnapshot` / `refreshRemoteSnapshot` | 远端 Git 面板 status/refresh | — | 是 | **活动事实 owner**（`RemoteGitSnapshotFacts`），不是兼容壳 |
| `remoteRefs` | 远端 refs 列表 | — | 是 | 领域入口；无公共 refs 替身，不另建缓存 |
| `remoteCommitDetail` / `remoteRefFileDiff` | `ProjectGitService.commitDetail` / `refFileDiff` 的底层通道 | — | 是 | 服务实现复用既有领域通道；renderer 不再直接调用 preload |
| `remoteProjectList` / `listProject` | 无 renderer 生产消费者 | — | 否 | 旧目录列表适配器；保留一版，候选后续删除 |
| `files:search-page`（新，2026-11-07 收口第一片） | renderer 两个 provider 的文件名搜索唯一入口；`Op<ProjectFileSearchPage>`，本机与远端同形 | — | 是 | 位置路由在 main：本机索引/BFS、ssh 走 `remoteProjectIpc.searchProject`；`kind:"other"` 只留在 `entries`，`truncated/scanned` 不丢 |
| `files:search`（本机旧形状） | 不再被 provider 使用 | — | 否（本机旧调用方仍可用） | 保留一版兼容；新调用方一律用 `files:search-page` |
| `files:create` / `files:rename` / `files:move` / `files:delete` 的 ssh 分支（2026-11-07 收口第二片） | main 内按位置分派：ssh 走 `remoteEntries`（entry 服务 + 令牌表 + 事实失效复用），本机走 local backend | — | 是 | rename/move/delete 的乐观锁凭据由 main 现读现用（stat→写），renderer 不再持令牌；delete 带回 trashId 收据；未装配端口时 ssh 明确 `UNSUPPORTED_PROJECT_LOCATION` |
| `remoteHosts.searchProject` / `createProjectFile` / `createProjectDirectory` / `renameProjectEntry` / `deleteProjectEntry` / `statProjectEntry` | renderer **全部不再调用**（2026-11-07 收口第二片扩展：create/rename/move/delete 都走公共 `files:*`） | — | 否 | 兼容壳保留一版；令牌与乐观锁凭据全部留在 main |
| `git:remote-check-ignore` + `ProjectDirectoryEntry.ignored` | **本机与远端目录页都已接线（2026-11-07）**：远端 `probeIgnore` → `projectDirectoryPage`；本机 `GitService.checkIgnore` → `LocalProjectFileBackend.directoryPage`；渲染层置灰。`git:remote-check-ignore` IPC 方法本身保留给显式调用方 | — | 是 | 只加修饰不过滤；缺失 = 未知（不是“未忽略”） |
| `files:list` 的远端 target 分支 | 无 renderer 生产消费者（本机树只用本机 target） | — | 否 | 与 `directoryPage` 共用同一目录事实；保留一版 |
| `openProjectText` / `saveProjectText` / `readProjectFile` | 远端文本编辑器/图片预览 | — | 是 | 领域文本/图片读写；未迁公共 files 写面，不与目录树重复 |
| `searchProject` / 条目 stat/create/rename/delete/trash/upload | 远端文件管理面板 | — | 是 | 远端文件写/管理领域入口；T6 未要求迁到公共写面 |

**审计结论**

- T1–T5 的主进程事实层、T6/T7 的公共读入口、T8 的两棵树共用内核与 Git 宿主组合、T9 的 sessions 信封与真机验收已收口。
- 没有第二份目录事实缓存：`remoteProjectList` 与 `directoryPage` 都经同一 `readDirSnapshot` / `FactCache`；`remoteRepos`/`remoteLog`/`remoteCompare` 都委托同一 `RemoteGitService`，不建旁路缓存或业务分支。
- 本机与远端各保留一个展示事实 owner：本机 `GitPanel` 状态机 / 远端 `useRemoteGitView`；共用的是变更树、diff、错误展示、`lazyDirTree` 与 `useGitAutoRefresh`。`ProjectGitDrawer` 只统一生产入口，不合并两套状态机。history/compare/trust/init/sync 语义和授权不同，继续作为真实远端专属区块保留。
- 兼容壳按 W4 只保留一版，不宣称通道数减少；`remoteRepos`/`remoteLog`/`remoteCompare` 的触发条件已在本表固定，新增调用不得重新引入第二事实源。`listProject` 无消费者，登记为后续清理候选而不是继续扩展。
- 能力边界不是迁移欠账：远端不提供 count/graph、批量/目录写与后台 fetch；这些由 F7 门控或面板不渲染，不能以“补齐”为名放宽授权或伪造结果。

## 11. 已修复：远端目录页的 Git ignore 修饰在真机上不生效（2026-11-07 定位并修复）

**现象**：远端项目的文件树不置灰任何条目。`e2e/remote-file-ignore.spec.ts` 的「后端契约」步骤红：
`files.directory-page` 返回的 entries 里没有任何 `ignored: true`。

**判定**：产品按契约「没判定就不修饰」在行事（`ProjectDirectoryEntry.ignored` 缺失 = 未知），
所以没有伪报；但这项功能在真机上等于没生效，属于缺陷而不是设计。

**根因（已确认）**：helper 的方法派发表（`dispatch`）**漏了 `git.checkIgnore`**——
`CAPABILITIES` 声明了它、`REPO_METHODS` 与 `git-read.mjs` 的 `prepare`/`start` 也都实现了它，
但入口分派没有把它交给 `handleGit`，于是 helper 对已声明的方法回 `METHOD_NOT_FOUND`。
主进程把未识别码折成 `GIT_COMMAND_FAILED`，渲染层/目录页只能看到“没判定”。

**已排除（都有实测证据）**：

| 假设 | 证据 |
|---|---|
| 前端没转发 `ignored` | 已修：`fileTreeIgnoredField` 单点转发，本机/远端两棵树都调用（`tests/directoryPageIgnoreDecoration.test.mjs`） |
| 装配没接 `probeIgnore` | 目录页 `debugProbe` 显示 `function`（临时诊断，已移除） |
| helper 未声明 `git.checkIgnore` | 能力门控通过（否则是 `UNSUPPORTED_CAPABILITY`，不是 `GIT_COMMAND_FAILED`） |
| `.git` 保留名让整页失败 | 已跳过 `.git`；跳过之后仍然失败 |
| 项目未信任 | `remoteTrust.set` 返回 active/approve，同 scope 的 `git.status` 成功 |
| 项目不是仓库 / 无 HEAD | 仓库有 commit；`git.status` 正常 |
| helper bundle 是旧版 | 清空 `~/.pideck/remote-host/bundles/*` 后重跑，远端只部署 `896b44d0…`（1.26.0，`git-read.mjs` 含 `allowed` 退出码处理），**仍然失败**；四个历史 bundle 其实都含 `allowed`（早期 grep 误判） |
| git 本身对该命令失败 | 远端手工跑 `git --no-pager --no-optional-locks -c … check-ignore --no-index -- <paths>`（`/tmp`、`$HOME` 下、`/proc/self/fd/N` 作 cwd 三种组合）全部正常：单条无命中 exit 1、有命中 exit 0 |
| 路径校验拒绝 | `.gitignore`/`visible.txt`/`ignored-dir`/`ignored.log` 都通过 `validateRemoteGitPath` 与 helper 的 `relative()` |

**修复（2026-11-07）**：

1. `RemoteHelperEntry.ts` 的 `dispatch` 补上 `git.checkIgnore`（能力声明与分派集合从此一致）；
2. `REMOTE_HELPER_ENTRY_VERSION` 1.26.0 → **1.26.1**（内容变化必须换版本，否则远端复用旧 bundle），
   同步 inline source 的 `VERSION` 字面量、`REMOTE_HELPER_ENTRY_SHA256`，以及四处版本断言；
3. 新增回归测试「every declared git capability is actually dispatched」：直接比对
   `CAPABILITIES` 里的 `git.*` 与 `dispatch` 的 `frame.method === "…"` 集合，漏一个就红；
4. 验证：`e2e/remote-file-ignore.spec.ts` **通过**（30.3s，后端契约 + UI 置灰两步都过）；
   远端 `-g "远端 Git|远端文件管理"` **11 passed**；定向单测 971 pass / 0 fail。

**教训**：能力声明、`prepare`、`start`、`dispatch` 是四处独立清单，任何一处漏写都会表现为
“能力存在但方法不可用”，而且只在真机出现。回归测试钉住了声明与分派的一致性。

**影响面**：只有「远端文件树置灰」这一条可见效果缺失；不涉及数据、授权或写路径。
本机目录页的 ignore 修饰（`GitService.checkIgnore`）不受影响。
