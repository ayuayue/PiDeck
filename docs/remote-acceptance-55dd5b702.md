# PiDeck 检查点 55dd5b702 独立验收

Status: **Current（2026-10-31 独立验收记录；基线 09aca4203..55dd5b702）**
验收对象：`fix(remote): 目录监听失败降级与项目关闭生命周期收尾`（55dd5b702）
验收方式：只读代码复核 + Windows 定向复跑 + WSL Linux 测试 + 真机方案编制；**未连接真实主机、未启动 Electron、未修改被审查代码、未提交/推送**。
状态口径：**通过 / 失败 / 跳过 / 未执行**；跳过与未执行都不计通过（同 `docs/remote-wsl-verification-log.md` 的口径）。本文件是新验收记录，不修改既有文档；旧文档失效项见 §5。

## 0. 结论摘要

| 项目 | 结果 |
|---|---|
| 基线 / HEAD / 工作区核对 | **通过**：HEAD=55dd5b702，父提交=09aca4203，`git status --porcelain` 为空；范围为 1 个提交、12 文件、+845/−173 |
| 只读复核：root 退休作用域 | **通过** |
| 只读复核：关闭项目期间的异步读围栏 | **通过**（3 条低风险观察项，见 §2.3） |
| 只读复核：监听失败降级与恢复 | **通过**（1 条低风险观察项） |
| 只读复核：显式断开后不自动复活 | **验收时失败（条件性 F1，仅 rootPooling 开启时可达）→ 已修复并提交 `a905d4d7d`**：“不自动复活”成立，但生产顺序下“清理 × retirement”交互未闭环；默认关闭的池化路径不受影响。复现见 §2.2，修复与验证见 §9 |
| Windows 定向复跑（本提交 6 个测试文件） | **通过**：62/62，0 skip（验收时 61 + §9 修复新增 1 例） |
| Windows 全量 / 通用门禁 | **通过（既有声明；本轮未重跑全量，仅定向复跑 + typecheck/format/ipc-wiring 佐证）** |
| Linux（WSL）本提交 6 个测试文件 | **通过**：61/61（验收时，0 skip）；修复后 lifecycle 7/7 复跑通过 |
| Linux（WSL）POSIX/Linux-only 邻接用例 | **通过**：139 pass / 1 skip（root-only chown） |
| Linux（WSL）根池化相关 4 文件 | **通过**：51/51 |
| Linux（WSL）remote/ssh 全扫 | **失败（7 例，全部既有，非本提交引入）** + **跳过 11 例**；基线 HEAD~1 复跑失败数一致，详见 §3.3 |
| 真实 SSH + Electron 端到端验收 | **通过（UI 入口 + 池化 home 修复后，R0/R1 均真机通过）**：R0 1 passed 40.7s；R1 连续 2 次 1 passed（41.7s / 39.3s），另有 1 次调试轮通过；S2/S5/S6/S7 未执行，详见 §10 |
| Linux CI 覆盖 | **通过（仅本地新增，未触发 GitHub CI）**：新增 `linux-unit-remote` job（硬门禁 17 文件 253/252+1；全扫 continue-on-error）+ 挂账文档；见 §11 |
| panel-service-baseline.manifest | **通过**：按 HEAD 重建，`panel-baseline.mjs verify` 48/48 rc=0；见 §11 |
| 旧文档失效状态审计 | **完成并已同步旧文档 + 重建 manifest**（见 §5/§11） |

**总体判定：默认生产构建（池化关闭）无阻断；本提交的四个修复方向中，前三个通过，第四个在池化开启场景存在条件性失败 F1。F1、UI 入口、池化 home 三处已修复并提交/验证；真机 R0（池化关闭）与 R1（池化）均通过。S2/S5/S6/S7（TTL/sweep、显式断开、监听降级等）仍未执行，池化默认开启前仍需补这些场景。**

## 1. 基线与工作区核对（只读）

| 项 | 实测 |
|---|---|
| 分支 / HEAD | `dev` / `55dd5b7020c7501b74986f00ecd4eac47cd5fb5d` |
| 基线（父提交） | `09aca4203`（`docs(git): 更新 Phase C 检查点状态与剩余验证项`） |
| 范围 | `09aca4203..55dd5b702` = 1 个提交；`git diff --stat` = 12 文件，+845/−173 |
| 工作区 | 验收复核期间 `git status --porcelain` 为空；F1 修复已提交 `a905d4d7d`，旧文档同步已提交 `f870d5574`；本轮 CI/清单/真机验收改动尚未提交（见 §9.3/§11） |
| 提交内容 | 新增 `src/main/ipc/remoteProjectDirFacts.ts`；改 `remoteProjectDirectoryReads.ts`、`remoteProjectIpc.ts`、`RemoteDeepDirWatch.ts`、`RemoteDirWatchDegradedHint.tsx`、`shared/types/projectFiles.ts`；新增/改 6 个测试文件 |
| 仓库外产物 | F1 探针 `%TEMP%\pideck-f1\f1-probe.test.mjs`；完整方案草稿 `%TEMP%\pideck-acceptance\ssh-electron-plan.md`（均未入库） |

未执行“准备提交”、未拆分/改写已有提交、未 `git add/commit/push/merge`。

## 2. 只读复核（09aca4203..55dd5b702）

复核由独立只读 subagent 完成，Lead 另用独立探针复现 F1，并复核关键结论；未对 P/S/F/G 做全量泛审。

### 2.1 四个焦点

| 焦点 | 结果 | 关键证据 |
|---|---|---|
| 1. root 退休作用域 | **通过** | `remoteProjectDirFacts.ts:199-209` 用 generation===sessionKey、host、root 三元组精确匹配；`:83-89` 只删本项目键并推进 epoch；`RemoteFactCache.ts:109-114/208-211` 的 clearWhere 会退休在途装载；`RemoteRootSessionPool.ts:174-189` 退休后通知，TTL/LRU/latched 不会走 `onHostDisconnected`；兄弟 root 不被清 |
| 2. 关闭项目期间的异步读围栏 | **通过** | 装载函数 4 道 epoch 检查 `remoteProjectDirFacts.ts:96/99/103/113/121`，`readDirSnapshot:137/140` 覆盖 target 解析窗口；`closeProject:211-217` 先丢期望集合、再清事实、再成对退订；`afterWrite:151-158`/`invalidateTree:160-164` 在无活代时 no-op；`RemoteDeepDirWatch.ts:187-190` 在 ensure 后再复核项目状态；新增 `tests/remoteProjectLifecycle.test.mjs:277-325` 用真 pool + 真 dirFacts 断言迟到读 `REQUEST_CANCELLED`、旧写不发布 |
| 3. 监听失败降级与恢复 | **通过** | `RemoteDeepDirWatch.ts:156-171` 收集 `fs.watch` 失败并用 `codeOf` 透传稳定码；`:199-213` 区分 paths-over-limit / 硬失败 / watcher-capacity / 兜底 WATCH_UNAVAILABLE；恢复后 `degraded=undefined`（`:214-216`）；页面投影 `remoteProjectDirectoryReads.ts:19-31/47-58`，提示 `RemoteDirWatchDegradedHint.tsx:13-24`，渲染层仅用最新成功页覆盖 `lazyDirTree.ts:157-158`；单测覆盖失败→真实码→恢复清除 |
| 4. 显式断开后不自动复活 | **失败（条件性 F1）** | “不自动复活”成立：服务入口/acquire 后窗口/收尾均有 `explicitlyDisconnected` 检查（`RemoteHostConnectionService.ts:947/964/994/1021-1025/1670`），sweep 只退休不建立（`RemoteRootSessionPool.ts:345-356`）；但“清理 × retirement”在生产顺序下失配，见 §2.2 |

### 2.2 F1（失败项）：显式断开的清理与 retirement 交互

**生产顺序**：`disconnect()` 先 `onDisconnect → onHostDisconnected`（`RemoteHostConnectionService.ts:1397` → `index.ts:3375`），把项目 generation 改写成 `host#disconnected#n` 并只 `invalidateWhere`；随后才 `retireHost(hostId, "explicit")`（`:1404-1405`）→ `onRootRetired` 因 generation 已不等于 sessionKey 而**不匹配**（`remoteProjectDirFacts.ts:204-207`）→ 项目暖缓存只被标脏、未被删除。

**后果**：`readDirSnapshot` 的暖缓存守卫（`remoteProjectDirFacts.ts:143-145`）在“有暖事实 + `projectConnectionFacts` 为 undefined”时直接返回 `SSH_HOST_NOT_READY`。池化模式下 `projectConnectionFacts` 只认本 root 的池会话（`RemoteHostConnectionService.ts:1633`），退休后恒为 undefined，因此**用户显式重连后目录树仍报 `SSH_HOST_NOT_READY`，且不建立新会话**；只有先走非目录读通道（`pathsExist`/读文件/搜索）建立了池会话，目录读才恢复。

**最小复现（仓库外，已实测）**：
1. 取 `tests/remoteProjectLifecycle.test.mjs` 的 harness；让 PROJECT_B 两次根目录读形成带 generation 的暖缓存；
2. 置 `disconnected=true` → **先** `facts.onHostDisconnected(HOST)` → **再** `pool.retireHost(HOST, "explicit")`；
3. 置 `disconnected=false`（模拟用户显式重连）→ `h.list(PROJECT_B)`。
实测结果：`{ok:false, code:"SSH_HOST_NOT_READY", establishedDelta:0}`；随后 `facts.pathsExist(PROJECT_B, [])` 成功、`establishedDelta=1`，再 `h.list` 才恢复 ok（探针输出见 `%TEMP%\pideck-f1`）。
若把顺序反过来（先 retireHost 再 onHostDisconnected），断开后返回 `SSH_HOST_DISCONNECTED`、重连后读成功——与本提交新增测试的断言一致，但**不是生产顺序**。

**影响面**：仅 `rootPooling` 开启的构建（生产装配当前未传该参数，默认关闭）；默认路径重连后由主机级 manager 换代，不受此路径卡住。属**存量缺陷**（基线 09aca4203 的 `onRootRetired` 只做 `forgetSession`，暖缓存同样不清），但本提交声称“主机断连时清理 generation/host/目录缓存”的语义在该路径未落地，且新增测试未覆盖生产顺序。

**测试缺口（不阻断，但必须补）**：`tests/remoteProjectLifecycle.test.mjs:246-275` 的“显式断开不复活”用例只调用 `pool.retireHost`，且 harness 的 fake service 在 `disconnected=true` 时直接短路（`:124`），断言只验证 mock 自己的门禁；它没有调用 `onHostDisconnected`，恰好绕过 F1。另有“已有暖事实 + 断连/重连”场景未覆盖（`:327-346` 只覆盖从未发布过暖值的断连读）。

**处置建议（验收时）**：池化默认开启前，按生产顺序补回归测试，并在“断开时清除目录事实 / 调整 retirement 与 generation 改写顺序 / 让暖缓存守卫区分 stale 与 current”三者中定一个方案；F1 修复前不得把池化默认开启当验收通过。

**验收后修复（已提交 `a905d4d7d`）**：用户指示“继续把剩余工作做完、不删东西”后，已选“暖缓存守卫区分 stale 与 current”并补生产顺序回归；改动仅 2 个文件、未改写 55dd5b702，细节与验证见 §9。

### 2.3 观察项与残余风险（均非本提交阻断）

| 项 | 说明 | 级别 |
|---|---|---|
| root 退休不清 `dirWatch` 的 desired/flushedSession/degraded | `onRootRetired` 只动 `projectWatches` 与事实层（`remoteProjectDirFacts.ts:199-209`）；已排期的深层 flush 可能用死会话写回一次 watch-failed，直到下一次成功冲刷 | 低 |
| `desired` 只增不减 | 已删除/改名的深层目录会永久留在目标集；helper 对含坏路径的整块（≤32 路径）整块拒绝后，该块会反复 watch-failed，恢复条件受限，直到关闭/重开项目（`RemoteDeepDirWatch.ts:254-261`） | 低 |
| `dispose()` 无 disposed/epoch 守卫 | 退出瞬间迟到装载理论上仍可写回并发布事件（`remoteProjectDirFacts.ts:221-224`） | 低 |
| `afterWrite` 只查“generation 是否存在” | 同一 projectId 在旧写回来前被重新登记时，会用新代多发一次失效通知（不产生脏数据） | 低 |
| 保活计数仍按 (host, root) 而非 sessionKey | `onRootRetired` 的 release 若迟到于同 root 新条目 retain 之后，会误减新条目计数（`docs/remote-project-parallel-handoff.md:379` 已登记，本提交未处理）；池化真机验收需观察 | 中（池化开启前） |

### 2.4 新增/修改测试质量核对

**真断言（通过）**：`remoteProjectLifecycle.test.mjs:277-325`（迟到读取消、旧写不写回、重开后通知代正确）、`:193-244`（TTL/LRU 后重开新会话、watcher 重新登记）；`remoteProjectDirFacts.test.mjs:268-292`（退休后旧代事实失效、下次读重载）、`:294-314`（watch 失败→页面 code→恢复清除）；`remoteDirWatchDeep.test.mjs:115-187`（covered/degraded/code/日志/恢复）；`remoteDirectoryPageWatchDegraded.test.mjs:43-51`（code 投影与旧形状）。

**弱断言 / 缺口（已记录，未改测试）**：
1. 显式断开用例用 mock 短路 + 非生产顺序（F1 的测试根因，见 §2.2）；
2. `remoteProjectDirFacts.test.mjs:316-338` 标题写“经 TTL/LRU 退休”，实际手工把 `rootUnavailable` 置 true（无 pool/sweep），真正 retirement 清除由 `:268-292` 覆盖，标题夸大；
3. `remoteDirWatchDegradedHint.test.mjs:31-40` 只验证渲染文本含 code，未验证降级消失后不渲染（该状态由 `lazyDirTree.test.mjs` 覆盖）；
4. `remoteProjectUpload.test.mjs:290-303` 仍是对 3 个源文件做字符串计数（过滤调用点），不验证列表/搜索真的过滤；属迁移期防丢过滤的弱断言；
5. 缺“迟到的 `fs.watch` 成功晚于关闭/换代不登记、不改降级”“desired 残留导致永久降级”的专门回归。

## 3. Linux / WSL 执行（实际运行，不是 Windows skip）

### 3.1 环境（复核实测）

| 项 | 事实 |
|---|---|
| 发行版 / 内核 | Ubuntu 26.04 LTS（resolute）/ WSL2 / `6.18.33.2-microsoft-standard-WSL2` / x86_64 |
| 用户 | uid=1000（组含 sudo）；`sudo -n true` 失败（无免密 sudo，不需要） |
| Node | 系统层无 node；用户目录已有官方 linux-x64：`~/node24/bin/node` = **v24.19.0**（与 Windows 同版），npm 11.17.0 |
| 仓库访问 | `/mnt/f/PiDeck` 可读写；Windows `node_modules`（typescript 5.9.3）可被 Linux node 使用；9p 未造成异常，无需 ext4 副本 |
| 命令 | 每个用例：`cd /mnt/f/PiDeck && node --test tests/<file>.test.mjs`（cwd 必须为仓库根；实验命令已记录 rc） |

### 3.2 本提交改动与邻接用例（全部 Linux 真跑）

| 文件 | tests | pass | fail | skip |
|---|---:|---:|---:|---:|
| `remoteProjectLifecycle.test.mjs` | 7 | 7 | 0 | 0（验收时 6；§9 新增 1 例） |
| `remoteDirWatchDeep.test.mjs` | 15 | 15 | 0 | 0 |
| `remoteDirWatchDegradedHint.test.mjs` | 4 | 4 | 0 | 0 |
| `remoteDirectoryPageWatchDegraded.test.mjs` | 5 | 5 | 0 | 0 |
| `remoteProjectDirFacts.test.mjs` | 14 | 14 | 0 | 0 |
| `remoteProjectUpload.test.mjs` | 17 | 17 | 0 | 0 |
| **小计（6 个改动文件）** | **62** | **62** | **0** | **0** |
| `remoteGitCompare.test.mjs`（Linux-only） | 9 | 9 | 0 | 0 |
| `remoteBootstrapContract.test.mjs` | 81 | 80 | 0 | 1（root-only chown） |
| `remoteBootstrapSessionIntegration.test.mjs` | 1 | 1 | 0 | 0 |
| `remoteBrowseRoot.test.mjs`（含 POSIX 探针） | 7 | 7 | 0 | 0 |
| `piAuthHostLaunch.test.mjs`（含 POSIX symlink） | 13 | 13 | 0 | 0 |
| `remoteBootstrapUpload.test.mjs`（POSIX 权限） | 14 | 14 | 0 | 0 |
| `remoteBundleMaintenance.test.mjs`（POSIX 分支） | 15 | 15 | 0 | 0 |
| **邻接小计** | **140** | **139** | **0** | **1** |
| `remoteRootPooling.test.mjs` | 14 | 14 | 0 | 0 |
| `remoteRootSessionPool.test.mjs` | 19 | 19 | 0 | 0 |
| `remoteProjectRootReverify.test.mjs` | 14 | 14 | 0 | 0 |
| `remoteProjectWatchKeepAlive.test.mjs` | 4 | 4 | 0 | 0 |
| **根池化小计** | **51** | **51** | **0** | **0** |

补充：`sessionCatalogLegacyPathHeal` 3/3、`userDataMigrationState` 36/36（POSIX 分支相关）。本提交 6 个测试文件 grep 无任何 `process.platform` 条件，因此上面的 Linux 结果不是靠 Windows skip 变绿；Windows 上的 skip 也不计入本节通过数。表内 62 例为修复后口径；验收时 lifecycle 为 6 例、小计 61 例。

### 3.3 Linux 全扫（remote + ssh 域）与跳过清单

`tests/remote*.test.mjs` + `tests/ssh*.test.mjs`（验收时、修复前）：**248 文件 / 2379 例 / 2361 pass / 7 fail / 11 skip**；修复后只复跑相关文件，未重跑全扫。

**跳过（11）**：1 例 root-only chown（`remoteBootstrapContract`）、1 例无真实主机凭据（helper 需要凭据的用例）、1 例 win32-only 分支、`sshAskpass` 3 例、`sshClientRuntime` 4 例、`sshLongLivedSessionDeadline` opt-in 1 例。跳过均未计入通过。

**失败（7，全部既有问题，非本提交引入）**：

| 文件 | 失败 | 现象 | 基线 HEAD~1 对比 |
|---|---:|---|---|
| `remoteGitStability.test.mjs`（Linux-only） | 4/4 | applied 回执丢失时 errorCode 为 undefined（期望 `GIT_WRITE_RESULT_UNCONFIRMED`）；第二窗口未报 `GIT_RESOURCE_CHANGED`；第三例得到 `REMOTE_CONNECTION_LOST`；soak 例 workspaceFileDiff 抛 `GIT_RESOURCE_CHANGED` | 同为 4 失败 |
| `remoteHelperSearchNames.test.mjs` | 1/13 | 断言依赖 readdir 名序；ext4 为哈希序，20000 上限外的 `zzzz-match.txt` 被提前命中 | 同为 1 失败 |
| `remoteSearchIsolation.test.mjs` | 1/25 | scanned cap 例访问到 20002 条（上限 `MAX_SCANNED+1`=20001），同属目录项计数/序 | 同为 1 失败 |
| `sshClientRuntime.test.mjs` | 1/12 | Ubuntu 26.04 的 `/bin/ls` 是符号链接，先报 `SSH_CLIENT_NOT_REGULAR_FILE` 而非期望的 `SSH_CLIENT_VERSION_UNSUPPORTED` | 同为 1 失败 |

结论：**本提交在 Linux 上无回归**（7 例在 `git archive HEAD~1` 副本上失败数完全一致，且失败文件不 import 本次改动的源文件）。其中 `remoteGitStability` 是 `docs/git-panel-phase-c-plan.md:213` 自己要求“合入前须在 Linux CI 跑一次”的 Linux-only 用例，现已在 Linux 上跑出红色——该问题属于既有 Git/Phase C 债，不是本验收的修复对象，但应在池化/Git 默认开启前挂账处理。

**机制性缺口（本轮已补，见 §11）**：原 CI 单测只在 `windows-latest` 跑（`ci.yml:17` 与 `:62-70`），ubuntu job 只做 Pet 冒烟（`ci.yml:92` 起），`dev-guard.yml:12` 不跑 `npm test` ⇒ Linux-only / POSIX 分支在 CI 零覆盖。本轮新增 `linux-unit-remote` job（17 文件硬门禁 + remote/ssh 全扫 `continue-on-error` 跟踪）与 `docs/ci-linux-known-failures.md`；7 个既有红挂账、不改测试不改产品。

## 4. 真实 SSH + Electron 验收方案（已获授权；R0/R1 已执行并失败，见 §10）

> 本节保留方案摘要；完整 609 行版本在仓库外草稿 `%TEMP%\pideck-acceptance\ssh-electron-plan.md`（不入库）。真实连接/构建/Electron 已按用户“全部去干”授权执行 R0/R1；S2/S5/S6/S7 未执行。

### 4.1 开关事实（必须先明确）

| 事实 | 证据 |
|---|---|
| 池化唯一开关是构造参数 `rootPooling`（`Partial<RootPoolPolicy>` 或 `false`）；无设置项、无环境变量、无运行期切换 | `src/main/remote/RemoteHostConnectionService.ts:130`、`:398-401`；ADR `:230` |
| 生产装配未传该参数 ⇒ **池化默认关闭** | `src/main/index.ts:3367-3388` |
| 默认 TTL 10 分钟；sweep 每 60 秒；sweep 只回收“无租约且无 watcher”的空闲条目 | `RemoteRootSessionPool.ts:40`、`RemoteHostConnectionService.ts:416-417`、`RemoteRootSessionPool.ts:345-356` |
| 远端能力本身只在 dev 通道开启（未打包运行 / dev 渠道包） | `src/main/index.ts:3327-3336`；`channelIdentity.ts:18-20`；`scripts/pack-dev.js:44` |
| 历史环境变量 `PIDECK_REMOTE_EXPERIMENTAL` 已不被 main 读取 | `src/main/index.ts:3330-3331`；`tests/remoteChannelGate.test.mjs:23` |

运行矩阵：**R0** 不改代码，仅池化关闭基线；**R1** 临时加 `rootPooling: {}` 走默认策略（主证据）；**R2** `rootPooling: { idleTtlMs: 60_000 }` 加速冒烟（仅补充，不作签收）。R1 补丁只在专用工作树/用户确认的空窗内加一行构造参数，**禁止提交**；记录补丁与 `out/main/index.js` 的 sha256，验收后 `git apply -R` 还原。

### 4.2 主机 / 测试目录 / 读写范围

- 主机：Linux，专用验收账号（示例 `pideck-accept`，禁止 root）；**ssh-ed25519**；远端 node ≥ 22.3 且登录 shell 可发现；不要 NFS/FUSE。
- 测试根：`/srv/pideck-accept-<id>/`，下建 `a/`、`b/`、`c/` 三个独立项目（各自 git 仓库），含同名不同内容的 `src/common.txt`、`ONLY-IN-A/B/C.txt`、`src/leaf/leaf.txt`、`docs/deep/one/two/deep.txt`、`volatile/nested/watch.txt`；C 可选 `c/bulk/d001..d130`（路径预算场景）。
- 权限：目录 755、文件 644、属主=验收账号；不要用 root 拥有后 chmod，否则 fs.list 与 fs.watch 失败面混在一起。
- 读写范围：**只写** `/srv/pideck-accept-<id>/`；**只读**其余远端系统信息；本地仓库只读（唯一例外是临时池化补丁与 `npx electron-vite build` 产物 `out/`）；**禁止**真实用户 home、`/root`、生产部署根。
- 产品契约的 helper 部署根 `<HOME>/.pideck/remote-host` 会被使用：清理时先记录 `leases` 与 bundle 清单，**只删本轮新增的 bundle/租约**，不整体删除既有部署根。

### 4.3 本地 Electron 与凭据

- 构建（仅测试准备，不是 `npm run build`）：`npx electron-vite build`；E2E 启动 `out/main/index.js`。
- 启动前：`Remove-Item Env:ELECTRON_RUN_AS_NODE`；用 `--user-data-dir` 隔离 profile，预置 `{"language":"zh-CN","piEnvironmentChecked":true}`；可选 `PIDECK_MEMORY_PROFILE=1`、`PIDECK_REMOTE_METER=1`。
- 真实主机凭据只经 `PIDECK_E2E_REMOTE_HOST/USER/PORT/FINGERPRINT` 进程环境变量；包装脚本放 `%TEMP%`，不打印、不落库；缺任一凭据则整体 skip，不启动 Electron（同 `e2e/remote-fixtures.ts:29-35/166/181-212`）。
- 现有 `e2e/remoteSessionAcceptance.spec.ts` 等不覆盖池化，只能作为 R0 基线；池化场景需人工按本方案或新增 spec（新增 spec 属仓库改动，需单独授权）。

### 4.4 场景矩阵（全部**未执行**）

| 场景 | 目的 / 关键判定 |
|---|---|
| S0 冒烟 | 主机已连接、项目可登记；池化开启时**仅连接不建 helper**；记 T0 基线 |
| S1 A/B/C 冷开 | 3 个不同 root 各 1 helper、各 1 ssh；helper RSS≈52.4MiB/7 线程量级；三棵树内容互不串 |
| S2 切换不重建 | A/B/C 循环 10 轮；**helper PID 与 ssh PID 集合全程不变**，METER 无新 bootstrap；暖切换延迟只记录 |
| S3 隔离 | `src/common.txt` 内容各自正确；跨项目 `touch` 不触发别的树重读；关闭 A 后 B 不受影响，重开 A 重新装载 |
| S4 关闭项目 | 移除项目→watcher 释放、目录事实清理；TTL 内重开复用暖会话但重新读远端；关闭与在途读交错记为“未覆盖”若不稳 |
| S5 TTL / sweep | 全空闲后 **600s 前不得消失、(600s,660s] 内消失**；消失后重新打开 A 必须成功（回归本提交的暖缓存挡路问题）；LRU 子场景 3 条空闲压到 2 |
| S6 显式断开 | 断开 ≤2s 全清；随后 5 分钟后台读 **0 新建**；UI 报断开类稳定码；显式重连后恢复 |
| S7 监听降级/恢复 | `chmod 000` 或移动深层目录（`nested`）→ 刷新两次 → 提示条 `remote-file-tree-watch-degraded` 带 `watch-failed` 与 `PERMISSION_DENIED`/`PATH_NOT_FOUND`；恢复后刷新两次提示消失；目录始终可读；路径预算 130 目录仅作可选补充 |
| S8 断连→重连缓存换代 | 断开后旧代内容不得当现状；重连后按新 generation 重新装载 |

**F1 与真机的关系**：S6/S8 正是 F1 的生产顺序场景；按当前代码预期会复现“重连后目录读 `SSH_HOST_NOT_READY`”。本轮方案要求**记录失败证据，不现场改代码**；池化默认开启前必须修复并补回归。

### 4.5 采样与阈值

- 时机：T0 暖机 60s；每个关键动作 +1s/+5s；稳态每 30s≥3 样本；TTL 等待每 30s≥22 样本；清理后终检。
- 本地（Windows）：`Get-CimInstance Win32_Process` 采 `electron.exe`/`ssh.exe`（RSS、线程、cmdline）；`Get-NetTCPConnection` 采 22 端口连接；`PIDECK_MEMORY_PROFILE=1` 的 5s CSV（`scripts/analyze-memory.mjs`）作主证据。
- 远端（Linux，只读）：`ps -eo pid,ppid,rss,nlwp,args | grep -F 'helper.mjs --root'`；`ss -tnp state established '( sport = :22 )'`；`/proc/<pid>/fdinfo` 统计 inotify 实例与 wd；`ls ~/.pideck/remote-host/leases` 查租约残留。
- 阈值（硬）：helper 数=已浏览项目数；单 helper RSS ≤80MiB、3 条合计 ≤180MiB；线程 ≤12；本地 ssh 数=helper 数（±1 瞬时）；helper inotify 实例 ≤4、wd ≤128；断开后进程/连接归零；TTL 时间窗如上；降级提示出现/消失与 code 正确。
- 记录项：暖切换 p50/p95、冷开耗时、main/renderer RSS 与 heap 相对基线增长（复用 soak 预算：main RSS +64MiB/heap +32MiB、renderer +128MiB/+64MiB）、METER 调用计数。

### 4.6 清理与回滚

1. 侧栏移除 A/B/C（触发 `closeProject`，释放订阅，不删远端目录）；2. 设置→连接→断开主机（`retireHost explicit`）；3. 正常退出应用（`dispose` 立即退休全部会话，**不能用关掉应用测 TTL**）；4. `rm -rf /srv/pideck-accept-<id>`（只此目录，先确认 realpath）；5. 处理 `<HOME>/.pideck/remote-host` 中本轮新增 bundle/leases（不整体删）；6. 删除隔离 profile；7. 还原池化补丁并重建；8. 新建账号/密钥由用户决定是否删除。
终检：本地 `ssh.exe`=0、`electron.exe`=0、22 端口连接=0；远端 `pgrep -u pideck-accept -af 'helper.mjs|runner.mjs'`=0、`ss` 会话=0、leases 为空、测试目录不存在；仓库 `git status --porcelain` 与本轮开始一致（无补丁残留）。

### 4.7 授权分段（本轮状态）

| 段 | 动作 | 状态 |
|---|---|---|
| 0 | 只读调研、方案、只读校验 | **已完成**（本文件与仓库外草稿） |
| 1 | 本地打 `rootPooling` 临时补丁 + 构建 `out/` | **未执行**（需授权；禁止提交） |
| 2 | 主机准备：专用账号、`/srv` 测试目录、A/B/C、指纹、node 核对 | **未执行** |
| 3 | Electron 实机连接（R0/R1/R2） | **未执行** |
| 4 | 故障注入（chmod/mv/inotify 实例耗尽/130 目录） | **未执行**（逐项授权） |
| 5 | 清理与回滚（删目录/账号/补丁/构建） | **未执行** |
| 6 | 把临时开关升级为正式设置/诊断 | **未执行**（不在本轮范围，禁止扩功能） |

### 4.8 方案已知限制

1. 主进程只有一个窗口；A/B/C“并行”是同一主机多条 root 会话保活 + 交替读取，不是三窗口同看。
2. watcher-capacity（第 5 个 watcher）单项目无法真机触发（单项目 128=4×32，同 root 多项目被 `ProjectStore.ts:352-369` 去重）；只能单测/故障注入覆盖，报告必须写“未在真机覆盖”。
3. TTL 10 分钟是实耗，应用必须保持运行；R2 加速只作冒烟，签收只用 R1。
4. S7c（inotify 实例耗尽）影响同 uid 其他进程，必须专用账号且逐项授权；不改全局 sysctl。
5. S4b（关闭与在途读竞态）窗口小，无法稳定复现时记“未覆盖”，不得记通过。
6. 现有远端 E2E 不覆盖池化；只能作 R0 基线。

## 5. 旧文档失效状态（已按建议同步；历史记录保留）

审计对象为 6 份重点文档 + 1 个基线清单；「失效」= 与 HEAD 代码/可复现结果矛盾，「需更新」= 计数/基线/状态行过期。可复现证据：`node scripts/panel-baseline.mjs verify` 返回 rc=1、**16/48 mismatch**；`node scripts/check-test-shape.mjs` rc=0、sourceOnly 411。下表保留审计时的原始描述；2026-10-31 已按建议更新文档（见本节末“更新记录”）。

| # | 文件:行 | 旧描述 | 失效原因 / 建议 |
|---|---|---|---|
| 1 | `docs/remote-project-parallel-handoff.md:212` | “onRootRetired 只清该 root 会话的 watch 登记与保活，不关终端、不动邻居 root” | **语义失效**：HEAD 还按 sessionKey+host+root 清该项目的 generation/host/root 与目录事实（`remoteProjectDirFacts.ts:199-209`），否则 TTL 后重开会被暖缓存挡成 `SSH_HOST_NOT_READY`。建议改写为“清 watch 登记/保活 + 本项目在本会话的 generation/host/root 与目录事实；不关终端、不动邻居 root” |
| 2 | `docs/remote-project-parallel-handoff.md:208` | “P 专属文件 = 6 改 src + 2 新增 src + 10 改测试 + 4 新增测试” | 本提交新增第 3 个 src 文件 `remoteProjectDirFacts.ts`，并新增 `remoteProjectLifecycle.test.mjs`；§8.1 自称当前权威，计数已不等于 HEAD。建议标为 I0 历史快照或补增量 |
| 3 | `docs/remote-project-parallel-handoff.md:217、:357` | “P 组 141 → 142”；“P 组 13 文件 / 142 tests” | 本提交 `remoteProjectDirFacts.test.mjs` +72/−20（12→14 例）、`remoteDirWatchDeep.test.mjs` +73（12→15）、新增 `remoteProjectLifecycle`（346 行/6 例），13/142 已过期。建议重跑 P 组回写实际数 |
| 4 | `docs/remote-project-parallel-handoff.md:325、:361` | “当前清单 48 文件”；“48/48 逐字节一致” | 清单已过期：`panel-baseline.mjs verify` rc=1、16/48 mismatch；本提交直接改了清单内 4 个文件，新增 2 个文件未登记。建议由清单所有者重建后再引用 |
| 5 | `docs/panel-service-baseline.manifest:12、:15、:35、:44` | 4 条 sha256（remoteProjectIpc.ts、RemoteDeepDirWatch.ts、remoteDirWatchDeep.test.mjs、remoteProjectDirFacts.test.mjs） | 哈希与工作树不符，作为可校验基线已失效；不要手改单条哈希，由所有者重建 |
| 6 | `docs/remote-wsl-verification-log.md:337` | “`REMOTE_UPLOAD_TEMP_NAME.test(` 在 remoteProjectIpc.ts + remoteProjectReadIpc.ts 里恰好 2 处” | 列表过滤已移到 `remoteProjectDirFacts.ts:123`，守卫改为读 projectIpc+dirFacts+readIpc 三个文件（`tests/remoteProjectUpload.test.mjs:297-302`）。建议更新文件归属与计数 |
| 7 | `docs/root-pooling-handoff.md:15` | “池化仍只交付 ADR + 探针，尚无池化生产实现” | 已有默认关闭的池化实现（`RemoteRootSessionPool.ts`、接入 `RemoteHostConnectionService.ts:398-411`）；本提交又补了目录事实/生命周期修复。建议改为“已实现、生产装配默认关闭（`main/index.ts:3367-3388`）、真机验收未做” |
| 8 | `docs/root-pooling-handoff.md:3、:13` | “Status: Active plan（2026-10-31 核对）”；“基线 dev = 24529c394” | 文档基线落后于 HEAD 55dd5b702；B1–B3 已实现而非待做，状态行与任务清单均过期。建议重写或归档 |
| 9 | `docs/README.md:38` | “remote-host-root-pooling-adr.md｜同主机多 root 池化 ADR（测量 + 方案，生产未改）” | 生产代码已有默认关闭的池化路径，“生产未改”不成立。建议改为“ADR + 已实现的默认关闭池化路径；真机验收未做” |
| 10 | `docs/git-panel-phase-c-plan.md:3` | “Status: 已实施，checkpoint 2d703f830，待最终验收” | 后续已有 09aca4203 与 55dd5b702；状态行仍把 2d703f830 当检查点。建议改为“历史检查点；HEAD 见 git log”，技术结论保留 |
| 11 | `docs/v-review-2026-10-31.md:3、:5、:9、:35` | “已执行并已按结论修复”“审查对象：G/F 未提交改动”“无阻断…代数围栏完整” | 审查范围只含 G/F；本提交改的是 P 域目录事实/监听生命周期，不在 V 的审查范围。作为质量背书引用时需补范围声明；`:35` 未覆盖清单应收录“P 域监听降级/关闭生命周期” |
| 12 | `docs/remote-wsl-verification-log.md:3、:343` | “Status: Current；最新 sweep HEAD 2c4b35e51” | 台账为现行文档，但没有任何一条覆盖 55dd5b702 行为（watch-failed/关闭生命周期/TTL 重开）；属记录缺口。建议追加一节登记本文件与未执行真机项 |

关联但不在本轮六份重点内：`docs/remote-host-root-pooling-adr.md:3` “池化生产实现尚未落地”已过期；其正文大量 file:line 已漂移，不能当现状引用。`docs/README.md:58` 关于 root-pooling-handoff 的“离线测试通过、真机验收未做”仍基本成立，但“离线测试”未含本提交新增 6 例，开启方式应补“改 main/index.ts 构造参数”。

**更新记录（2026-10-31）**：已更新 `docs/remote-project-parallel-handoff.md`（§8.1 I0 快照注记、onRootRetired 语义、P 文件/测试增量、48/48 清单过期）、`docs/root-pooling-handoff.md`（Status/基线/已实现说明）、`docs/README.md:38/:58`、`docs/git-panel-phase-c-plan.md:3`、`docs/v-review-2026-10-31.md`（范围注记）、`docs/remote-wsl-verification-log.md:337`（历史注记 + §15）、`docs/remote-host-root-pooling-adr.md:3`（默认关闭实现已落地）。`docs/panel-service-baseline.manifest` 已按 HEAD `f870d5574` 重建（48 条成员不变，仅刷新哈希），`panel-baseline.mjs verify` 48/48 rc=0；重建前实测 19/48 mismatch（初始 16/48 为文档更新前快照）。

未审计：`docs/archive/**`、`docs/maintenance-domains.md`、`docs/unified-api.md` 等大文档；只按本检查点相关面审计。

## 6. 本轮边界与本轮未做

- **验收阶段未修改被审查代码；F1 修复已提交 `a905d4d7d`**；旧文档同步已提交 `f870d5574`；本轮 CI/基线清单/真机验收改动未提交（见 §9.3/§11）。
- **未修改生产池化默认值**：`main/index.ts` 未传 `rootPooling` 的事实保持不变；真机 R1 用临时补丁，已逐字还原并确认 `git diff` 为空。
- **已执行真实主机验收**：R0（池化关闭）与 R1（临时 `rootPooling: {}`）分别跑 `e2e/remoteHostAcceptance.spec.ts`，均失败于同一 UI 断言（§10）；远端测试目录由 spec 的 finally 清理，未 sudo、未改系统、未动既有部署 bundle/leases。
- **未执行** 本轮 CI/清单/真机改动相关的 commit/push/merge；未拆分或改写 55dd5b702。
- 未重跑 Windows 全量（已知声明通过）；真机 S2/S5/S6/S7 未执行（§10.5）。
- 仓库外产物：F1 探针 `%TEMP%\pideck-f1\f1-probe.test.mjs`；方案草稿 `%TEMP%\pideck-acceptance\ssh-electron-plan.md`；均未入库。
- 仓库内变更：本文件（新增）+ 2 个修复文件（修改，未提交）。当前 `git status --porcelain` = `M src/main/ipc/remoteProjectDirFacts.ts`、`M tests/remoteProjectLifecycle.test.mjs`、`?? docs/remote-acceptance-55dd5b702.md`。

## 7. 复现与验证命令（摘要）

```powershell
# 基线
git rev-parse HEAD                      # 55dd5b7020c7501b74986f00ecd4eac47cd5fb5d
git status --porcelain                  # 空（复核前）
git diff --stat 09aca4203..55dd5b702    # 12 files, +845/−173

# Windows 定向复跑（本轮实测 62/62：验收时 61 + 修复新增 1）
node --test tests/remoteProjectLifecycle.test.mjs tests/remoteProjectDirFacts.test.mjs tests/remoteDirWatchDeep.test.mjs tests/remoteDirWatchDegradedHint.test.mjs tests/remoteDirectoryPageWatchDegraded.test.mjs tests/remoteProjectUpload.test.mjs

# Linux（WSL）示例；实际逐文件跑，cwd=/mnt/f/PiDeck
wsl.exe -d Ubuntu-26.04 -- bash -lc 'cd /mnt/f/PiDeck && /home/wsl/node24/bin/node --test tests/remoteGitCompare.test.mjs'
wsl.exe -d Ubuntu-26.04 -- bash -lc 'cd /mnt/f/PiDeck && /home/wsl/node24/bin/node --test tests/remoteProjectLifecycle.test.mjs'

# Linux-only 既有红（基线 HEAD~1 同失败，非本提交）
wsl.exe -d Ubuntu-26.04 -- bash -lc 'cd /mnt/f/PiDeck && /home/wsl/node24/bin/node --test tests/remoteGitStability.test.mjs' 2>&1 | Select-Object -Last 20

# F1 探针（仓库外）：从 tests/remoteProjectLifecycle.test.mjs 复制 harness，改 helper 导入为
# file:///F:/PiDeck/tests/helpers/loadTsCommonJs.mjs，追加“生产顺序”用例后运行
node --test "$env:TEMP\pideck-f1\f1-probe.test.mjs"
# 修复前实测：断开后/重连后 list → {ok:false, code:"SSH_HOST_NOT_READY", establishedDelta:0}
# 修复后实测（§9）：断开 → SSH_HOST_DISCONNECTED；重连 → ok，establishedDelta=1
```

## 8. 验收签字建议

- **默认构建（池化关闭）**：可接受；本提交四个方向中 3 个通过，F1 不触发默认路径。
- **池化默认开启**：**仍不能只凭本轮签收**——R0/R1 的 UI 验收已通过，但 S2/S5/S6/S7（切换不重建、TTL/sweep、显式断开、监听降级）未执行；需补这些场景，并处理 §2.3 的保活计数风险。
- **Git Phase C / Linux-only 既有红**：`remoteGitStability` 4 例在本 Linux 环境稳定红（基线同红），需另行挂账，不应被本检查点的“Windows 全绿”掩盖。

## 9. 验收后修复（已提交 `a905d4d7d`）

按用户“继续把剩余工作做完、不删东西”的指示，在验收结论之后对 F1 做了最小修复并提交（`a905d4d7d`）；**未改写 55dd5b702，未 push**。

### 9.1 改动

- `src/main/ipc/remoteProjectDirFacts.ts`（`readDirSnapshot`）：暖缓存守卫只对 `stale === false` 的暖事实要求活的同代会话；被断连/失效标脏的 stale 暖值放行一次装载，让真实错误码（`SSH_HOST_DISCONNECTED`）或重连后的新会话接管，而不是永久返回 `SSH_HOST_NOT_READY`。未删除缓存、未改 generation 语义，拒绝/重载仍由装载层负责。
- `tests/remoteProjectLifecycle.test.mjs`：新增“显式断开按生产顺序（先 onHostDisconnected 再 retireHost）：断连报 DISCONNECTED，重连后目录读自愈”用例；原“显式断开不复活”用例保留。

### 9.2 验证（本轮实测）

| 项 | 结果 |
|---|---|
| F1 生产顺序探针（仓库外） | **通过**：断开 → `SSH_HOST_DISCONNECTED`；重连 → list ok，`establishedDelta=1` |
| Windows 6 个改动测试文件 | **通过**：62/62，0 skip |
| Linux（WSL）`remoteProjectLifecycle` | **通过**：7/7 |
| `npm run typecheck` | **通过**（exit 0） |
| `npm run check:format` | **通过**（4263 files，无差异） |
| `npm run check:ipc-wiring` | **通过**（795 channels 齐备，无重复） |

### 9.3 提交与当前工作区

- 修复提交：`a905d4d7d`（F1 源码 + 回归测试 + 验收文档）。
- 旧文档同步提交：`f870d5574`。
- CI/基线清单/文档提交：`17cce290a`。
- UI 入口修复与回归测试已提交 `c1012918e`（未 push）。
- 池化 HOME 探针修复已提交 `1702179e2`（含 manifest 与本文档当时版本）。
- 本文档本轮 R1 通过结果的最新更新待提交（本次文档提交）。
- 原检查点 `55dd5b702` 未被改写；未 push/merge。

### 9.4 仍未做

- 真机 S2/S5/S6/S7（切换不重建、TTL/sweep、显式断开、监听降级）未执行。
- 7 个既有 Linux 红已挂账（`docs/ci-linux-known-failures.md`），未修；`remoteGitStability` 属 Git/Phase C 债。
- 池化 HOME 探针与 UI 入口修复已提交（未 push）；池化默认开启仍缺 S2/S5/S6/S7 真机证据。

## 10. 真实 SSH + Electron 执行结果（2026-10-31/11-02；R0/R1 均通过）

### 10.1 运行与结果

- 授权：用户“全部去干一下，把它干完”；主机只经本机 ssh 别名 `serve`，凭据只放进程环境变量，不写入本文。
- 隔离：复用 `e2e/remote-fixtures.ts` 的 `remoteApp` fixture（临时 userData；不隔离 HOME/USERPROFILE，产品用系统 OpenSSH）。
- 构建：R0 `npx electron-vite build`（2m03s）；R1 临时加 `rootPooling: {}` 后 `npm run build:main`（17.1s），跑完删除补丁并重建 `out/main`。
- spec：`e2e/remoteHostAcceptance.spec.ts`。

| 轮次 | 配置 | 结果 |
|---|---|---|
| R0（修复前）#1/#2/#3 | 池化关闭 | exit 1；42.3s / 34.9s / 35.1s；均卡在 spec:223 |
| R1（修复前）#1/#2 | `rootPooling: {}` | exit 1；37.8s / 33.0s；同一点失败 |
| **R0（修复后）** | 池化关闭，含 UI fix | **1 passed（40.7s）** |
| **R1（修复后）** | `rootPooling: {}`，含 UI fix + HOME 探针 | **1 passed**：首次 41.7s、重复 39.3s；调试轮另通过 1 次 |

**UI 入口失败根因（已修复）**：R0（修复前）的 ARIA 显示中栏是 `SessionStartSurface`，但按钮不存在。React fiber 对照确认：`SessionStartSurface` 收到 `secondaryAction`（Button 元素），而 `SessionStartBody` 没收到——`SessionStartSurface.tsx:123` 在重构后返回 `SessionStartBody` 时**漏转发 `secondaryAction`**，`SessionStartBody.tsx:169` 因此永远不渲染。修复：补 `secondaryAction={props.secondaryAction}`；回归断言加到 `tests/remoteProjectComposerEntry.test.mjs`（“start surface and file panel expose the two-way switch”）。R0 复跑 **1 passed (40.7s)**，证明入口恢复。

**R1（池化）修复与结果**：R1 先失败于 step 5「远端会话列表」：UI 文案“无法确定远端会话目录（远端 home 解析失败）”，断言位置 `e2e/remoteHostAcceptance.spec.ts:237:62`。原因：池化 `connect` 只 `ensureHeldShared`、不创建 root helper（`RemoteHostConnectionService.ts:669-688`），`readHomeEnsuring` 在没有缓存 manager/池条目时返回 undefined（`:1095-1110`）。已补 pinned 只读 HOME 探针（`buildReadHomeCommand` + `buildPinnedSshInvocation`，不建 helper、不碰项目 root），提交在 `1702179e2`。R1 随后连续 2 次通过（41.7s / 39.3s），调试轮另通过 1 次。**曾出现一次 step 6 权威标题 240s 超时（回退文件名），在后续 3 次运行中未复现**；按 flake 记录，若再次出现需单独查标题读取时序。

影响：R0/R1 的 S0/S1 入口、登记、会话列表/标题/导入、项目级 root 状态链路均通过；S2/S5/S6/S7 未执行。

### 10.2 采样（修复前 R0/R1 记录）

- R0：运行中稳定 1 条 helper（`~/.nvm/versions/node/v24.11.0/bin/node ~/.pideck/remote-host/bundles/<sha>/helper.mjs`）；远端 :22 established 3→5、sshd 7→9；结束回落到 3/7，helper 归零；本机 ssh 1→3。
- R1：14 次采样 helper=0、:22 连接 3–4；2.7s 采样分辨率不足以证明“池化未建会话”；全程**未见 2 条不同 root 的 helper**。
- 采样口径坑：`ps -eo args` 折行会截掉 `--root`；改用 `ps -eww -o args=` 后又恰好无 helper 可采 ⇒ 本轮没有 helper `--root` 归属的直接证据。

### 10.3 补丁与清理

- `rootPooling: {}` 临时应用多次（修复前 R1、修复后 R1、标题调试轮），均已删除；`git diff -- src/main/index.ts` 为空；干净源码重建 `out/main` 后其中 `rootPooling: {}` 命中 0。
- 远端：每次结束 helper 归零、:22 回到基线；5 次运行的 runId 目录均由 spec 的 `finally` 清理；唯一残留 `~/.pideck-e2e-e2emvulqwle` 与这 5 次 runId 都不匹配（更早遗留），未动；`.pi/agent/sessions` 无 e2e 夹具残留。
- 未 sudo、未改系统、未动既有 `~/.pideck/remote-host` 的 bundle/leases。

### 10.4 结论

- UI 入口 bug 是产品回归（`SessionStartSurface` 漏转发 `secondaryAction`），已修复；R0 真机复跑通过，回归测试已加。
- 池化 HOME 缺口已用 pinned 只读探针补齐并提交 `1702179e2`；R1 连续通过，UI 入口、登记、会话列表/标题/导入、项目级 root 状态链路均有真机证据。
- 曾有一次 step 6 标题超时未复现，按 flake 记录；S2/S5/S6/S7 未执行，不能把 R0/R1 通过写成完整池化验收。

## 11. CI 与基线清单同步（2026-10-31，已提交 17cce290a）

### 11.1 Linux CI

- `.github/workflows/ci.yml` 新增 `linux-unit-remote`（`ubuntu-latest`，node 24.13.0，`npm ci`）：
  - 硬门禁：17 个远端/SSH 相关文件 = **253 tests / 252 pass + 1 root-only skip**，失败挡合并（`remoteProjectLifecycle` 已按修复后的 7 例计入）。
  - 跟踪：`tests/remote*.test.mjs` + `tests/ssh*.test.mjs` 全扫，`continue-on-error`，只用于发现“§2 清单之外的新红”；WSL2 实测 **248 文件 / 2380 tests / 2362 pass / 7 fail / 11 skip（668s）**，7 红全部命中清单、无第 8 条。
- 新增 `docs/ci-linux-known-failures.md`：7 条既有 Linux 红（`remoteGitStability` 4、`remoteHelperSearchNames` 1、`remoteSearchIsolation` 1、`sshClientRuntime` 1），均给出复现命令、现象、基线 HEAD~1/09aca4203 同红证据与处置=挂账；并区分 Windows-only / POSIX-only / root-only skip。
- 状态：本地改好 `ci.yml` 与新文档，**未触发 GitHub CI**；push 后才生效。

### 11.2 基线清单

- `docs/panel-service-baseline.manifest`：48 条成员不变，按 HEAD `f870d5574` 重算 sha256；`panel-baseline.mjs verify` **48/48 rc=0**。
- 重建前实测 **19/48 mismatch**（验收文档更新前的 16/48 是更早快照）；差额来自本检查点的文档更新，不是源码回归。
- handoff §8.4 已记录重建与计数口径；manifest 由脚本整表重算，**未手改单条哈希**。

### 11.3 本轮 UI 修复提交内容

- `src/renderer/src/components/session/SessionStartSurface.tsx`（补 `secondaryAction` 转发）
- `tests/remoteProjectComposerEntry.test.mjs`（source 回归断言）
- `docs/remote-acceptance-55dd5b702.md`（§10 更新）
- 另有 `?? docs/remote-sftp-evaluation.md`：非本轮产出，未纳入/未修改。
- 本次提交未 push。
