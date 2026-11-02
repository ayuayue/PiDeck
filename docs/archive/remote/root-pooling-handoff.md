# 会话交接：root 池化生产实现（B0–B4）

> **Status: Historical（2026-10-31 更新：B0–B4 的默认关闭实现已合入 dev，生产装配仍未开启，真机验收未做；当前验收见 [remote-acceptance-55dd5b702.md](../../remote-acceptance-55dd5b702.md)）**


> 用途：把「同主机多项目 root 池化」的生产实现交给新会话。设计权威是
> `docs/remote-host-root-pooling-adr.md`（已含现状 file:line、方案对比、B0–B5 迁移、回滚、验证矩阵、真机测量）。
> 并行派工先读 [remote-project-parallel-handoff.md](../../remote-project-parallel-handoff.md)，执行其中 P 任务；本文件保留池化专用阅读与验证入口。

## 0. 状态

- 仓库：`F:\PiDeck`，主工作树在 `dev`。
- 本次核对基线原为 `dev` = `24529c394`；2026-10-31 更新：池化默认关闭实现已随 `24529c394..55dd5b702` 合入 dev，当前验收基线为 `55dd5b702`（修复提交 `a905d4d7d` 见验收文档）。
- 远端：`origin` = github.com/ayuayue/PiDeck。origin/dev 已合入；若开工时 HEAD 已变化，以实际 `git log` 为准。
- **池化已交付默认关闭的实现**（`RemoteRootSessionPool.ts`、接入 `RemoteHostConnectionService.ts:398-411`、`tests/remoteRootPooling.test.mjs`）；生产装配 `main/index.ts:3367-3388` 仍未传 `rootPooling`，真机验收未做。并行交接中的 A0 是独立 renderer stat 修复，不能算池化完成。
- 当前工作树/分支清单以开工时的只读检查为准，不清理其他工作流；未提交前置不会自动进入新 worktree，按并行交接 §2 同步。

## 1. 先读（按顺序）

1. `AGENTS.md`
2. `docs/remote-host-root-pooling-adr.md`（§2 现状、§3 容量/失败、§4 测量、§5 B0–B5、§6 验证矩阵、§7 决定）
3. `docs/architecture.md`、`docs/engineering-standards.md`、`docs/host-boundaries.md`
4. `docs/remote-wsl-verification-log.md` 的 §9/§11/§14（既有全量/E2E 口径与远端基础设施）

## 2. 任务

> 2026-10-31：B0–B4 的默认关闭实现已完成并合入 dev；本节保留为原始任务书，B4 默认开启仍须真实场景验收。

按 ADR §5.3 分片实现 **B0–B4**（B5 不在本任务内）；P 先交付默认关闭路径与离线门禁，B4 默认开启另过真实场景验收：

- **B0 测量基线**：先准备离线时序/隔离基线与 ADR §4.4 的测量项；热 acquire < 50 ms 指本地管理开销，不含网络操作；N=2 约 120 MiB 是待复测预算。真实主机接入需授权，默认开启前补验收。
- **B1 影子池（默认关闭）**：新增 main 私有 `RemoteRootSessionPool`（feature flag/构造参数），旧单会话路径保留为默认；指标：acquire hit/miss、创建/淘汰次数、每 root operation 等待、SSH/节点发现次数。**不改协议、不改持久化**。
- **B2 路由与锁**：`withProjectSession` 改为 pool-backed；per-(host,root) 锁；同 root 合并；**flag=off 时旧行为逐字节保持**。
- **B3 watcher/facts**：registry 与 helper 事件按 host + sessionKey；目录/Git/能力查询改用 root-scoped facts；root 退休不走关闭全 host 终端的回调；`lazyDirTree` 不因兄弟项目换代清树。
- **B4 默认开启**：设置项/诊断 + 真机 A/B/C 多项目验收；不达标保持默认关闭。开关首版按启动选择，不在运行期自动拆掉在途写。

**实施前先给计划**：列出每片改动文件、测试、回滚点、门槛。用户按并行交接提示词明确分派 P 后，可执行其默认关闭与离线实施范围；不把派工扩大为提交/合并、外部连接或重启授权。

## 3. 硬约束

- 不 push / 不 merge 到远端 / 不发布（除非用户明确要求）；不跑 `npm run build` / `preflight` / `pack`；不装依赖；不升级 Electron/pi；不改 pi 活着的会话 JSONL。
- 不清理/暂存/重置他人未提交工作；跨目录写用 `git worktree`。
- TDD 红→绿；需求/契约变化可同步更新相关过时测试，说明依据与覆盖变化，保留仍有效的回归和安全边界；不为消红弱化验证。
- 门禁：`npm run typecheck` + 针对性 `node --test` + `check:ipc-wiring` + `check:test-shape` + `check:format`；全量 `npm test` 只在阶段集成时跑（约 7–13 分钟，交叉安装可能更慢）。
- 生成物：改 zh-CN 文案后跑 `node scripts/genZhTwCopy.mjs`，`*.zh-TW.ts` 不手改；Lead 统一重生成。
- 团队上限 8；每个写任务用独立 worktree；公共汇聚文件（`main/index.ts`、i18n copy、`package.json`）同一时刻只许一个写者。

## 4. 环境与工具

- 远端主机：`ssh` 别名 `serve`（已免密）；E2E 凭据只经 `PIDECK_E2E_REMOTE_*` 进程内注入，不打印、不落库。
- 跑 Electron E2E 前：`Remove-Item Env:ELECTRON_RUN_AS_NODE`；窗口默认屏幕外。
- 现有探针：`node tests/remoteRootSwitchProbe.mjs`（无凭据时输出 `not-measured`，不编数据）。
- 既有远端 E2E：`e2e/remoteSessionAcceptance.spec.ts`（16 条）、`e2e/remoteHostAcceptance.spec.ts`、`e2e/remoteFunctionalAcceptance.spec.ts`；同一时刻只跑一条 Electron 用例。

## 5. 已知数据（ADR §4，可直接引用）

真机（node v24.11.0、helper 1.25.0、5 cycles/0 helper 失败）：SSH 342ms、node 发现 703ms、root 复核 354ms、bundle verify 342ms、helper 启动→hello 405ms、完整 helper cycle 中位 874ms、**产品切换下界代理 1813ms**；单 helper 52.4MiB RSS / 7 线程；双 helper 共存 104.9MiB、各自 SSH 连接。

## 6. 与远端分叉的处理

本次基线 `24529c394` 已同步 origin/dev；不再执行旧交接中的“先合入 48 个提交”。后续先只读检查实际分叉，不因文档指令自动 fetch/merge/force-push；并行任务的共同基线由协调人登记。
