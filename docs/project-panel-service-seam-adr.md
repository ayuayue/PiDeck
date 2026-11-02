# 工作区面板服务缝（Phase A：契约草案 + 迁移对照）

Status: **Active plan（2026-10-31 更新）**。Phase A 已落地，尚未接 UI；A0 纯 stat 修复已在工作树验证，文本令牌等契约仍待校准。并行实施与前置门禁见 [remote-project-parallel-handoff.md](remote-project-parallel-handoff.md)。

## 1. 问题

本地与远端各有一套文件抽屉/Git 面板实现：

| 面板 | 本地 | 远端 |
|---|---|---|
| 文件抽屉 | `FileTree` 系列 | `RemoteProjectPanel`（402 行）+ 独立 hooks |
| Git | `GitPanel`（1811 行，全量） | `RemoteGitPanel`（628 行，子集） |
| 会话/终端 | ✅ 同一套 `SessionView` / `TerminalDock` | 同左（靠 `SessionLocator` 分支） |

后果不是“代码多”，而是**同一事实有两个读取点**：这轮修掉的侧栏 rootStatus badge（一个读取点按 Op 信封、一个按扁平）就是这类漂移；每加一个本地面板功能，远端要再实现一遍。

## 2. ZCode 怎么做（静态调研，未运行）

ZCode 已经把“位置”从 UI 里拿掉了：

1. **服务契约层**：`packages/services` 定义 `IFileService` / `IGitService` / `ITerminalService` / `IFileWatcherService` 等接口（[file.ts](F:/ZCode/packages/services/src/file/file.ts)、[git.ts](F:/ZCode/packages/services/src/git/git.ts)），接口方法全部是位置无关的请求/响应。
2. **本机实现**：`packages/services/src/node.ts` 把 `createGitService()` 等进程内实现注册进服务集合。
3. **远端实现**：`packages/client/src/remoteServiceAccess.ts` 用 `ProxyChannel.toService<IFileService>(channelClient.getChannel(...))` 生成同一接口的 RPC 代理。
4. **按 workspace 注入**：`packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts` 的 `buildRemoteWorkspaceSessionServices()` 只覆盖必须走远端的服务（file/git/terminal/fileWatcher/skills/provider…），本地专属（高速卡、闲时任务）显式保留本机 provider。
5. **UI 只依赖接口**：`packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts` 从 `useWorkspaceServices()` 取 `fileService/gitService/fileWatcherService`，没有 `RemoteFileTree` 这种组件。
6. **契约完整性**：`assertRemoteWorkspaceRpcContract` + 注册表（[remoteWorkspaceServiceCollection.ts](F:/ZCode/packages/desktop/src/host/remoteWorkspaceServiceCollection.ts)）保证“远端注册了哪些服务，renderer 就代理了哪些”，漏一个在启动期报错。
7. **传输再抽象**：`RemoteTarget = ssh|wsl|docker` + `IRemoteBackend` + `create-backend.ts`，连接/部署/握手/RPC 复用（[remote-target-abstraction.md](F:/ZCode/docs/architecture/remote-target-abstraction.md)）。

**不照抄**：整套 RPC/ChannelServer/服务注册框架（PiDeck 已有 IPC + 冻结 helper 协议）、100+ 服务域与架构策略文件、Source Server daemon 架构。

## 3. PiDeck 现状：读面已经统一，写面没有

调研代码后有一个重要事实：**只读面已经是位置无关的公共契约**，不需要新协议。

| 操作 | 本地与远端是否同一入口 | 证据 |
|---|---|---|
| 目录页 | ✅ `files.directoryPage` | `src/shared/types/projectFiles.ts` 明确“本地与 SSH 同一形状”；`useRemoteFileTree.ts:67` 与本地树共用 |
| 文件名/内容搜索 | ✅ `files.search` / `files.searchContent` | W2 起 `files.searchContent` 对远端项目路由 helper |
| Git status | ✅ `git.status` | `gitIpc.ts:730` 对远端项目转 `remoteGitReads.status` |
| Git 历史/仓库列表/refs/compare | ✅ `git.historyPage` / `repositoryList` / `refs` / `compareRefs` | `gitIpc.ts` 内按 `isRemoteProject` 路由 `remoteGitReads.*` |
| 文件读正文/保存/新建/改名/删除 | ❌ | 本地 `files.*`；远端 `remoteHosts.*`（带 version / entry 令牌） |
| Git 写（stage/commit/discard/sync） | ❌ | 本地 `git.*`；远端 `mutateRemoteIndex` / `commitRemote` / `discardRemote` / `fetchRemote`…（main 签发的一次性令牌） |
| 面板组件 | ❌ | `DrawerSurface.tsx` 按 `isRemoteProject` 切两套组件 |

所以 Phase B/C 的工作不是“造协议”，而是：**把已经统一的读入口 + 分裂的写入口收进同一个 provider，再让面板组件只消费 provider**。

## 4. Phase A 交付（本次）

新增（未接入 UI）：

- `src/renderer/src/services/projectServiceContracts.ts`：`ProjectFileService` / `ProjectGitService` 接口、能力表、`ProjectServiceError`（稳定码 + outcome）、`unwrapOp`。
- `src/renderer/src/services/projectFileService.ts`：本机 provider（`files.*`）与远端 provider（`remoteHosts.*`，保存必须带 version；改名/删除缺省时先取 entry 令牌）。
- `src/renderer/src/services/projectGitService.ts`：两个 provider 共用同一份读面（`git.status/historyPage/repositoryList/refs/compareRefs`）；本机写面委派 `git.*`，远端写面显式 `PROJECT_SERVICE_UNSUPPORTED`（Phase C 的令牌经纪）。
- `src/renderer/src/services/projectServices.ts`：`createProjectServices(project, api)` —— **UI 唯一允许判断位置的地方**；能力表区分本机/远端。
- `src/renderer/src/hooks/useProjectServices.ts`：Phase B 起面板使用的 React 入口（当前无人调用）。
- `tests/projectServiceSeam.test.mjs`：8 条行为测试（读面同通道、远端写带 version、entry 令牌复用、系统打开 unsupported、Git 读统一、远端 Git 写 unsupported、能力表）。

验证：`node --test tests/projectServiceSeam.test.mjs` 8/8 pass；`typecheck` 0；`check:format` 0；`check:test-shape` 新增 0。

### 4.1 接 UI 前的校准（2026-10-31）

- A0 已修：本地/远端 `stat` 共用 `files.stat` 纯读取；新增 `projectServiceStatRead` 用真实 entry 令牌表验证 128 次查询不挤掉 rename 授权。相关三文件测试 14/14、typecheck 通过；既有测试未改。
- 待处理：文本保存缺 version 时误取 entry token；旧 `projectServiceSeam` 用例还要求这种行为。两张令牌表不兼容，按并行交接 T 同步纠正实现和错误旧预期，补真实边界测试并说明覆盖变化；无需仅因修改旧用例另行确认，验证通过后再接文本写 UI。
- 待处理：当前删除等 provider 丢弃写入收据，能力表是静态值，`refresh` 仍读缓存 status。复用 `shared/projectCapabilities.ts` 的已有纯判定，补项目事实与动作能力，不新建第二事实 owner。
- 公共 stat 当前有远端失败折为不存在的行为，接 UI 前须明确错误契约；A0 不代表全部读写语义已就绪。
- §5 是目标 parity 与 Phase A 历史交付对照，不能据其勾选认定上述待处理项已经完成。§6 的 B/C 先过并行交接的 S/T 门禁。

## 5. Parity 矩阵

| 操作 | 本机 provider | 远端 provider | Phase A |
|---|---|---|---|
| 目录页 | `files.directoryPage` | 同左 | ✅ |
| 文件名搜索 | `files.search` | 同左 | ✅ |
| 内容搜索 | `files.searchContent` | 同左（helper 能力协商，旧 helper 返回 null） | ✅ |
| 读正文 | `files.readContent` | `remoteHosts.openProjectText` | ✅ |
| 保存 | `files.writeContent` | `saveProjectText`（必须 version） | ✅ |
| 新建 | `files.create` | `createProjectFile/Directory` | ✅ |
| 改名/删除 | `files.rename/delete` | `statProjectEntry` → `rename/deleteProjectEntry`（entry 令牌） | ✅ |
| 系统打开/定位 | `files.open/showInFolder` | 无本机路径 → unsupported | ✅（显式拒绝） |
| Git status/历史/仓库/refs/compare | `git.*` | 同左（main 路由） | ✅ |
| Git stage/unstage/commit/discard | `git.*` | 令牌化通道 | 本机 ✅ / 远端 Phase C |
| Git fetch/pull/push | `git.*` | 令牌化通道 | 本机 ✅ / 远端 Phase C |
| Git worktree | `git.worktree*` | 不支持 | Phase C 能力置灰 |
| 深层 watch | 本机 watcher | helper 4×32，降级事实 | Phase B 进能力表 |

## 6. 迁移计划（每步可独立回滚）

**Phase B（文件抽屉，3–5 天）**
1. `FileTree` 与 `RemoteProjectPanel` 的数据入口改为 `useProjectServices(project).files`；删除远端专用读 hooks 的重复实现（保留上传限制、回收站、能力提示等 UI 差异）。
2. 组件只读 `capabilities.files` 决定“系统打开/内容搜索/降级提示”等差异，不再 `isRemoteProject` 分支。
3. 门禁：`npm test`（相关）、文件管理 e2e、内容搜索 e2e、`RemoteProjectPanel ≤ 440 行` 保持。

**Phase C（Git 面板，5–8 天）**
1. `RemoteGitPanel` 并回 `GitPanel`，用 `capabilities.git` 控制 Worktree/图谱/同步等不可用项（置灰 + 说明，不是隐藏实现）。
2. 远端写面在 provider 内实现令牌经纪：`remoteSnapshot` 取 `mutationToken/commitToken/...` → 对应 `mutateRemoteIndex/commitRemote/discardRemote/fetchRemote/...`；`outcome=unknown` 只读回核对、绝不重放。
3. 门禁：G1–G5e e2e 与 parity 用例验证当前契约；过时预期可同步更新，保留仍有效的行为与安全覆盖，不为消红弱化验证。

**Phase D（契约完整性）**
- 参照 ZCode 的 `assertRemoteWorkspaceRpcContract`：为 `ProjectFileService/ProjectGitService` 建方法清单，两个 provider 必须实现或显式 unsupported；缺一个单测红。
- 把 §5 矩阵变成测试数据，防“本地加了功能、远端忘了”。
- 其中方法/能力一致性与结果语义检查前移到 S、B/C 各片门禁，不能等所有 UI 接完才验证。

## 7. 开放问题

1. **令牌经纪放哪**：建议 main（与现有 `mutateRemoteIndex` 的令牌签发同源），provider 只持有并使用；不要让 renderer 自造令牌。
2. **能力来源**：内容搜索用 `rootStatus.helperCapabilities`（W4 已修读取）；watch 降级用目录页的 `dirWatch` 事实；WSL 项目是 local-kind + UNC，沿用本机 provider 即可。
3. **UI 收敛顺序**：文件抽屉先做（组件小、e2e 全）；Git 后做（能力多，按 G1–G5 阶段对齐）。
4. **删除策略**：Phase B 合并后删除 `RemoteProjectPanel` 还是保留为“远端特有能力”外壳，取决于上传限制/回收站/降级提示的归属；倾向保留为薄外壳 + 共用 `FileTree` 内核。

## 8. 门禁与约束

- 不改 `shared/` 契约（本 Phase 只新增 renderer 服务层）。
- 不新增 IPC 通道；写面继续用现有 `files:*` / `remoteHosts:*` / `git:*`。
- 测试按任务需求与契约演进，更新依据和覆盖变化可审查；保留仍有效的回归与安全边界，不为消红迁就缺陷。
- 文件行数预算：`RemoteProjectPanel ≤ 440`；新服务文件保持 < 300 行，超出即拆。
