# 重新绑定主机（rebind）UI 设计

> 状态：**设计稿，未实现**。基线 `dev / 62b24815c`（只读核对，未改任何产品代码）。
> 范围：渲染层交互形态 + 它需要的 main 侧只读/编排面的**形状**（不含实现）。
> 关联：[跨 store 事务设计](archive/remote/remote-host-cross-store-design.md)（§4.2 协调器 / §4.3 journal / §5.4 收敛 / §6 修复 / §8 待确认）、[位置模型 ADR](project-location-architecture.md)、[文件树与 Git 统一计划](remote-file-tree-and-git-unification-plan.md)（§1.2 R1–R3、§1.2.1）、[UI 统一批次三](remote-ui-unification-wave-3-plan.md)（§4「rebind UI 未做」、§6 D）、`AGENTS.md`、[工程标准](engineering-standards.md)。

## 0. 先写清三个事实（它们直接决定界面形状）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | **journal / 收敛 / tx 锁已实现，但生产完全没装配**：`HostRebindJournal.resume()` 没有生产调用者，`HostRebindHostPort` 只有测试实现，`shared/ipc.ts` 里没有任何 rebind 通道。今天用户界面上不存在（也不该存在）任何"重新绑定"按钮。 | `HostRebindJournal.ts:76`、`:352`；`src/shared/ipc.ts:30-36`（只有 `repair-*` 三条）；`src/main/index.ts` 无 `HostRebindJournal` 引用 |
| **F2** | **`disable` 之后没有回滚**：`RemoteHostStore` 的公开写面里没有 `enable`，架构文档已把这个代价写进语义——`rebind` 不提供 abort。界面不能出现"取消迁移"。 | `docs/archive/remote/remote-host-cross-store-design.md` §5.4「为什么先 disable 再迁引用」；`RemoteHostStore.ts:578`（`disable`）、无 `enable` |
| **F3** | **只要 journal 或 tx 锁文件存在，整机所有 pinned SSH 调用直接 `SSH_HOST_NOT_READY`（fatal，不进重试阶梯）**。所以"有一次没收敛的迁移"不是局部故障，是全机远端不可用。 | `SshVerifiedConnection.ts:37-47`（`assertNoPendingHostRebind` 同时看 `.json` 与 `.lock`）、`:163`、`:209`；`SshConnectionManager.ts:271-307`（`SSH_HOST_NOT_READY` 在 FATAL 集） |

再加上一条**只能由代码回答**的结论：`stage` 是提示、不是权威（`HostRebindConvergence.ts:112-115` 的逐记录判定才是），所以**界面上的"已完成"只能来自 `RebindOutcome.code`**，绝不能来自 stage 或"看起来没报错"。

## 1. 目标与非目标

### 1.1 目标（可验收）

1. 用户能在**不丢失项目与会话身份**的前提下，把 `projects.json` / `session-catalog.json` 里指向旧 `hostId` 的引用整体迁到新 `hostId`，并在界面上看到"迁了哪些、迁到哪、还剩什么"。
2. 界面**只呈现**主进程已经判定合法的事实与动作：列出诊断给的合法动作、显示稳定码、不发明按钮（沿用 `RepairPanel.tsx:14-20` 的纪律）。
3. 崩溃/中断之后，用户能在界面里看到"有一次未完成的迁移"，并能**继续收敛**（roll-forward），包括"另一个进程正在处理"这种合法的等待态。
4. 每条失败稳定码都能落到**一个界面态 + 一条唯一出路**，不留"只看到一句 code"。
5. 迁移完成后，界面明确指出后续需要人处理的两件事：**项目 trust 需要重新决策**（`hostId` 变了 ⇒ `trustKey` 变，见 §3.5）、**source 档案的最终归属**（disabled tombstone 或已退役）。

### 1.2 非目标 / 明确不碰的授权语义

| 语义 | 现状锚点 | 本设计的处置 |
|---|---|---|
| **pin（host key 信任锚）** | `SshHostPinStore.ts:126`（reverify）、`:143`（offer）、`:185`（answer）；`INV-4` | **只读引用，不写。** UI 不提供"重新 pin 旧主机"、"复制 pin 到新主机"、"跳过指纹比对"任何入口。target 的 pin 只能由既有的 add/edit 流程（offer→confirm）产生。 |
| **trust（项目授权）** | `remoteTrustKey = hostId::endpointDigest::canonicalRoot`（`RemoteProjectTrust.ts:71`）；`stale` 独立态（`:97-115`） | **不迁移、不继承、不自动重放。** rebind 后 target 上必然是 `undecided`，界面只做提示 + 跳转（§3.5）。 |
| **bootstrap（helper 部署 / 内容寻址 bundle）** | `RemoteBootstrapContract.ts`、`RemoteBundleMaintenance.ts:1-27` | **不进入 rebind 流程。** helper 重装/升级不是 rebind（见 §2 S2）：换 bundle 不换 hostId，引用无需迁移。 |
| **`needs-repair` 的 store 级语义** | `RemoteHostStore.ts:143-175`（`pinIssues`）、架构 §8 Q7 | 不改成 per-host 隔离。rebind 遇到 needs-repair 一律**前置阻断**（§5）。 |
| **强制退役 / 硬删除被引用主机** | `retire` 要求引用为空（`RemoteHostStore.ts:433-455`） | 不提供 force retire，不提供"删除引用以完成退役"的一键按钮。 |
| **`LocationBackend` / 令牌 / 文件与 Git 写面** | 统一计划 §2、§3.1 | 完全不涉及。rebind 后位置仍是 `ssh`，只是 `hostId` 变了。 |

### 1.3 本设计**允许**新增的东西（边界声明）

- 一组新的 `remote:host-rebind-*` IPC（`shared/ipc.ts` → `src/main/ipc/*` → `preload`，三处同步，`AGENTS.md` 铁律 3）与它们的渲染层调用。
- 一个 main-only 的 `HostRebindCoordinator`（架构 §4.2 的设计契约 + `docs/archive/remote/remote-host-cross-store-design.md` §7.1 第 3 项）+ `HostRebindHostPort` 的生产实现（今天不存在，`HostRebindJournal.ts:76` 只有类型）。
- 两个**只读**前置探测：`describePending()`（journal 阶段 + 逐记录三态 + 锁归属）、`plan()`（引用清单 + 冲突）。
- 渲染层一个向导组件 + 一条全局横幅；i18n 键。
- **禁止**：任何写 `verifiedEndpoint` / pin 字节 / trust 记录 / helper 部署状态的代码路径（`RemoteHostRepair.ts:1-13` 的三条铁律同样适用于这里）。

## 2. 触发场景清单（现状 → 缺口）

> 口径：`remoteFeatureEnabled` 全开、store `ready`、OpenSSH 可用。每行只写**代码能证明**的现状。

| # | 场景 | 当前行为（证据） | rebind 适用？ | 设计结论 |
|---|---|---|---|---|
| **S1** | **主机密钥变化**（重装系统 / 换机但沿用地址与端口） | ssh 以 `UserKnownHostsFile=<pin>` + `StrictHostKeyChecking=yes` 启动（`SshCommandBuilder.ts:92-98`）；pin 不匹配时 ssh 子进程退出，stderr 文本**从不**落记录（`SshConnectionAttempt.ts:359-361`），尝试失败后由 host 分类；`SSH_HOST_KEY_MISMATCH` **不在** FATAL 集（`SshConnectionManager.ts:271-307`，`isFatalCode` 只额外放行 `REMOTE_HOST_` 前缀，`:310-312`）。⇒ 用户看到的是反复重试后的一句通用失败码。 | **是**（典型场景） | 不自动改任何 pin。入口靠用户主动发起；plan 阶段拒绝未验证/不可读的 target。**建议增加只读探测**（复用 `SshHostPinStore.reverifyRoute`，`SshHostPinStore.ts:126-140`，它只读 pin + 握手，判 `SSH_HOST_KEY_MISMATCH` / `SSH_HOST_PIN_INVALID`），把"是不是换钥匙了"变成可读结论——列入开放问题 Q6。 |
| **S2** | **helper 重装 / PiDeck 升级 / 远端 `.pideck/remote-host` 被删** | bundle 是内容寻址目录（`RemoteBootstrapContract.ts`、`RemoteBundleMaintenance.ts:1-27`）；缺 bootstrap 结果时 `SSH_HELPER_NOT_BOOTSTRAPPED`（`SshConnectionAttempt.ts:306`、`:329`），属 FATAL（`SshConnectionManager.ts:307`）。hostId 不变。 | **否** | 明确写进 UI 文案与文档：**不是 rebind**。修复路径是重连/重新部署（既有 `bootstrapping` 阶段），不产生 journal、不动引用。 |
| **S3** | **主机迁移**（新机器、新地址、新 hostId） | 今天用户只能：新加一台已验证主机 → 手工重建远端项目/会话；旧档案因仍被引用无法移除：`REMOTE_HOST_REFERENCED`（`RemoteHostStore.ts:433-455`），渲染层文案已存在（`ConnectionsTab.tsx:233`、`rendererCopy.zh-CN.ts:4716`）。 | **是**（主场景） | 本设计的主流程：source 保持 tombstone/退役两态可选，引用整体迁到 target。 |
| **S4** | **同机端口/用户/地址变更**（同一个 hostId） | `updateProfile` 在同一次原子写里**清掉** `verifiedEndpoint`/`verifiedAt`（`RemoteHostStore.ts:358-425`，判定见 `:364`），随后 IPC 立刻重跑 `offerPin` → `confirmPin`（TOFU，无人工确认步骤，`remoteHostEditIpc.ts:97-110`）；失败则返回 `{ok:false, saved:true, code}`，界面提示"已保存但验证失败"（`rendererCopy.zh-CN.ts:4511`）。 | **否（错误工具）** | 这是"编辑连接"，不是 rebind：引用无需迁移，身份不变。代价是 trust 变 `stale`（`endpointDigest` 变，`RemoteProjectTrust.ts:97-115`）——界面必须讲清"重连后每个远端项目要重新决策一次授权"。 |
| **S5** | **主机改名 / DNS 变化**（`~/.ssh/config` 里的 alias 变了，机器没变） | 同上：走 `updateProfile`，hostId 不变，pin 因 endpoint 变而失效并重新验证（同一段代码）。 | **否** | 同 S4。若 alias 变了但 hostId 也变了（用户删了又加），才会退化成 S3。 |
| **S6** | **source 已是 disabled tombstone 或已 retired** | `retire` 要求已 disabled（`RemoteHostStore.ts:433-455`）；`disable` 后档案仍在列表里带"已禁用"标签（`ConnectionsTab.tsx:325`、`rendererCopy.zh-CN.ts:4721`），引用仍可解析（`SshVerifiedConnection.ts:30-34` 对 disabled 直接 `SSH_HOST_NOT_READY`）。 | **是**（`disabled` 可以；`retired` 不行） | `plan()` 对 `source` 允许 disabled tombstone（架构 §4.2 `RebindRequest.sourceHostId` 注释）；对 **retired** 必须拒绝：`SOURCE_MISSING` 语义（`HostRebindConvergence.ts:175`）。UI：来源选择器里 `retired` 的 id 不出现。 |
| **S7** | **半迁移残留**（有 journal、无进程在跑；或只有残留 tx 锁） | 有 journal：所有 pinned 调用 `SSH_HOST_NOT_READY`（F3）。**只有 `.lock` 而无 `.json`** 时同样被拒（`SshVerifiedConnection.ts:38`），而清理入口缺失：`RemoteHostRepair.clearStaleHostLock` 只清 `remote-hosts.json.lock`（`RemoteHostRepair.ts:188-189`、`:299`），**不认 rebind 锁**；rebind 锁只会在 `acquireRebindTxLock` 时按 R6 回收（`HostRebindTxLock.ts:51`），而那要 journal 或一次引用写（`RemoteReferenceWriteGuard.ts:99`）才会发生。 | **是（收敛）** | 界面必须有"未完成的迁移"横幅 + **继续收敛**；并把"清残留 rebind 锁"作为一条新的修复动作（§5.4，前置依赖 P1）。 |
| **S8** | **主机彻底不可达**（机器没了/关机） | `plan()`/`rebind()` 全程**不连网**（只读写 `remote-hosts.json`、pin 文件、`projects.json`、`session-catalog.json`；见 `HostRebindJournal.ts:298-352` 与各端口注释）。但 target 必须已验证（`HostRebindConvergence.ts:214-232`），而验证必须能连上 target。 | **部分** | 已迁往的 target 之前必须先能连一次；source 不可达**不阻断**。若 target 也连不上 ⇒ rebind 不可用，唯一出路是 `forgetTrustAnchor`（`RemoteHostRepair.ts:329-360`，降信任、引用仍可解析但不能连接）。这条必须写进界面文案，避免"机器坏了就能搬迁"的误解。 |

## 3. 用户旅程

### 3.1 入口（三处，一个向导）

| 入口 | 位置 | 可见条件 |
|---|---|---|
| **E1 主入口** | 设置 → 连接 → 主机行：现有三个按钮（连接/编辑/移除，`ConnectionsTab.tsx:344-376`）右侧新增 `Rebind` 图标按钮，`aria-label` = 重新绑定 | `remoteAvailable === true` 且该主机 **不是** retired；`disabled` 允许（S6）。**不做**"已连接"限制（tx 期间本来就必须断开，§5.5） |
| **E2 修复面板联动** | `RepairPanel` 的 `anchor-invalid` finding 里，把 `rebuild-target-and-rebind` 从"说明文字"升级为**可执行动作**，点击打开同一个向导 | 这是**必须补的一处契约缺口**：`RemoteHostRepair.diagnose()` 会给出该动作（`RemoteHostRepair.ts:208-212`），但 IPC 允许表把它丢掉了（`remoteHostIpc.ts:52` 的 `REPAIR_ACTIONS` + `:568` 的 `filter`），渲染层根本收不到。实现时必须同步扩表并更新 `tests/settingsTabLayout.test.mjs` 附近的源码断言 |
| **E3 阻塞横幅** | 设置页顶部（`RepairPanel` 之上，`ConnectionsTab.tsx:277` 前）＋ 侧栏远端区域一行摘要 | `describePending()` 返回非空（有 journal）**或**探测到不可回收的 rebind 锁。横幅优先级高于 `RepairPanel`（因为 F3 让全机远端不可用） |

**不做入口的地方**：项目页、文件/Git 面板、会话页。它们在有 journal 时本就 fail closed，放入口只会让用户以为"从这里能绕过去"。

### 3.2 主流程（5 步，单模态）

```
[E1/E2] → ①选择来源与目标 → ②预检(只读 plan) → ③高风险确认 → ④执行(不可取消) → ⑤结果
```

**① 选择来源与目标**
- 来源：从 `remoteHosts.list()` 的当前行带入（只读，不可改）。显示 `label` + `sshHost` + 状态标签（已禁用/未验证）。
- 目标：下拉，候选 = `verified === true && disabled === false && id !== source`。
- 候选为空时的空态：说明"目标必须是一台已在 PiDeck 里完成指纹验证的主机"，并给「添加主机」次按钮（复用 `AddHostDialog`），**不**在向导内直接创建（见 Q5）。
- 选中后立即展示静态对比：两台的 `label`/`sshHost`/是否已连接；**不显示指纹**（`RemoteHostListItem` 本身不携带指纹，`shared/types/remoteHost.ts:3-9`）。
- 取消：关闭对话框，无副作用（这一步没有任何 IPC 写）。

**② 预检（只读 `plan()`）**
- 一次调用返回：`{records: {projects, sessions}, warnings, referenceScan: {complete, count}, target: {verified, anchorReadable}, store: {host, projects, sessions}, tx: "idle" | "busy" | "journal-present"}`，全部为**稳定码/计数**，不含路径、不含 pin 字节、不含记录正文。
- 界面呈现三行可读结论 + 一个"将迁移 N 个项目、M 个会话"；`warnings` 用稳定 token 列表展示（`ORIGIN_CONFLICT` 之类）。
- 失败 ⇒ 停在 ②，见 §3.3 的码→界面表。**预检本身不写任何文件**（包括不写 journal）。
- 取消：任意时刻关闭，无副作用。

**③ 高风险确认**
- 复用既有一次性确认模式（main-only `PendingConfirmationBroker`，`PendingConfirmationBroker.ts:23-70`；TTL 默认 60s，`:31-34`）。确认的 `stateDigest` 必须绑定 `(sourceHostId, targetHostId, 记录集 digest, host store revision)`。
- 文案必须包含三句硬事实：（a）来源会被**禁用**且不再可连接；（b）**确认之后无法取消**（F2）；（c）迁移完成之后，远端项目需要**重新决策授权**（§3.5）。
- 取消/超时（60s）⇒ 什么都没执行，回 ②（`CONFIRMATION_EXPIRED`，`PendingConfirmationBroker.ts:53`，只提示"确认已超时，请重新确认"）。
- 若两次确认之间状态变了（用户在别处编辑/移除主机）⇒ `CONFIRMATION_CHANGED`（`:57`，digest 不匹配）或 `REMOTE_HOST_REVISION_CONFLICT`，回 ② 重算；**禁止**用旧确认继续。

**④ 执行（无取消）**
- 进入后按钮只有两个：**「在后台继续」**（关闭对话框，主进程继续；界面退化为 E3 横幅）与**「查看详情」**（展开阶段 + 逐记录计数，只读）。
- **没有「取消/停止」**。理由在界面上要写出来（一行小字）：迁移一旦开始会继续到结束或需要人工处理为止，因为来源一旦被禁用就没有回退（F2）。
- 进度显示：阶段名（§4.1 映射）＋ 权威计数（`projects: 3/12 · sessions: 0/7`，来自逐记录三态，§4.2）。**不显示百分比进度条**（阶段是离散的，百分比是编的；见 Q7）。
- 中断语义（三种，必须分别处理）：
  - **关窗口 / 切标签 / 应用仍在跑**：tx 在主进程继续。重开时从 `describePending()` 恢复显示（不依赖前端状态）。
  - **应用崩溃 / 断电**：journal 留在盘上；下次启动时按 Q8 的结论自动 `resume` 一次，失败则显示 E3 横幅。
  - **另一个 PiDeck 实例持锁**：`resume()` 返回 `undefined`（`HostRebindJournal.ts:352-360` + `HostRebindTxLock.ts:51`）⇒ 界面显示"另一个进程正在处理这次迁移"，**不是失败**；提供「重新检查」。

**⑤ 结果**
- 成功：`REMOTE_HOST_REBIND_COMMITTED` → 标题"迁移完成"，列出 `migratedProjects/migratedSessions`、`sourceRetired`（true/false 两种文案），并跳转两个后续动作：**「检查项目授权」**（打开 `RemoteProjectTrustPanel`，`src/renderer/src/components/app/settings/RemoteProjectTrustPanel.tsx`）与**「刷新主机列表」**。
- 有遗留：`REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS` + `warnings[]`（`HOST_REBIND_WARNING_CODES`：`UNKNOWN_OUTCOME_ROLLED_FORWARD` / `JOURNAL_REMOVE_FAILED`，`HostRebindJournal.ts:130`）→ 同一页，但用 warning 色调并逐条给解释（这两条**不是**错误：迁移已收敛，只是有清理尾巴）。
- **未收敛**（抛稳定码）：不关闭对话框，落到 §3.3 对应行；已写入的进度用权威计数展示（例如"项目已迁移，来源未退役"）。

### 3.3 失败态与恢复（码 → 界面 → 唯一出路）

> 表里每一行都必须有一个界面态；`未知码` 一律走最后一行（fail closed，不猜）。

| 稳定码 | 出现时机 | 界面态 | 唯一出路 |
|---|---|---|---|
| `REMOTE_HOST_REBIND_SAME_HOST` | plan | ① 内联错误："来源与目标相同" | 改选目标 |
| `REMOTE_HOST_REBIND_SOURCE_MISSING` | plan / 收敛 | ② 内联错误 + 刷新按钮 | 刷新主机列表；source 可能已被退役 |
| `REMOTE_HOST_REBIND_TARGET_MISSING` | plan / 收敛 | ② | 重选目标 |
| `REMOTE_HOST_REBIND_TARGET_UNVERIFIED` | plan / 收敛 `verifyTarget` | ② + 「去完成激活」 | 修复面板 A1（`complete-activation-from-pin`）或重新添加该主机 |
| `REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE` | plan / 收敛 | ② + 指出该主机的 pin 不可用；store 多为 `needs-repair` | 修复面板（`forgetTrustAnchor` 会**降级**它 ⇒ 之后不再能当 target） |
| `REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE` | plan | ② 阻止开始 | 「重新检查」；持续出现 ⇒ 人工检查（`RemoteReferenceWriteGuard` 的 `REMOTE_HOST_REFERENCE_STORE_UNVERIFIED` 同源） |
| `REMOTE_HOST_REBIND_ORIGIN_CONFLICT` | plan（**目前无产出点**，只声明于 `HostRebindJournal.ts:117`） | ② 列出冲突计数 | 先人工处理重复 origin（不自动合并） |
| `REMOTE_HOST_REBIND_JOURNAL_PRESENT` | 执行前 | ③ 之前 | 先显示 E3 横幅 →「继续收敛」 |
| `REMOTE_HOST_REBIND_TX_BUSY` / `resume()` 返回 `undefined` | 执行 / 收敛 | ④ "另一个进程正在处理" | 等待 + 重新检查（不提供抢占） |
| `REMOTE_HOST_REBIND_JOURNAL_WRITE_FAILED` / `_JOURNAL_INVALID` / `_TX_LOCK_UNWRITABLE` | 执行 | ④ 明确"没有继续" | 磁盘/权限问题；`JOURNAL_INVALID` 需人工处理，**界面绝不提供"删除 journal"** |
| `REMOTE_HOST_REBIND_STALE_PLAN` | 执行/收敛 | ④ "有记录被别处改过，已停止" + 计数 | 转人工；可「重新预检」（新 tx），**不**自动重写 |
| `REMOTE_HOST_REBIND_RECORD_MISSING` | 执行/收敛 | ④ 同上，注明"不会重建已被删除的记录"（INV-6） | 转人工 |
| `REMOTE_HOST_REBIND_INCOMPLETE` | 收敛第 8 步 | ④ "引用已迁完，但仍有引用（含来源自身）⇒ 来源保持已禁用" | 「重试收敛」或先删除剩余引用（用户手动） |
| `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`（注册表码，注意无 `REBIND_` 前缀） | 收敛第 8 步 | ④ 同上，但文案强调"扫描不完整，无法证明无引用" | 「重试收敛」 |
| `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME` | 任意 store 写 | ④ "结果未知，正在重新核对" + 重试按钮 | 重新 `describePending()` 后再判；**禁止**显示"失败，未写入" |
| `REMOTE_HOST_REBIND_STORE_PORT_MISSING` | 执行 | ④ dev 级错误 | 装配缺陷（同 `HostRebindConvergence.ts:150-152` 的 `assertStorePort` 语义），界面只显示 code |
| `PROJECT_STORE_NEEDS_REPAIR` / `SESSION_CATALOG_NEEDS_REPAIR` / `PROJECT_STORE_REMOTE_UNSUPPORTED` | plan/执行（**原样透出**，`HostRebindJournal.ts:138`） | ②/④ 指向具体 store | 先修那个 store；`REMOTE_UNSUPPORTED` 属版本/能力问题 |
| `REMOTE_HOST_STORE_NEEDS_REPAIR` | plan/执行 | ② + 链接 `RepairPanel` | 先修复主机库（`RemoteHostStore.ts:143-175`） |
| `HOST_REPAIR_*` | 修复动作（E2 路径） | 修复面板 | 与今天一致 |
| `REMOTE_HOST_REFERENCE_REBIND_ACTIVE` | 其它域的写（项目/会话增删） | 不是本向导的态 | 横幅文案解释"迁移期间不能新增/删除远端项目与会话"（`ProjectStore.ts:371`/`:396`、`SessionCatalog.ts:1996`/`:2041`） |
| `REMOTE_FEATURE_DISABLED` | 任意新通道 | 整个连接页不可见（`SettingsModal.tsx:654`/`:920`） | 无（能力下线） |
| 其它未列码 | 任意 | ④ "迁移未完成（{code}）" + 「重新检查」 | 收敛重试；保留 journal（绝不删） |

### 3.4「放弃」的边界（唯一允许的"取消"）

- 允许放弃的**唯一**条件：`describePending()` 的权威判定证明**什么都没写**——`stage === "prepared"`、所有记录仍等于 `beforeLocator`、source 未 disabled、source 未 retired。此时删 journal 等价于"没发生过"。
- 判定必须由 main 做（在 tx 锁内读 store 真实内容），**不能**由界面看 stage 推断。理由：stage 只是提示（§0）。
- 界面呈现为 `④` 之外的独立态："这次迁移尚未开始写入。要放弃吗？"（二次确认）。
- 不满足条件时**没有**放弃按钮；此时唯一出路是收敛（roll-forward）。
- 该能力需要一个新的 main 原语（`discardPrepared()`），列入开放问题 Q2。

### 3.5 结果页之后（必须写，否则用户会误以为"一切都好了"）

1. **项目 trust**：`trustKey = hostId::endpointDigest::canonicalRoot`（`RemoteProjectTrust.ts:71`）。`hostId` 变了 ⇒ target 上没有任何记录 ⇒ 评估为 `undecided`（`:107-114`），每个远端项目首次打开时都会弹 `RemoteSessionTrustNotice`（`src/renderer/src/components/session/RemoteSessionTrustNotice.tsx:73-95`）。旧 hostId 的记录在 `retire` 时被清（`src/main/index.ts:3578-3581` 的 `onHostRetired → remoteProjectTrustService.forgetHost`）。界面要在结果页写"这些项目需要重新决策授权"，并给一跳转。
2. **来源档案的最终归属**：`sourceRetired === true` ⇒ 行消失（仅剩 `retiredHostIds`，`RemoteHostStore.ts:433-455`；展示名不保留，架构 §8 Q3）。`false` ⇒ 行保留为 disabled tombstone，**必须**在行上标出"这是迁移后的旧档案，可以移除"，并且移除时若仍被引用会再次 `REMOTE_HOST_REFERENCED`（这正是 `INCOMPLETE` 的可见形态）。
3. **残留 pin**：退役后的 pin 由 `pruneRetiredPins` 在下次 open/refresh 清理（`RemoteHostStore.ts:198`、`:271`、`:283`，以及 `retire` 内的注释 `:449-453`）；**不出现在 UI**（不是 warning，架构 §4.2 表注）。

## 4. 与 `HostRebindJournal` 状态机、`HostRebindTxLock` 的对应

### 4.1 `stage` → 界面态（并声明它不代表什么）

阶段定义见 `HostRebindJournal.ts:26`；阶段**先写后做**（`HostRebindConvergence.ts:208-212` 的 `advance`，调用点 `:178`/`:184`/`:188`/`:195`/`:202`）。

| journal.stage | 界面文案键 | 权威含义 | **不代表** |
|---|---|---|---|
| `prepared` | `progress.stage.prepared` | journal 已落盘，**可能一步都没写** | 不代表"还没开始"（若记录已等于 after，说明写过了） |
| `source-disabled` | `progress.stage.sourceDisabled` | 来源即将/已经不可连接 | 不代表引用的迁移进度 |
| `projects-written` | `progress.stage.projectsWritten` | 项目引用正在/已经迁完 | 不代表会话迁完 |
| `sessions-written` | `progress.stage.sessionsWritten` | 会话引用正在/已经迁完 | 不代表可以退役 |
| `source-retired` | `progress.stage.sourceRetired` | 正在做最终引用扫描与退役 | 不代表已收敛（扫描不完整/仍有引用会停在这里） |
| `committed` | `progress.stage.committed` | 只剩删 journal | 不代表 journal 已删（可能 `JOURNAL_REMOVE_FAILED`） |

**界面规则**：stage 只用于"现在大概在哪一步"这一句辅助文案；**进度与完成判定一律用 §4.2 的计数 + `RebindOutcome`**。stage 缺失或超前时界面不得改变行为（设计 §4.3「journal 是 write-ahead hint」）。

### 4.2 逐记录三态（权威）→ 界面计数

`classifyRebindRecord`（`HostRebindConvergence.ts:112-115`）的优先级：`missing` > `done`(== after) > `pending`(== before) > `stale`(既非 before 也非 after)。

| 分类 | 界面 | 说明文案要求 |
|---|---|---|
| `done` | 计入 "已完成" | — |
| `pending` | 计入 "待迁移" | 只在 `②` 预检与 `④` 中途可见 |
| `missing` | 显示为"记录已不存在"并**终止** | 文案必须写"不会重建"（INV-6） |
| `stale` | 显示为"被其它写入改过"并**终止** | 文案必须写"需要人工确认"，不给自动覆盖 |

界面只显示**计数**（`projects: done/pending/total`），不显示 recordId（recordId 是内部标识，跨 IPC 传输没有价值且扩大攻击面；若未来要做"详情"再单列，见 Q9）。

### 4.3 tx 锁 → 界面态

| 锁状态 | 判定 | 界面 |
|---|---|---|
| 无锁、无 journal | 空闲 | `②` 可以开始 |
| 有 journal、锁**可获取** | 上次遗留，可自查 | E3 横幅 +「继续收敛」 |
| 有 journal、锁被**活着的** owner 持有 | `resume()` 返回 `undefined`（`HostRebindJournal.ts:352-360`） | "另一个进程正在处理"（不是失败；`HostRebindTxLock.ts:31-50` 的 R4 语义是"退让而非等待"） |
| 无 journal、**只有锁文件** | F3 的旁路：`SshVerifiedConnection.ts:38` 会拒绝一切 pinned 调用 | E3 横幅 +「清理残留锁」（新动作，§5.4） |
| 锁不可回收（无 owner 元数据且不满足年龄/无活跃写） | `HostRebindTxLock.ts:31-50` + `StoreFileLock` 的 R6 判定 | 显示"锁不可读，需要人工处理"，指向诊断；**不**给"强制解锁" |

**注意**：界面上的"锁"从不显示 pid/bootId/时间戳（属于内部实现细节，且 `DIAGNOSTIC_*` 的脱敏纪律已定，`remoteHostIpc.ts:42-52`）。

### 4.4 界面禁止的三种"乐观"

1. 未拿到 `RebindOutcome` 就显示"完成"。
2. 把 `UNKNOWN_OUTCOME` 显示成"失败/未写入"（实际可能已提交，`HostRebindConvergence.ts:296-312` 的 roll-forward 就是为此）。
3. 用 stage 推断"可以放弃"（§3.4）。

## 5. 能力门控与降级

### 5.1 功能开关
- 单一发布策略 `REMOTE_FEATURE_AVAILABLE`（`src/main/remote/remoteFeaturePolicy.ts:6`）→ `update:get-channel.remoteAvailable`（`systemIpc.ts:1344`）→ 渲染层 `useRemoteFeatureAvailable()`（`src/renderer/src/hooks/useRemoteFeatureAvailable.ts:11-13`）。
- 渲染层：`isRemoteEntryVisible(remoteAvailable)` 已经让"连接"页整体不可见（`SettingsModal.tsx:654`/`:920`），因此 rebind 入口**自动**跟随；横幅也只在连接页内渲染，不做全局常驻。
- 主进程：每个新通道 `if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" }`（与 `remoteHostIpc.ts:141`/`:468` 同型），**fail closed**，不因为是"只读"就放行。

### 5.2 host 不可达
- **不阻断** `plan()` 与 `rebind()`：两者不联网（S8）。这是设计要点，也是文案要点（"主机离线也能迁移引用"）。
- **阻断 target 的诞生**：target 必须已验证（INV-3）。所以"source 没了、target 也连不上"⇒ rebind 不可用，界面必须直接给替代路径：`forgetTrustAnchor`（降级 source）+ 手工重建（§2 S8）。
- 连接态与 rebind 互不影响：tx 期间连接必然失败（F3），界面用横幅解释，不把 `SSH_HOST_NOT_READY` 当成用户的错（连接行内失败提示已有 `lastFailure` 机制，`ConnectionsTab.tsx:375-380`、`rendererCopy.zh-CN.ts:4710`）。

### 5.3 store 健康度
- host store `needs-repair` ⇒ `②` 前置阻断 + 链接修复面板（`repair-diagnose` 已可用，`remoteHostIpc.ts:468`）。
- `projects` / `sessions` store 的 `*_NEEDS_REPAIR` ⇒ 原样透出并指向对应提示（这些码**不会**被折叠成 `UNKNOWN_OUTCOME`，`HostRebindJournal.ts:138` + `HostRebindConvergence.ts:97-101`）。
- `PROJECT_STORE_REMOTE_UNSUPPORTED` ⇒ 该版本的项目 store 不能持有远端 locator，rebind 无意义：界面直接说明"当前版本不支持远端项目"，不给按钮。

### 5.4 前置依赖（不做这两条，UI 会变成一个"死按钮"）

| # | 依赖 | 为什么必须有 |
|---|---|---|
| **P1** | **清残留 rebind 锁的 UI 可达入口**：新增修复动作（例如 `clear-rebind-lock`），复用 `RemoteHostRepair.clearStaleHostLock` 的判定纪律（`RemoteHostRepair.ts:299-327`：活着的 owner 一律拒绝、无 owner 时看年龄与活跃写），只是锁路径换成 `RemoteHostPaths.rebindJournalLockFile`；同时进 `HOST_REPAIR_*` 词表与 `remoteHostIpc.ts:52` 的允许表 | 否则"journal 已删、锁残留"会让整机远端永久不可用（F3 + `SshVerifiedConnection.ts:38`），而唯一能清它的是 `acquireRebindTxLock` 的 R6 回收（需要 journal 或一次引用写）。这是今天**已经存在**的死锁，不是本设计引入的 |
| **P2** | **`plan()` 需要的"按 hostId 列出记录"读面**：`HostRebindStorePort` 只有 `readHostRecordLocators(recordIds)`（`HostRebindJournal.ts:67-69`），registry 的扫描只产出 `hostId` 集合与 `{source, recordId}` 命中（`RemoteHostReferenceSources.ts:120-141`，**命中项不带 hostId**），无法反推"哪些记录指向 source" | 没有它，`plan()` 生成不出 `records[]`，向导的 `②` 无法显示计数。属 main 侧新增只读端口（`listHostRecords(hostId)`），不在本文件实现 |

### 5.4.1 实施进度（2026-11-07）

两个前置已落地（本片）：

- **P2 端口**：`RemoteHostReferenceHit` 新增 `hostId` 归因（`RemoteHostReferenceSources.ts` 的 sessions/projects
  扫描产出它），registry 新增 `recordsOf(hostId)`；`HostRebindCoordinator.plan()` 因此能按来源枚举记录，
  不再需要第二次扫描。
- **P1 清锁**：`RemoteHostRepair.clearStaleRebindLock` 与 host 锁共用同一 owner 判定（只有可证明已结束的
  owner，或无 owner 且足够旧的锁）；`diagnose()` 在 `remote-host-rebind.lock` 存在时给出 `clear-rebind-lock`
  动作，IPC 允许表、确认流与 `RepairPanel` 的显式映射都已接入（i18n zh-CN/en-US + 生成的 zh-TW）。
- **第 1 步**：`HostRebindCoordinator`（plan / rebind / resumePendingRebind / describePending）与
  `createRemoteHostRebindPorts`（host 端口 + store 端口装配 + `listHostRecords`）已实现并有单测。
  仍未装配到 `index.ts`：IPC 通道属于附 A 第 3 步，等向导一起接，避免出现没有消费者的通道。

- **第 3 步（IPC）**：`remote:rebind-plan` / `answer` / `describe` / `resume` 四条通道。
  确认是一次性的（60s TTL），digest 绑定「来源 + 目标 + host store revision + 每条记录当前 locator」；
  批准前用当前状态重算 digest，不一致即 `CONFIRMATION_CHANGED` 且不执行。批准后先断开来源（§5.5），
  再执行；IPC 只回稳定码、阶段与计数（txId/recordId 不出 main）。
- **第 4 步（向导）**：设置 → 连接里的 `RebindPanel`（横幅 + 5 步向导），状态机在
  `rebindWizardState.ts`（换任一端即作废旧摘要）；只有确认页的 approve 会写，running 阶段没有取消按钮。
- 仍未做：真机 E2E（附 A 第 5 步）；项目页/报错恢复入口（用户已定只放设置页一处）。

- **第 5 步（真机验收，无破坏性子集）**：`e2e/rebind-wizard.spec.ts` 3 例通过（真机启动，31.2s）：
  ① 入口存在 + 无目标时禁用并给出原因；② 残留 rebind 锁被诊断 → 「执行修复」→ 锁文件消失；
  ③ 残留 journal 横幅出现 → 「继续收敛」失败时报 `REMOTE_HOST_REBIND_TARGET_MISSING`。
  **真实迁移未在开发机执行**：一次 rebind 会 disable + retire 来源并改写两个 store，需要专属的第二台
  已验证主机，不在本机验收的安全范围内（附 A 第 5 步的破坏性部分仍待专用环境）。
- **验收中发现并修复的缺陷**：`remote:repair-diagnose` 与 `repair-run` 原先在 host store `status === "ready"`
  时直接跳过 `diagnose()`。于是一个健康 store + 残留 rebind 锁（整机 pinned SSH 都被它挡住）在界面上
  完全没有出口。现在两者始终诊断：ready 时返回空 find（无锁）或锁 finding（有锁）。

- **收尾补全（Q8 / §4.3 / Q4）**：
  - 启动时在项目/会话 store 都 load 之后自动 `resumePendingRebind()` 一次；失败不阻塞启动，
    journal 保留由横幅提示（`index.ts` 的 `projectStoreLoadPromise` 链）。
  - 设置页横幅补上 `busy`（另一个进程正在处理）与 `lock-unreadable`（需人工处理）两种状态；
    两者都没有可点按钮，只给说明。
  - 向导空态可以直接打开既有的 `AddHostDialog` 添加目标主机（复用添加流程，添加后刷新列表，
    不在这里自动连接）。

### 5.5 断开连接
- 执行前（`③` 之后、写 journal 之前）main 应主动 `disconnect(source, "shutdown")`（`RemoteHostConnectionService` 已有 `disconnect`），否则 tx 一开始所有 pinned 调用（含正在跑的远端 agent）都会被 F3 打断，用户看到的是"应用坏了"。
- 界面不暴露"是否断开"选项（技术决策，不交给用户）。

## 6. i18n 键草案（zh-CN / en-US 成对）

规则（沿用仓库既有纪律）：
- 全部落在渲染层词典 `src/renderer/src/i18n/rendererCopy.zh-CN.ts` / `.en-US.ts`；`*.zh-TW.ts` 是**生成物**，改 zh-CN 后必须重跑 `node scripts/genZhTwCopy.mjs`（`AGENTS.md` 铁律 9）。
- JSX 不硬编码中英文；**稳定码与阶段名必须走显式映射函数**（像 `RepairPanel.tsx:23-44` 的 `actionLabel`），禁止 `t(\`...error.${code}\`)` 拼 key。
- 占位符只用 `{code}` / `{count}` / `{projects}` / `{sessions}` / `{done}` / `{total}` / `{label}` / `{source}` / `{target}`（与现有 copy 的 `{name}` 式插值一致，不引入格式化语法）。

| 键 | zh-CN | en-US |
|---|---|---|
| `settings.connections.rebind.action` | 重新绑定… | Rebind… |
| `settings.connections.rebind.title` | 重新绑定主机引用 | Rebind host references |
| `settings.connections.rebind.subtitle` | 把远端项目与会话的引用迁到另一台主机。项目与会话的身份不变。 | Move remote project and session references to another host. Project and session identities stay the same. |
| `settings.connections.rebind.step.pick` | 选择来源与目标 | Choose source and target |
| `settings.connections.rebind.step.precheck` | 预检 | Pre-check |
| `settings.connections.rebind.step.confirm` | 确认 | Confirm |
| `settings.connections.rebind.step.run` | 执行 | Run |
| `settings.connections.rebind.step.result` | 结果 | Result |
| `settings.connections.rebind.source` | 来源主机 | Source host |
| `settings.connections.rebind.target` | 目标主机 | Target host |
| `settings.connections.rebind.target.hint` | 目标必须是已完成指纹验证、且未禁用的主机。 | The target must be a verified, enabled host. |
| `settings.connections.rebind.target.empty` | 还没有可用的已验证主机。 | There is no verified host to use as a target yet. |
| `settings.connections.rebind.target.add` | 添加并验证主机 | Add and verify a host |
| `settings.connections.rebind.counts` | {projects} 个远端项目 · {sessions} 个会话 | {projects} remote projects · {sessions} sessions |
| `settings.connections.rebind.precheck.references` | 引用扫描：完整 | Reference scan: complete |
| `settings.connections.rebind.precheck.anchor` | 目标信任锚：可读 | Target trust anchor: readable |
| `settings.connections.rebind.precheck.tx` | 没有正在进行的迁移 | No migration in progress |
| `settings.connections.rebind.precheck.running` | 正在预检… | Pre-checking… |
| `settings.connections.rebind.confirm.body` | 开始后来源主机将被禁用并无法连接；确认之后不能取消；迁移完成后每个远端项目需要重新决策一次授权。 | Once started the source host is disabled and can no longer connect; this cannot be cancelled after confirmation; each remote project needs a new trust decision afterwards. |
| `settings.connections.rebind.confirm.run` | 开始迁移 | Start migration |
| `settings.connections.rebind.progress.stage.prepared` | 准备 | Preparing |
| `settings.connections.rebind.progress.stage.sourceDisabled` | 禁用来源 | Disabling source |
| `settings.connections.rebind.progress.stage.projectsWritten` | 迁移项目引用 | Migrating project references |
| `settings.connections.rebind.progress.stage.sessionsWritten` | 迁移会话引用 | Migrating session references |
| `settings.connections.rebind.progress.stage.sourceRetired` | 退役来源 | Retiring source |
| `settings.connections.rebind.progress.stage.committed` | 收尾 | Finishing |
| `settings.connections.rebind.progress.counts` | 项目 {done}/{total} · 会话 {done}/{total} | Projects {done}/{total} · Sessions {done}/{total} |
| `settings.connections.rebind.progress.detach` | 在后台继续 | Continue in background |
| `settings.connections.rebind.progress.detachHint` | 关闭这个窗口不会停止迁移；可以在设置页顶部查看进度。 | Closing this window does not stop the migration; progress stays visible at the top of settings. |
| `settings.connections.rebind.progress.noCancel` | 迁移开始后无法取消。 | A started migration cannot be cancelled. |
| `settings.connections.rebind.result.committed` | 迁移完成 | Migration complete |
| `settings.connections.rebind.result.committedWithWarnings` | 迁移完成（有遗留清理） | Migration complete (with leftovers) |
| `settings.connections.rebind.result.sourceRetired` | 来源主机已退役 | The source host was retired |
| `settings.connections.rebind.result.sourceDisabled` | 来源主机保留为已禁用档案 | The source host is kept as a disabled profile |
| `settings.connections.rebind.result.trust` | {count} 个远端项目需要重新决策授权。 | {count} remote projects need a new trust decision. |
| `settings.connections.rebind.result.openTrust` | 检查项目授权 | Review project trust |
| `settings.connections.rebind.warning.UNKNOWN_OUTCOME_ROLLED_FORWARD` | 有一次写入报错但已确认落地并继续。 | One write reported an error but was confirmed applied. |
| `settings.connections.rebind.warning.JOURNAL_REMOVE_FAILED` | 迁移记录未能删除，下次会重试清理。 | The migration record could not be deleted; cleanup retries later. |
| `settings.connections.rebind.banner.title` | 有一次未完成的主机迁移 | A host migration did not finish |
| `settings.connections.rebind.banner.body` | 迁移完成前，这台机器上的所有远端连接都会失败。 | Until it finishes, every remote connection on this machine fails. |
| `settings.connections.rebind.banner.resume` | 继续收敛 | Resume convergence |
| `settings.connections.rebind.banner.recheck` | 重新检查 | Check again |
| `settings.connections.rebind.banner.busy` | 另一个进程正在处理这次迁移。 | Another process is handling this migration. |
| `settings.connections.rebind.banner.staleLock` | 有残留的迁移锁，会阻止所有远端连接。 | A leftover migration lock blocks every remote connection. |
| `settings.connections.rebind.banner.clearLock` | 清理残留迁移锁 | Clear the leftover lock |
| `settings.connections.rebind.abandon.title` | 这次迁移还没有写入任何数据 | This migration has not written anything yet |
| `settings.connections.rebind.abandon.body` | 放弃只会删除迁移记录，项目和会话保持不变。 | Discarding only removes the migration record; projects and sessions stay unchanged. |
| `settings.connections.rebind.abandon.confirm` | 放弃这次迁移 | Discard this migration |
| `settings.connections.rebind.error.sameHost` | 来源与目标相同。 | Source and target are the same host. |
| `settings.connections.rebind.error.sourceMissing` | 来源主机已不存在，可能已被退役。刷新主机列表后重试。 | The source host no longer exists; it may have been retired. Refresh and retry. |
| `settings.connections.rebind.error.targetMissing` | 目标主机已不存在。 | The target host no longer exists. |
| `settings.connections.rebind.error.targetUnverified` | 目标主机还没有完成验证。 | The target host is not verified. |
| `settings.connections.rebind.error.targetAnchor` | 目标主机的指纹不可读，先在修复面板处理。 | The target host key is unreadable; handle it in the repair panel first. |
| `settings.connections.rebind.error.referenceScan` | 引用扫描不完整，无法证明迁移是安全的。 | The reference scan is incomplete, so a safe migration cannot be proven. |
| `settings.connections.rebind.error.originConflict` | 迁移后会出现重复的远端来源。 | The migration would create duplicate remote origins. |
| `settings.connections.rebind.error.stalePlan` | 有记录在这次迁移之外被修改过，已停止。 | A record changed outside this migration, so it stopped. |
| `settings.connections.rebind.error.recordMissing` | 有记录已经不存在；不会重建它。 | A record no longer exists and will not be recreated. |
| `settings.connections.rebind.error.incomplete` | 引用已迁移，但仍有引用存在，来源保持已禁用。 | References were migrated but some remain; the source stays disabled. |
| `settings.connections.rebind.error.unknownOutcome` | 结果未知，正在重新核对。 | The outcome is unknown; re-checking. |
| `settings.connections.rebind.error.txBusy` | 另一个进程正在迁移，请稍后重试。 | Another process is migrating; retry later. |
| `settings.connections.rebind.error.journalPresent` | 有一次未完成的迁移，先继续收敛。 | A migration is unfinished; resume it first. |
| `settings.connections.rebind.error.journalInvalid` | 迁移记录读不出来，需要人工检查。 | The migration record cannot be read; manual review is required. |
| `settings.connections.rebind.error.lockUnwritable` | 迁移锁目录不可写。 | The migration lock directory is not writable. |
| `settings.connections.rebind.error.storeNotReady` | 主机档案需要修复，先在修复面板处理后重试。 | The host store needs repair; fix it first. |
| `settings.connections.rebind.error.storeUnsupported` | 当前版本的项目档案不支持远端项目。 | Project records in this version cannot hold remote projects. |
| `settings.connections.rebind.error.failed` | 迁移没有完成：{code} | The migration did not finish: {code} |

## 7. 测试策略

### 7.1 单测（可在 CI 与本机跑，纯逻辑/源码断言）

| 测试文件（建议名） | 覆盖 | 判定点 |
|---|---|---|
| `tests/rebindWizardState.test.mjs` | 新纯函数模块 `rebindWizardState.ts`：`stage → 界面态`、`code → 界面态`、`canAbandon(describePending)`、`canResume(tx)` | ① 六个 stage 全部映射到 §4.1 表；② `HOST_REBIND_CODES` 每个码都有界面态（用 `HostRebindJournal.ts:105-125` 的词表 **import 后遍历**，新增码自动失败）；③ `warnings` 两个 token 都有文案；④ stage 缺失/未知不改行为；⑤ stage 与逐记录冲突时以计数为准 |
| `tests/rebindI18n.test.mjs` | §6 的键 | ① zh-CN / en-US 键集合相等；② 占位符集合相等；③ 不存在动态拼 key（源码里没有 `rebind.error.${`） |
| `tests/rebindIpcWiring.test.mjs` | 新通道三处同步 | `shared/ipc.ts` 常量存在、`src/main/ipc/*` 有 handler、`preload/index.ts` 有转发；`check:ipc-wiring` 计数随之更新（现有 845 通道门禁，见 UI 统一计划 §7） |
| `tests/repairActionAllowlist.test.mjs` | E2 的契约 | `RemoteHostRepair.diagnose()` 给出的动作集合 ⊆ IPC 允许表 ⊆ `RemoteHostRepairAction` 类型；今天 `rebuild-target-and-rebind` 会被 `remoteHostIpc.ts:52`/`:568` 丢掉，扩表后此断言保证**每个诊断动作都在界面可出现**（这条测试落地时是红的，是它存在的理由） |
| `tests/hostRebindUiGating.test.mjs` | §5 门控 | `enabled=false` ⇒ 每个新 handler 返回 `REMOTE_FEATURE_DISABLED` 且**不触碰**任何文件（对比目录哈希）；`remoteAvailable=false` ⇒ 连接页正则不可见（沿用 `tests/settingsTabLayout.test.mjs` 的源码断言风格） |
| `tests/rebindAbandon.test.mjs` | §3.4 判定 | 只有"全部记录 == before 且 source 未 disabled"才允许；`stage=prepared` 但有一条记录 == after ⇒ **拒绝**（证明不靠 stage） |
| （main 侧，属 coordinator 任务） | plan 冲突矩阵 | `SAME_HOST` / `TARGET_UNVERIFIED` / `TARGET_ANCHOR_UNREADABLE` / `REFERENCE_SCAN_INCOMPLETE` / `ORIGIN_CONFLICT` 各一例；`plan()` **零写**（目录哈希不变） |

已有可复用的护栏（不要重复发明）：`tests/hostRebindJournal.test.mjs`（收敛、崩溃点、锁）、`tests/hostRebindConvergence.test.mjs`、`tests/hostRebindStorePorts.test.mjs`、`tests/hostRebindTxLock.test.mjs`、`tests/remoteHostRepair.test.mjs`、`tests/remoteHostReferenceInterlock.test.mjs`。

### 7.2 必须真机 E2E（`e2e/remoteSessionAcceptance.spec.ts` 或新 spec，凭据走 `PIDECK_E2E_REMOTE_*`，见 `e2e/remote-fixtures.ts:25-34`）

| 用例 | 为什么必须真机 | 判定点 |
|---|---|---|
| 完整 rebind（source→target，两个真实主机） | target 必须真实验证（offer/confirm 需要真握手）；`disable`/`retire` 的 store 语义只有真跑才成立 | ① 结束时 `remote-hosts.json` 里 source 名消失或 `disabled`，`retiredHostIds` 含它；② `projects.json`/`session-catalog.json` 的 ssh locator `hostId == target`；③ 设置页显示"迁移完成"；④ target 能连上并列出项目；⑤ source 行（若保留）显示"已禁用" |
| 迁移后项目可打开、会话历史可读 | 只有真机才证明 helper/root/会话 locator 真的能用 | 打开 target 上的项目 → 文件树出条目；打开一个迁移来的会话 → 历史消息渲染；期间**不出现** `REMOTE_HOST_REFERENCE_REBIND_ACTIVE` |
| 迁移后 trust 需要重新决策 | trustKey 含 hostId，必须真机观察 UI 行为 | 项目页出现 `RemoteSessionTrustNotice` 的 `undecided` 态；决策后再打开不重复提示 |
| host key 变化 → 只读探测判 `SSH_HOST_KEY_MISMATCH`（若采纳 Q6） | 需要一台能改 host key 的机器（重建 `/etc/ssh` 主机密钥或换 known_hosts 内容） | 探测返回 `host-key-changed` 分类；**断言 `ssh-host-keys/` 与 `remote-hosts.json` 哈希未变**（只读） |
| 中断收敛（真机 + 强杀进程） | 崩溃点只有进程被真杀才可信 | 在 `projects-written` 之后杀进程 → 重启 → 横幅出现 → 「继续收敛」→ 最终状态与不中断一致（对齐 `tests/hostRebindJournal.test.mjs:228` 的模型，但这次是真盘） |

### 7.3 窗口外 E2E（Electron，无 SSH，可常态跑）

| 用例 | 判定点 |
|---|---|
| 有 journal 时全机远端 fail closed + 横幅 | 造一个合法 journal（写 `remote-host-rebind.json`）→ 打开应用 → ① 横幅可见 ② 任何远端连接返回 `SSH_HOST_NOT_READY` ③ 项目/会话新增返回 `REMOTE_HOST_REFERENCE_REBIND_ACTIVE` |
| journal 畸形 → 不猜不删 | 写入半截 JSON → 界面显示 `journalInvalid` 态；**断言文件仍存在**（对应 `HostRebindJournal.ts:298-327`） |
| 残留锁（无 journal）→ 横幅 + 清理入口 | 只放 `remote-host-rebind.lock` → 连接失败 + 横幅给出「清理残留迁移锁」；点击后连接恢复（P1 的验收） |
| `remoteAvailable=false` | 连接页不可见，无横幅（`SettingsModal.tsx:654`） |

### 7.4 不写测试的地方（明确登记，避免假覆盖）

- 真实 pin 字节 / fingerprint 的界面呈现：**不测**，因为设计上不让它跨 IPC。
- `rename`/删除项目这类与 rebind 无关的并发路径：由既有 `tests/remoteHostReferenceInterlock.test.mjs` 覆盖，本设计不新增。

## 8. 开放问题（需产品/评审拍板，逐条给推荐）

| # | 问题 | 推荐 | 理由 |
|---|---|---|---|
| **Q1** | rebind 入口只放设置页 + 横幅，够不够？ | **够（MVP 只做这一处）** | 场景是低频维护动作；项目页/面板放入口会诱导在有 journal 时误操作，而那时它们本就 fail closed（F3） |
| **Q2** | 是否提供「放弃未开始的迁移」（§3.4）？ | **提供，但仅由 main 在 tx 锁内证明"零写入"后允许** | 不给的话，一次卡在 `prepared` 的 journal 会永久挡住整机远端（F3）；给的话必须让 stage 不参与判定，否则会删掉一个已迁移一半的事务 |
| **Q3** | 残留 rebind 锁（无 journal）是否新增修复动作（P1）？ | **必须新增** | 今天这是后台无法自愈的可用性死角：`SshVerifiedConnection.ts:38` 拒一切调用，而唯一清理点在 `acquireRebindTxLock`（`HostRebindTxLock.ts:51`），它需要 journal 或一次引用写 |
| **Q4** | 向导里能否直接创建并验证 target？ | **能（复用 `AddHostDialog`），但验证仍走既有 offer/confirm** | 分两步会让用户以为"必须先回设置页加主机"；而 pin/trust 语义一行不改 |
| **Q5** | 执行前是否强制断开 source 的活动连接（§5.5）？ | **强制断开，且不作为用户选项** | tx 一旦开始，pinned 调用全部 `SSH_HOST_NOT_READY`；让用户选等于让他选"要不要看见一堆报错" |
| **Q6** | 是否加只读"探测主机密钥是否变了"（S1）？ | **加，放到阶段 2（MVP 不做）** | 复用 `SshHostPinStore.reverifyRoute`（`SshHostPinStore.ts:126-140`）即可，零写入；但它会让 rebind 之外的连接失败也有了归因，属于独立可交付的小能力 |
| **Q7** | 进度要不要百分比进度条？ | **不要** | 阶段是离散的、记录数在预检后才确定；百分比是编的，而编出来的进度会让"卡住"看起来像"在动" |
| **Q8** | 启动时自动 `resume` 一次？ | **自动一次（无 UI 确认），失败则横幅** | 与架构 §8 Q5 一致：引用迁移与 retire 属自动收敛，只有"降信任/删锚点"需要人工确认；自动一次也是让 F3 的窗口最短 |
| **Q9** | 是否在 UI 里展示逐条 recordId / 项目名清单？ | **MVP 只给计数**（列表放阶段 2） | recordId 跨 IPC 无价值；项目名要给就得新开一条只读通道，属于另一份契约 |
| **Q10** | rebind 后是否自动重放旧 trust 决策？ | **不重放，只提示 + 跳转** | `trustKey` 含 `hostId`（`RemoteProjectTrust.ts:71`），重放等于"把用户对旧机器的授权搬到新机器"，正是 §8 Q2 明确禁止的锚点继承的同型错误 |
| **Q11** | 连续迁移（A→B→C）是否需要"历史"？ | **不做** | `retiredHostIds` 只留 id（`RemoteHostStore.ts:433-455`），要展示历史得改 codec schema（架构 §8 Q3 已建议不做） |
| **Q12** | source 可以是 disabled tombstone 吗？ | **可以**（retired 不行） | tombstone 的引用仍可解析，是"先禁用再迁移"这条既有修复路径的自然延续（架构 §6.2 B）；retired 的 id 已不在 profiles，`SOURCE_MISSING`（`HostRebindConvergence.ts:175`）语义正确 |

---

## 附 A：实现顺序（供后续派工，不是本文的任务）

1. **前置**：P2（`listHostRecords` 只读端口）→ `HostRebindCoordinator.{plan,rebind,resumePendingRebind,describePending}` + `HostRebindHostPort` 生产实现。
2. **前置**：P1（清残留锁动作）+ 修复面板允许表扩到包含 `rebuild-target-and-rebind`。
3. **契约**：`shared/ipc.ts` 四条通道 + `shared/types/remoteHost.ts` 结果类型（只含稳定码/计数/阶段，不含路径/指纹/recordId）。
4. **渲染层**：`rebindWizardState.ts`（纯函数）→ 向导组件 → 横幅 → i18n（zh-CN/en-US + `genZhTwCopy`）。
5. **验证**：§7 的单测与窗口外 E2E 先绿，再上真机。

## 附 B：本文不解决、但必须被看见的问题（登记）

- `REMOTE_HOST_REBIND_ORIGIN_CONFLICT` 今天**只有声明没有产出点**（`HostRebindJournal.ts:117`），`plan()` 落地后才有 `plan` 层用例（架构 §7.1 第 16 项同样指出这一点）。
- `RemoteHostRepair.ts` 仍 500+ 行、未拆分（架构 §7.4 风险 5）；若 P1 把清锁逻辑往里塞，先按该节边界拆。
- `assertNoPendingHostRebind` 把 `.lock` 也当作"有事务"（`SshVerifiedConnection.ts:38`），与本设计 §4.3 的"只有锁"分支是同一件事的两面；若未来把锁语义收窄，这条 UI 分支要一起改。
