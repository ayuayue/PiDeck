Status: **Active plan** — 2026-10-31；核对基线 `dev / 24529c394`。A0 已在本工作树修复并验证，尚未提交；P/S/T/F/G 均为待实施任务。用户已修订测试演进规则，T 不再需要旧用例修改的单独授权。

# 远程多项目与面板服务并行交接

## 1. 已定范围与事实

- 用户已确定：本阶段以桌面在线为前提，支持远程多项目；暂不支持桌面退出后 Agent 继续运行、另一设备接回同一次运行。因此暂不部署独立常驻 PiDeck server。
- 多项目通过 main 侧按 `(hostId, canonicalRoot)` 复用单 root helper；不改 helper 线协议，不改变 pi 的 Agent/会话文件权威。注册项目数、活跃请求和空闲保温容量分别管理。
- SFTP 是后续独立传输任务，不是本批 P/S/F/G 的前置；本文件不授权更换传输、安装依赖或连接真实 SSH 主机。
- server 重评触发：独立多端控制同一运行、桌面关闭后的运行存活；大仓库须先测状态/搜索/传输/资源瓶颈，只有需要跨连接长期保留共享运行或索引状态时再评审。
- Phase A 已落地但尚无 UI 消费者；文件/Git 公共读面、`lazyDirTree`、事实失效等已有实现。不要按旧统一计划顶部说明重做 T1–T9，现状以其 §10.7/§10.8 和源码为准。

设计依据：[服务缝 ADR](project-panel-service-seam-adr.md)、[统一计划](remote-file-tree-and-git-unification-plan.md)、[池化 ADR](remote-host-root-pooling-adr.md)。本文件拥有派工、依赖与 ownership；安全/授权/路径规则仍由现有领域契约拥有。

### A0：本次已完成的前置

- `src/renderer/src/services/projectFileService.ts`：本地/远端 `stat` 共用 `files.stat` 纯读取入口，不调用签发 entry 令牌的通道。
- `tests/projectServiceStatRead.test.mjs`：真实 entry 令牌服务 + 模拟传输，验证 128 次查询后原 rename 授权仍可消费，另验证本地/远端目录、文件、缺失路径和项目身份。
- 修复前新增两例均失败（令牌表变为 128，根路径误进 entry 校验）；修复后新增测试及原服务缝/令牌压力测试共 14/14 通过，`npm run typecheck` 通过。未改任何既有测试。
- 限制：公共 `files.stat` 当前把部分远端读取失败映射为不存在（`filesIpc.ts` 的现有行为）；A0 沿用该入口语义，不宣称完善了错误契约。S 必须决定在接 UI 前如何表达“缺失/不可用”。
- 文本 version、写入收据、动态能力、Git force refresh 尚未修复；A0 不等于 Phase A 全部校准完成。

## 2. 任务拓扑与派工

```text
A0（已完成） ─┬─ P：main 池化 + watch/facts ──────────────────┐
              └─ S：服务契约/能力/收据 ─┬─ F：文件面板 ──────┤
                                       └─ G：Git 服务/面板 ─┤─ I/V：集成验收
T：文本保存契约纠错与验证 ─────────────────> F 的文本写接线   │
P 的 root-scoped facts 接线完成 ───────────> G 的 main 强刷变更┘
```

**现在可同时分派 P 和 S 两个代码任务；第三位可做 V 的只读审查。** F/G 等 S 的接口、能力与收据检查点验证并同步后再并行，不凭草稿猜 API。T 未完成时 F 可以迁只读面，文本写沿用既有路径并登记未完成项，不能宣布 Phase B 全部完成。

| 编号 | 职责 | 开始门槛 | 完成门槛 |
|---|---|---|---|
| P | 池、锁、root 会话事件、watch 与 facts 接线 | 读本文件和池化 ADR，列本任务实施计划 | 默认关闭的可测池化路径 + 项目隔离；默认开启另过真机门禁 |
| S | renderer 服务契约、能力组合、文件收据 | A0 文件可见；独占服务契约 | 类型/行为测试通过，给 F/G 固定方法、返回值、错误与生命周期说明 |
| T | 文本保存与错误旧测试合同纠错 | §4 的纠错范围明确，与 S 由同一负责人先后实施 | 真实文本令牌边界成立，错误旧预期已纠正、有效覆盖保留，相关测试全绿 |
| F | 文件抽屉与编辑器接服务 | S 检查点；文本写还需 T | 文件 parity、草稿/回收站/未知结果/订阅清理保持 |
| G | Git provider、能力副作用与面板迁移 | S 检查点；main 修改等待 P 释放对应文件 | 分片保留读、确认写、恢复和显式同步，unknown 不重放 |
| I/V | 汇聚接线、复核与集成 | 各卡差异可审查；V 可先只读 | 在同一集成结果上运行门禁，区分 pass/fail/skip/未测 |

### 工作树与公共文件

1. 优先两条独立 worktree；可复用合适的已有工作树，新增分支用 `codex/`。不要替别的智能体清理工作树、stash、装依赖或终止进程。
2. **本次文件尚未提交。** 从 `24529c394` 新建 worktree 不会自动带上 A0 和本交接。协调人须先统一基线：经用户授权提交后使用该提交；或在目标文件确认与基线一致时，显式同步下列白名单文件。目标已有改动时停下核对，不覆盖。
3. 前置同步白名单：`AGENTS.md`、`docs/engineering-standards.md`、`src/renderer/src/services/projectFileService.ts`、`tests/projectServiceStatRead.test.mjs`、本文件、`docs/README.md`、`docs/project-panel-service-seam-adr.md`、`docs/remote-file-tree-and-git-unification-plan.md`、`docs/remote-host-root-pooling-adr.md`、`docs/root-pooling-handoff.md`。必须同步测试演进新规则，避免工作树继续按旧禁令执行。未提交同步要记录源/目标内容一致，任务 diff 分开列前置与本任务文件，避免重复提交。
4. 若只能共享当前工作树，严格按下表 ownership；不运行全仓写格式化。公共文件由 I 单写，提交修改需求/补丁给 I 后继续自己独立部分。
5. `AGENTS.md`、`package*.json`、`scripts/testShapeBaseline.json` 不在本批修改范围。`main/index.ts`、`App.tsx`、`DrawerSurface.tsx`、`src/preload/index.ts`、`src/shared/**`、i18n 由 I 单写；只读不受限。I 应及时应用必要汇聚改动再验证，不能让代码任务以未接线类型错误收尾。
6. 未获用户明确授权，不 `git add/commit/push/merge`，不重启宿主、不连接真实远端。代码完成与允许合入是不同状态。
7. 各线可按工程标准更新本域相关既有测试，跨域共用测试仍单一写者。`projectServiceSeam.test.mjs` 在 S/T 阶段归 S，检查点后 G 所需变更由 I 协调移交，避免同时修改同一测试文件。

## 3. P：main 池化线

**独占修改范围：**

- `src/main/remote/RemoteHostConnectionService.ts`、新增 `RemoteRootSessionPool.ts` 等本域窄模块。
- `src/main/remote/RemoteDirWatchRegistry.ts`、`RemoteDeepDirWatch.ts`。
- `src/main/ipc/remoteProjectIpc.ts`、`remoteProjectReadIpc.ts`、`remoteGitReadIpc.ts`。
- 新增池化行为测试；保留旧路径仍有效的回归覆盖，相关测试可按工程标准更新。`RemoteFactCache.ts`/`RemoteGitSnapshotFacts.ts` 先作为只读依赖，不重造缓存。
- `main/index.ts` 的 helper 事件/断开装配由 I 单写；P 给出精确接线要求及测试。

**先给实施计划，再在默认关闭路径实施 P0–P3：**本地基线与预算 → 池/按 root 锁 → watcher/facts/能力接线 → 离线验收。外部环境未授权不阻塞可离线的实现；默认开启须另过真实多项目、资源、延迟验收，不能把历史双 helper 探针当新实现通过。

必须落实池化 ADR §5.2，尤其：

1. 缓存 key 按项目并不代表输入 generation 已正确。当前目录和 Git 暖缓存仍读 `connectionFacts(hostId)`；内容搜索和 rootStatus 仍读 `helperCapabilities(hostId)`。项目读必须取该 root 的事实，纯查询不能创建会话或退回兄弟 root。
2. 建议 main 私有 `projectConnectionFacts(hostId, canonicalRoot)` 返回对应 session 的身份、状态和 helper 能力；名称可随既有类型调整。旧 host 管理入口不当作项目事实入口。不新增公共 IPC 是优先路径。
3. helper 事件增加 main 内 session 身份，按 host + session + watchId 路由；不同 helper 返回同一个 watchId 也不能串事件。
4. root 退休与 host 断开分开。`main/index.ts` 当前 host 断开回调还会关闭该主机终端，TTL/LRU/单 root 崩溃绝不能复用它。
5. 保留 `requireReady` 的既有语义：主机在线时允许为新项目建 helper；用户显式断开后后台读不能复活主机。
6. 空闲保温候选值 2 / TTL 10 分钟，不限制登记项目数。执行 lease 与订阅策略、总资源上限和可取消的有界等待必须可测；不得只看 inflight 而回收仍受保护的 watch。
7. 新请求不能中断在途写。首版开关在构造/启动时选择；运行期自动拆池降级不在首版范围。

**新增验收：**同主机 A/B/C 三 root；同 key 并发仅建一次；A 慢操作不阻塞已就绪 B；相同 watchId 的隔离；A 淘汰/B generation 不变；租约/订阅/TTL 交错；预算满时取消/超时；显式断开、rebind、root drift；旧 session 写失败且不重放。重叠目录/共享 Git 资源另列冲突处理，不假定不同项目必然无写冲突。

本地已有回归起点：

```powershell
node --test tests/remoteHostConnectionService.test.mjs tests/remoteProjectReadIsolation.test.mjs tests/remoteProjectRootStatusIsolation.test.mjs tests/remoteDirWatchRegistry.test.mjs tests/remoteDirWatchLifecycle.test.mjs tests/remoteDirWatchDeep.test.mjs tests/remoteFactCache.test.mjs
node --test tests/remoteGitFactsBoundary.test.mjs tests/remoteFactsNotificationLoop.test.mjs tests/remoteFactsTreeInvalidation.test.mjs tests/remoteConnectionCancellation.test.mjs tests/remoteHostOperationLock.test.mjs tests/remoteSessionScanIsolation.test.mjs tests/remoteSessionRootIsolation.test.mjs tests/remoteSessionRootResolution.test.mjs
```

第一组在本次只读核对中 68/68 通过，只是现行单 root 基线。真实扫描已使用注入的 command transport，不重做扫描迁移。

## 4. S/T：服务契约与文本纠错

**S 独占：**`src/renderer/src/services/projectServiceContracts.ts`、`projectServices.ts`、`projectFileService.ts`、`hooks/useProjectServices.ts`、必要的新服务模块和本域相关测试。检查点前 S 也拥有 `services/projectGitService.ts` 的类型适配/显式 unsupported 实现权限，确保扩契约后两个 provider 都能通过 typecheck；检查点交付时该文件明确转交 G，不能同时写。T 与 S 涉及同一文件，由同一负责人先后处理，不能各写一份。

S 冻结的内容：

- 服务/订阅绑定明确 project 身份；异步结果检查连接代数。业务组件不读取全局“当前项目”来补目标。
- 复用 `src/shared/projectCapabilities.ts` 的纯判定，组合实际方法支持、root/host 状态、trust、watch/search 能力与代数；已有 resolver 不足以单独代表完整有效能力。main 仍逐操作复验，capability 不代替授权。
- 远端 Git provider 尚未实现的动作不得因为主机 ready 而宣布可用。断线、项目失效、重绑后能力应更新，订阅必须有清理。
- 明确无运行上下文时的行为：现有测试锁定远端写 unsupported 和静态能力值，但这些包含 Phase A 阶段性预期。S 应按真实能力与授权边界定义新契约，G 同步更新过时预期并覆盖可用/不可用两条路径；不得为了旧断言检测测试环境或造兼容壳。未经有效授权不得实际写入的边界继续验证。
- 目录页的 truncated/revision/generation/未知 children 保留；文件写返回既有收据（如 trashId），保留 rejected/unknown；文本 version 与 entry token 不能合并。
- `stat` 的缺失与读取不可用语义明确记录；若需公共结果扩展，先交 I 统一改共享类型/IPC/preload，不在两个 provider 中自行猜码。
- 明确所需 Git 方法与 capability（包括自动 status/refs/fetch 的效果门禁），实现交给 G；不要求先扩完整未来 RPC 框架。

检查点交付：类型与最小适配实现一起通过 typecheck；每个方法/能力都有现状或显式 unsupported；给 F/G 可同步的基线，不只交一份仍变化的接口草稿。

```powershell
node --test tests/projectServiceSeam.test.mjs tests/projectServiceStatRead.test.mjs tests/projectCapabilities.test.mjs tests/projectFileBackendConformance.test.mjs
```

### T：文本保存与错误旧测试一起纠正

`tests/projectServiceSeam.test.mjs` 的“远端文件写面：保存必须带 version；缺省时先取 entry 令牌，再写”用例要求：无 version 时 `statProjectEntry → saveProjectText` 并成功。main 的 `RemoteProjectFileService` 只接受其文本 `versions` 表的令牌，entry token 属于另一张表，两者不兼容。

根 `AGENTS.md` 铁律 10 已按用户要求改为允许测试随需求与契约演进。T 可在下述明确范围内同时纠正实现与旧预期，无需仅为修改该用例再确认；交付须说明旧预期为何错误、哪些有效断言保留，并补真实令牌边界验证。不跳过测试、不带红灯合入、不自动 open 后覆盖保存。T 仍待实施，F 的文本写接线须等待它通过验证。

具体纠错范围为该用例、相应 `writeText` 分支及令牌边界回归测试：

| 输入/场景 | 应验证的行为 |
|---|---|
| readText 返回的有效 version | 原样传给 save，保存成功并返回新 version |
| version 缺失或空串 | 抛 `PROJECT_SERVICE_VERSION_REQUIRED`；不调用 entry stat、text open 或 save |
| 有字符串但属于 entry/另一项目/另一窗口/旧主机身份 | main 拒绝，不发实际写；provider 不补令牌重试 |
| 结果 unknown | 保留错误与草稿，按既有流程只读核对，不自动重放 |

保留既有有效 version 断言；将“缺省自动取 entry 并成功”的断言纠正为“缺省拒绝且无调用”，同时新增跨平台、无 SSH 的真实文本服务令牌边界测试。原 `remoteProjectFileService.test.mjs` 多数用例仅 Linux 运行，Windows 上 skip 不能算保存竞态验收。

## 5. F/G：契约冻结后的两个 UI 任务

### F：文件抽屉

可写：`hooks/useRemoteFileTree.ts`、`hooks/files/useProjectFileTreeController.ts`、`hooks/useFileSearch.ts`、`hooks/useRemoteProjectSearch.ts`、`hooks/useRemoteContentSearch.ts`、`hooks/useRemoteProjectEntries.ts`、`hooks/useRemoteFileDraft.ts`、`components/session/RemoteProjectPanel.tsx`、`components/session/WorkspaceSurface.tsx`、`components/workspace/RemoteFileEditor.tsx`；本域相关测试。

只消费 S 契约；共享装配 `DrawerSurface.tsx` 交 I。复用已存在的 `lazyDirTree`，保住分页截断、未知 children、已展开目录更新、草稿/冲突、回收站收据、上传限制、取消与退订。未迁完的真实专属 UI 可以保留薄外壳，不提前删除。

```powershell
node --test tests/lazyDirTree.test.mjs tests/remoteFileTreeKeyMapping.test.mjs tests/remoteFileDrafts.test.mjs tests/remoteProjectEntryState.test.mjs tests/remoteContentSearchCapabilityUi.test.mjs tests/remoteDirectoryPageWatchDegraded.test.mjs tests/remoteProjectRootStatusEnvelope.test.mjs
```

### G：Git 服务与面板

可写：`services/projectGitService.ts`、`components/app/GitPanel.tsx`、`components/workspace/RemoteGitPanel.tsx`、`hooks/useRemoteGitView.ts`、`utils/remoteGitViewState.ts` 及本域必要模块/相关测试。S 冻结契约并释放 Git provider 文件后 G 才接手，公共契约需要变更交 I 协调。按 S 的新契约更新 Phase A 阶段性预期，同时验证远端写可用与不可用、授权拒绝等边界。

分片：纯事实 status/真正强刷、diff/history/refs/compare → stage/commit/discard → 分支/sync/recovery。既有 token owner、确认、scope、unknown 和本地行为保持；按钮、菜单、快捷键、effect 均受能力约束。

`refresh()` 不能继续调用缓存 status，也不能机械调用 `refreshRemoteSnapshot` 后丢掉令牌：后者会 revoke 并重新签发授权。先设计“纯事实强刷”和“显式授权 snapshot”的区分；若扩 force 参数，P 释放 `remoteGitReadIpc.ts` 后由 I 协调 main/preload/共享类型一次接全。

Git 的 `FileTree` 在 `components/app/git/GitResourceTree.tsx`；它是变更树，不是文件抽屉本体。修改共用展示组件需先声明给 I，不能按 ADR 的简称误改整个文件域。

```powershell
node --test tests/remoteGitFactsBoundary.test.mjs tests/remoteGitSnapshotFacts.test.mjs tests/remoteGitReadIpc.test.mjs tests/remoteGitMultiRepoTokenScope.test.mjs tests/remoteGitViewState.test.mjs tests/gitGraphCapabilityGating.test.mjs tests/gitPanelRefreshStability.test.mjs
```

## 6. I/V：验收、交付与集成顺序

- 基线顺序：A0/本交接 → P 与 S 可各自验收 → S 检查点供 F/G 使用 → T 验证通过后接文件文本写 → P/F/G 汇聚 → 最终多项目验收。P 不依赖 T，F/G 不修改 P 的私有连接接口。
- 每卡必跑 `npm run typecheck`、自己新增测试和涉及的现有测试；有 IPC 接线再跑 `npm run check:ipc-wiring`；代码测试过 `npm run check:test-shape`，不得更新基线绕过。
- 格式化只针对本任务文件，集成时检查 `npm run check:format`。全量 `npm test` 仅在跨域集成/合入前由 V 跑一次并记录基线失败；不得把历史失败数直接当本轮结果。
- E2E 单一运行者、窗口默认屏幕外，先准备本次代码对应的必要子构建。禁止全量 `npm run build`、`npm run test:e2e`、`preflight/pack`；构建方法见统一计划 §10.5。
- 真实主机连接、服务重启须有当前授权；探针 `tests/remoteRootSwitchProbe.mjs` 与 `e2e/remoteHostAcceptance.spec.ts`、`remoteFunctionalAcceptance.spec.ts`、`remoteSessionAcceptance.spec.ts` 不能因旧日志存在就自动执行。未测/skip 单列，不伪称池化 E2E 已过。
- 派工不等于提交/合并授权。每卡交回：基线与工作树、仅本任务文件、行为前后对照、命令与退出码/通过失败跳过数、未验证项、需 I 接线的精确位置、回滚方式。不改别人的文件；文件 ownership 变化先由 I 发布。

## 7. 可直接复制的提示词

### 提示词 P：现在可发

```text
在 F:\PiDeck 承接远程多项目任务 P（main 池化 + watch/facts）。先读 AGENTS.md、docs/remote-project-parallel-handoff.md 全文和它引用的池化 ADR，按第 3 节执行。
先核对工作树/基线；本次前置修复与交接可能尚未提交，必须按第 2 节确认已同步，不能从旧 HEAD 开 worktree 后忽略它们。优先独立工作树。
先给本任务分片实施计划，然后实现默认关闭的池化路径与离线行为测试。只写 P 的 ownership；main/index.ts、shared/preload 等公共文件把精确变更交协调人，不擅自改 renderer。
重点验证 root-scoped connection facts/helper capabilities、同 watchId 隔离、root 退休不能触发 host 断开/关闭终端、租约/容量/取消、旧写不重放。保留旧路径有效行为覆盖；相关测试按新契约演进，报告依据与覆盖变化。
无需等待 S/T；真实主机未授权时继续可离线实现，记录真机验收缺口，不默认开启。不要提交、push、merge、安装依赖、全量构建或重启宿主。按第 6 节交回证据和未完成项。
```

### 提示词 S：现在可发

```text
在 F:\PiDeck 承接任务 S（服务契约、动态能力、文件收据）。先读 AGENTS.md、docs/remote-project-parallel-handoff.md 全文及服务缝 ADR/统一计划，按第 4 节执行。
先核对基线、工作树和 A0 前置同步，优先独立工作树。P 智能体正在独占 main 池化/事件/facts；你只写 S 的 ownership，公共文件交协调人。
先列方法/结果/错误/能力/订阅的最小实施计划，再实现并验证，向 F/G 交付可消费且类型检查通过的契约检查点。复用已有 shared/projectCapabilities，不造第二套连接状态规则。
你同时负责第 4 节 T 的文本保存纠错，按明确范围同步修改实现与错误旧预期，补真实令牌边界测试；无需仅为修改旧用例另行确认。先后修改同一文件，T 验证通过后再交 F 接文本写；未完成项如实列出。Git 纯刷新不能借授权 snapshot 静默重签令牌。
不要提交、push、merge、连接远端、安装依赖、全量构建或重启宿主。按第 6 节交回文件、验证、契约检查点及 T/公共接线的未完成项。
```

### 提示词 V：可同时只读审查

```text
在 F:\PiDeck 承接任务 V。先读 AGENTS.md 和 docs/remote-project-parallel-handoff.md，核对 P/S 的 ownership、基线、契约检查点和已有测试证据。
现阶段只读审查，不修改 P/S 文件、不跑真实远端或 Electron、不创建假的已完成记录。优先审查项目身份/generation、令牌类型、force refresh、退订与 root/host 清理边界。
输出按严重性排序的具体问题、遗漏的行为验收、可重用的测试文件。等协调人提供集成基线后再承担第 6 节的最终验收，不用历史测试数字替代当前结果。
```

### 提示词 F/G：S 检查点后再发

```text
在 F:\PiDeck 承接 docs/remote-project-parallel-handoff.md 第 5 节的【F 或 G，由协调人选定一个】。先读 AGENTS.md 和交接全文。
先确认 S 的契约检查点已经同步且通过 typecheck；F 的文本写需 T 验证通过，G 的 main 强刷修改需 P 释放对应文件。依赖未就绪时只审查/准备自己的局部工作，不自行发明接口。
优先独立工作树，只修改所选任务 ownership；DrawerSurface/main/index/shared/preload/i18n 由协调人单写。按第 5 节分片实现、验证和登记 parity，不删除尚有真实职责的远端外壳。
按新契约更新相关过时测试，保留仍有效的回归与安全覆盖并说明依据；不自动重取令牌重放写入，不把远端显式同步变成自动 fetch。不要提交、push、merge、连接远端、安装依赖、全量构建或重启宿主。按第 6 节交回。
```
