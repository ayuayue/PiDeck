# PiDeck SSH 远程开发 — 交接说明

> 面向接手这条分支的开发者。**先读这一页，再读代码。**
> 详细设计见 [`remote-development-plan.md`](./remote-development-plan.md)（阶段计划与门禁）与
> [`remote-host-cross-store-design.md`](./remote-host-cross-store-design.md)（跨 store 事务设计）。
> 本文只回答三个问题：**现在到哪了、怎么跑起来、下一步做什么、哪里有雷。**

---

## 0. 一句话现状

`feat/remote-development` 是一条**独立开发线**（不是从 `main` 线性长出，也没有合回 `main`）。
它把「本地 PiDeck 通过 SSH 管远端主机/项目/Session」拆成 Phase 0–6 逐步推进：
**Phase 0–2 的安全底座已实机验证；Phase 3 第一段只读浏览、第二段「远端项目可持久化 + 登记 + 按 projectId 只读」已交付**。
Phase 4 及以后未开始。

**这条分支目前不具备"可发布"形态**：所有远端能力只在开发态开关下可见，正式包里一律返回 `REMOTE_FEATURE_DISABLED`。
不要把它当成"远端功能已经能用了"来对外描述。

---

## 1. 三种状态，必须分清（最容易踩空的地方）

代码库里同时存在三类东西。**看到代码不等于它在跑。**

### 1.1 已交付且已装配（有单测；部分有真机验收）

| 能力 | 关键文件 | 证据 |
| --- | --- | --- |
| 严格主机 pin（无 TOFU 回退）、`ssh -G` 路由复核、已知主机隔离 | `src/main/remote/SshVerifiedConnection.ts`、`SshHostPinStore.ts`、`SshRouteDigest.ts`、`SshClientRuntime.ts` | 单测 + 真机 |
| 主机档案 store（版本化 envelope、revision CAS、目录锁、needs-repair） | `RemoteHostStore.ts`、`RemoteHostStoreCodec.ts` | 单测 |
| 连接状态机 + 诊断（有界、脱敏） | `RemoteHostConnectionState.ts`、`SshConnectionDiagnostics.ts`、`SshConnectionManager.ts`、`SshConnectionAttempt.ts` | 单测 + 真机 |
| bootstrap 部署（冻结单文件 helper 上传、finalize、原子 rename） | `RemoteBootstrap*.ts`、`RemoteHelperEntry.ts`、`RemoteHelperContract.ts` | 单测 + **真机 `BOOTSTRAP_FINALIZED`** |
| 远端 Node 定位（登录 shell 取 PATH，≥22.3 门禁） | `RemoteNodeDiscovery.ts`、`RemoteBootstrapSession.ts` | 单测 + 真机 |
| **Phase 3 第一段：只读浏览**（输入远端目录 → canonical → 用户确认 → 绑定 `--root` 重建会话 → 列目录/读文件） | `RemoteBrowseRoot.ts`、`RemoteWorkspaceReader.ts`、`ipc/remoteHostIpc.ts`（`remote:workspace-*`） | 单测 + 真机（列目录/读文件/越界拒绝） |
| **Phase 3 第二段：远端项目**（判别联合、ssh locator 持久化、登记、按 projectId 只读） | `src/shared/projectLocation.ts`、`src/shared/types/project.ts`、`ProjectStore.addRemote`、`projectStoreCodec.ts`、`RemoteHostReferenceSources.ts`、`ipc/remoteHostIpc.ts`（`remote:project-*`）、`components/session/RemoteProjectPanel.tsx` | 单测（尚未真机验收第二段） |

### 1.2 已实现 + 有离线测试，但**没有生产调用方**（纯 main-only 切片）

`src/main/remote/` 下有大量模块是**为了分阶段落地先写好、但还没接线**的。新人最容易误判"它在跑"。典型：

- `RemoteControlClient.ts`（NDJSON 控制协议客户端）、`RemoteHelperContract.ts`（帧契约）：**冻结 helper 的协议实现，已被连接 attempt 消费**，但远端 pi 的长连接（Phase 4）还没接。
- `RemoteBootstrapContract.ts` / `RemoteBootstrapTransfer.ts` / `RemoteBootstrapUpload.ts` / `RemoteBootstrapDeployment.ts`：bootstrap 全链路，**已由真机验证脚本驱动**，但生产路径目前只走 `RemoteBootstrapSession.bootstrapPinnedHost`。
- `HostRebindJournal.ts` / `HostRebindConvergence.ts` / `HostRebindTxLock.ts`：跨 store rebind 事务算法**已实现**，但**没有协调器调用它**（`resumePendingRebind()` 还不存在），也没有 IPC 入口。
- `RemoteHostRepair.ts`：修复原语，**有 `repair-diagnose` / `repair-run` IPC**，但只在开发态。

> **判断口诀**：一个 `src/main/remote/` 模块如果没出现在 `src/main/index.ts` 的 `registerIpc()` 装配里，也没被 `RemoteHostConnectionService` 引用，那它就是"纯模块"，跑不到。

### 1.3 明确未做（见 §4 Backlog）

搜索、远端 Session 扫描、重启后 canonical 复核的 `needs-attention` 可视化、多 root 注册、
Windows WSL 路径、跨 store 写锁的严格互斥、Phase 4 的远端 pi Agent 生命周期与 Session 长期运行。

---

## 2. 怎么跑起来

### 2.1 开发态开关

远端功能**只在开发构建 + 显式环境变量**下开放：

```bash
PIDECK_REMOTE_EXPERIMENTAL=1 npm run dev
```

- 门禁常量：`src/main/index.ts` 的 `remoteExperimentEnabled = !app.isPackaged && process.env.PIDECK_REMOTE_EXPERIMENTAL === "1"`。
- 正式包 / 未设环境变量：所有 `remote:*` 通道返回 `REMOTE_FEATURE_DISABLED`，不会读主机库、不会起 SSH。
- 入口在 **设置 → 连接**（添加主机、连接、诊断、修复）。

### 2.2 验证命令

```bash
npm run typecheck     # 必须全绿
npm test              # 必须"相对基线无新增失败"
node_modules/.bin/biome check src tests scripts   # 必须全绿
```

**已知基线失败（不是你的锅，别去修）**：`npm test` 在本机（Linux + Node 24）有 **18 项既有失败**，全部是**平台相关**：

- Windows 盘符大小写/路径语义：`projectPathKey ignores trailing separators and Windows case`
- Windows 回收站实现（Linux 上是 `gio`，测试期望 `trash`）：`tool_call: rm 前把副本送回收站...`
- Windows OpenSSH/终端/编辑器探测：`detectExternalEditors ...`、`uses the macOS user shell ...`
- 依赖 `main` 上不存在的前置提交：`sync-workflow-choices ...`、`settings and Pi management sections use the shared heading` 等

**判断回归的方法**：先 `git stash` 出干净基线，跑一次记录失败集，再比对你的改动。本次交接前的基线是 **7181 项 / 7157 pass / 18 fail / 6 skip**。

### 2.3 真机验证脚本（远端主机）

```bash
# 需要一台 Linux 远端主机 + 系统 OpenSSH + 远端 node ≥ 22.3
node scripts/verify-remote-host.mjs <alias> --bootstrap      # bootstrap 全链路
node scripts/verify-remote-connection-service.mjs <alias>    # 连接服务到 ready
```

> 这两个脚本**会真的连远端、上传 helper**。只在你自己的测试主机上跑，不要对别人的机器跑。

---

## 3. 架构地图

### 3.1 两条独立通路（不要混）

```
① 设备/主机通路（设置 → 连接）
   主机 profile/pin 管理 → 连接 → 诊断/修复
   远端只读浏览：remote:workspace-*（hostId + main 内存里的「临时已确认 root」）

② 项目通路（侧栏项目）
   远端项目持久化：ProjectStore 里的 ssh locator { hostId, remotePath }
   按 projectId 只读：remote:project-list / remote:project-read
   root 来自项目库（可跨重启），不依赖 ①的内存 root
```

**当前两套并存**，`remote:workspace-*` 是设置页的临时浏览边界，`remote:project-*` 是正式项目。
未来方向（见 §4 第 2 项）是**设置页只留设备管理、把登记入口搬到侧栏「+」**。

### 3.2 `src/main/remote/` 模块职责（一句话）

| 模块 | 职责 |
| --- | --- |
| `SshClientRuntime` / `SshProcessLauncher` | 定位并验证系统 OpenSSH；`shell:false` 启动、环境白名单、输出有界 |
| `SshCommandBuilder` / `SshConfigCandidates` | 生成 pinned argv；解析 `~/.ssh/config` 候选 |
| `SshHostPinStore` / `SshHostVerifier` / `SshRouteDigest` / `SshVerifiedConnection` | pin 存储/校验、host key 验证、路由摘要、每次调用前复核 |
| `RemoteHostStore` / `RemoteHostStoreCodec` | 主机档案持久化（envelope + CAS + 锁 + needs-repair） |
| `RemoteHostConnectionService` | 每个主机的 bootstrap + manager 生命周期编排 |
| `SshConnectionManager` / `SshConnectionAttempt` / `RemoteHostConnectionState` | 连接状态机、重试阶梯、generation 栅栏 |
| `RemoteControlClient` / `RemoteHelperContract` / `RemoteHelperEntry` | helper NDJSON 协议（客户端 / 契约 / 冻结入口源码） |
| `RemoteBootstrap*` | helper 上传部署（契约 / 传输 / 上传 / 会话 / 部署） |
| `RemoteNodeDiscovery` | 经登录 shell 定位远端 node（≥22.3） |
| `RemoteBrowseRoot` | 用户输入目录 → pinned `readlink -f` → canonical + 目录判定 |
| `RemoteWorkspaceReader` | 只读 `fs.stat/list/read` 的验证层（分块、边界、fail-closed） |
| `RemoteHostReferenceSources` / `RemoteHostReferenceRegistry` | 引用源扫描（projects/sessions 真实扫描；host-profiles/runtime 声明无引用） |
| `HostRebindJournal` / `HostRebindConvergence` / `HostRebindTxLock` | 跨 store rebind 事务（**尚未接入**） |

### 3.3 Phase 3 第二段的类型契约（接手必读）

`Project` 已改为**判别联合**（`src/shared/types/project.ts`）：

```ts
type LocalProject  = { path: string; environment?: ...; worktreeEnabled?: ...; kind?: "chat"; ... }
type RemoteProject = { locator: { kind: "ssh"; hostId: string; remotePath: string }; path?: never; ... }
type Project = LocalProject | RemoteProject
```

- 窄化唯一出处：`src/shared/projectLocation.ts` 的 `isLocalProject` / `isRemoteProject`。
- **远端项目没有 `path`**。任何把 `project.path` 当本机路径用的地方，编译器都会报错——这就是审计机制。
- 本段已逐处处理 71 处 `project.path` 消费点（本地 fs / Git / 终端 cwd / session scanner / 导入 / 资源 / 粘贴 / quick-task / 编辑器 / worktree / 侧栏显示），远端项目一律显式拒绝或改用 `locator.remotePath`。
- 新增远端项目时**不要**用 `as` / `!` 绕过窄化。

---

## 4. 下一步 Backlog（按优先级）

### P0 — 修一个已知隐患：root 串根（**先修这个**）

设置页的 `remote:workspace-list/read` 只用内存里的 `workspaceRoot` 当**门禁**，但实际读取跟着**当前 helper 会话的 `--root`** 走。
而 `remote:project-*` 会切换同一主机会话的 `--root`。因此：**在设置页浏览过 → 打开一个远端项目（切了 root）→ 回到设置页浏览**，会读到项目根的相对位置，内容错乱或 `PATH_OUTSIDE_ROOT`。

**正确不变量**：每条读取都绑定它被授权时的那一个 root，读取前把会话重新对齐到该 root（root 漂移就重建会话）。
这同时是"重启复核"的一半。修法：把「确保某主机会话处于某 root」抽成共用动作，`workspace-*` 与 `project-*` 读前都先对齐。

> 若按 P1 直接**删掉设置页浏览**，这个隐患随之消失（工作量大减）。两条路二选一，别两个都做。

### P1 — 设置页只留设备管理；登记入口搬到侧栏「+」

用户已确认的方向：设置页只管设备/主机；**增删项目回到侧栏项目区的「+」**，像 ZCode 那样点「+」时可选「远端文件夹」。

- 侧栏「+」→ 小菜单「本机 / WSL / 远端 (SSH)…」；选远端 → 选一台**已验证**主机 → 输入远端路径 → 解析并展示 canonical 确认 → 复用现有 `remote:project-enroll`。
- 设置页 `ConnectionsTab` 移除 `RemoteWorkspacePanel`（连同 `remote:workspace-*` 通道一起删，能顺带消掉 P0）。
- 参考实现：ZCode 的 `SSHDialog` 向导（`kind → settings → connecting → directory`）+ 侧栏/空态的 workspace 菜单（本机/远端两个入口）。

### P2 — 重启后 canonical 复核 + `needs-attention` 可视化

目前 root 不一致只会隐式重建会话，没有变成用户可见的待处理状态。
要求：重连为已存项目注册 project root 前，重跑 canonical containment；失败/漂移进入 `needs-attention`，**不静默换根**。

### P3 — 远端搜索与 Session 扫描（Phase 3 剩余项）

当前远端项目只能列目录/读文件，不扫描 Session（本地 scanner 不读远端路径，主进程已拒绝）。

### P4 — Phase 4：远端 pi Agent 生命周期

`SshPiRuntimeLauncher`、长连接、停止、Session 恢复、断线语义（**断线不得盲目重发可能已执行的 prompt**）、远端配置/trust/安全 artifact。

### P5 — 更远

多 root 注册（同一 helper 会话挂多个 root，替代"切换即重连"）、Windows WSL 路径、跨 store 写锁的严格互斥、`HostRebind` 协调器接入。

---

## 5. 雷区与硬约束（别踩）

1. **不得 TOFU**：主机指纹必须用户独立核对；`serve` 的独立核验指纹是唯一可信锚点，**不写进代码/文档**。
2. **系统 OpenSSH + 严格 pin**：不替换传输层；每次调用前复核 route digest / pin / endpoint。不得自作主张改用户的 Node 或 SSH 环境（曾误删 `/usr/bin/node`，已恢复，**不能重犯**）。
3. **远端 pi 是 Agent 的唯一主体**：PiDeck 不复制本地密钥/凭据到远端，不把远端路径交给本地 fs/Git 实现。
4. **远端 node ≥ 22.3**：helper 依赖 `process.getBuiltinModule` 与 WebCrypto；低版本在 `try` 之外就失败（表现为 0 帧退出）。探针门禁在前。
5. **改 schema / 公共契约 / 安全门禁前，先列方案与验收条件**（本仓库的既有约定）。
6. **`main` 不是这条分支的祖先**：不能直接 merge 回 `main`；合入要走独立评审。相对 `main` 约领先 90 / 落后 27。
7. **正式包门禁**：新增远端能力必须仍受 `remoteExperimentEnabled` 约束，不能悄悄在正式包开放。
8. **测试基线**：见 §2.2，18 项平台相关失败属正常。

---

## 6. 协作约定建议

- **不要直接往 `feat/remote-development` 推**：各自开 `feat/remote-<topic>` 分支，走 PR 到这条线，至少一人 review。
- 每个 PR 描述写清：**改了哪一层（§1 的哪一类）、验证命令与结果、是否触及 schema/契约/门禁**。
- commit 风格随仓库既有约定（`feat:` / `fix:` / `docs:` …）。
- 涉及 P0/P2 这类"安全语义"改动，先开 issue/discussion 对齐再写码。

---

## 7. 相关文档

| 文档 | 内容 |
| --- | --- |
| [`remote-development-plan.md`](./remote-development-plan.md) | 主计划：范围、架构、Phase 0–6 阶段门禁、能力对照、风险表 |
| [`remote-host-cross-store-design.md`](./remote-host-cross-store-design.md) | 跨 store（hostId × ProjectStore × SessionCatalog）事务设计、INV 不变量、rebind 收敛 |
| [`project-location-architecture.md`](./project-location-architecture.md) | 项目位置架构 ADR（本机/WSL/SSH 并列，Proposed） |
| [`wsl-location-baseline.md`](./wsl-location-baseline.md) | WSL 位置基线 |
| 本文件 | 交接入口：现状分层、怎么跑、Backlog、雷区 |
