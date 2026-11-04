# ADR：同主机多项目 root 池化（测量 + 方案）

> Status: **生产默认已开启并通过真实主机验收（2026-11-02；2026-11-03 审计后复验）**。`main/index.ts` 显式装配 `ROOT_POOL_DEFAULT_POLICY`，E2E-only 池化开关已移除；当前结论、实测资源和回滚见 §8。§2–6 的源码行号和测量是历史基线，不能当作本轮验收。
> 测量脚本为 `tests/remoteRootSwitchProbe.mjs`；并行派工与前置同步见 [remote-project-parallel-handoff.md](remote-project-parallel-handoff.md)。本轮起点 `01b4cf517`，未改写原 `codex/sftp-0` 分支。
>
> 相关前置：`docs/archive/remote/remote-functional-optimization-plan.md` F3（切 root 仍重建会话，只复用已验证安装内容）、
> `docs/archive/remote/remote-phase4-plan.md` B7（`--root` 每连接一个）、`docs/archive/remote/remote-development-plan.md` `7（`root.register`
> 只是早期规划词，从未实现）、`docs/archive/remote/remote-wsl-functional-hardening-handoff.md` `7.6（本卡来源）。

## 1. 问题与结论摘要

现状是**每台主机只持有一个 helper 会话，root 在 helper 启动时固定**。同主机两个远端项目交替读取时，
每次换项目都要 `discard` 当前 manager/held → 重新发现 node → bootstrap（F3 命中时 verify-existing，
通常不 scp）→ 新 SSH + `node helper --root` → hello → root 复核 → 首次读。用户可见后果：换项目/回到
另一个项目要等一次完整重建；期间同主机所有项目读被串行化；换代后目录 watcher 全部重建、事实缓存换代。

真实主机测量（2026-10-30，5 个交替 cycle，0 失败）支持这个判断：

- 一次 helper-only 切换 cycle（spawn ssh+helper→hello→fs.list→fs.watch→kill）中位 **874 ms**（min 855 /
  max 1685）；其中 helper 冷启动到 hello 中位 **405 ms**。
- 产品路径还要加 node 发现（中位 **703 ms**）、bootstrap verify 扫描代理（中位 **342 ms**）、root 复核
  （中位 **354 ms**）；可观测下界代理 **≈1.81 s/次切换**（不含锁等待、pin/route 构造、bootstrap staging）。
- 两个 root 的 helper 可以同时存活（各 52.4 MiB RSS、7 线程、各自 SSH 连接，合计 104.9 MiB），说明
  **按 root 的会话池在进程/协议层可行**，不需要先改 helper 协议。
- 换代后 watcher 必须重建：5/5 次切换都拿到新 `watchId`；9 条路径一帧耗时中位 4.6 ms，但产品还会
  重读**全部已加载目录**，成本随已加载目录数线性增长。

**建议**：选 **B（main 侧按 (hostId, root) 的 helper 会话池）**，分阶段落地；不做 A（helper 内
`root.register` 多 root 协议）作为第一步——A 要改冻结协议/所有 fs+git 方法/安全边界，收益与 B 相同
但涉及的协议与安全改动范围更大。B 的空闲保温候选容量为 2，活跃租约与总资源预算另管，不作为可打开项目数上限；单会话路径保留为启动时回滚选项。

## 2. 现状路径（源码事实）

### 2.1 一次项目读如何落到一个 root 会话

1. **项目身份解析**：`remoteProjectReadIpc.ts` / `remoteProjectIpc.ts` 用项目 locator 得到
   `{hostId, remotePath}`，再经 `RemoteProjectTargetResolver` 拿连接服务（`remoteProjectTarget.ts`）。
2. **每主机操作锁**：`withProjectSession`（`RemoteHostConnectionService.ts:1259`）持有每主机 FIFO 锁，
   把「切根 + 就绪判定 + 整次操作」包在一个边界里；`operationLock` 定义在同文件 `:336`。
3. **root 切换**：`establishProjectSession`（`:652`）比较 `workspaceRoots.get(hostId) ?? options.root`
   与请求 root（`:656`）；不同则 `workspaceRoots.set` + `discard(entry)`（`:659-660`）。
   `discard`（`:479-490`）清掉 `held/manager` 并**异步 dispose** 旧 manager；旧 manager 的事件/状态回调
   被 `managerFor`（`:451-476`）用 manager 身份围栏，迟到事件不会影响新会话。
4. **重建**：`ensureHeld`（`:502-545`）先读 store revision；held 失效后重新 `resolveNode`（`:517`，一次
   登录 shell 发现）→ `ports.bootstrap`（`:524`，F3 的 verify-existing 分支在
   `RemoteBootstrapDeployment.ts:144-152`：先 `runBootstrapVerify`，verified 则 `reused:true`、不上传）→
   `managerFor` + `manager.connect`（`:705-721`）。`manager.connect` 启动新的 pinned SSH 进程，argv 带
   `--root`（root 来自 `ensureHeld :537` 的 `workspaceRoots`，随 held session 固定）。
5. **握手与复核**：`SshConnectionAttempt` 的 hello 校验 `result.root === requestedRoot`，不一致是 FATAL
   `SSH_HELPER_ROOT_MISMATCH`（`SshConnectionAttempt.ts:263-266`）；`establishProjectSession` 在需要重建
   时先 `verifyProjectRoot`（`:684-704`，`readlink -f` + `[ -d ]`，失败记 per-project
   `SSH_PROJECT_ROOT_CHANGED` / `SSH_PROJECT_ROOT_UNRESOLVED`）。
6. **会话身份**：`connectionId = hostId#managerToken#generation`（`:737`）；每次换 root/重连/换 manager
   都会变。它同时是事实缓存代数（`RemoteFactCache` 的 `generation` 围栏，`RemoteFactCache.ts:155-177`）、
   目录 watcher 的登记代（`RemoteDirWatchRegistry.ts:130-140`）与渲染层失效依据
   （`lazyDirTree.ts:285-301` 换代时清树并重读根 + 全部已加载目录）。
7. **写/终端**：写路径同样经 `withProjectSession`，session 绑定当时代 manager，换代后旧 session 的
   request 失败关闭（`:770-777`）。终端 PTY 明确**不随 root 切换死亡**（注释 `:764`），但 launch ticket
   绑定 helper 自己的 canonical root。

### 2.2 重绑/换 root 的其它触发点

- `setWorkspaceRoot`（`:1026-1031`）：设置页确认浏览 root 时直接 `discard`（root 是启动参数，不能热改）。
- store revision 变化（重绑/禁用/重验）：`ensureHeld` 发现 held revision 不符则 `discard`（`:502-510`）。
- 显式 `disconnect`/`dispose`：关 manager；`explicitlyDisconnected` 阻止后台读偷偷重连。
- 会话扫描/根解析：生产装配已注入一次性 command transport（`remoteSessionIpc.ts`、`remoteRuntimePort.ts`），
  不再因常规扫描切换 helper root。兼容 helper 路径仍存在，不能把它当作生产扫描尚未迁移；title/register 等实际调用另按源码核对。
- 测试约束：`tests/remoteHostConnectionService.test.mjs:467` 明确断言「换 workspace base ⇒ 丢弃 held、
  新 manager 使用新 root」；`remoteProjectReadIsolation` / `remoteProjectRootStatusIsolation` 钉住
  串根/项目隔离。池化须保留旧模式的有效行为覆盖，并新增池化模式验证；测试组织或过时预期可按工程标准更新，不能丢掉仍有效的不变量。

## 3. 容量与失败模式

### 3.1 容量现状

| 维度 | 现状 | 依据 |
| --- | --- | --- |
| 每主机 helper/SSH 会话 | 1 个 held helper + 1 个 manager | `RemoteHostConnectionService.ts:330-336` |
| root | 每 helper 固定一个；换 root = 换进程 | `SshConnectionManager.ts:20-33`（`SshHelperSession.root`） |
| 并发请求 | helper 4 in-flight + 64 等待室（每会话） | `RemoteHelperContract.ts` 常量 |
| 目录 watcher | 每会话 4 watcher × 32 路径 | `RemoteDirWatchRegistry.ts:25` |
| 事实缓存 | 每项目目录键 + generation 围栏，LRU 512 | `RemoteFactCache.ts:67-93,155-177` |
| 切换成本 | 见 `4；下界代理 ≈1.81 s | 本次真机测量 |

### 3.2 失败模式（现状与池化后）

- **串行阻塞**：A 的读/切根持锁期间，B 的读排队；一个慢 bootstrap 会放大为整台主机的用户等待。
- **root 复核失败**：`SSH_PROJECT_ROOT_CHANGED`/`UNRESOLVED` 记到项目而非主机；健康邻居不受影响
  （设计 (i)，`RemoteHostConnectionService.ts:637-650`、`projectRootStatus :1015-1018`）。
- **bootstrap/连接失败**：`SSH_HELPER_NOT_BOOTSTRAPPED`、`BOOTSTRAP_*`、`SSH_CONNECTION_TIMEOUT`、
  `SSH_HOST_NOT_READY`；旧 manager 被丢弃后其迟到事件被 manager 身份围栏拒绝。
- **断连/重绑**：manager generation 前进；旧 watcher 随旧 helper 死亡，registry 换代不假装退订；
  事实缓存旧代标脏，渲染层清树重读。
- **换 root 与写/取消交错**：操作锁保证不交错；但**一个已建立的写 session 在换 root 后失败关闭**，
  不重放；未确认结果仍按既有 unknown 语义处理。
- **池化新增风险**：容量/淘汰竞态（正在执行的操作不能被淘汰）、跨 root 串读（路由键必须含 root）、
  watcher 登记表必须从「按 host」升级为「按 host+sessionKey」、主机级诊断/needs-attention 可能被单
  root 失败污染（必须继续 per-project 记录）、内存线性增长（N×~52 MiB 远端 + 本机 SSH 进程）。

## 4. 真机测量（可复现）

### 4.1 方法与环境

- 主机：真实 SSH 主机（凭据只经环境变量 `PIDECK_E2E_REMOTE_*` 注入，未写入仓库/日志）；
  OpenSSH 客户端（Windows），远端 node **v24.11.0**，已部署 bundle 含 7 个文件（helper 1.25.0）。
- 脚本：`tests/remoteRootSwitchProbe.mjs`（非 `*.test.mjs`，不参与默认单测；输出 JSON + 退出码）。
- 夹具：两个临时项目根 A/B（9 文件/8 深目录），交替 **A→B→A→B→A（5 cycles）**；每 cycle spawn
  `ssh -T <node> <bundle>/helper.mjs --root <root>` → hello → `fs.list(".")` → `fs.watch(9 paths)` →
  `fs.unwatch` → kill；另有 3 次 primitives 采样与一次双 helper 共存采样。所有临时目录结束后删除。
- 运行方式：仓库根 `node tests/remoteRootSwitchProbe.mjs`；本轮通过临时 PowerShell wrapper 在子进程
  注入同一组环境变量运行（wrapper 不在仓库内）。测量时间 2026-10-30。

### 4.2 数字（同一轮、中位/最小/最大，单位 ms）

| 指标 | 中位 | min | max | 说明 |
| --- | ---: | ---: | ---: | --- |
| SSH 短命令（建连+RTT） | 342.37 | 325.72 | 356.37 | 每次 node 发现/root 复核/bundle 扫描都各含一次 |
| node 发现（登录 shell PATH） | 702.76 | 682.64 | 705.46 | `resolveNode` 的远端部分 |
| root 复核（A，readlink+[ -d ]） | 353.85 | 352.33 | 356.62 | `verifyProjectRoot` 的一次 pinned 探测 |
| root 复核（B） | 353.71 | 334.58 | 356.41 | 同上 |
| bundle verify 扫描代理 | 341.93 | 340.97 | 372.25 | `sha256sum` 已部署 7 文件；真实 verify 还有 staging 帧 |
| helper 冷启动→hello（切换 cycle） | 405.30 | 390.17 | 1217.29 | 新 SSH + node helper + 握手；max 是一次异常慢启动 |
| hello→首次 fs.list | 4.21 | 3.97 | 6.67 | 根层第一次读 |
| fs.watch（9 路径） | 4.61 | 4.22 | 4.90 | 换代后一次订阅 |
| 完整 cycle（spawn→kill 结束） | 874.20 | 854.72 | 1685.44 | 不含 node 发现/bootstrap/root 复核 |
| kill（stdin EOF→进程退出） | 21.78 | 19.94 | 22.36 | 清理成本 |
| **产品切换下界代理** | **1812.66** | — | — | node 发现 + root 复核 + bundle 扫描 + helper 启动 + 首读 + watch 之和 |

辅助计数：5 次 helper 启动 / 0 次 helper 失败 / 5 个不同 `watchId`（每次换代必然重建）/ 9 条路径一帧 /
约 27 条 SSH 命令（含采样与共存检查）。冷启动单列：start→hello 469.98、hello→list 21.77、整 cycle 957.76。

容量：单 helper **53,686 KB RSS（≈52.4 MiB）/ 7 线程**；两个 root 的 helper 同时存活时
53,672 + 53,700 KB = **107,372 KB（≈104.9 MiB）**，各自独立 SSH 连接（进程级可行性证据）。
失败码：非法 `--root` → `ROOT_INVALID` + 退出码 1；删掉 root 后同一复核命令退出码 5（存在 root 为 0），
产品把它记为 `SSH_PROJECT_ROOT_UNRESOLVED`（源码事实）。

### 4.3 能得出的结论

1. 一次冷切换的主要成本是**两个固定整包**：node 发现 + bootstrap/连接建立（约 1.0–1.1 s）与新的
   SSH+helper 启动（约 0.4 s），root 复核与首读都很小。池化命中热会话可以把这三项都省掉。
2. watcher 重建本身一帧很便宜（~5 ms/9 路径），但产品换代会对**全部已加载目录**重读（每个目录一次
   `fs.list`，本机 RTT 约 4–7 ms；100 ms RTT 链路上约 100 ms/目录，推断未实测），因此池化要尽量
   **避免换 root 引起的换代**，而不是只优化 watch 帧。
3. 两个 helper 共存的内存代价约 105 MiB（N=2）；N 增大按 N 线性（未测 N>2）。

### 4.4 未测量（原因）与补测步骤

| 未测量项 | 原因 | 补测步骤 |
| --- | --- | --- |
| 产品 service 级切换耗时（含 operation lock 排队、pin/route 构造、bootstrap staging、dispose） | 需要可注入真实 SSH 的 pinned host fixture；现有 e2e 只能经 Electron，本轮明确不跑 Electron/不影响 verifier | 在 `tests/` 增加一个使用真实 launcher + 临时 userData/pin fixture 的 probe（参考 `e2e/remote-fixtures.ts` 的 env 口径，但不启动 Electron）；对 `withProjectSession` A/B 交替 50 次记录 p50/p95；不修改生产代码 |
| 换代后 N 个已加载目录的重读 + 4×32 分片 rewatch | 探针只按 9 路径一帧代理；渲染层未运行 | 在 probe 中读 N 个目录（10/20/40）并记录 `Σ fs.list` 与 watch 帧数；或用真实 app 日志统计 |
| 真实 failure codes（root drift、SSH 断链、rebind、取消交错） | 不能为了测量破坏主机/项目数据；本轮只做了只读失败注入（非法 root/删除临时 root） | 用临时 root 与临时 host profile 注入：删目录、改名、断连、store revision bump；记录 `SSH_PROJECT_ROOT_*`/`SSH_HOST_NOT_READY`/`REQUEST_CANCELLED` 的 p50 与计数 |
| N>2 的内存/连接数、长活 TTL 行为 | 成本与主机资源限制；本轮只做 N=2 共存采样 | 池化实现后做 N=1..4 soak（每 root 1000 次读，记录 RSS/线程/SSH 连接数） |
| 渲染层用户感知延迟（tree 重读、内容搜索暂停） | 禁止 Electron/E2E | verifier 在池化实现后用现有 e2e 加计时断言；本轮只给源码路径 |
| macOS / WSL 主机 | 无环境 | 同 WSL smoke 步骤由 verifier 补；macOS 不声称已验证 |

## 5. 池化方案

### 5.1 备选

- **A：helper 多 root（`root.register`）**。一个 helper 进程注册多个 canonical root，帧带 root 标识。
  优点：每主机一个 SSH/进程；缺点：改冻结协议与**所有** fs/git/config/terminal 方法的路径边界、capability
  与 sha/manifest 全变；4×32 watcher、4+64 并发、8 MiB 帧、取消/超时在多个 root 间共享，一个 root 的
  长扫描会队头阻塞另一个；安全评审面显著扩大。**不推荐作为第一步**。
- **B：main 侧按 (hostId, root) 的 helper 会话池（推荐）**。保留现有 helper 协议与单 root 冻结体；
  main 维护多个 manager，每个对应一个 `(host, root)`；读按项目 root 路由到池条目；未命中时创建（沿用
  `ensureHeld`/`bootstrap`/`connect`），命中时直接复用（零 bootstrap、零新 SSH、零 node 发现）。
  代价：N×~52 MiB 远端 + N 个 SSH 客户端；需要淘汰、路由键与锁粒度改造。
- **C：只复用 SSH 连接（ControlMaster/共享传输）**。严格 pinned argv 显式 `controlmaster false`，
  且每个写命令要重新构造 pin/route；共享 master 会削弱「每次调用都重新证明 route」的既有证据。**不做**。

### 5.2 选定方案 B 的形状

    RootSessionPool
      key: <hostId> | canonicalRoot        // canonical root 来自项目 locator + verifyRoot
      entry: { manager, held, root, revision, connectionId, lastUsedAt, state, inflight, leases }
      空闲保温: 候选容量 2、TTL 10 min、LRU；不限制登记/打开项目数量
      活跃资源: 执行 lease 不可淘汰；订阅需保活或显式暂停策略；总资源预算独立且有界
      满载: 可取消、有超时的等待或稳定拒绝；不无限排队、不静默串根
      主机变更: 显式 disconnect/rebind/disable/store-revision 变化使全池失效；写结果不自动重放

- **获取（acquire）**：以 `(host, root)` 为键的 per-key 锁（替代/扩展当前 per-host 锁）。命中且
  `state=ready` ⇒ 直接返回 session（只做 generation/route 快速复核，不 probe、不 bootstrap）。未命中 ⇒
  在 per-key 锁内 `verifyProjectRoot` → `ensureHeld`（held 可按 host 共享 node 发现/已部署事实）→
  `manager.connect` → 放入池。**同一 host 不同 root 的 acquire 可以并行**；同 root 并发合并。
  `requireReady` 仍允许主机在线时首次创建另一个项目的 helper；显式断开不能被后台读取复活。
- **路由**：`RemoteProjectSession.connectionId` 继续作为事实/渲染层代数（每 root 不同）；session 的
  `request/cancel/runCommand` 绑定到池条目的 manager。旧 session 在条目被淘汰后失败关闭
  （`SSH_HOST_NOT_READY`），调用方可重新 acquire（读可重试、写不重放）。
- **锁粒度**：把现在的 `operationLock`（per-host）改为 **per-(host,root)**；跨 root 共享的资源（store
  revision 读、node 发现、bootstrap）用更短锁或按 host 的轻量锁保护，避免 A 的 bootstrap 阻塞 B 的已
  就绪读。Host 级诊断/needs-attention 不被单 root 失败驱动（继续 per-project rootFailures）。
- **watcher 关系**：`RemoteDirWatchRegistry` 从「host → 一代」升级为「host → sessionKey → 一代」；
  main 内 helper 事件也必须携带 session 身份，相同 watchId 不同 session 不能混用；换代只清对应 root 的登记。
  每 helper 仍有 4×32；订阅保活/暂停和预算回收成对处理。
- **facts 与能力来源**：缓存已有 generation 围栏，但当前目录/Git 读仍调用 host-only `connectionFacts(hostId)`，
  搜索/rootStatus 仍调用 `helperCapabilities(hostId)`，并未天然按 root 隔离。新增 main 私有的按 root 事实查询，
  迁移 `remoteProjectIpc`、`remoteGitReadIpc`、`remoteProjectReadIpc` 的项目消费者；查询不建连、不回退兄弟 root。
  `projectGenerations` 继续 per-project，`lazyDirTree` 只响应自身代数变化。保留 host 管理入口供真正的主机控制使用。
- **淘汰/清理**：manager.dispose（async）→ helper 随 stdin EOF 退出；watcher 随会话死亡（registry 换代
  不假装退订）；root 退休发独立内部通知，不调用还会关闭全 host 终端的 `onDisconnect`；terminal PTY 不受影响。
  有执行 lease 时不可因 TTL/LRU 拆会话；租约和队列释放/取消必须可测，不能留下预算外的 host 管理 helper。
- **安全**：热 acquire 只做本地 manager/generation/route/revision 身份检查；冷建立/重建仍做 `verifyProjectRoot`
  与 hello root equality；具体读写/启动操作保留既有路径与 root 边界复验。池命中不是跳过操作边界校验的理由，
  也不要求每次命中重复整套 SSH 探测。root 仍是 session 启动参数，不是帧内过滤器。

### 5.3 迁移步骤（每步独立可回滚）

1. **B0 测量基线**：把本 ADR 的 probe 纳入 `tests/` 文档流程（非默认单测）；补 `4.4 中 service 级与
   N 目录测量；定义门槛（热 acquire 本地管理开销目标 < 50 ms，不含 WAN 操作；N=2 夹具下约 120 MiB 为待复测预算；无串根）。
   可先完成无 SSH 的基线/时序验收，真实主机测量需授权并在默认开启前完成。
2. **B1 影子池（默认关闭）**：新增 `RemoteRootSessionPool`（main 私有），先用 feature flag/构造参数
   启用；现有单会话路径保留为默认。加指标：acquire hit/miss、创建次数、淘汰次数、每 root 的
   operation 等待时间、SSH/节点发现次数。**不改协议、不改持久化/存储**。
3. **B2 路由与锁**：`withProjectSession` 改为 pool-backed；per-(host,root) 锁；同 root 合并；旧单会话
   行为在 flag=off 时逐字节保持。回归：现有 `remoteHostConnectionService`/`remoteProjectReadIsolation`/
   `remoteProjectRootStatusIsolation` 全绿（保留旧模式有效覆盖，新增池化路径测试；更新过时预期时说明依据）。
4. **B3 watcher/facts**：registry/事件键升级到 host+sessionKey；`RemoteDeepDirWatch` 按项目 session 登记；
   目录/Git 缓存和能力查询改取 root-scoped facts。验证既有 per-project generation 通知能正确驱动 renderer，
   不假定只改 pool 就已接全。回归 `remoteDirWatch*`、`remoteFact*`、`lazyDirTree`。
5. **B4 默认开启**：flag 默认 on，容量/TTL 设置项与诊断（池条目、命中率、内存/连接数）；真实主机
   e2e A/B/C 三项目并发与交替 + 目录展开计时；不满足门槛则保持默认关闭。
6. **B5（可选）**：若 B 的 SSH/进程开销仍不可接受，再评估 A（helper 多 root）或 Node/runner 共用传输；
   不在 B 落地前启动。

### 5.4 回滚

- 代码回滚：每次提交独立；B1/B2/B3 都保留 flag=off 的单会话路径，回滚只需 flag=off（或 revert 对应
  提交），无数据迁移、无 schema 变化。
- 首版开关在构造/启动时选择，不在运行期为了降级立即 dispose 在途写。切回旧路径在正常退出/用户授权重启后生效。
- 指标异常记录诊断并保持后续启动默认关闭；如以后需要运行期切换，须单独设计停止接单、drain/取消与 unknown 结果，禁止自动重放。

## 6. 验证矩阵

| 层 | 用例 | 断言 |
| --- | --- | --- |
| 单元 | acquire 命中/未命中/同 key 并发合并 | 命中 0 次 bootstrap/0 次 SSH；并发只建 1 个条目 |
| 单元 | 空闲保温容量 2 + 第 3 个 root | 项目可登记/打开；按独立资源预算接纳，满载时可取消有界等待/拒绝，不串根 |
| 单元 | TTL 淘汰 / 显式 disconnect / store revision 变化 | 条目 dispose、旧 session 请求失败关闭、无残留 watcher |
| 行为 | A/B/C 三项目交替与并发读（真实或 fake 端口） | 结果只来自各自 root；A 慢读不阻塞 B 的已就绪读 |
| 行为 | 仅访问兄弟 root | 原 root 的 connectionId/session 保持有效，在途操作不因切项目失败 |
| 行为 | 所属 root 条目退休/重建或 host 重绑后的旧 session 写/读 | 失败稳定码，不重放；新 acquire 按当前身份判定 |
| watcher | 两个 root 各自 fs.watch，watchId 相同 | 登记和事件按 sessionKey 隔离；旧代事件不影响新 root |
| 生命周期 | 执行/订阅 lease、TTL、root 退休 | 活跃操作不被回收；单 root 失效不关闭邻居终端或清全 host watch |
| facts | generation 变化 | 仅该项目缓存换代；兄弟项目不丢树/不重读 |
| 失败注入 | root drift、SSH 断链、rebind、cancel | 稳定码按项目记录；host 不被单 root 拖入 needs-attention |
| 资源 | N=1..4 soak（1000 次读/root） | RSS/线程/SSH 连接数有界；TTL 后回落 |
| 真机 | A/B 交替 50 次 | p50/p95 切换延迟、命中率、bootstrap 次数、失败码计数达标 |
| 既有回归 | `remoteHostConnectionService`、`remoteProjectReadIsolation`、`remoteProjectRootStatusIsolation`、`remoteDirWatch*`、`remoteProjectIpc` | 当前契约下全绿；旧模式有效覆盖保留，测试演进有依据和覆盖说明 |

## 7. 决定

- **接受 B 作为方向，池化已实现、硬化并成为生产默认**：真实主机多项目与资源验收已通过；当前状态见 §8。
- **拒绝 A 作为第一步**：多 root 助手协议改动过大，且 watcher/并发预算共享会引入新的队头阻塞；若 B
  的进程/内存成本不可接受，再单独立项评估 A。
- **拒绝 C**：共享 SSH 传输会削弱 pin/route 的逐次证明语义。
- 后台存活、独立多端接回与常驻 server 不在本阶段范围。

## 8. 生产默认推进记录（2026-11-02，已签收）

### 8.1 当前决定与实施切面

工作树 `C:\Users\Administrator\.codex\worktrees\root-pooling-prod\PiDeck`，分支
`codex/root-pooling-prod`，起点 `01b4cf517`；未改写 `codex/sftp-0`，未提交。
**生产默认已开启**：`main/index.ts` 显式传 `rootPooling: ROOT_POOL_DEFAULT_POLICY`。
原 `PIDECK_E2E_REMOTE_ROOT_POOLING` 生产绕行已删除，未替换成另一个环境变量。
真实正确性与资源门禁均通过，因此保留默认开启。

默认策略只有一个定义 `ROOT_POOL_DEFAULT_POLICY`：`idleCapacity: 2`、`idleTtlMs: 600000`、
`maxEntries: 6`、`acquireTimeoutMs: 30000`。预算属于一个 connection service，覆盖该服务的所有
host/root，包括 rootless config helper；不是每个项目各 6 条，也不是只能打开两个项目。

| 方案 | 审计结论 |
| --- | --- |
| 仅改开关 | 不够：异步退休提前让出槽位、旧代 watcher release、关闭项目遗漏退休等竞态可复现 |
| 按 root 池化 + 生命周期硬化 | 最小正确方向；继续复用已验证的 helper/SFTP 协议和每 root 事实 |
| helper 多 root 协议 | 不需要；会改变 fs/git 路由与协议安全边界，本轮禁止 |
| 常驻 server | 与当前桌面在线范围不符，本轮禁止 |

### 8.2 审计与离线覆盖

| 切面 | 本轮处理与证据 |
| --- | --- |
| helper 生命周期 | 建立中、可用、销毁中都计入硬预算；退出前不释放槽位；manager 重复 dispose 等待同一个清理 Promise |
| 同 root 并发 | 共享一次建立；一个等待者取消不取消其他等待者；所有等待者离开才取消建立 |
| watcher retain/release | 携带 connectionId；旧 release 不减新会话计数；释放最后一个 watcher 唤醒容量等待者 |
| per-project generation | wrapper 和请求回包都复核 manager/generation/revision；旧操作迟到结果拒绝；退休取消延迟 deep-watch |
| close/remove project | 先取消该项目传输、清目录事实/订阅，再退休该 root；删除前 locator 快照供清理使用；兄弟 root 不受影响 |
| host disconnect/retry/rebind | 主机级 epoch 和 store revision 使整 host 池退休；禁止断开后后台读复活。未发布的 root 冷开失败只属于该次项目尝试，不能覆盖显式连接或健康兄弟已经证明的 host ready；已发布 root 的后续故障仍会更新 host 状态，状态观察者抛错也不能破坏已经成功的连接 |
| TTL/LRU/sweep | 只回收无 lease/无 watcher 条目；每次异步退休后重算候选；并发 sweep 与 dispose 幂等 |
| transfer / 文件抽屉 | lease 覆盖整个操作；取得 lease 和构造 route 后再次检查 AbortSignal，取消后不会在“已取得 lease、任务尚未启动”的窗口继续执行；取消 A、关闭 A 的 worker 不影响 B；不改上传提交协议 |
| Git / 文件事实 | 保留现有按项目 root 查询和 generation 缓存；不重构 Git UI；目录 root 退休清掉旧代事实与待订阅 |
| 资源上限 / 错误码 | 六槽位冷开回归中 6 成功、2 返回 `SSH_ROOT_POOL_BUSY`；满载只淘汰空闲项，否则有界等待；不改投其他 root |
| host config | rootless helper 也走池预算，不再依赖池化时不存在的单 manager；不借项目 root 做 host config |

前 8 个竞态用例在原实现上 0/8，通过修复后全部转绿；另补六槽位并发、sweep、迟到结果、重复
dispose、延迟 watcher 与关闭传输隔离。最终审计又补了“acquire 后、任务启动前取消”的 fencing，以及
“未发布 root 冷开失败不得把显式 ready 主机降级”和“已发布 root 失败仍更新 host”两条对照回归。
完整命令、结果和未通过的门禁见验收报告 §12。

### 8.3 诊断与资源口径

主进程 logging scope 为 `remote-root-pool`，只在建立、退休、等待超时、每分钟非空 sweep、dispose
记录快照。包含 entries/creating/retiring、idle/leased/watched、hits/misses/created/retired/
evictedIdle、waits（累计）/waitCount（当前）/waitTimeouts/peakEntries，以及 sweep before/after。
每 root 记录连接身份、ready/retiring 状态、helper 数和建立中 root；路径只保留 SHA-256 的 16 位
摘要，不记录 SSH argv，不新增 renderer 诊断通道。计数之间有重叠（同条目可同时 leased 与 watched）。

真机 harness 每约 2 秒采集本 run 的远端 helper PID/RSS/线程和 Electron 后代 ssh PID/RSS，另采
三条与六条 watcher 稳态。门槛：单 helper 稳态 ≤80 MiB、3 条合计 ≤180 MiB、6 条合计 ≤480 MiB、
线程 ≤12，稳态 ssh 为 helper 数至 helper 数+1（只容许瞬时只读探针）；传输期间额外 SFTP ssh 单列
采样。峰值指采样峰值，不能宣称连续时间绝对峰值。

2026-11-02 初次真机结果：三条 watched root 为 `3 helpers / 3 ssh.exe / 187,084 KiB` helper RSS
（约 182.7 MiB，单条 61,516–63,108 KiB、7 线程）；六条 watched root 连续 3 次采样均为
`6 helpers / 6 ssh.exe / 349,136 KiB` helper RSS（约 341.0 MiB，单条 53,984–63,108 KiB、7 线程），
本机 SSH RSS `68,329,472 bytes`。

2026-11-03 最终审计修复后复验：三条 watched root 为 `3 helpers / 3 ssh.exe / 186,816 KiB` helper
RSS（单条 61,576–63,076 KiB、7 线程）；六条 watched root 连续 3 次采样均为
`6 helpers / 6 ssh.exe / 348,652 KiB` helper RSS（单条 53,936–63,076 KiB、7 线程），本机 SSH RSS
`68,952,064 bytes`。两次运行的峰值均为 `helpers=6`、`ssh=6`、`peakEntries=6`；最终断线采样
`helpers=0`、`ssh=0`，采样错误为 0。资源门槛通过。

### 8.4 真机验收、回滚与未覆盖边界

- **日期与范围**：2026-11-02 初次真机签收；2026-11-03 在最终审计修复后复验。Windows Electron
  客户端 + 真实 Linux SSH 主机 `serve`，
  测试根 `/home/zhadainian/.pideck-acceptance/root-pooling-prod-20261102`。启动前清除
  `ELECTRON_RUN_AS_NODE`，未设置 `PIDECK_E2E_REMOTE_ROOT_POOLING`；既有 bundle
  `4f41cea1ba176eb067fafff92f1c8661d5a7e43fc33f7285070faeb22159d0f5` 只读复用。未 sudo、
  未修改系统目录、未覆盖/升级既有 bundle。
- **通过项**：空文件与中文/空格名、32 MiB 上传/下载与进度、冲突拒绝、批量部分失败、取消与 spool
  收敛、权限拒绝、A/B 并行取消隔离、关闭 A 不影响 B、重开 A 后继续传输、A/B/C 连续 61,079 ms
  （19 轮、3 条 helper PID/代数稳定、watcher 与 UI 持续更新）、D/E/F 六 root 资源门禁、显式断开
  退休整主机、后台读不复活、重连后重新建立并上传。初次 Playwright 结果 `1 passed (5.9m)`；
  最终审计修复后的 2026-11-03 生产装配复验为 `1 passed (4.6m)`，A/B/C 连续
  `60,632 ms / 22 轮`，66 次切换耗时 102–216 ms（中位 149 ms），3 条 helper PID/代数稳定。
- **A→B→A 闭环**：2026-11-02 热切回 A 后上传入口恢复就绪实测 `158 ms`；2026-11-03 最终审计后
  复验为 `153 ms`，不再等待约 240 秒。
- **池化诊断**：最终运行 `hits=162 / misses=9 / created=9 / retired=7 / evictedIdle=0 / waits=0 /
  waitTimeouts=0 / peakEntries=6`；六 root 稳态采样 `entries=6`，之后显式断开使全部 6 条退休。
  `before/after` sweep、per-root 连接身份与 helper 数已进入 main-only `remote-root-pool` 日志。六 root
  恰好在预算内，真实运行未触发 `waits`/`evictedIdle` 路径；这两条由离线竞态测试覆盖。
- **清理**：测试进程删除每个 `runs/sftp-*` 后，另以 SSH 只读复核 `runs/` 下 run 目录为 0、匹配本任务
  路径的 helper 为 0；既有 deploy bundle 未改动。2026-11-03 再次只读复核 `runs/` 与 helper 均为 0，
  实际复用的 `4f41cea1…` bundle 目录 mtime 仍为 2026-11-02，复验当天没有新增 bundle。
- **回滚**：只改 `src/main/index.ts` 为 `rootPooling: false`，运行 `npm run build:fast`，正常退出后
  下次启动生效。没有设置项、schema 或数据迁移；不热切换在途写，不重放 unknown 结果。若要回退整项
  行为，也可单独 revert `codex/root-pooling-prod` 的最终提交。
- **未覆盖**：真实等待 10 分钟 TTL 到期、长时间网络抖动/单 root 自动重试的 UI 恢复、真实 host
  rebind UI、多 host 争用六槽预算、第七 root 满载的真实等待/超时、重叠目录/Git 写竞争、
  8 GiB/32 文件压力、ProxyJump/askpass、提交后硬断网/崩溃、Linux 原生 Electron 客户端。
  `maxEntries=6` 的真实资源峰值已验证，但连续长稳只覆盖至少 60 秒 soak，不等同于小时级压力测试。
