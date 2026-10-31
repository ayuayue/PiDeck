Status: **Active plan** — 2026-10-31（I0 集成更新，取代原「A0 已完成、P/S/T/F/G 待实施」状态）；基线 `dev / 24529c394`。A0、P、S/T 已在集成工作区 `F:\PiDeck` 整合并通过门禁，并以一组提交落到 `dev`（未 push；范围 `git log --oneline 24529c394..dev`）；S 契约已冻结（§8.2）、T 已验证（§8.5）；**F/G 可开工**；V **未核验（未找到产出物）**，不得表述为「V 已通过」。凡与源码冲突的旧表述以源码为准。

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

**I0 更新（2026-10-31）：P、S/T 已完成并在 `F:\PiDeck` 整合；S 契约冻结（§8.2）、T 已验证（§8.5），F/G 的开工条件已满足。V 未核验（§8.6）。** 下面的派工表保留为历史；当前状态、证据与剩余项以 §8 为准。

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
2. **I0 基线已提交到 `dev`（从 `dev` 当前 HEAD 新建工作树即可继承）。** 从 `24529c394` 新建 worktree 不会带上 A0 和本交接；现在应从 `dev` 新建 worktree（§8.4），或在目标文件确认与基线一致时显式同步白名单文件。目标已有改动时停下核对，不覆盖。
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

根 `AGENTS.md` 铁律 10 已按用户要求改为允许测试随需求与契约演进。T 可在下述明确范围内同时纠正实现与旧预期，无需仅为修改该用例再确认；交付须说明旧预期为何错误、哪些有效断言保留，并补真实令牌边界验证。不跳过测试、不带红灯合入、不自动 open 后覆盖保存。T 已在 `F:\PiDeck-codex-s` 完成并通过验证（62/62、0 skip，见 §8.5），F 的文本写可接线。

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

---

## 8. I0 集成结果（2026-10-31）

> 本节是 **I0（24529c394）历史快照**；2026-10-31 更新：后续检查点 09aca4203、55dd5b702 与修复提交 a905d4d7d 已改变文件计数、基线清单与 root 退休语义，当前验收状态见 [remote-acceptance-55dd5b702.md](remote-acceptance-55dd5b702.md)。本文其余小节若与源码冲突，以源码为准。

### 8.1 集成工作区、落点与接线

- **集成工作区：`F:\PiDeck`（`dev` @ I0 基线提交组，基于 `24529c394`）**。A0 与文档前置本来就在此；P 与 S/T 以显式文件同步并入，随后按来源拆成四个提交落到 `dev`（**未 push、未 merge**）；P、S/T 两个工作树的未提交成果原样保留（未 stash、未清理、未覆盖）。
- 来源与文件数（逐文件 sha256 见 §8.4 的清单）：
  - **P（main 池化）**：22 个 P 专属文件 = 6 改 src + 2 新增 src（`RemoteRootSessionPool.ts`、`remoteProjectWatchKeepAlive.ts`）+ 10 改测试 + 4 新增测试（I0 快照；55dd5b702 增量：+1 src `remoteProjectDirFacts.ts`、+1 测试 `remoteProjectLifecycle.test.mjs`、改 2 个测试）。另 2 个文件与 A0 逐字节相同（`projectFileService.ts`、`projectServiceStatRead.test.mjs`），未重复写入。
  - **S/T（服务契约）**：15 个文件 = 5 改 src + 5 新增 src + 1 改测试 + 4 新增测试。其中 `projectFileService.ts` 与 `projectServiceStatRead.test.mjs` 是 A0 的**超集**（stat 语义演进为 present/unavailable），集成取 S 版；A0 的两个用例已随之演进（未被删除）。
  - **A0/文档前置**：§2.3 白名单 10 个文件在三树 sha256 逐字节一致，无需重同步。
- **公共接线（集成者单写，`src/main/index.ts` 两处）**：服务构造参数新增 `onRootRetired`；事实层端口 `onHelperEvent` 增加 `sessionKey` 并新增 `onRootRetired`。
  - **root 退休 ≠ 主机断开**：`onDisconnect` 仍负责关闭该主机终端 + `onHostDisconnected`；`onRootRetired` 清该 root 会话的 watch 登记与保活，**55dd5b702 起还按 sessionKey+host+root 清该项目的 generation/host/root 与目录事实**（`remoteProjectDirFacts.ts:199-209`），但仍**不关终端、不动邻居 root**。
  - **池化保持默认关闭**：未传 `rootPooling`，生产仍走原单会话路径（开启方式见 §8.8 第 13 条，属集成者单写）。
  - p-public-wiring.md 的三条建议中，第 1、2 条为强制接线，已按代码真实签名落地；第 3 条（开启池化）按「默认关闭」未采用。
- **集成期发现并修正的差异（透明记录）**：
  1. P 把项目事实改成 root-scoped 后，`tests/projectFileBackendConformance.test.mjs` 的假 service 只有主机级 `connectionFacts`，3 例 `TypeError`。按新契约把假 service 改为 `projectConnectionFacts`（语义仍是 ready 会话）——夹具适配新契约，不是放宽断言。
  2. 按 p-public-wiring.md 建议，在 `tests/remoteProjectDirFacts.test.mjs` 增加 1 例「root 退休只归还该会话保活、迟到事件不再标脏」的**接线断言**（P 组 141 → 142；I0 快照，55dd5b702 后该用例已演进为“旧代目录事实失效”，且新增 `remoteProjectLifecycle.test.mjs` 6 例，当前计数以实跑为准）。
  3. 提交前把两处 CRLF 文档（`docs/engineering-standards.md`、`docs/remote-file-tree-and-git-unification-plan.md`）规范为 LF，与 `.gitattributes` 的 `eol=lf` 一致；否则 git 入库转 LF 后，清单哈希与任何新检出都对不上。

### 8.2 S 冻结契约（F/G 的唯一消费面）

**入口**：`useProjectServices(project)` → `ProjectServices`（`src/renderer/src/services/`）。F/G 只消费它：
- 不自行调用 preload 的事实/状态订阅，不读取全局「当前项目」来补目标，不在两个 provider 之外再写一套「主机 ready ⇒ 都可用」的判定。
- 组件卸载/项目或 host/root 变化由 hook 换 runtime 并清理订阅；旧实例的迟到结果一律抛 `PROJECT_SERVICE_GENERATION_STALE`。

`ProjectServices`（`projectServiceContracts.ts:325-337`）：`projectId`、`kind: "local" | "remote"`、`generation`、`facts`、`files`、`git`、`capabilities`、`isCurrent(): boolean`、`refresh(): Promise<void>`。

**文件服务 `ProjectFileService`（pfc:155-170，实现 `projectFileService.ts`）**

| 方法 | 返回 | 行为与本地/远端差异 |
|---|---|---|
| `listDirectory(target, {force?})` | `ProjectDirectoryPage` | 两端同走 `files.directoryPage`；`truncated/revision/generation/hasChildren="unknown"` 原样保留；先校验 `target.projectId` |
| `searchFiles(query)` | `{ results, truncated?, scanned? }` | 本地 `files.search`；远端 `remoteHosts.searchProject`（**不是** `files.search`，见 §8.8 第 9 条）；没有元数据就不填 `false` 冒充完整 |
| `searchContent(query)` | `FileContentSearchResult` 或 `null` | 两端同走 `files.searchContent`；`null` = 该位置没有内容索引（旧 helper/无索引），是否展示看能力 |
| `readText(target, {maxBytes?})` | `{ content, version? }` | 本地 `files.readContent`（无 version）；远端 `openProjectText`（main 256KiB 上限，`maxBytes` 忽略），`version` 原样返回 |
| `writeText(target, content, expectedVersion?)` | `{ version? }` | **远端必须带 `readText` 返回的 version**：缺失/空串 → `PROJECT_SERVICE_VERSION_REQUIRED` 且零调用（不取 entry 令牌、不 open、不 save）；本地传任何 version → `UNSUPPORTED` 且零调用；unknown 不重试、不重开 |
| `stat(target)` | `{ availability, isDirectory?, code? }` | 只用公共 `files.stat` 纯读（A0 入口，不签 entry 令牌）；`exists→present`，负结果 → `unavailable` + `PROJECT_SERVICE_STAT_UNAVAILABLE`（**不得当成「文件不存在」**）；`missing` 已建模但当前不可达（见 §8.8 第 3 条） |
| `createEntry(parent, name, type)` | `{ target, kind? }` | 本地 `files.create`；远端 `createProjectFile/Directory`，收据带返回的 relativePath/kind |
| `renameEntry(target, newName, expectedVersion?)` | `{ target }` | 远端缺 version 时取 **entry 令牌**（只用于 entry 面，绝不作文本 version） |
| `deleteEntry(target, expectedVersion?)` | `{ target, trashId? }` | 远端进回收站时带 `trashId`；本地无恢复收据 |
| `openInEditor(target)` / `showInFolder(target)` | `void` | 本地 `files.open/showInFolder`；远端显式 `UNSUPPORTED`、零通道调用 |

**Git 服务 `ProjectGitService`（pfc:198-228，实现 `projectGitService.ts`，**已移交 G**）**

| 方法 | 返回 | 现状（S 检查点） |
|---|---|---|
| `status/repos/refs/compare/history/workspaceDiff` | 对应 `Git*` 类型 | 本地与远端走同一公共 `git:*`（main 按位置路由）；先校验项目身份 |
| `refresh(repoPath?)` | `GitResourceGroups` | 本地 = 直接 `git.status`；**远端显式 `UNSUPPORTED`**（不得退化为 status，也不得用授权 snapshot 静默重签令牌）——G 接「纯事实强刷」 |
| `branches/aheadBehind` | `GitBranchInfo` / `GitAheadBehind` | 本地可用；远端 `UNSUPPORTED`（待 G） |
| `stage/unstage/commit/discard/fetch/pull/push/init/deleteFiles/worktree*` | — | 本地委派既有 `git:*`；远端全部 `UNSUPPORTED`（写/同步/恢复/worktree 待 G 接令牌经纪） |
| `createBranch(name, mode)` | `void` | 本地只接受 `create-and-checkout`（不暗改「仅创建」）；远端 `UNSUPPORTED` |
| `syncFacts/recoveryList/recoveryRestore/recoveryDrop` | `ProjectGitSyncFacts` / `ProjectGitRecoveryListing` | 类型已冻结，实现归 G；当前 `UNSUPPORTED` |

**能力 `ProjectServiceCapabilities`（唯一判定：`projectServiceCapabilities.ts`，复用 `shared/projectCapabilities.ts`）**

- 顶层：`projectId/locationKind/generation/trust/files/git/blocked`。
- `files`：`read/write/trash/search/contentSearch/systemOpen/textVersion("required"|"none")/watch("full"|"degraded"|"none")`。
- `git`：`read/diff/branchRead/history/repos/refs/write/branchWrite/branchCreateMode/sync/syncFacts/aheadBehind/compare/recovery/worktree/init/forceRefresh/autoFetch/statusPoll/refsWatch/deleteFiles`。
- 判定链：shared 的连接/可写结论 → 项目事实（root 复核、trust、helper hello 声明的方法）→ provider 实际方法支持；**helper 未声明 = 不支持**；远端 Git 写/同步/恢复/worktree/deleteFiles/branches/aheadBehind/forceRefresh 一律关闭，等 G 实现后再逐项打开。
- 每条关闭项在 `blocked` 里带第一条稳定原因：`PROJECT_SERVICE_CAPABILITY_ROOT_NEEDS_ATTENTION / TRUST_REQUIRED / TRUST_STALE / TRUST_UNKNOWN / HELPER_METHOD_MISSING / PROVIDER_UNSUPPORTED`（host 级原因复用 `PROJECT_CAPABILITY_REASONS`）。
- 能力只决定 UI 入口，**不替代 main 的逐操作授权**；trust 只门禁 Git（文件 API 不读 trust）；本机 WSL 无内容索引。

**错误与失败语义（pfc:30-64、`projectServiceFence.ts`）**

| 码 | 语义 |
|---|---|
| `PROJECT_SERVICE_UNSUPPORTED` | provider/位置明确不支持（零通道调用） |
| `PROJECT_SERVICE_VERSION_REQUIRED` | 远端文本保存缺 version / 空串；在触达 entry stat/open/save 之前抛出 |
| `PROJECT_SERVICE_FAILED` | 中性回退码（raw 通道没有稳定码时），不冒充「远端失败」 |
| `PROJECT_SERVICE_PROJECT_MISMATCH` | target/targets/repoPath 与 services 绑定的项目不符；构造期 facts/project 不符也用它 |
| `PROJECT_SERVICE_GENERATION_STALE` | await 后连接代已变；**读 = rejected，写 = unknown**（写可能已落地，禁止自动重放） |
| `PROJECT_SERVICE_STAT_UNAVAILABLE` | `stat` 的 availability=unavailable 附带码，不抛；不能显示为「不存在」 |

- 失败以 `ProjectServiceError` 抛出：`code` + `outcome("rejected"|"unknown")` + 内部 `detail`（不当 UI 文案）。`outcome` 决定后续动作：rejected 可提示重试；unknown 只读核对、保留草稿、不重放。
- raw 错误归一：已是 `ProjectServiceError` 原样；否则取稳定码形状；`OP_UNKNOWN_CODES`/attached unknown → unknown，其余 rejected；不猜自由文本。

**生命周期/订阅规则**

| 规则 | 落地 |
|---|---|
| 项目身份绑定 | services 创建即绑定 `projectId`；所有 target 触达 IPC 前断言；组件不读全局当前项目 |
| 连接代 | `generation = ssh:hostId:epoch[:mainGeneration]`（本机 `local`）；服务捕获创建代，await 后与共享槽比对；runtime 代数单调、已退休代不复活 |
| 断线/事实更新 | `start()` 幂等：订 host 状态 + 项目事实并采集一次；host 状态变化 → epoch+1、清 mainGeneration、重建；事实事件的 generation 迟于状态事件也不得回退；断线 → 能力全关 |
| 退订/清理 | `dispose()` 退订并作废在途采集，可再次 `start()`（StrictMode）；订阅按 `(api, projectId, hostId, root)` 引用计数共享，最后一个消费者释放才真正退订 |
| 重绑 | `project.id / hostId / remotePath` 变化 → hook 换 runtime、旧 effect cleanup；旧 services 不得缓存复用 |
| 对外刷新 | `services.refresh()` 只读重采集（trust 无推送事件）；`isCurrent()` 供调用方在发布结果前自检 |

**F/G 注意**：runtime 不暴露 facts scopes（只重建 capabilities）。目录/Git 的数据失效通知仍需各自订阅既有事实事件（`onProjectFactsChanged`）；但**不要各自直订 preload**——现有直订实现会互相退订（见 §8.8 第 4 条），统一入口定案前，F/G 同时开两个直订 hook 会掉订阅。

### 8.3 ownership 发布（I0）

- `services/projectGitService.ts` **S 检查点完成，正式移交 G**（S 不再写该文件）；G 可按新契约更新其实现与相关测试。
- **F**：§5「F：文件抽屉」的可写清单不变；只消费 §8.2 契约。
- **G**：§5「G：Git 服务与面板」的可写清单不变；`projectGitService.ts` 归 G；main/preload/shared 的强刷与写令牌经纪需集成者一次接全，不得各自扩通道。
- **集成者单写**：`main/index.ts`、`shared/preload`、i18n、`DrawerSurface.tsx`/`App.tsx` 等公共装配、本文档与基线清单。
- 测试 ownership：`projectServiceSeam.test.mjs` 仍归 S；`projectFileBackendConformance.test.mjs` 与 `remoteProjectDirFacts.test.mjs` 的集成期夹具/接线断言已由 I 更新（见 §8.1）；G 后续若要改共用展示组件或公共测试，先提 I。

### 8.4 F/G 如何获得完全一致的基线（基线已提交；清单与工具用于校验/回退）

**现状**：I0 成果已提交到 `dev`（提交组见 §8.7）。F/G 从 `dev` 当前 HEAD 新建 worktree 即**自动继承**全部文件，不需要手工同步。

**历史问题（保留作背景，也是工具的用途）**：成果最初全部未提交时，从 `24529c394` 新建 worktree **不会**继承 A0/P/S 的任何文件。清单 + 工具因此保留，用于：① 校验任意工作树是否与 I0 基线逐字节一致；② 若后续又在未提交状态下继续集成，可显式同步（先查冲突，再写入）。

**做法（清单 + 工具 + 冲突检查，可重入）**：

1. 清单：`docs/panel-service-baseline.manifest` —— 每行 `<sha256>  <相对仓库根的路径>`，覆盖 A0 + 文档前置 + P + S/T + 本次集成改动（`main/index.ts` 接线、集成期测试夹具、本工具）。清单自身不在清单内（它是参照物）。
2. 工具：`scripts/panel-baseline.mjs`（无依赖、无网络）：

~~~powershell
# 推荐：F 或 G 从 dev 当前 HEAD 新建工作树（分支名自定，用 codex/ 前缀）——无需 sync，文件自动继承
# 基线由 docs/panel-service-baseline.manifest 定格；若 dev 之后又有提交，用 verify 核对代码文件是否与基线一致
git -C F:\PiDeck worktree add F:\PiDeck-f -b codex/file-drawer dev
# 独立复核：确认该工作树与 I0 基线逐字节一致（退出码 0 = 一致）
node F:\PiDeck\scripts\panel-baseline.mjs verify --dir F:\PiDeck-f

# 仅当「在未提交状态下继续集成」时才需要：先逐文件查冲突，冲突则整体中止（退出码 2，一个文件都不写）
node F:\PiDeck\scripts\panel-baseline.mjs sync --to F:\PiDeck-f
~~~

3. 冲突/漂移规则：
   - 基线提交建造的 worktree：文件随提交继承，`git status` 干净，不存在“基线算谁的改动”的问题。
   - 未提交同步场景：目标已是清单值 → 跳过（可重入）；不存在（基线新增文件）→ 写入；**存在且有它自己的未提交改动** → 判冲突、整体中止，不覆盖别人的成果。
   - 源与清单不一致（清单过期）→ `sync` 中止；先在集成工作区重建清单，再重新 sync，禁止把半新半旧的文件带到 F/G。
   - 同步完成后 `git status` 的未提交清单应与 manifest 完全对应；不一致就是漏同步或混入额外改动，停止开工并报告。
4. 内容一致性证据：`verify` 逐个文件比对 sha256（**I0 清单 48 个文件**）。已实测两次：① 在基线提交组的新工作树上 `verify` 48/48 且 `git status` 干净；② 在空 `24529c394` 工作树上 `sync → verify` 48 文件逐字节一致、目标 `git status` 恰为 48 项（见 §8.7）。**2026-10-31 实测：重建前 verify rc=1、19/48 mismatch（16/48 为文档更新前快照；差额来自本检查点的文档更新）；已按 HEAD f870d5574 重建（48 条成员不变，仅刷新哈希），verify 48/48 rc=0。**
5. 依赖：新工作树没有 `node_modules`。按 AGENTS.md「并行期间不 `npm install`」，开工前由集成者统一准备（或在用户授权下安装），F/G 不自行处理。
6. 基线变更纪律：集成者修改清单内文件时必须提交并在提交信息中注明基线变更；F/G 从新基线提交重开工作树（或按本节的未提交同步流程）。F/G 不得各自修改公共文件、不得自建第二份基线、不得用旧基线开工。

### 8.5 T 验证结论（已验证）

| 交接 §4 要求 | 实现 | 验证 | 结论 |
|---|---|---|---|
| readText 的有效 version 原样传给 save | pfs:73-76,181-189 | seam:286-306；textVersion:102-116,206-217 | 已验证 |
| version 缺失/空串 → `PROJECT_SERVICE_VERSION_REQUIRED`，且不调用 entry stat/open/save | pfs:73-76,185 | seam:297-305（零调用）；textVersion:219-230（open=save=stat=0） | 已验证 |
| 跨项目/跨窗口/旧主机身份的令牌由 main 拒绝，不写不重试 | `main/remote/RemoteProjectFileService.ts:114-119,139-141` | textVersion:118-161（sender/项目/hostRevision/TTL） | 已验证 |
| unknown 保留错误与草稿，不自动重放 | pfs:181-189；pfc:60-64；pfen:47,59-63 | seam:537-546；textVersion:247-257（save=1，open/stat=0） | 已验证 |
| 旧预期纠正、有效断言保留 | 旧「缺省先 statProjectEntry 再 save」改为「缺省拒绝且零调用」 | 保留远端 version、entry 令牌改名/删除、系统打开 unsupported、Git 读统一、远端 Git 写 unsupported 等断言 | 已纠正/保留 |
| Windows 无 skip | — | T 新增 3 例实跑 skipped 0（旧 `remoteProjectFileService.test.mjs` 的 Linux-only 守卫仍 skip，不计入验收） | 满足 |

**结论：T 已在服务层验证通过（真实 main 令牌表 + 跨平台 + 0 skip）**。未覆盖：真实 `ipcMain` handler/Electron/E2E、真实 SSH、F 的草稿与「只读核对」UI 流程（属 F）。

### 8.6 V：未核验（不得表述为已通过）

- 在三棵工作树、`docs/`、`.agents/`、`.pi/`、文件名与内容关键词、未提交文件、git 历史以及本机会话存储中均**没有找到 V 的审查产出物**；会话检索工具本次不可用（storage unavailable），已用本地会话存储替代检索。
- 因此：**V 未核验**。F/G 开工不以 V 为前置，但也不得引用「V 已通过」作为质量背书；§8.8 第 1 条要求补做。
- 补做方式：基线发布后指定独立只读 V（不得由 P/S 作者兼任），用本文 §7「提示词 V」，报告落盘 `docs/v-review-<日期>.md` 并回传。
- 附：会话里另有一份**非 V** 的文档级审计（Codex 14:58），其中「S/G 循环依赖」「F 漏 `useFileSearch.ts`」「seam 旧断言」三项在当前文档与 S 成果中已不成立；「池化 ADR 措辞」仍列为 §8.8 第 10 条。

### 8.7 门禁记录（2026-10-31，均在集成工作区 `F:\PiDeck`）

| 门禁 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| IPC 接线 | `npm run check:ipc-wiring` | 0 | 795 通道（主进程 + preload 齐备）+ 8 agentEventTags，无重复 |
| 测试形态 | `npm run check:test-shape` | 0 | sourceOnly 411（基线 411，新增 0） |
| 格式化 | `npm run check:format` | 0 | 4245 个文件，无待修正（含本次新增 `scripts/panel-baseline.mjs`） |
| P 组（13 文件） | 见 p-public-wiring.md 第一组命令 | 0 | 142 tests / 142 pass / 0 fail / 0 skip |
| P 附加（3 文件） | `remoteGitReadIpc / remoteHostIpc / remoteProjectWatchKeepAlive` | 0 | 94 / 94 pass |
| S/T 组（7 文件） | 交接 §4 命令 | 0 | 62 / 62 pass / 0 skip（集成初跑 3 fail 为夹具问题，修正后见 §8.1） |
| 集成附加（7 文件） | `remoteGitFactsInvalidation / remoteGitTargetBoundary / remoteProjectEntryIpc / remoteProjectFileIpc / remoteProjectTransferIpc / remoteProjectRootStatusEnvelope / remoteContentSearchCapabilityUi` | 0 | 24 / 24 pass |
| 基线继承 | `git worktree add <新树> dev` + `panel-baseline.mjs verify --dir <新树>` | 0 | 48/48 逐字节一致；新工作树 `git status` 干净（无需 sync） |
| 同步回退自测 | `panel-baseline.mjs sync --to <空 worktree>` + `verify --dir` | 0 | 48 个文件全部同步并逐字节一致；目标 `git status` = 48 项，与清单完全对应 |
| 提交 | `git commit`（四个提交，未 push） | 0 | docs/前置 → P → S/T → 基线清单/工具，见 `git log --oneline 24529c394..dev` |

**未跑（本轮禁止/无授权）**：全量 `npm run build`、`npm test`、E2E、真实 SSH 主机、Electron 启动、宿主重启、`preflight/pack`。Windows 上 Linux-only 用例的 skip 不计入通过数。

### 8.8 剩余集成 / 真机验收项（不阻塞 F/G 开工，但必须在对应节点闭环）

1. **V 未核验** → 基线发布后补一次独立只读 V（§8.6）。
2. **真机/资源验收**（池化默认开启前必须）：N=1..4 多项目 soak、RSS/线程/SSH 连接数、TTL 回落、A/B/C 切换 p50/p95、latched 重建、断连/重绑/root drift 的 E2E；现有离线测试只覆盖默认关闭路径。
3. **stat 的 missing 语义**：公共 `files.stat` 仍把读取失败折叠成 `exists:false`，provider 只能报 `unavailable`。要启用 `missing` 需集成者改 `shared/types/projectFiles + filesIpc + preload` 带失败码——F 在此之前**不得把 unavailable 当删除**。
4. **事实订阅统一入口**：`projectServiceFactSubscription` 的引用计数只覆盖 `services` runtime；现有 hooks 直接订 `onProjectFactsChanged` 会互相退订。F/G 同时开两个直订 hook 会掉订阅——统一入口定案前，二者都走 `useProjectServices` 的 runtime。
5. **trust 无推送事件**：设置页改 trust 后能力可能滞后，需 UI 显式 `services.refresh()` 或补事件（集成者）。
6. **契约文件拆分**：`projectServiceContracts.ts` 339 行 > ADR §8 的 300 行上限，建议拆 file/git/capabilities（S/I 收尾，拆分不得改语义）。
7. **远端 Git 写面**：G 接 main 令牌经纪；「纯事实强刷」若需扩 force 参数，由集成者一次接全 `shared/preload/main`（P 已释放 `remoteGitReadIpc.ts`）。
8. **远端 Git 读能力偏保守**：依赖 helper hello 声明 `git.status/workspaceDiff/log/repos/refs/compare`，旧 helper 会整块关闭读；是否放宽由 P/S 复核，G 不得反向探测。
9. **ADR 文档漂移**：`project-panel-service-seam-adr.md` 仍写远端文件名搜索走统一 `files.search`，实际 main 对 remote 抛 `UNSUPPORTED_PROJECT_LOCATION`、S 走 `remoteHosts.searchProject`；F 只消费 service，ADR 需集成者同步。
10. **池化 ADR 措辞**（非 V 审计遗留）：`remote-host-root-pooling-adr.md:241` 验收措辞与「默认关闭」表述需统一。
11. **保活计数按 (host, root) 而非 sessionKey**：`onRootRetired` 的 release 若迟到到同 root 新条目已 retain 之后，会误减新条目计数；无测试覆盖，建议按 sessionKey/代数复核（P 审计风险 4）。
12. **「A 慢操作不阻塞已就绪 B」缺正向断言**：现有测试只用预算拒绝侧证明（P 审计风险 5）。
13. **池化开关**：首版只在构造期选择，无设置项/无运行期降级；开启即改 `main/index.ts` 构造参数 `rootPooling: { idleCapacity: 2, idleTtlMs: 10*60_000, maxEntries: 6, acquireTimeoutMs: 30_000 }`（集成者单写，且必须先过第 2 条真机验收）。
14. **host 级 `connectionFacts`/`helperCapabilities` 已无生产消费者**：保留作真机控制面或标 deprecated，由集成者决策，避免后续误用回兄弟 root。

---

## 9. F/G 开工判定（I0 结论）

| 问题 | 结论 | 依据 |
|---|---|---|
| **F 能否开工** | **能**（读面 + 文本写都可接） | §8.2 文件契约冻结；T 已验证（§8.5）；A0 stat 纯读入口在基线内；仅 stat `missing` 与订阅统一入口属已知限制（§8.8 第 3、4 条），不阻塞 |
| **G 能否开工** | **能**（Git 读面/面板迁移 + 能力置灰；写面需 main 接线后） | §8.2 Git 契约冻结、`projectGitService.ts` 已移交；远端写/强刷/同步/恢复仍 `UNSUPPORTED`，实现需集成者接 `shared/preload/main`（§8.8 第 7 条） |
| **池化默认开启** | **不是** F/G 开发前提（保持关闭） | 池化默认关闭且无设置项；真机验收未做（§8.8 第 2 条） |
| **最终远端验收** | **不是** F/G 开发前提 | 未授权连接真实远端；离线门禁已过（§8.7） |

---

## 10. 并行 F/G 集成检查点（2026-10-31）

- **checkpoint**：`2d703f830 chore: checkpoint 并行 F/G 成果（文件抽屉 + Git Phase C）`，76 个文件；未 push、未合并。
- **F**：文件抽屉/本地树/搜索/草稿/文件操作已接入 `ProjectServices`；本地树经 `useProjectServices(project).files.listDirectory`，目录页新增本机 `path/mtimeMs/ctimeMs/size` 与 `totalEntries`；远端搜索保留原始 `entries`（bytes/other）；跨目录移动新增 `ProjectFileService.moveEntry`。
- **G**：Git provider/面板能力门禁、令牌经纪、纯事实强刷、V 审查修复已落地；`DrawerSurface` 已透传 `capabilities.git`。
- **门禁**：`typecheck` / `check:ipc-wiring`（795 通道）/ `check:test-shape` / `check:format` 均 0；全量 `npm test` **15475 tests / 15190 pass / 0 fail / 285 skip**。
- **E2E**：`git-panel`、`file-viewer`、`file-tree-dom-budget` 通过；`file-tree-sticky` 行距断言在 I0 基线同样失败（既有环境/布局问题，已用临时 baseline worktree 复核并清理）。
- **未完成/限制**：真实 SSH、远端 E2E、Linux CI、T 的文本保存真机验收；回收站/上传下载/图片预览仍是远端薄壳；`files.stat` 的 `missing` 与 `capabilities.files.watch` UI 仍待集成者。
