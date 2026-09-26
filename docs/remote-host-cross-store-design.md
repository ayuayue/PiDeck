# 远程主机跨 store 事务设计（hostId 引用 × ProjectStore × SessionCatalog）

> 状态：**部分落地**。依赖 Phase 1 脏文件的部分仍是 Proposed（未实现）；「不依赖 Phase 1 脏文件」的切片已实现并提交 `9d0710470` —— §4.1 注册表（`src/main/remote/RemoteHostReferenceRegistry.ts`）、§4.3 journal + tx 锁 + §5.4 收敛算法（原在 `src/main/remote/HostRebindJournal.ts`；`295877d8e` 之后 tx 锁与收敛分别落在 `src/main/remote/HostRebindTxLock.ts` / `src/main/remote/HostRebindConvergence.ts`，见 §7.4 风险 5）、§4.5 修复原语与 `diagnose`（`src/main/remote/RemoteHostRepair.ts`），以及 `RemoteHostStore.ts` 的注册表接入、无 provider fail-closed 对称化与两个 main-only 修复写入口。仍缺 §4.2 的 `HostRebindCoordinator`、§4.4 两个 store 的端口实现、§4.1 引用源的生产实现，且**尚无生产装配**：`src/main/index.ts` 不构造这些模块，唯一的 store 消费方 `SshVerifiedConnection.ts:117`、`:146` 仍是无选项的 `open(userDataDir)`。
>
> 适用工作树：`feat/remote-development`，调研基线 commit `2fd646c3a`（工作树另有 114 项与本任务无关的脏改动，本文只读引用，不评价、不触碰）。
>
> 关联文档：[远程开发实施计划](remote-development-plan.md) §5.2（主机配置与 rebind 约束）、[位置模型 ADR](project-location-architecture.md)。
>
> **标注约定**：本文所有关于现状的陈述都带 `文件:行号`；凡由行号推出、而非代码字面写明的结论，标 **【推断】**；凡代码中查不到、必须由产品/后续调研拍板的，标 **【待确认】**，并在第 8 节汇总。本文不复制大段源码，只用行号 + 一句话概括。
>
> **行号基线**：§1 的现状陈述按调研基线 `2fd646c3a` 取行号；`RemoteHostStore.ts` 在该基线之后净增 188 行（398 → 586 行，来自 §4.1 注册表接入、`isReferenced` 改写、`mutateRepair` 与两个修复写入口），因此该文件的旧行号必须按符号重新定位。凡标注 `当前:` 的行号都取自含 `9d0710470` 的当前工作树。
>
> **模块拆分基线（`295877d8e`）**：`HostRebindJournal.ts` 已从 674 行拆成三个模块 —— `HostRebindJournal.ts`（361 行：端口契约类型、稳定码词表、`canonicalHostLocatorJson`、journal 编解码与文件 I/O、`resume()` 外壳）、`HostRebindTxLock.ts`（155 行：tx 锁 owner/存活判定/抢占）、`HostRebindConvergence.ts`（343 行：`convergeRebindJournal` 全流程，含 `classify` / `applyStore` / roll-forward）。**因此本文里凡指向 `HostRebindJournal.ts` 的旧行号（尤其 §4.2 方法失败语义表、§4.3 的"已落地"注、§5.1 R6、§6.2 C）都按符号重新定位**：§4.2/§4.4/§5.4/§7.1/§7.4 已在本次修订中校正，其余章节的旧行号尚未逐条重取，按符号名搜索即可。

---

## 1. 现状与不变量

### 1.1 参与跨 store 事务的四个持久化实体

| 实体 | 磁盘位置 | 进程内串行化 | 跨进程锁 | revision / CAS | 备份与恢复 | `needs-repair` 停写 |
| --- | --- | --- | --- | --- | --- | --- |
| `RemoteHostStore` profile 目录 | `<userData>/remote-hosts.json`（+`.bak`） | 目录锁文件本身即互斥 | ✅ `remote-hosts.json.lock`，`open("wx",0o600)`：`src/main/remote/RemoteHostStore.ts:356`（当前 `:544`） | ✅ 锁内重读磁盘，比对 `revision` + `profiles`/`retiredHostIds` 的 JSON：同文件 `:364`（当前 `:552`） | `writeDurableJsonFile`（temp→fsync→轮换 `.bak`→rename），备份失败策略 `throw`：`:369`；启动时 primary/backup 取最高有效 revision：`:118-137`（当前 `:190-214`） | ✅ 所有**普通** mutator 首行要求 `status === "ready"`：`:350`（当前 `:538`）；唯一例外是 §4.5 的两个 main-only 修复写入口（`mutateRepair`，当前 `:494-535`，按 reason 白名单） |
| `SshHostPinStore` pin 文件 | `<userData>/ssh-host-keys/<hostId>` | 无（文件级原子发布） | ❌ | ❌ 以 `link()` 发布并天然拒绝覆盖：`src/main/remote/SshHostPinStore.ts:247`、`:251` | 无备份；temp + `fsync` + 硬链接 + 目录 sync：`:238-248` | ✅ 发布前 `assertPinAbsent`：`:51-59`、`:125`、`:128` |
| `ProjectStore` | `<userData>/projects.json`（+`.bak`） | 单条 `writeQueue`：`src/main/projects/ProjectStore.ts:40`、`:456-473` | ❌ | ❌ 只在自己内存 revision 上 `+1` 后写盘，**不比对磁盘**：`:463-465` | `writeDurableJsonFile` + `backupFailurePolicy:"throw"`：`src/main/projects/projectStorePersistence.ts:47-54`；启动取 primary/backup 最高有效 revision：`:26-45`，两者都坏抛 `PROJECT_STORE_NEEDS_REPAIR`：`:34` | ✅ `needsRepair` 时读写都抛：`ProjectStore.ts:420-426` |
| `SessionCatalog` | `<userData>/session-catalog.json`（+`.bak`） | 单条 `writeQueue`：`src/main/sessions/SessionCatalog.ts:392`、`:1499-1517` | ❌ | ❌ 文件 schema **没有 revision 字段**：`:84-89`（只有 `version:1`、`sessions`、`dismissedDshSessionIds`） | 自实现 temp+`.bak`+rename，备份轮换失败只告警不阻断：`:1560-1605` | ✅ `assertWritable`：`:1495-1497` |

**事实**：四个实体中只有 `RemoteHostStore` 有跨进程锁和 CAS；另外两个 store 只有进程内写队列，且 `SessionCatalog` 连 revision 都没有。这是第 5 节锁顺序设计的全部约束来源。

### 1.2 不变量表

| # | 不变量 | 由谁保证 | 证据行号 | 崩溃后的可见状态 |
| --- | --- | --- | --- | --- |
| I1 | profile id 唯一，且 profile 集与 `retiredHostIds` 不重叠 | 编解码器严格校验 | `RemoteHostStoreCodec.ts:126-127` | 快照非法 → 主/备回退；两者都坏 → `needs-repair`（`REMOTE_HOST_SNAPSHOT_INVALID`，`RemoteHostStore.ts:135-136`） |
| I2 | 每次提交 `revision + 1` 且锁内复核 old revision + 内容 | `mutate` | `RemoteHostStore.ts:351`、`:364`、`:367` | 提交前后崩溃：rename 原子 ⇒ 磁盘要么 N 要么 N+1；写后复核失败 ⇒ `REMOTE_HOST_WRITE_UNCERTAIN`（`:375-377`） |
| I3 | 退役前置：profile 已是 disabled tombstone 且无引用 | `retire` | `:247`、`:248` | 未满足即拒绝，磁盘不变（测试：`tests/remoteHostStoreLifecycle.test.mjs:208-226`） |
| I4 | 存在 pin ⇒ 该 id 对应 profile 是 verified，或该 id 已 retired | `pinIssues` | `:76`（retired 豁免）、`:77`（其余视为 `REMOTE_HOST_PIN_ORPHAN`） | `needs-repair`；**没有自动清理路径**（`pruneRetiredPins` 只处理 retired id，`:105-114`） |
| I5 | profile 是 verified ⇒ pin 存在且 sha256 与 fingerprint 都匹配 | `pinIssues` 调 `readPin` | `:79-86`；校验在 `SshHostPinStore.ts:175-177` | `needs-repair`（`REMOTE_HOST_PIN_INVALID`） |
| I6 | verified / disabled profile 的身份字段冻结（比 endpoint 四元组更严） | `updateDraft` 显式拒绝 | `:197` | 改指只能新建 hostId；今天没有 rebind 实现 ⇒ 改指事实上不可完成（见 G2） |
| I7 | `verifiedEndpoint` 与 `verifiedAt` 必须成对出现 | 编解码器 | `RemoteHostStoreCodec.ts:85` | 快照非法 → `needs-repair` |
| I8 | retire 的提交顺序：**先提交快照，再删 pin** | `retire` 代码顺序 | `:257-261`（删除在 `mutate` 返回之后） | 提交成功 + 删 pin 失败 ⇒ 残留 pin；因 I4 的 retired 豁免而仍 `ready`，下次 open/refresh 重试清理 |
| I9 | `needs-repair` 下禁止任何写入；唯一例外是 §4.5 按 reason 白名单的修复写入口 | `mutate` / `offerPin` / `mutateRepair` | `:350`、`:301`（当前 `:538`、`:391`、`:494-535`） | 普通 mutator 抛 `REMOTE_HOST_STORE_NEEDS_REPAIR`（测试：`tests/remoteHostStore.test.mjs:123`、`:135`、`:166`）；修复写入口只允许「锁内新鲜磁盘的全部 reason ⊆ 该原语拥有的那一类」，否则抛同一个码（测试：`tests/remoteHostRepair.test.mjs:304-320`） |
| I10 | `needs-repair` 下禁止任何新的 SSH 调用 | `activeProfile` | `SshVerifiedConnection.ts:29`（status）、`:31`（disabled/无 endpoint）→ `SSH_HOST_NOT_READY` | 已建立的连接不会被主动断开（没有任何 store 订阅机制）**【推断】** |
| I11 | retired id 永久保留、永不复用 | `createDraft` + 编解码器 | `:294`、`RemoteHostStoreCodec.ts:126-127` | 复用尝试抛 `REMOTE_HOST_ID_REUSED` |
| I12 | 备份只能离线查看，绝不能被提升为可写信任 | 备份被选中时必然带 reason → `needs-repair` | `:121-137` + `:350`（测试：`remoteHostStore.test.mjs:126-137`、`:170-182`） | 只读，任何 mutator 拒绝 |
| I13 | **今天 `projects.json` 里不可能出现 ssh locator** | `readV2Project` 显式拒绝 | `projectStoreCodec.ts:81`（`PROJECT_STORE_REMOTE_UNSUPPORTED`）；`encode` 只产出 local locator：`:48-52` | 读到 ssh 项目 ⇒ 整个 store 加载失败并 `needs-repair`（`ProjectStore.ts:51-58`）。这是一条 **Phase 3 开关**，不是永久不变量 |
| I14 | `SessionCatalog` 接受并原样保存 ssh locator，但任何文件/运行路径都拒绝它 | 读侧白名单 vs 路由层 fail closed | 接受：`SessionCatalog.ts:266-274`、`:1538-1541`；清除本地字段：`:293-299`；拒绝：`SessionLocatorRouter.ts:15`、`SessionRuntimeCoordinator.ts:960`、`:1269` | ssh 条目可持久存在但不可 attach/执行；今天没有任何写入者（见 1.6） |
| I15 | 主机目录锁没有 owner 信息（创建后从不写入内容） | `open(lockPath,"wx",0o600)` 后只 close/unlink | `RemoteHostStore.ts:356`、`:388-395` | 进程崩溃遗留的锁文件 ⇒ 启动即 `needs-repair`（`REMOTE_HOST_LOCK_PRESENT`，`:94-95`）且 mutator 抛 `REMOTE_HOST_STORE_BUSY`（`:358`）；**只能人工删锁**（G5） |

### 1.3 引用提供者的确切形状与失败语义

- 形状（唯一出处）：`export type RemoteHostReferences = { referencedHostIds(): Promise<ReadonlySet<string>> }` —— `src/main/remote/RemoteHostStore.ts:14`（当前 `:15`）。
- 注入点：`static open(userDataDir, { pinStore?, references?, referenceRegistry? })` —— `:158`（当前 `:232`，新增 `referenceRegistry` 供 §4.1 注册表接入），构造函数保存于 `:150-155`（当前 `:224-230`）。
- 查询点只有两处，都在**目录锁内**执行：
  1. `updateDraft` → `:201`（`REMOTE_HOST_REFERENCED`；当前 `:279`）；
  2. `retire` 的 change 回调 → `:248`（`REMOTE_HOST_REFERENCED`；当前 `:326`）。
  两者都经由 `private isReferenced()`：`:265-269`（当前 `:343-359`）。
- 失败语义（设计补的洞 vs `9d0710470` 已落地的部分）：
  - **无 provider**：`retire` 在进入锁之前显式抛 `REMOTE_HOST_REFERENCES_UNAVAILABLE`：`:243`（当前 `:321`）；`updateDraft` 基线时不会（`isReferenced` 无 provider 返回 `false`，基线 `:266`），**当前已改成显式拒绝**（`updateDraft` 当前 `:272`、`isReferenced` 当前 `:345`）—— 即 fail-open 已修正为与 `retire` 对称的 fail-closed（测试：`tests/remoteHostStoreLifecycle.test.mjs:270-302`）。
  - **注册表视图是惰性的**：`referenceRegistry` 经 `resolveReferences`（当前 `:92-103`）包成 store 需要的窄接口，`open()` 不读注册表，§4.1 的 `REMOTE_HOST_REFERENCE_SOURCE_MISSING` / `_SCAN_INCOMPLETE` 都在**首次查询**时才出现；同时传 `references` 与 `referenceRegistry` 视为装配歧义，`open()` 直接抛 `REMOTE_HOST_REFERENCES_UNAVAILABLE`（当前 `:94`）。
  - **provider 抛错**：基线时异常直接冒泡、调用方拿到 provider 自己的错误对象（**没有稳定码**）；**当前有稳定码**：注册表码（`REMOTE_HOST_REFERENCE_*`）原样透出，其余一律折叠成 `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`（当前 `:353-355`），errno 与 provider 文本不再跨边界。
  - **无法表达"扫描不完整"**：已由 §4.1 的 `complete` 补上（`RemoteHostReferenceRegistry.ts:29-47`）；接口返回值仍只有 `ReadonlySet<string>`，所以「一个 store 读不出来」在 store 侧只能靠抛错表达。一旦实现者图省事 `catch` 后返回空集，就会静默变成「无引用」→ 硬删仍被引用的主机。**【推断】这是本设计里最危险的失败模式**，见 G1。
- **今天仍然没有任何生产路径注入 references**：全仓库对 `RemoteHostStore` 的使用只有 `SshVerifiedConnection.ts:117` 与 `:146`（两次 `open(userDataDir)`，都不传 options），其余全在 `tests/remoteHostStore*.test.mjs`；注册表 / journal / 修复模块同样没有生产构造点（`src/main/index.ts` 未装配）。**⇒ 生产代码里 `retire` 与 `updateDraft` 都必然抛 `REMOTE_HOST_REFERENCES_UNAVAILABLE`**；同时也没有任何生产 mutator（`disable/retire/offerPin/confirmPin/updateDraft` 都只在测试里被调用）。**【推断】** 因此本文描述的跨 store 事务是"从零加装配"，而不是改造既有调用链。

### 1.4 `needs-repair` 的全部触发条件与可用恢复动作

`loadState` 汇总所有 reason 并去重，`status = reasons.length ? "needs-repair" : "ready"`（`RemoteHostStore.ts:138-139`）。

| reason | 触发条件 | 证据 |
| --- | --- | --- |
| `REMOTE_HOST_SNAPSHOT_INVALID` | primary 与 backup 都不可读/非法（且至少有一个存在） | `:135-136` |
| `REMOTE_HOST_PRIMARY_INVALID` / `REMOTE_HOST_PRIMARY_MISSING` | primary 坏/缺，改用 backup | `:132-134` |
| `REMOTE_HOST_BACKUP_INVALID` | primary 有效但 backup 不可读 | `:129-131` |
| `REMOTE_HOST_BACKUP_SELECTED` | backup revision 更高，改用 backup | `:121-124` |
| `REMOTE_HOST_SNAPSHOT_CONFLICT` | primary 与 backup revision 相同但内容不同 | `:127` |
| `REMOTE_HOST_PIN_ORPHAN` | `ssh-host-keys/` 非目录或符号链接 ⇒ 直接返回（`:63`）；条目数 > 2000（`:65`）；pin 名对应的 id 既不是 verified profile 也不是 retired id（`:77`）；无 profile 的同名 pin（`:77`） | `:57-78` |
| `REMOTE_HOST_PIN_INVALID` | `ssh-host-keys/` 目录 `lstat` 非 ENOENT 失败（`:67`）；verified profile 的 `readPin` 抛错（`:84`） | `:67`、`:79-86` |
| `REMOTE_HOST_LOCK_PRESENT` | `lstat(remote-hosts.json.lock)` 成功 | `:93-95`；另在 mutator 收尾解锁失败时也会被打上（`:393`） |
| `REMOTE_HOST_LOCK_UNREADABLE` | 锁文件 `lstat` 非 ENOENT 失败 | `:97-100` |
| `REMOTE_HOST_WRITE_UNCERTAIN` | 写盘已开始后抛出（含写后复核失败） | `:374-377` |
| `REMOTE_HOST_STATE_UNCERTAIN` | pending activation 路径下，重新读盘本身失败 | `:379-386` |

`refresh()` 的确切行为（`:172-178`）：重新 `loadState`（**不传 `pendingActivationHostId`**）→ `applyLockCheck` → `pruneRetiredPins` → 替换内存快照并返回。**它不写 profile，不碰 pin（只删 retired id 的残留 pin）**。因此：

- ✅ 能修：外部持锁者已退出后的 `REMOTE_HOST_LOCK_PRESENT`（测试：`tests/remoteHostStoreLifecycle.test.mjs:186-197`）；retired id 的残留 pin（`:176-184`，走 `pruneRetiredPins`）。
- ❌ 修不好（refresh 只会重算同样的 reason）：
  1. **失败激活留下的孤儿 pin**：`pinIssues` 只在传入 `pendingActivationHostId` 时容忍（`:73`；当前 `:147`），而 `refresh()` 不传 ⇒ 永远 `REMOTE_HOST_PIN_ORPHAN`。测试 `tests/remoteHostStore.test.mjs:105-124` 固化了这个状态。**且该实例会被彻底锁死**：`offerPin` 要求 `status === "ready"`（`:301`；当前 `:391`），`mutate` 同样（`:350`；当前 `:538`）⇒ 既不能重新 offer/confirm（`assertPinAbsent` 也会拒绝，`SshHostPinStore.ts:125`），也不能 retire/disable。**唯一出路是 §6.2 A 的修复原语**（A1 用已发布 pin 完成激活，或 A2 删除这个从未被验证的孤儿 pin），不再需要人工删文件（基线时的手段，已由 `9d0710470` 取代）。
  2. **verified profile 的 pin 丢失或被篡改**：refresh 报同样的 `REMOTE_HOST_PIN_INVALID`；而且因为是 store 级 `needs-repair`，**同一 store 里其它主机也全部变成只读**（`:350`）。这是 G6。
  3. **快照双坏 / 版本未知**：`REMOTE_HOST_SNAPSHOT_INVALID` 无法通过 refresh 消除。
  4. **`REMOTE_HOST_WRITE_UNCERTAIN`**：refresh 会按磁盘实际内容重算——若那次 rename 未落地，会"退回"到旧 revision 并显示 `ready`（**静默丢失一次未确认写入**，因为调用方只拿到过异常）**【推断】**；若落地了，则 revision 前进。两者都要求调用方**先 refresh 再判断结果**，不能假定失败。
  5. **锁文件权限问题导致的 `REMOTE_HOST_LOCK_UNREADABLE`**：要修文件系统权限，refresh 无用。

### 1.5 pin 与 profile 的提交顺序，以及两个崩溃点

- 顺序：`retire` = `mutate`（提交快照：移除 profile + 追加 retired id，`:250`）→ 返回后 `deletePin`（`:257-261`，异常被吞）。`confirmPin` = `pinStore.answer()` 先发布 pin（`SshHostPinStore.ts:167`）→ 锁内 `readPin` 复核（`RemoteHostStore.ts:321-325`）→ 提交 `verifiedEndpoint`（`:327-333`）。
- **崩溃点 A「提交成功但删 pin 失败」**：profile 已消失、id 在 `retiredHostIds`、pin 文件残留。可见状态 = `ready`（I4 的 retired 豁免），残留物由 `pruneRetiredPins` 在下一次 open/refresh 重试（`:105-114`，`deletePin` 缺失时整个清理被跳过，`:106`）。**注意**：若删除持续失败（权限/占用），残留 pin 会长期存在且**没有任何告警**（错误被吞，`:110-112`）。
- **崩溃点 B「删 pin 成功但提交失败」**：**按当前代码不可达**——`deletePin` 严格在提交返回之后。等价的真实风险是反向命名的那一个：**`confirmPin` 中 pin 已发布、快照未提交**（进程崩溃或 `readPin` 复核失败）⇒ 留下"draft profile + 已发布 pin"，下次启动即 `needs-repair`（`:77`），且如 1.4 所述**无法自愈**。
- 还有一个必须写进设计的事实：`mutate` 的收尾 `finally` 里解锁失败会**在提交已成功的情况下抛出** `REMOTE_HOST_STORE_NEEDS_REPAIR` 并把状态打成 `REMOTE_HOST_LOCK_PRESENT`（`:388-395`）。⇒ **"抛异常"不等于"未提交"**，所有协调层都必须按"未知结果"处理并重新读盘。

### 1.6 谁在引用主机（grep 证据）

对持久化结构里 `hostId` 字段的全量核查（`grep hostId src/shared` 只有 4 处命中，无第五处）：

| 持久化结构 | 是否含 hostId | 读 | 写 | 证据 |
| --- | --- | --- | --- | --- |
| `Project`（`projects.json` v2 `locator`） | 类型上有：`ProjectLocator` ssh 分支 | `readProjectLocator` 能解析 ssh（`projectStoreCodec.ts:119-121`），但上一层的 `readV2Project` 直接拒绝（`:81`） | `encode` 只写 local（`:48-52`）；内存 `Project` 类型根本没有 hostId（`shared/types/project.ts:19-42`） | `shared/types/project.ts:3`、`:5`；`projectStoreCodec.ts:81` |
| `SessionCatalogEntry.locator`（`session-catalog.json`） | ✅ `SessionLocator` ssh 分支 | 白名单接受：`SessionCatalog.ts:266-274`、`:1538-1541`；读出时清掉本地字段：`:293-299`；`recordFromEntry` 对 ssh 置空 filePath/projectPath 等：`:1414`、`:1424-1430` | **没有任何写入者**：全仓库没有构造 `{kind:"ssh"}` 的 locator；`SessionLocatorRouter` 对 ssh 抛错（`:15`），`SessionRuntimeCoordinator` 全线拒绝 ssh（`:362`、`:371`、`:908`、`:952`、`:960`、`:1269`、`:1405`、`:1569`、`:1738`、`:1755`） | `shared/types/session.ts:108` |
| `settings`（`SettingsStore`） | ❌ 完全没有 host/ssh 字段 | — | — | `grep host\|ssh src/main/settings` 只命中代理 bypass、DSH host 等无关项（`SettingsStore.ts:168`、`:173`、`:252`、`:255`） |
| `TerminalTarget` / `TerminalSessionManager` | ❌ 无 hostId | — | — | `grep hostId src/shared` 无 terminal 命中 |
| `remote-hosts.json` | profile 自身 | `RemoteHostStore` | `RemoteHostStore` | — |
| 连接状态机 / 诊断（`RemoteHostConnectionState.ts:28`、`RemoteHostConnectionTypes.ts:18`） | 运行期字段 | — | — | 不持久化（`src/main/remote` 下唯一的持久化写入是 profile 与 pin，见 1.1） |

**结论（事实）**：今天唯一"能"持久化 hostId 引用的结构是 `SessionCatalog`，而它没有写入者；`ProjectStore` 连读都不允许。**结论（推断）**：现在把 `referencedHostIds()` 实现成"只扫 session catalog"在当下是**完备的**，但只要 Phase 3 打开 `PROJECT_STORE_REMOTE_UNSUPPORTED`（`projectStoreCodec.ts:81`），它立刻变成**不完备**，`retire` 就会硬删仍被项目引用的主机。这决定了第 4 节必须用"注册式引用源 + 契约测试"而不是"手写一个 union 函数"。

补充：现存的跨 store 编排是**顺序调用、无事务**，且吞掉第二段的错误——删除项目时 `projectStore.remove(id)` → `sessionCatalog.removeByProjectId(projectId).catch(() => 0)`（`src/main/ipc/projectsIpc.ts:102-108`；同型代码在 `src/main/index.ts:3667-3670`）。**这是"跨 store 事务"最直接的模板反面**：第一步成功、第二步失败，则 catalog 永远留着已删项目的会话引用。

### 1.7 与任务背景描述的差异（已核对）

| 背景描述 | 实际 | 证据 |
| --- | --- | --- |
| `RemoteHostStoreReferences` | 实际类型名是 **`RemoteHostReferences`**（计划文档 `docs/remote-development-plan.md:701` 曾用旧名，属文档漂移；`9d0710470` 已把该处改写为 `RemoteHostReferences`） | `RemoteHostStore.ts:14`（当前 `:15`） |
| "`retire` 要求显式注入 references、对象已是 disabled tombstone、引用为空" | ✅ 全部成立，**另有一条容易漏掉的前置**：`typeof pinStore.deletePin !== "function"` ⇒ `REMOTE_HOST_PIN_CLEANUP_FAILED` | `:243`、`:244`、`:247`、`:248` |
| "成功时先提交快照再删 pin" | ✅ | `:250`、`:257-261` |
| "已退役 id 的残留 pin 由加载器容忍并在下次 open 清理" | ✅，且 `refresh()` 也会清理；清理是 best-effort 且错误被吞、不告警 | `:163`、`:175`、`:105-114` |
| "`refresh()` 是恢复路径" | 部分成立：只覆盖持锁与 retired pin 两类；**对孤儿 pin、丢失的 verified pin、双坏快照无效** | `:172-178`、`:73`、`:79-86` |
| "锁存在时进 `needs-repair`" | ✅，且此时 mutator 抛的是另一个码 `REMOTE_HOST_STORE_BUSY`（不是 `items needs-repair`） | `:94-95`、`:358` |
| 计划文档 §5.2 期望"所有会新增/删除/迁移引用的 mutator 都必须先取得同一份跨进程持久锁" | **今天做不到**：`ProjectStore`/`SessionCatalog` 没有跨进程锁也没有磁盘 CAS（1.1），要落实这条需要给它们加锁或改设计（见 5.3） | `docs/remote-development-plan.md:255`；1.1 各行号 |
| `src/shared/types/remote.ts` 与 `src/main/remote/HostRebindCoordinator.ts` | 计划文档列为新增模块，**两者都还不存在**（`src/shared/types/remote.ts` 缺失；remote 目录下无 `HostRebindCoordinator.ts`） | `docs/remote-development-plan.md:275`、`:282`；目录清单 |

---

## 2. 缺口

**G1｜引用集合可能是"漏报"的，而 `retire` 会据此硬删。**
`referencedHostIds()` 只返回一个集合（`RemoteHostStore.ts:14`），无法表达"某个引用源读不出来"。今天的引用源只有 session catalog，明天会多出 ProjectStore（`projectStoreCodec.ts:81` 一放开）以及任何新加的持久化 hostId 字段。没有强制登记机制时，漏一个就静默删除仍被引用的主机（`retire` 只查 `ids.has()`，`:267-268`）。

**G2｜已验证档案无法改指，也没有 rebind 可用。**
`updateDraft` 对 verified/disabled 一律拒绝（`:197`），而 rebind 协调器不存在（1.7 末行）。用户面前只有两条路：新建一个 hostId 然后手工重建项目/会话引用（会同时踩 G3/G4），或者放弃。计划里"改指必须新建 + 显式 rebind"的闭环（`docs/remote-development-plan.md:247`）目前只有前半句。

**G3｜跨两个 store 的中途崩溃没有任何恢复物。**
现存最接近的编排（删项目 → 删会话，`projectsIpc.ts:102-108`）是"先 A 后 B、B 失败被吞"。rebind 需要的是：projects 写了、sessions 没写，进程就崩了——重启后没有任何记录能告诉我们要不要继续、继续到哪一步。没有 journal 时，唯一的判据是"引用里一部分指 source、一部分指 target"，而**这种状态本身是合法的**（见 5.4），所以无法与"用户本来就这么配的"区分。

**G4｜引用迁移与并发写者的交错没有被排除。**
`ProjectStore.save()` 用内存 revision `+1` 直接写盘（`ProjectStore.ts:463-465`），不复核磁盘；`SessionCatalog` 连 revision 都没有（`:84-89`）。另一个 PiDeck 实例（不同版本可并行，见 `AGENTS.md`）或同进程的普通 mutator 可能在 rebind 的"扫描→写引用"之间把项目/会话写回旧状态，使"迁移完成"这一判断失效；最坏情况是在 `retire` 之后才出现一条指向已退役 id 的新引用——这正是 I4/目标不变量要禁止的状态。

**G5｜主机锁没有 owner，崩溃后锁死且没有安全的自动回收依据。**
锁文件创建后从不写入内容（`:356`），所以无法区分"另一个活着的实例在写"与"上次崩溃留下的空文件"。当前设计直接把两种情况都判成 `needs-repair`（`:94-95`），并把 mutator 打成 `REMOTE_HOST_STORE_BUSY`（`:358`）。人工删锁是目前唯一出路，而删锁本身没有可核对的前置条件。

**G6｜单点损坏把整个 store 变成只读，且管理面没有出口。**
任一 verified profile 的 pin 丢失/被篡改 ⇒ 整 store `needs-repair`（`:79-86`、`:139`）⇒ 所有 mutator 拒绝（`:350`），包括对**其它健康主机**的 disable/retire。修复路径又要求写权限，形成闭环死锁：（正确做法）"新建 hostId 重新确认 + rebind + 退役坏档案"里的最后一步 `retire` 需要 store 可写，而 store 因为坏档案不可写。今天没有任何"只针对单个 hostId 的修复原语"。

**G7｜`needs-repair` 的人工修复没有明确允许/禁止清单，容易把"修好"做成"删掉信任锚"。**
最诱人的错误修复是"删 pin 让 store 变 ready"：对 verified profile 这是永久销毁信任锚；对 draft profile 留下的孤儿 pin 反而是唯一出路（1.4）。两者外观相同（都是 `ssh-host-keys/<hostId>`），当前没有任何 API 或诊断能把它们分开——只能靠人肉读 `remote-hosts.json` 判断。

**G8｜失败结果的可见性不足。**
`mutate` 在提交成功但解锁失败时抛 `REMOTE_HOST_STORE_NEEDS_REPAIR`（`:388-395`），在写盘不确定时抛同一码（`:375-377`）；provider 抛错时透传任意错误。调用方无法区分"没写成 / 写成了但状态未知 / 校验失败"，而跨 store 事务必须能区分，否则收敛算法会在错误的前提上运行。

---

## 3. 目标不变量（可被测试断言）

> 这些是断言式陈述，每条都能写成一个 `node --test` 用例（第 7.2 节给建议）。

- **INV-1（引用完整性）** 任何时刻磁盘上都不存在"引用存在但档案已删"：对每个 `projects.json` / `session-catalog.json` 中的 ssh locator，其 `hostId` 必须要么是 `remote-hosts.json` 里的 profile，要么在 `retiredHostIds` 中，且后者只允许出现在 tx 已完成（stage=`committed`）或未开始的状态里（禁止中间态）。
- **INV-2（退役前置）** `retire` 提交的那一刻，引用扫描结果必须是"完整且为空"；扫描不完整（任一引用源读失败）时**必须拒绝退役**，而不是当成空集。
- **INV-3（信任不继承）** 任何 rebind 都不得把 source 的 `verifiedEndpoint`、`hostKeyFingerprints`、`routeDigest`、`knownHostsSha256` 或 pin 字节复制给 target；target 必须是**独立完成过 offer/confirm** 的 verified profile，且其 pin 在 tx 开始时通过 `readPin` 校验。
- **INV-4（唯一信任锚）** 崩溃收敛过程中任何一步都不得删除 target 的 pin，也不得删除任何"仍被 profile 声明为 verified"的 pin；唯一允许的 pin 删除是 (a) `retire` 提交之后的 source pin 清理，(b) 明确的人工修复原语在 human confirmation 下删除"无 profile 认领的孤儿 pin"。
- **INV-5（幂等收敛）** 从任意崩溃点重启，`resumePendingRebind()` 反复执行任意次的结果必须相同，且最终落到 INV-1 允许的某个状态；不得用内存快照覆盖磁盘上更新的数据（每条记录按 journal 记录的 `beforeLocator` 做逐记录 CAS）。
- **INV-6（不复活）** 收敛过程发现 journal 记录的某条目标记录已不存在时，**不得重建**该记录，必须停在可诊断的 `needs-repair`。
- **INV-7（无静默信任）** 任何修复/收敛路径都不得写入或修改 `verifiedEndpoint`；唯一允许的"降信任"动作是显式人工原语把某 profile 降级为无 endpoint 的 disabled tombstone（`forgetTrustAnchor`），且必须 human confirmation + 该 profile 的 pin 不可用。
- **INV-8（退役不可逆）** `retiredHostIds` 只增不减；不存在"复活已退役 hostId"的 API；新引用永远不得指向 retired id（写入侧拒绝并返回稳定码）。
- **INV-9（阶段原子性）** 每个 store 阶段用**一次** store 写完成（单文件原子替换），因此阶段内部没有可观测的中间态；阶段之间才需要 journal。
- **INV-10（失败可区分）** 跨 store 事务的每个失败出口都返回稳定码，且明确区分"未写入 / 已提交但结果未知 / 校验失败 / 需要人工修复"四类。
- **INV-11（引用源完备性）** 每个持久化 hostId 字段都必须归属于一个已登记的引用源；新增未登记字段时契约测试必须失败（不许靠 code review 兜）。
- **INV-12（连接门）** `needs-repair`、pending journal、或 tx 进行中时，任何新的 SSH 调用都必须以稳定码失败（现状已隐式满足 `SSH_HOST_NOT_READY`，需要显式断言）。

---

## 4. 接口设计（契约，不含实现）

### 4.1 引用提供者（替换现有 `RemoteHostReferences`）

```ts
/** 一个引用源的分类，仅用于诊断与审计。 */
export type RemoteHostReferenceSource = "projects" | "sessions" | "host-profiles" | "runtime";

export type RemoteHostReferenceHit = {
	readonly source: RemoteHostReferenceSource;
	/**
	 * 记录 id（projectId / sessionId / hostId），只用于报告、审计与逐记录 CAS，不用于展示路径。
	 * **hit 不携带 hostId**（当前 `RemoteHostReferenceRegistry.ts:23-27`）：它无法回答"这条记录引用的是哪台主机"，
	 * 所以 rebind 的记录集**只能由 store 端口给出**（§4.4 `readHostRecordLocators`）；provider 多返回的字段会被丢弃（`:114-117`）。
	 */
	readonly recordId: string;
};

export type RemoteHostReferenceScan = {
	/** 所有被引用的 hostId（保守超集：宁可多报，不可漏报）。 */
	readonly referencedHostIds: ReadonlySet<string>;
	/** 命中明细，供人工修复报告与审计；**不用于生成 rebind 记录集**（没有 hostId，见上）。 */
	readonly hits: readonly RemoteHostReferenceHit[];
	/**
	 * false = 至少一个引用源未能完整读取（文件损坏、needs-repair、超时、未知 schema），或**一个源都没注册**。
	 * 调用方在 complete=false 时**必须**按"可能仍被引用"处理。
	 */
	readonly complete: boolean;
	/** 未读取成功的来源，用于稳定码与诊断。注意：零注册源时它是空的，所以**不能只看它**。 */
	readonly unavailable: readonly RemoteHostReferenceSource[];
};

export type RemoteHostReferenceProvider = {
	scan(): Promise<RemoteHostReferenceScan>;
	/** 一个源可声明自己"结构性不可能有引用"（例如 Phase 3 之前的 ProjectStore），避免误报 complete=false。 */
	readonly capability?: { readonly canHoldHostReferences: boolean };
};

export type RemoteHostReferenceRegistry = {
	/** 重复注册同一 source ⇒ `REMOTE_HOST_REFERENCE_SOURCE_DUPLICATE`（替换会静默丢掉前一个源的引用）；非法源/非 provider ⇒ `_SOURCE_INVALID`：`RemoteHostReferenceRegistry.ts:131-136`。 */
	register(source: RemoteHostReferenceSource, provider: RemoteHostReferenceProvider): void;
	/** 已登记的源，按登记顺序：`:138-140`。 */
	registeredSources(): readonly RemoteHostReferenceSource[];
	/** 并发扫描所有来源并按 hostId 取并集；任一源抛错 / 自报不完整 / 返回形状非法 ⇒ complete=false 且该源进入 unavailable（`scan()` 本身不抛）：`:148-183`。 */
	scan(): Promise<RemoteHostReferenceScan>;
	/** 单主机判定：扫描不完整时 `referenced` 恒为 `true`（安全答案不能因为调用方只看 referenced 而丢失）：`:190-193`。 */
	isReferenced(hostId: string): Promise<{ readonly referenced: boolean; readonly complete: boolean }>;
	/** 供 RemoteHostStore 注入用的兼容视图：complete=false 时抛 REFERENCE_SCAN_INCOMPLETE（fail closed）。 */
	asStoreReferences(): RemoteHostReferences;
};
```

> **已落地词汇**（`9d0710470`）：本模块自有稳定码只有五个 —— `HOST_REFERENCE_REGISTRY_CODES`（`RemoteHostReferenceRegistry.ts:53`）= `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE` / `_SOURCE_MISSING` / `_SOURCE_INVALID` / `_SOURCE_DUPLICATE` / `_SCAN_INVALID`；`isHostReferenceRegistryCode()`（`:60-62`）供 `RemoteHostStore` 与 journal 判定"这个码属于注册表，可以原样透出"。

**失败语义（稳定码）**

| 情形 | 结果 |
| --- | --- |
| 某源抛错 / 超时 / 读不出 | `scan()` 本身不抛，返回 `complete=false` + `unavailable[]`；**已读到的 id 仍进入并集**（部分答案仍是保守超集，`:163-175`） |
| 某源返回形状非法（缺 `hits`/`complete`、id 非法或超长） | 整源按"不可读"处理（`REMOTE_HOST_REFERENCE_SCAN_INVALID` → 进 `unavailable`），**绝不降级成空集**（`:110-119`；测试：`tests/remoteHostReferenceRegistry.test.mjs:167`） |
| **零注册源** | `scan()` **不抛**：返回 `complete=false`，且 `unavailable` 为**空数组**（`:180`）⇒ 调用方必须看 `complete`，不能只看 `unavailable`（测试：`tests/remoteHostReferenceRegistry.test.mjs:84`） |
| `complete=false` 时调用 `retire`/`updateDraft` | `asStoreReferences()` 返回的 `referencedHostIds()` 抛 `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`（`:199-210`），store 原样透出同码（当前 `RemoteHostStore.ts:353-355`）；替换基线里透传的任意错误 |
| 未注册任何源 | `asStoreReferences()` **同步抛** `REMOTE_HOST_REFERENCE_SOURCE_MISSING`（`:200`），并在每次 `referencedHostIds()` 调用内重复检查（`:204`，store 可能持有这个视图整个生命周期）；**store 侧的惰性视图把同码推迟到首次查询** —— `open()` 不因此失败，`updateDraft`/`retire` 才失败（`RemoteHostStore.ts:92-103`；测试：`tests/remoteHostStoreLifecycle.test.mjs:280-282`） |
| 某源声明 `canHoldHostReferences=false` | 该源跳过且不影响 `complete`；一旦该源真的出现 hostId（由契约测试发现），实现方必须改回 true（`:152`、`:164`；测试：`tests/remoteHostReferenceRegistry.test.mjs:98`） |

> 与现状的差异：现有接口 `RemoteHostReferences`（`RemoteHostStore.ts:14`，当前 `:15`）没有 complete 概念。本设计把"无 provider"和"扫描不完整"都变成硬失败 —— **已落地**：无 provider 时 `updateDraft` 也硬失败（当前 `:272`），`retire` 与 `updateDraft` 对称（§1.3）。

### 4.2 跨 store 事务协调器

```ts
export type RebindRequest = {
	/** 被迁移的（旧）端点身份；允许是 disabled tombstone，允许其 pin 已不可用。 */
	readonly sourceHostId: string;
	/** 新端点身份；必须已 verified 且 pin 可读（INV-3）。 */
	readonly targetHostId: string;
	/** 调用方持有的主机目录 revision，仅用于提前拒绝明显过期的请求。 */
	readonly expectedHostRevision: number;
	/** 高风险确认（PendingConfirmationBroker 的 requestId），绑定 source/target/记录集 digest。 */
	readonly confirmationRequestId: string;
};

export type RebindPlan = {
	readonly txId: string;
	readonly projects: readonly RebindRecordPlan[]; // store: "projects"
	readonly sessions: readonly RebindRecordPlan[]; // store: "sessions"
	/** 计划阶段即被拒绝的冲突（例如 target 上已存在同一远端会话）。 */
	readonly warnings: readonly string[];
};

export type RebindRecordPlan = {
	readonly store: "projects" | "sessions";
	readonly recordId: string;
	/** 记录当前 locator 的规范 JSON；逐记录 CAS 的期望值。 */
	readonly beforeLocator: string;
	/** 迁移后的 locator 规范 JSON；除 hostId 外必须与 before 完全一致。 */
	readonly afterLocator: string;
};

/**
 * 终态码：**只覆盖"已收敛"两态**（`HostRebindJournal.ts:122-123`）。
 * 失败出口**不返回 outcome**，一律抛稳定码（`HOST_REBIND_CODES`，见下表）—— 这就是 INV-10 要求的可区分性。
 */
export type RebindOutcomeCode = "REMOTE_HOST_REBIND_COMMITTED" | "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS";

export type RebindOutcome = {
	/** 终态分类（INV-10）：有非致命遗留时是 `..._COMMITTED_WITH_WARNINGS`；由 warnings.length 推导，不是独立写入的字段（`:541-551`）。 */
	readonly code: RebindOutcomeCode;
	readonly txId: string;
	readonly stage: RebindStage; // 见 4.3
	readonly migratedProjects: number;
	readonly migratedSessions: number;
	readonly sourceRetired: boolean;
	/**
	 * 需要人工处理但事务已收敛（例如 journal 删除失败）——不是错误。
	 * **承载方式是稳定 token 数组**，取值只来自 `HOST_REBIND_WARNING_CODES`（`:118`），当前恰好两个：
	 * `UNKNOWN_OUTCOME_ROLLED_FORWARD`（store 写抛错但磁盘证明效果已落地，`:509-530`）与
	 * `JOURNAL_REMOVE_FAILED`（journal 删除失败，`:532-539`）；不是自由文本、不是 errno。
	 */
	readonly warnings: readonly string[];
};

export type HostRebindCoordinator = {
	/** 只读预检 + 生成计划（含引用扫描、冲突检查、target 锚点校验）；不写任何 store。 */
	plan(request: Omit<RebindRequest, "confirmationRequestId">): Promise<RebindPlan>;
	/** 执行：写 journal → 逐阶段推进 → 收敛。可重入；已在进行的 tx 会返回同一个结果或稳定码。 */
	rebind(request: RebindRequest): Promise<RebindOutcome>;
	/** 启动时（暴露任何 store 之前）调用；无 journal 时是 no-op。 */
	resumePendingRebind(): Promise<RebindOutcome | undefined>;
	/** 供人工修复使用：当前诊断摘要（含 journal 阶段、待迁移记录、遗留 pin、锁状态）。 */
	describePending(): Promise<RebindDiagnosis | undefined>;
};
```

> **命名与落地**：本节 `HostRebindCoordinator` 仍是设计契约（**未实现**，§7.1 第 3 项）。`9d0710470` 落地的收敛入口叫 `HostRebindJournal.resume(ports): Promise<RebindOutcome | undefined>`（`HostRebindJournal.ts:350-360`，`295877d8e` 后取锁即转交 `HostRebindConvergence.ts:160` 的 `convergeRebindJournal`）：无 journal、或 tx 锁被**活着的**持有者占用时返回 `undefined`（R4 的"看到锁就退让"）；`resumePendingRebind()` 只是协调器将来对它的包装。端口形状见 §4.4。

**方法失败语义**

| 方法 | 稳定码 | 语义 |
| --- | --- | --- |
| `plan` | `REMOTE_HOST_REBIND_SOURCE_MISSING` / `_TARGET_MISSING` | source 不在 profiles（可能已 retired）；target 不存在 |
| `plan` | `REMOTE_HOST_REBIND_TARGET_UNVERIFIED` / `_TARGET_ANCHOR_UNREADABLE` | target 无 `verifiedEndpoint`；或其 pin 读不出/不匹配（INV-3） |
| `plan` | `REMOTE_HOST_REBIND_SAME_HOST` | source === target |
| `plan` | `REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE` | 引用扫描不完整（不完整⇒不允许开始） |
| `plan` | `REMOTE_HOST_REBIND_ORIGIN_CONFLICT` | 迁移会在 target 上产生重复 origin（同 `(hostId, remotePath/remoteSessionId)` 已存在另一条 stable id） |
| `plan` | `PROJECT_STORE_NEEDS_REPAIR` / `SESSION_CATALOG_NEEDS_REPAIR` / `REMOTE_HOST_STORE_NEEDS_REPAIR` | 任一参与方处于 needs-repair：先修复，不开始新事务 |
| `rebind` | `REMOTE_HOST_REBIND_JOURNAL_PRESENT` | 已有未收敛 tx（必须先 `resumePendingRebind`）；**不自动覆盖** |
| `rebind` | `REMOTE_HOST_REBIND_TX_BUSY` | 另一进程持有 tx 锁 |
| `rebind` | `REMOTE_HOST_REBIND_STALE_PLAN` | 任一记录 locator 既不等于 `beforeLocator` 也不等于 `afterLocator`（被并发写过） |
| `rebind` | `REMOTE_HOST_REBIND_RECORD_MISSING` | journal 记录的项目/会话在收敛时已不存在（INV-6，转人工） |
| `rebind` | `REMOTE_HOST_REBIND_INCOMPLETE` | 迁移完成但最终锁内扫描仍有引用 ⇒ 不 retire，停在 disabled tombstone |
| `rebind` | `REMOTE_HOST_REFERENCED` / `REMOTE_HOST_RETIRE_INVALID` / `REMOTE_HOST_REVISION_CONFLICT` | 由 `RemoteHostStore` 原样透出（语义不变） |
| `rebind` | `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME` | 主机 store 在提交后抛出（见 1.5 的 finally 分支）：调用方必须 refresh 后重读，禁止假定未提交；端口抛出的非稳定错误文本与"结果条数少于补丁数"也折叠到这个码。**但 store 端口的直通码不折叠**：`PROJECT_STORE_NEEDS_REPAIR` / `PROJECT_STORE_REMOTE_UNSUPPORTED` / `SESSION_CATALOG_NEEDS_REPAIR` 原样透出（词表 `HOST_REBIND_STORE_PORT_CODES`，`HostRebindJournal.ts:131-137`；折叠点 `HostRebindConvergence.ts:97-101`；详见 §4.4） |
| `rebind` | `REMOTE_HOST_REBIND_STORE_PORT_MISSING` | 需要的 store 端口没装配或形状不对（`HostRebindConvergence.ts:150-152`；测试：`tests/hostRebindJournal.test.mjs:444`） |
| `rebind` | `REMOTE_HOST_REBIND_JOURNAL_INVALID` / `_JOURNAL_WRITE_FAILED` | journal 读不出（畸形/超限/非普通文件）或写不进；读侧**绝不猜测、绝不删除**（`HostRebindJournal.ts:296-342`：`read` `:296-320` / `write` `:327-334` / `remove` `:336-342`） |
| `rebind` | `REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE` | tx 锁目录不可写、创建失败（非 `EEXIST`）：`HostRebindTxLock.ts:120`（码本身 `:28`，经 `HostRebindJournal.ts:108` 并入 `HOST_REBIND_CODES`） |
| `rebind` | `REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS` | **终态码（`RebindOutcome.code`，不是异常）**：tx 已收敛，但有非致命遗留 —— 未知结果已回滚前进（`UNKNOWN_OUTCOME_ROLLED_FORWARD`）或 journal 删除失败（`JOURNAL_REMOVE_FAILED`）。注意：**source pin 清理失败不在 warning 里** —— 它在 `retire` 内部 best-effort（当前 `RemoteHostStore.ts:335-339`），由下次 open/refresh 的 `pruneRetiredPins` 重试（`:179-188`） |

> **行号提醒**：本表原引用取自 617 行的基线；`9d0710470` 补齐 §4.4 的端口类型、`295877d8e` 又把 tx 锁与收敛拆出去，行号两次下移。**本表已整体按当前工作树校正**：journal 读写 `HostRebindJournal.ts:296-342`、`assertStorePort` `HostRebindConvergence.ts:150-152`、折叠点 `HostRebindConvergence.ts:97-101`、tx 锁 `HostRebindTxLock.ts:28` 与 `:120`。

### 4.3 journal 记录

```ts
export type RebindStage = "prepared" | "source-disabled" | "projects-written" | "sessions-written" | "source-retired" | "committed";

export type RebindJournal = {
	readonly schemaVersion: 1;
	readonly txId: string;
	readonly createdAt: string;
	/** 进度提示；**权威状态是逐记录的 before/after 内容比对**，stage 丢失或过期不得导致错误动作。 */
	readonly stage: RebindStage;
	readonly source: { readonly hostId: string; readonly endpointDigest: string; /** 计划时 source 是否已 disabled */ readonly disabled: boolean };
	readonly target: { readonly hostId: string; readonly endpointDigest: string; readonly knownHostsSha256: string };
	readonly expectedHostRevision: number;
	readonly records: readonly RebindRecordPlan[];
	/** 写 journal 时的引用扫描摘要，用于收敛时判断"计划是否还成立"。 */
	readonly referenceScan: { readonly complete: boolean; readonly count: number };
};
```

- 落盘：`<userData>/remote-host-rebind.json`，复用 `writeDurableJsonFile`（`src/main/persistence/durableJsonStore.ts:18-63`），`backupPath` 可省（journal 是幂等提示物，不是数据真相；丢 journal 的后果见 5.4）。**【推断】** 不设 `.bak` 是有意取舍：备份会让"哪个 journal 是权威"变成第二个需要 CAS 的问题。
- commit point：先写入 `stage:"committed"` 并 fsync，再删除 journal 文件（对应计划 §5.2 的"`committed` 持久化后才清理 journal"，`docs/remote-development-plan.md:255`）。删除失败 ⇒ `REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS`，重启时按已提交处理并重删。
- **WAL 语义**：推进到下一阶段前先把 `stage` 写成**即将执行**的那一步；因为每一步都幂等（逐记录 before/after + 幂等 retire 判定），重放安全。

> **已落地**（`HostRebindJournal.ts`）：本节由该文件实现 —— `read`/`write`/`remove`（`:298-344`）、严格解码 `decodeRebindJournal`（拒绝未知键、超限、以及 `beforeLocator === afterLocator` 的无效补丁，`:207-240`），落盘确实没有 `.bak`（测试：`tests/hostRebindJournal.test.mjs:176-188`）。同一文件还携带 §5.1 的 tx 锁与 §5.4 的收敛入口 `resume(ports)`；journal 的注入项是 `{ userDataDir, isProcessAlive?, bootId?, now? }`（`:141-148`）。

### 4.4 store 侧新增契约（读 + 写两条入口，逐记录 CAS）

```ts
export type HostRebindRecordPatch = { readonly recordId: string; readonly beforeLocator: string; readonly afterLocator: string };

export type HostRebindRecordOutcome = "applied" | "already-applied" | "missing" | "changed";

export type HostRebindRecordResult = {
	readonly recordId: string;
	/** applied = 本次写入；already-applied = **store 当前内容**已是 after（幂等重放，读的是内存快照而不是磁盘，见 §5.4）；missing = 记录不存在；changed = 与两者都不同 */
	readonly outcome: HostRebindRecordOutcome;
};

/** `locator === undefined` = 该记录已不存在（INV-6）。 */
export type HostRebindRecordSnapshot = { readonly recordId: string; readonly locator?: string };

/**
 * **projects 与 sessions 共用同一个类型**（`HostRebindJournal.ts:50-69`；没有 `ProjectHostRebindPort` /
 * `SessionHostRebindPort` 之分）。
 * **注意：origin 冲突检查不在这里** —— 端口只做逐记录 CAS，`REMOTE_HOST_REBIND_ORIGIN_CONFLICT` 归
 * `plan()`（见 §4.2 与 §7.1 第 16 项）。
 */
export type HostRebindStorePort = {
	/**
	 * 该 store **结构上**能否持有 ssh locator（`HostRebindJournal.ts:58-64`）；缺省 = 能。
	 * `false`（Phase 3 之前的 ProjectStore：`projectStoreCodec.ts:81` 读 ssh 即拒绝、`Project` 无 locator：
	 * `ProjectStore.ts:38-43`）表示读端口仍如实返回记录真正持有的内容，但**每一批补丁都会被拒**。
	 */
	readonly canHoldHostReferences?: boolean;
	/** 读回每个被请求记录的当前 locator（规范 JSON）；"记录已删除"用缺省 locator 表达。 */
	readHostRecordLocators(recordIds: readonly string[]): Promise<readonly HostRebindRecordSnapshot[]>;
	/** 单次原子写完成全部 patched 记录；任一记录 changed/missing ⇒ 整次写入放弃（不部分提交）。 */
	applyHostRebind(txId: string, patches: readonly HostRebindRecordPatch[]): Promise<readonly HostRebindRecordResult[]>;
};
```

- **为什么必须补 `readHostRecordLocators(recordIds)`**：§5.4 步骤 5 的权威判据是"逐记录比对 locator"（`classify`，`HostRebindConvergence.ts:249-274`；拆分前在 `HostRebindJournal.ts`），而 §4.1 的 hit **不携带 hostId**，无法回答"这条记录该不该迁" ⇒ 端口必须能**只读**返回记录当前的 locator。没有它，收敛只能看 journal 的 `stage`，而 `stage` 明确不是权威（§4.3）。
- **没有 `listHostReferences()`**：全仓库不存在这个方法（grep 无命中）。引用集合由 §4.1 的注册表产出；端口只负责逐记录读与写。
- **收敛对端口的强制契约**（判定在 `HostRebindConvergence.ts`，端口类型在 `HostRebindJournal.ts`）：
  - 必须对**每个**被请求的 recordId 返回一条 snapshot：漏条目与"记录已不存在"落到同一个判据（`locator === undefined`）⇒ 报 `REMOTE_HOST_REBIND_RECORD_MISSING`（`:260-272`，判定点 `:269`）。**所以"读不出来"必须抛错，不能少返条目**，否则会被当成"记录已被删"。
  - `applyHostRebind` 的结果条数必须等于补丁条数，否则整次判 `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`（`:284`）——"少返结果"不等于"已应用"。
  - `missing` / `changed` 由**收敛侧**再判一次并停止事务（`:288-289`），端口返回值不能自已宣布成功。
  - 两个端口都必须装配：端口缺失或形状不对在逐记录判定之前就抛 `REMOTE_HOST_REBIND_STORE_PORT_MISSING`（`:170-171` 对两个 store 都先做 `assertStorePort`；`assertStorePort` 本体在 `:150-152`）。
- `applyHostRebind` 必须**全有或全无**（单次 `writeSnapshot`），且重放时返回 `already-applied` 而不是报错。
- 两个 port 的实现都必须**只有** `hostId`（以及 ssh locator 的 `remote*` 字段原样保留）可变；`remotePath`/`remoteSessionId`/`remotePathAliases` 在 rebind 中保持不变；禁止顺手做别的"修复"。
- **before/after 的编码只有一个规范器：`canonicalHostLocatorJson`**（`HostRebindJournal.ts:182-202`：键按字典序排序 `:196`、丢掉 `undefined` 字段 `:197`）。这不是风格问题 —— `classifyRebindRecord` 与两个端口的 CAS 都是**逐字节**比对（`locator === plan.afterLocator` `HostRebindConvergence.ts:114`、`locator === plan.beforeLocator` `:115`），planner 若用别的编码（`JSON.stringify` 原样、键序随构造顺序）产出 `beforeLocator`/`afterLocator`，**每一条记录都会落进 `changed`** ⇒ `REMOTE_HOST_REBIND_STALE_PLAN`，一条也写不进去。这是**字节陷阱**，失败形态还是"计划看起来完全正确、执行时全军覆没"。端口侧做的是同一件事的逆运算：`parseCanonicalSessionLocator` 要求 `canonicalHostLocatorJson(parsed) === value`（`SessionCatalog.ts:361-373`），键序不同的 before 直接判 changed（测试：`tests/hostRebindStorePorts.test.mjs:413-415`）。
  - **落点漂移（已发生，记录在此）**：§7.1 第 18 项原规划把规范化器放 `src/shared/locationAdapters.ts`（名为 `canonicalLocatorJson`，见 §7.1 C 表第 18 行），实际落在 `HostRebindJournal.ts:190`（`295877d8e` 拆分后仍在原模块），名字是 `canonicalHostLocatorJson`；`src/shared/locationAdapters.ts` 至今**没有**任何 canonical 函数（只有 `projectLocatorFromLegacy` / `sessionLocatorFromLegacy`）。现在的实际契约是"规范器跟着端口契约走"：两个 store 都从 `../remote/HostRebindJournal` import 它（`SessionCatalog.ts:9`、`ProjectStore.ts:9`）。第 18 项的行动项因此应改为"**不要**另建第二个规范器"。
- **端口码直通词表 `HOST_REBIND_STORE_PORT_CODES`**（`HostRebindJournal.ts:131-137`）= `PROJECT_STORE_NEEDS_REPAIR` / `PROJECT_STORE_REMOTE_UNSUPPORTED` / `SESSION_CATALOG_NEEDS_REPAIR`。折叠逻辑在收敛模块：`asStableError`（`HostRebindConvergence.ts:93-101`）只原样透出四类码 —— 本模块自有的 `HOST_REBIND_CODES`、`REMOTE_HOST_STORE_CODES`、`HOST_REFERENCE_REGISTRY_CODES`、以及注入进来的直通词表（`isStableJournalCode` = `isHostRebindCode || isHostRebindStorePortCode`，`HostRebindJournal.ts:152-155`，由 `resume()` 传进 `convergeRebindJournal`）—— **其余一律折叠成 `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`**（`HostRebindConvergence.ts:100`）。少了这个词表，"这个 store 写不了 / 装不下 ssh / 需要修复"这些**已知的 fail-closed 答案**会被读成"结果未知"，把"什么都没写"和"写没写不知道"混成一类 ⇒ 直接违反 INV-10。判定入口是 `isHostRebindStorePortCode()`（`HostRebindJournal.ts:147-150`），端到端透出由 `tests/hostRebindStorePorts.test.mjs:489` 固化（`PROJECT_STORE_REMOTE_UNSUPPORTED` 原样冒出）。
- **`PROJECT_STORE_REMOTE_UNSUPPORTED` 是复用码：它同时是"读 ssh 拒绝"和"写拒绝"**。读侧是 `readV2Project` 拒绝 ssh locator（`projectStoreCodec.ts:81`，§1.2 I13）；写侧是端口拒绝**任何**非空补丁（`ProjectStore.ts:18`、`:457-462`）。语义是同一句"这个 store 装不下 ssh locator"，所以不需要第二个码。评审时不要把它误读成"只有读到 ssh 才会出现"：只要 plan 给 ProjectStore 派了补丁，写侧就会抛它（测试：`tests/hostRebindStorePorts.test.mjs:209-210`、`:489`）。
- **被拒批次里的记录一律报 `changed`：绝不允许"没写盘却报 applied"**（`SessionCatalog.ts:388-394` 的 `refusedHostRebind`，调用点 `:772`）。整批是全有或全无（INV-9），任一条 `missing`/`changed` 就让整批不写；此时"本来能写、但因同批失败而没写"的那几条也**必须**报 `changed`。`applied` 的定义是**本次写入**（见上文 `HostRebindRecordResult` 的注释），在没写盘的批次上它是假的；收敛侧把 `applied` 计进 `migrated*`（`HostRebindConvergence.ts:285-292`），假 applied 会直接污染 `RebindOutcome`。测试：`tests/hostRebindStorePorts.test.mjs:372-396`（`[本可 applied, missing]` 的批次回报 `[changed, missing]`，且落盘逐字节不变、内存 hostId 不动）。
- **端口入参形状非法 ⇒ `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`（fail closed，什么都不写）**：批次形状（数组、条数 ≤ 10000、id 非空 ≤ 128 字符且无控制字符）在**任何读/写之前**校验 —— `assertHostRebindRecordIds`（`HostRebindJournal.ts:209-217`，上限 `:162`）、`readHostRebindPatches`（`SessionCatalog.ts:344-354`，上限 `:19`）、`ProjectStore.applyHostRebind` 的数组检查（`:459`）。形状错误的调用"无法解释"，既不能答成"没有记录"也不能答成"没有补丁"；**读端与写端都按同一码拒绝**（畸形输入逐项固化：`tests/hostRebindStorePorts.test.mjs:441-464`），空批次是合法 no-op（返回 `[]`）。
- **`canHoldHostReferences` 缺省 true，且今天没有任何消费方**（声明与注释：`HostRebindJournal.ts:58-64`）：`resume`/`convergeRebindJournal` 从不读这个字段 —— 全仓库只有三处声明/赋值（`HostRebindJournal.ts:64` 的**端口**声明、`RemoteHostReferenceRegistry.ts:46` 的 **provider** 同名字段、`ProjectStore.ts:43` 的赋值），唯一被读取的只有 provider 那一个（注册表在 `RemoteHostReferenceRegistry.ts:152` 用它整源跳过）。⇒ 一个声明 `false` 的端口不会因此被收敛侧跳过：它照样会被调用 `applyHostRebind`，拒绝来自端口自己抛码（`ProjectStore.ts:457-462`）。将来的消费方是**装配层**：把端口的这个字段转发成 §4.1 provider 的 `capability`（测试固化的正是这个形状：`tests/remoteHostStoreLifecycle.test.mjs:309`、`tests/remoteHostReferenceRegistry.test.mjs:104`）。注意 §4.1 与 §4.4 是**同名字段、两个类型**：前者已落地消费，后者还没有。
- **ssh 条目的镜像字段同步：真正生效的边界是读入路径，写路径那一层是防御性冗余**（这句是给评审与测试看的事实，**不要**读成"写路径规则已被测试锁住"）：`normalizeEntryLocator`（`SessionCatalog.ts:298-314`）在 ssh 分支清空 `filePath`/`originKey`/`piSessionId`/`wslDistro`/`wslUser`/`parentSessionPath`；它在**读入路径上无条件生效**（`readCatalogFile` 对每个条目都跑：`:1710-1721`，`entries.map(normalizeEntryLocator)` 在 `:1718`），写路径（`applyHostRebind` 的 `:775`）再跑一次只算冗余。
  - 今天**没有任何可观测状态**需要写路径那一层：能进入内存的 ssh 条目只有 `readCatalogFile` 一个来源（已规范化），而所有会给条目挂本地字段的入口都对 ssh 硬拒绝或过滤（`setLocalSessionFilePath` `:316-317`、`attachRuntime` `:1124`、`mergeScanned` 的 origin 索引 `:1320` 与 `setLocalSessionFilePath` `:1433`、`repairRelativeFilePaths` `:1636`）—— 镜像字段在内存里长不回来。
  - 因此**去掉 `:775` 的规范化零个用例转红**（含 `tests/hostRebindStorePorts.test.mjs` 的 15 个）：写路径的输入前提就是"字段已经干净"。真正咬合的是读入路径 —— 去掉 `:1718` 的规范化，`tests/sessionEntryLocatorNormalization.test.mjs` 2/2 转红（该文件头部记录了两次突变自检的结果），而 15 个端口用例**仍然全绿**（它们被写路径的冗余救了回来，所以锁不住读入路径）。
  - 保留写路径那一层的唯一理由：`applyHostRebind` 是本模块**唯一**改 `locator` 的写入口，将来若出现绕开 `setLocalSessionFilePath` 直接改 `locator` 的新入口，"只改 locator、不带上镜像同步"会立刻让 `findByFilePath` / `originKeyForEntry` / `sessionLocatorForEntry` 三条链路各说各话（`:732-736` 的注释就是这条规则）。
- 失败语义：`REMOTE_HOST_REBIND_STALE_PLAN`（changed）、`REMOTE_HOST_REBIND_RECORD_MISSING`（missing）；写盘失败沿用各自 store 现有错误（`PROJECT_STORE_NEEDS_REPAIR` / `SESSION_CATALOG_NEEDS_REPAIR`，以及写侧复用的 `PROJECT_STORE_REMOTE_UNSUPPORTED` —— 三者都是直通码，见上）；端口缺失/形状不对为 `REMOTE_HOST_REBIND_STORE_PORT_MISSING`；批次形状非法为 `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`（fail closed，什么都不写）。

### 4.5 人工修复原语（main-only，全部需要 human confirmation）

```ts
export type RepairConfirmation = { readonly requestId: string; readonly senderId: number };

export type HostRepairPort = {
	/** 诊断：把 needs-repair reasons 映射成可执行建议（不写盘）。 */
	diagnose(): Promise<readonly HostRepairFinding[]>;
	/** 完成一次"pin 已发布但档案未提交"的激活（A 类，保留信任锚）。 */
	completeActivationFromPin(hostId: string, expectedRevision: number, confirmation: RepairConfirmation): Promise<void>;
	/** 删除一个没有任何 profile 认领的孤儿 pin（A2；只允许"从未验证且未 disabled"的 draft）。 */
	discardOrphanPin(hostId: string, confirmation: RepairConfirmation): Promise<void>;
	/** 删除崩溃残留的主机目录锁（只允许在无进程持有 + 年龄阈值满足时）。 */
	clearStaleHostLock(observerPid: number, confirmation: RepairConfirmation): Promise<void>;
	/** 把 anchor 不可用的 profile 降级为无 endpoint 的 disabled tombstone（不删 profile、不删 id）。 */
	forgetTrustAnchor(hostId: string, expectedRevision: number, confirmation: RepairConfirmation): Promise<HostProfileSummary>;
};
```

**已落地的注入形状**（`RemoteHostRepair` 类，`RemoteHostRepair.ts:172`）：构造参数是 `{ userDataDir, store: HostRepairStorePort, pins: HostRepairPinPort, paths?, lockAgeMs?, now?, isProcessAlive?, bootId? }`（`:61-73`）。

- `HostRepairStorePort`（`:42-50`）：`getSnapshot()` / `getProfile()` / `refresh()` + **两个修复写入口**（`completeActivationFromPin`、`forgetTrustAnchor`）；`RemoteHostStore` 结构化满足它，不需要额外胶水。
- `HostRepairPinPort`（`:53-59`）：`verifyRoute(route, pinAlias)`（A1 需要的重新认证；**`SshHostPinStore.verifierFor()` 是 private**，见 6.2 A 与 §7.4 风险 4）/ `readPin(hostId, endpoint)`（不复用、抛 `SSH_HOST_PIN_INVALID`）/ `deletePin(hostId)`。
- `diagnose()` 的产物是 `HostRepairFinding = { reason, classification, hostIds, actions }`（`:34-39`），按 reason 映射到 `orphan-pin` / `anchor-invalid` / `lock` / `snapshot` / `write-uncertain` / `unknown` 六类合法动作集（`:200-235`）。

失败语义：全部以 `HOST_REPAIR_*` 前缀返回稳定码，**取值只来自 `HOST_REPAIR_CODES`**（`RemoteHostRepair.ts:76-93`）= `CONFIRMATION_REQUIRED`、`NOT_APPLICABLE`、`ANCHOR_STILL_VALID`、`ANCHOR_UNREADABLE`、`ANCHOR_MISMATCH`、`ROUTE_UNVERIFIED`、`LOCK_HELD`、`LOCK_UNREADABLE`、`STORE_NOT_READY`、`REVISION_CONFLICT`、`WRITE_UNCERTAIN`、`WRITE_FAILED`、`PIN_CLEANUP_FAILED`、`HOST_ID_INVALID`、`REVISION_INVALID`、`OBSERVER_PID_INVALID`。store 侧的码经 `mapStoreFailure()`（`:131-157`）折叠进这套词汇（`REMOTE_HOST_STORE_NEEDS_REPAIR` → `HOST_REPAIR_STORE_NOT_READY`、`REMOTE_HOST_STORE_BUSY` → `LOCK_HELD`、`REMOTE_HOST_PIN_INVALID`/`SSH_HOST_PIN_INVALID` → `ANCHOR_UNREADABLE` …），因此 errno、路径与 provider 文本都不会跨出边界。**任何原语都不得触及未指名的 hostId**（`assertHostId`：`:516-518`；测试：`tests/remoteHostRepair.test.mjs:415`），且没有 `confirmation` 一律 `HOST_REPAIR_CONFIRMATION_REQUIRED`（`:509-513`；测试 `:155`）。`forgetTrustAnchor` 在 profile 的 `verifiedEndpoint` 仍与现存 pin 匹配时必须抛 `HOST_REPAIR_ANCHOR_STILL_VALID`（`:338-342`，防止把"信任锚好着呢"误降级）。

**与 I9 的关系：这是"按 reason 分类的白名单"，不是把规则开洞。**

修复原语必须能在**它要修的那种损坏**上写盘，否则 §6.2 A/B 的修复路径永远需要一个"先恢复可写"的前置条件（G6/G7 的死锁）。实现把例外收窄成白名单：`RemoteHostStore.mutateRepair(expectedRevision, allowedReasons, change)`（当前 `:494-535`）在**锁内重新加载磁盘**后要求 `disk.reasons ⊆ allowedReasons`，否则抛 `REMOTE_HOST_STORE_NEEDS_REPAIR`（`:506-507`）。当前白名单只有两项：

| 修复写入口 | 允许的 reason | 出处 |
| --- | --- | --- |
| `completeActivationFromPin`（A1） | `["REMOTE_HOST_PIN_ORPHAN"]` | 当前 `RemoteHostStore.ts:447` |
| `forgetTrustAnchor`（B 降级） | `["REMOTE_HOST_PIN_INVALID"]` | 当前 `RemoteHostStore.ts:469` |

说它不是开洞，理由有三条（每条都有测试/行号）：

1. **判据是"全部 reason ⊆ 该类"，不是"包含该类"**：两种损坏同时存在时两个原语都不能写（测试：`tests/remoteHostRepair.test.mjs:304-320` 断言 `HOST_REPAIR_STORE_NOT_READY` 且目录字节不变）—— 修复不会顺手绕过别的损坏。
2. **判定用锁内的新鲜磁盘状态**（`:506`），不是内存快照、也不是调用方自述；锁（`open("wx")`）、磁盘 CAS（`:508`）与编解码校验（`:511`）与普通 mutator 完全一致。写后**只断言 revision 前进、不断言 `ready`**（`:514-517`）—— 把"写成功"说成"已修好"本身就是 §6.1 铁律 2 禁止的静默信任。
3. **每个原语只能做它自己那一类变换**（提交一次被中断激活的端点 / 把一个不可用锚点降级）：`createDraft`/`updateDraft`/`disable`/`retire`/`offerPin`/`confirmPin` 仍全部要求 `ready`（当前 `:538`、`:391`），这条规则没有一处被放宽。

---

## 5. 锁顺序与失败矩阵

### 5.1 获取顺序（唯一合法顺序）

```
1. remote-host-rebind.lock        （新增：跨 store tx 锁，跨进程互斥，owner 写入 pid+bootId+时间）
2. remote-hosts.json.lock         （由 RemoteHostStore.mutate 内部获取，短命，锁内做 CAS）
3. ProjectStore.writeQueue        （进程内单条队列）
4. SessionCatalog.writeQueue      （进程内单条队列）
```

> **路径同源（本节可靠性的前置）**：上面四处锁/目录路径目前是各自派生的（`RemoteHostStore.ts:133`、`:167`、`:191`、`:226`、`SshHostPinStore.ts:101`、`RemoteHostRepair.ts:188-189`、`HostRebindJournal.ts:282-283`），应收敛到 `resolveRemoteHostPaths(userDataDir)` 一个入口（§7.1 第 25 项）；否则"锁 1 与锁 2 指向不同磁盘根"这类漂移会直接让本节规定的获取顺序失效（`AGENTS.md`：同一磁盘根必须同源）。

规则：

- **R1**：只能在**未持有**任何 store 锁/队列时获取 1。禁止"在 session 写队列里发起 rebind"。
- **R2**：2 只在单个 `RemoteHostStore` 调用期间存在（由 `mutate` 自己开关，`:356`、`:388-395`），调用返回即释放；**不允许**跨越 3/4 持有它。⇒ 阶段之间不存在"同时持有两个 store 锁"的情况，死锁不可能形成（只嵌套一层，且方向单一）。
- **R3**：引用扫描（4.1）必须是**纯读**：只读内存快照 + 只读磁盘文件（含 `.bak`），**不得**进入 3/4 的写队列，也不得获取 1 之外的锁。否则会形成 `2 → 3` 与 `3 → 2` 的反向嵌套。**【推断】** `isReferenced` 在 `mutate` 的锁内被调用（`:201`、`:248`），所以这条是硬约束而不是风格建议。
- **R4**：`resumePendingRebind()`（落地的等价入口是 `HostRebindJournal.resume(ports)`，§4.2）遵守同一顺序：先 1 再逐 store；发现 1 被别的进程持有时**不强等**，直接放弃本次恢复（`remote-hosts.json` 侧现状已经是这种"看到锁就退让"的语义，`:94-95`）。
- **R5**：1 的持有者允许在锁内做**多轮** store 写（这是它存在的意义），但每轮之间必须释放 2（由 store 自己保证）。
- **R6**：崩溃恢复不使用超时抢占：1 有 owner 信息 `{pid, bootId, startedAt}`（`HostRebindJournal.ts:560-568`），只有"owner 进程不存在"或"owner pid 存在但启动标识不同（pid 复用）"才允许回收；否则一律转人工（对应 G5）。**启动标识怎么来（跨平台）**：`currentBootId()` 不依赖 `/proc`，用 `String(Math.round((Date.now() - uptime() * 1000) / 1000))` 反推本次开机时刻 —— 同一次启动内两个进程必然得到同一个值（`:187-189`），且 `bootId` / `isProcessAlive` / `now` 都可注入（`:141-148`；测试：`tests/hostRebindJournal.test.mjs:384-415`）。判定顺序（`:592-597`）：owner 是自己 ⇒ 视为仍被持有；bootId 与本进程不同 ⇒ 判定 pid 复用，可回收；bootId 相同 ⇒ `kill(pid,0)` 探测，只有 `ESRCH` 证明进程已消失（`EPERM` 仍算活着，`:191-200`）。owner 读不出（空文件 / 超长 / 非 JSON）一律**当作活着**，不强等也不抢占（`:581`、`:599-616`）。修复侧复用同一个推导（`RemoteHostRepair.ts:21`、`:196`），两把锁的 bootId 因此可比；但**主机目录锁 `remote-hosts.json.lock` 目前仍是空文件**（当前 `RemoteHostStore.ts:544` 不写 owner），`clearStaleHostLock` 对"无 owner"落到年龄阈值 + 活跃 `*.tmp` 检测（`RemoteHostRepair.ts:309-313`），见 6.2 C。**【推断】** 给主机目录锁也写入同一份 owner 后，R6 的判定可以直接复用，不需要第二套约定。

### 5.2 死锁避免依据

1. 只有一把跨进程锁（1），它永远是最外层；不存在第二把跨进程锁可与之交叉。
2. 3/4 是**进程内**队列，且从不在彼此内部调用（`ProjectStore.remove` 不调用 catalog；catalog 的 `removeByProjectId` 不调用 project store —— 现有跨 store 编排发生在 IPC 层顺序调用，`projectsIpc.ts:102-108`）。
3. 2 是最内层且短命，从不回调外部（`mutate` 只调用 `change` 回调；唯一"外部"调用是引用扫描，按 R3 是纯读）。
4. 因此锁图是 DAG：`1 → 2`、`1 → 3`、`1 → 4`、`2 → ∅`、`3 → ∅`、`4 → ∅`。

### 5.3 两个 store 无法共享一把锁：方案与放弃的保证

**现实**：`ProjectStore` 与 `SessionCatalog` 没有跨进程锁，也没有磁盘 CAS（1.1）。要满足计划 §5.2 字面上的"所有会新增/删除/迁移引用的 mutator 都必须先取得同一份跨进程持久锁"（`docs/remote-development-plan.md:255`），需要给这两个 store 的**所有** mutator 加锁——那是一次覆盖 `projectsIpc`/`sessionIpc`/启动导入/扫描回填/DSH 自动导入等十余条路径的改造，且这些文件此刻正处于 Phase 1 未提交状态（7.1）。

**采用方案：journal + 单侧 owner + advisory interlock + 事后校验**

1. **单侧 owner**：只有 `HostRebindCoordinator` 允许写 ssh locator 的 `hostId`（含新建引用）。普通 mutator 只允许**原样保留**已有 locator；任何试图改写 hostId 的路径都必须走协调器。⇒ "hostId 单调、单一写者"。
2. **advisory interlock**：会**新增 hostId 引用**或**删除项目/会话记录**的 mutator，在提交前检查 tx 锁/journal 是否存在；存在则拒绝（`REMOTE_HOST_REBIND_IN_PROGRESS`）并由 UI 提示稍后重试。这条不要求持有锁，只是"看到就退让"。
3. **逐记录 CAS**：`applyHostRebind` 用 `beforeLocator` 精确比对（4.4），任何被并发写过的记录都会变成 `changed` ⇒ 事务停下（`REMOTE_HOST_REBIND_STALE_PLAN`），不做部分迁移。
4. **最终锁内扫描**：`retire` 之前，在 tx 锁内重做一次**完整**引用扫描（读盘 + 读内存，含 `.bak` 的保守并集），并交给 `RemoteHostStore` 自己的 `isReferenced`（`:248`）二次确认。
5. **事后校验 + 主动补偿**：`retire` 返回后进行第三次扫描；若发现指向已退役 id 的引用（意味着"扫描→提交"窗口里被并发写入），**立即滚动前进**：把这些引用迁到 target（仍在同一 tx 内，journal 已记录 target），而不是回滚。

**放弃的保证（写清楚）**：

| 放弃 | 影响 | 残余缓解 |
| --- | --- | --- |
| 与普通 mutator 的**严格**跨进程互斥 | 存在"扫描→retire 提交"之间的 TOCTOU 窗口；另一实例在别处修改 `projects.json`/`session-catalog.json` 时无法被锁住 | 步骤 3/4/5 把不可见错误变成可检测错误或可补偿动作；窗口内产生的新引用会在步骤 5 被迁走 |
| "rebind 期间引用集合冻结" | 同上层原因；不再承诺"计划时的记录集就是全部要迁的记录" | `plan()` 的结果只作为初值；收敛以 **store 内存内容**为准（逐记录 CAS + `already-applied` 幂等；这两个 store 的端口从不重读磁盘，见 §5.4 的"权威来源"注） |
| "journal 永不丢失" | journal 文件被外部删除/磁盘损坏时，事务退化为"半迁移但合法"的状态 | 该状态满足 INV-1（引用要么指 source，要么指 target，两者都存在 profile）；恢复方式是用同一对 source/target **重新执行** rebind（`already-applied` 使重放安全）。不承诺自动发现 |
| 锁的自动回收 | 崩溃遗留 tx 锁需要人工/进程标识判定（R6） | owner 元数据 + 年龄阈值 + 显式确认；不做超时抢占 |
| 对 `.tmp` 残留的清理 | 硬崩溃会留下 `*.tmp`（`durableJsonStore.ts:21-22` 的随机名只在进程内 `finally` 清理，`:59-62`） | 列为低优先级：由 journal 收敛流程顺带按前缀+年龄清理（不删非本目录文件）**【推断】** |

### 5.4 阶段 × 崩溃点 → 启动收敛算法

阶段与磁盘效果：

| 阶段 | 动作（单次 store 写） | 磁盘可见效果 |
| --- | --- | --- |
| `prepared` | 写 journal（WAL，先于任何 store 写） | 只有 journal + tx 锁 |
| `source-disabled` | `RemoteHostStore.disable(source, rev)`：`RemoteHostStore.ts:339-347` | source 变 tombstone；引用仍指 source（合法：可解析、无新连接，`SshVerifiedConnection.ts:31`） |
| `projects-written` | `ProjectStore.applyHostRebind(...)` 一次原子写 | 全部项目记录一并改指，或全不变（INV-9） |
| `sessions-written` | `SessionCatalog.applyHostRebind(...)` 一次原子写 | 同上 |
| `source-retired` | `RemoteHostStore.retire(source, rev)`：`:242-263` | profile 消失、id 入 `retiredHostIds`、source pin 尽力清理 |
| `committed` | journal 先写 `committed` 再删除 | journal 消失（或残留 `committed`） |

**为什么先 disable 再迁引用**：`disable` 之后 source 不再是可连接端点（`activeProfile` 要求非 disabled，`SshVerifiedConnection.ts:31`），因此"迁移期间产生新 source 引用"只能来自**已存在的**记录或另一实例的普通 mutator，而不能来自"用户此刻选了这台主机建新会话"；这把 G4 的风险面收窄了一半。代价：**当前没有 `enable` API**（`RemoteHostStore` 的公开写方法只有 `createDraft/updateDraft/disable/retire/offerPin/confirmPin`），所以 `source-disabled` 之后**不存在回滚**，只能滚动前进或人工修复。这一点必须写进 UI 文案与 API 语义（`rebind` 不提供 abort）。

**为什么先 projects 后 sessions**（沿用计划 `docs/remote-development-plan.md:255` 的阶段序，并给出理由）：项目是 host 作用域根（文件/授权按项目解析），会话从属项目。先迁父级 ⇒ 中间窗口里残留的 source 引用一定落在"已 disable 的会话"上（必然 fail closed），而不是"项目在 source、会话却指向 target"这种可能被 UI 用来跨主机打开项目的组合。

**启动收敛算法（幂等、可重入）**

> **落地对应**：下面的算法已实现为 `HostRebindJournal.resume(ports)`（`HostRebindJournal.ts:344-360`，取锁后转交 `convergeRebindJournal`）；每步执行**之前**先由 `advance()` 把 `stage` 改写成"即将执行的那一步"（`HostRebindConvergence.ts:207-212`）。`resumePendingRebind()` 这个名字属于尚未实现的协调器（§4.2）。

> **权威来源是 store 的内存内容，不是磁盘**（对 `ProjectStore` / `SessionCatalog` 这两个 store 成立，与 §4.3 的"权威状态是逐记录内容比对"配套）。`readHostRecordLocators` 读的是内存快照 —— catalog 从不重读磁盘（`SessionCatalog.ts:707-723` 的注释与实现，写侧同样只改内存：`:1663-1680` 的 `enqueueMutation` → `writeSnapshot`），ProjectStore 也只走内存（`ProjectStore.ts:433-450`）。两个后果必须写清：
> 1. **"写已落地但抛错"时内存会暂时落后于磁盘**：`rename` 已落地、store 才抛错（§1.5 的 `finally` 分支同型），此时磁盘是 `after`、内存仍是 `before`；收敛重跑时逐记录判定（`classify`，`HostRebindConvergence.ts:249-274`）会按内存再判成"待迁移"，`applyHostRebind` 用内存内容重写一次 ⇒ **幂等收敛**（既不卡住，也不会把已迁移的记录写回 source）。测试固化：`tests/hostRebindStorePorts.test.mjs:538-566`（`:555` 磁盘已是 target、`:556` 内存仍是 source，重跑后在 `:561-564` 收敛）。
> 2. **别处的写者在端口这一层是不可见的**：端口的期望值来自内存，不是"重新读盘比对"，所以另一个实例/进程直接改 `projects.json` / `session-catalog.json` 时，端口会拿自己的内存快照整份覆盖它。这正是 §5.3 放弃"严格跨进程互斥"的根因；也意味着 **INV-5 里"不得用内存快照覆盖磁盘上更新的数据"这句在端口层并不成立**，它只能靠"单侧 owner + advisory interlock + 事后扫描补偿"缓解（§5.3）。**【待确认】** 是否把 INV-5 收窄成"只约束 host store 的 CAS（它确实锁内重读磁盘，`RemoteHostStore.ts:544`）"，并把两个 store 的保证降级为"同进程串行 + 逐记录内容幂等"，需要产品/评审拍板；本文其余部分按"端口权威 = 内存"叙述。

1. 读 `<userData>/remote-host-rebind.json`。不存在 ⇒ no-op（返回 `undefined`）。
2. 解析失败 ⇒ 不猜测、不删除：抛 `REMOTE_HOST_REBIND_JOURNAL_INVALID`，并让 host store 保持 `needs-repair`（人工介入，6.2 D）。
3. 取 tx 锁（R4：被别的进程持有 ⇒ 放弃本次恢复，返回 `undefined`，由"看到 journal 就退让"的 mutator 保证一致性）。
4. 校验 `target` profile 仍存在且 verified、pin 仍可读（`readPin`）。任一不成立 ⇒ 停在 `needs-repair`（`REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE`），**绝不**改用 source 的锚点或跳过校验（INV-3）。
5. 对 `records` 逐条判定（**权威判据，不看 stage**；判据取自 store 的**内存快照**，见上方"权威来源"注）：
   - 记录不存在 ⇒ `REMOTE_HOST_REBIND_RECORD_MISSING`，停止（INV-6）。
   - locator == `afterLocator` ⇒ 视为已完成（幂等）。
   - locator == `beforeLocator` ⇒ 待迁移。
   - 两者都不是 ⇒ `REMOTE_HOST_REBIND_STALE_PLAN`，停止。
6. 若仍有待迁移的记录：先确认 source 的期望状态（若 source profile 仍 enabled ⇒ 执行 disable），再按 `projects` → `sessions` 顺序各执行一次 `applyHostRebind`（只含待迁移记录）。
7. 若 `source` 的 id 已在 `retiredHostIds` 中 ⇒ 阶段已完成，跳到 9（**这一分支必须显式写**：`retire` 对已退役 id 会抛 `REMOTE_HOST_RETIRE_INVALID`，`:247` + 测试 `tests/remoteHostStoreLifecycle.test.mjs:225-226`，把它当失败会让收敛永远卡住）。
8. 最终锁内完整引用扫描（`scanReferences`）—— **两个失败分支的码不同，必须分开写**（`HostRebindConvergence.ts:198-199`）：
   - 扫描**不完整**（有源读不出、或集合形状非法）⇒ `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`（注意是**注册表**的码，没有 `REMOTE_HOST_REBIND_` 前缀）：不完整证明不了"无引用"，唯一安全答案是**不 retire**。
   - 扫描**完整但仍有引用**（含 source 自己）⇒ `REMOTE_HOST_REBIND_INCOMPLETE`：不 retire，source **停在 disabled tombstone**（这是合法终态，引用仍可解析、任何连接 fail closed）。
   - 两者都不写任何 store、不删 journal（停在 `source-retired`），因此重跑 `resume` 幂等；测试把两个分支各固化成一条：`tests/hostRebindJournal.test.mjs:318-338`（`:321` 与 `:335`）。
   - 引用为空 ⇒ `retire(source, 当前 revision)`（revision 从 `refresh()` 取，不复用 journal 里的旧值；测试：`tests/hostRebindJournal.test.mjs:457-461`）。
9. 写入 `stage:"committed"` → 删除 journal → 释放 tx 锁 → 返回 `RebindOutcome`（含 warnings）。

各崩溃点的收敛结果：

| 崩溃点 | 磁盘状态 | 收敛动作 | 终态 |
| --- | --- | --- | --- |
| journal 写完前 | 无 journal，可能有 tx 锁 | 按 R6 回收陈旧锁 | 无变化 |
| journal 写一半 | journal 缺失或完整（原子替换） | 缺失 ⇒ no-op | 无变化 |
| `source-disabled` 前/中 | source 仍 enabled | 步骤 6 重放 disable | 前进 |
| `projects-written` 前/中 | projects 全未迁（原子写） | 步骤 6 重放 | 前进 |
| `projects-written` 后、`sessions-written` 前 | 项目指 target、会话指 source（source 已 disable） | 步骤 6 只补 sessions | 前进 |
| `sessions-written` 后、`retire` 前 | 引用全部指 target | 步骤 7/8 执行 retire | 前进 |
| `retire` 提交后、pin 清理前 | source 已退役、pin 残留 | `pruneRetiredPins` 下次 open/refresh 清理（`:105-114`） | 已收敛（**不是** warning：`retire` 内 best-effort、loader 容忍残留） |
| `committed` 写入后、journal 删除前 | journal 存在且 `committed` | 直接删除 journal | 已收敛 |
| 步骤 8 判定失败（扫描不完整 / 仍有引用） | source 已 disable、引用已迁到 target、未 retire、journal 停在 `source-retired` | 抛稳定码（`REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE` / `REMOTE_HOST_REBIND_INCOMPLETE`），不写任何 store、不删 journal | **未收敛**（可诊断）：停在 disabled tombstone，重跑 `resume` 幂等 |
| journal 被外部删除 | 引用合法（source 或 target） | no-op；如需完成迁移则重新执行 rebind（`already-applied` 幂等） | 合法但可能半迁移 |

**可重入规则**：`resumePendingRebind()` 任意次调用结果一致；`rebind()` 在 journal 已存在且指向同一 (source,target) 时返回同一 txId 的结果（续跑），指向不同端点时抛 `REMOTE_HOST_REBIND_JOURNAL_PRESENT`。

---

## 6. 人工修复流程（无 UI 阶段：主进程函数描述）

### 6.1 三条铁律

1. **不得删除唯一一份信任锚**：任何 pin 的删除都必须能证明"没有 profile 认领它"（孤儿 —— 含"降级之后已没有 `verifiedEndpoint` 的 profile"，见 6.2 B 的提交后清理）或"它的 profile 已退役"（`retire` 的提交后清理）。禁止为了让 `needs-repair` 消失而删 verified profile 的 pin；**读不出内容的 pin 一律不删**（没有证明就没有删除，INV-4）。
2. **不得静默信任新 endpoint**：修复与收敛都不得写 `verifiedEndpoint`；任何"改指"都必须先有一份**独立完成 offer/confirm** 的 target 档案与其 pin（INV-3/INV-7）。`forgetTrustAnchor` 只会降低信任，绝不会提高。
3. **不得手改 JSON**：`remote-hosts.json`、`projects.json`、`session-catalog.json` 的任何手工编辑都会绕过 codec 校验（`RemoteHostStoreCodec.ts:107-129`）与备份轮换（`durableJsonStore.ts:34-54`），并且下一次写入会用内存快照覆盖它。所有修复必须经 §4.5 的原语。

### 6.2 按 `needs-repair` reason 的分诊与步骤

**A 类｜`REMOTE_HOST_PIN_ORPHAN`：draft profile 名下存在 pin（失败激活残留）**

- 前置检查（主进程 `diagnose()` 返回）：该 hostId 对应的 profile **存在、`verifiedEndpoint === undefined`、`disabledAt === undefined`**（`RemoteHostStore.ts:77` 的判定条件；当前 `:151`）；`ssh-host-keys/<hostId>` 存在且大小 ≤ 16 KiB（`SshHostPinStore.ts:30`）。`diagnose()` 会把这类 finding 归到 `orphan-pin` 并给出 `["complete-activation-from-pin", "discard-orphan-pin"]`（`RemoteHostRepair.ts:205-207`），孤儿 id 由 `orphanPinHostIds()` 扫目录得到（`:456-475`）。
- 允许动作（二选一，都需要 human confirmation）：
  - **A1 保留锚点（推荐，前提是主机可达）**：`completeActivationFromPin(hostId, rev, confirmation)` —— 用 profile 当前 route 交给**注入的** `verifyRoute(route, pinAlias)` 重新认证一次（`RemoteHostRepair.ts:253`；`SshHostPinStore.verifierFor()` 是 private（`SshHostPinStore.ts:110-115`），修复模块拿不到它，端口是唯一入口），然后要求活主机给出的候选与**已发布的 pin 字节**双向一致：`sha256(pin 字节) === candidate.knownHostsSha256` **且** `fingerprintSshHostKey(pin 字节, candidate.pinAlias) === candidate.hostKeyFingerprints[0]`，别名必须是 `pideck-<hostId>` 且指纹恰好一条（`:258`、`:496-503`）。最后把候选端点交给 store，在 **store 锁内再 `readPin` 复核一次**后才提交 `verifiedEndpoint`（`RemoteHostStore.ts:446-460`；测试 `tests/remoteHostRepair.test.mjs:322-342` 断言"锁内复核失败 ⇒ `HOST_REPAIR_ANCHOR_UNREADABLE` 且文件未变、revision 未动"）。语义等价于"把一次被中断的 confirm 走完"，信任来源仍是用户原始确认的同一把 host key —— pin 字节前后不变（测试 `:190`），且旧实现想要的 `pinDigest` 复核在这里由"候选 ↔ 已发布 pin 字节"的双向校验取代（`pinDigest` 是 `SshHostPinStore.ts:32-35` 的模块内私有函数，外部无法调用）。
    - 稳定码：`HOST_REPAIR_NOT_APPLICABLE`（不是 draft / pin 不存在或字节读不出）、`HOST_REPAIR_ROUTE_UNVERIFIED`（重新认证失败，`:254-257`）、`HOST_REPAIR_ANCHOR_MISMATCH`（候选与 pin 字节不一致，含 host key 轮换；测试 `:198-209`）、`HOST_REPAIR_ANCHOR_UNREADABLE`（store 锁内复核失败）。写入口本身只允许 `REMOTE_HOST_PIN_ORPHAN` 这一 reason（§4.5）。
    - **未决风险（生产绑定）**：`verifyRoute` 必须由装配方注入；`SshHostPinStore.verifierFor()` 目前 private，未注入时 A1 与 A 类诊断在生产不可用（§7.4 风险 4，§7.1 第 11 项）。
  - **A2 删除孤儿 pin**：`discardOrphanPin(hostId, confirmation)`。前置仍要求 profile **从未验证且未 disabled**（`requireDraft`，`RemoteHostRepair.ts:358-362`：`verifiedEndpoint`、`disabledAt` 都为 `undefined`），pin 存在且字节可读（否则 `HOST_REPAIR_NOT_APPLICABLE`），删除后复查确实缺失（否则 `HOST_REPAIR_PIN_CLEANUP_FAILED`，`:277-287`）。安全性论证：draft 从未写入 `verifiedEndpoint`（`RemoteHostStoreCodec.ts:85` 保证成对），因此这个 pin **不是任何档案的信任锚**；删除后该 hostId 回到"从未验证"状态，重新激活必须重新走 offer/confirm（新的 SSH 认证 + 新指纹确认，`SshHostPinStore.ts:125-128`、`:231-256`），不会静默信任任何 endpoint。**注意它够不到已 disabled 的 tombstone**：`disabledAt` 一旦写入，A2 就拒绝 —— 这正是 B 类降级后必须由 `forgetTrustAnchor` 自己收尾的原因（见下）。
- 禁止动作：把它当成"verified profile 的 pin 丢失"处理；直接删 pin 而不确认 hostId 对应的确实是 draft；删除 profile 记录。
- 回到可用：任一路径完成后 `refresh()`（`RemoteHostStore.ts:172-178`）应返回 `ready`；再断言 `getSnapshot().reasons` 不含 pin 类 reason。

**B 类｜`REMOTE_HOST_PIN_INVALID`：verified profile 的 pin 丢失/被篡改（最危险）**

- 前置检查：确认真实性——`readPin` 失败是"文件不存在"还是"内容不匹配"（`SshHostPinStore.ts:171-182` 把两者折叠成同一个码，诊断层需要区分，见 7.1 第 11 项）。
- 允许动作：**没有任何"原地修好"的动作**。正确路径是"重建 + 迁移 + 退役"三步：
  1. `createDraft`（新 hostId）+ `offerPin` + `confirmPin`：对同一 endpoint 重新做一次完整认证与指纹确认（这就是"重新拿到信任锚"的唯一合法方式）；
  2. `rebind(source=坏档案, target=新档案)`（§4.2）：把所有引用迁到新 hostId；
  3. `disable(source)` → `retire(source)`：把坏档案压成 retired id（此时 `pinIssues` 不再要求它的 pin，`:79-86` 只检查存在 `verifiedEndpoint` 的 profile）。
  - 若主机不可达（无法完成第 1 步），则退化为：`forgetTrustAnchor(source, rev, confirmation)` 把坏档案降级为**无 endpoint 的 disabled tombstone**（`verifiedEndpoint`/`verifiedAt` 同时移除，满足 `RemoteHostStoreCodec.ts:85`；store 侧实现见当前 `RemoteHostStore.ts:468-486`），随后照 2/3 完成迁移与退役。语义：显式声明"这个端点的信任锚已经不可用且无法重建"，引用仍可解析（hostId/label 保留），但任何连接都会 fail closed（`SshVerifiedConnection.ts:31`）。
  - **降级后那个 pin 怎么办（实现的清理规则，避开死锁）**：降级会把该 hostId 变成**已 disabled 的 tombstone**，而 `pinIssues` 对"存在 pin 但 profile 没有 `verifiedEndpoint`"一律报 `REMOTE_HOST_PIN_ORPHAN`（当前 `RemoteHostStore.ts:151`）；此时 `discardOrphanPin` 因 `disabledAt` 已写入而拒绝（A2 的 `requireDraft`），`retire` 又要求 store `ready` ⇒ 残留 pin 会把整个 store 永久钉在 `needs-repair`，第 3 步（退役）永远走不到。因此 `forgetTrustAnchor` 在**提交之后**自己收尾，规则只有一条：**仅当 pin 可读、且用 `sha256` + `fingerprint` 证明它不再认证刚被丢弃的那个锚点时才删除**（`RemoteHostRepair.ts:344-349` + `pinCertifiesAnchor` `:162-169`）；**不可读的 pin 一律不删**，留给 `diagnose()` 报 `PIN_ORPHAN` 交人工（INV-4：没有证明就没有删除）。两种情形都有测试固化：可读但不匹配 ⇒ 删掉、store 回到 `ready`；不可读（例如 pin 路径被换成目录）⇒ 保留，reason 从 `PIN_INVALID` 变成 `PIN_ORPHAN`（`tests/remoteHostRepair.test.mjs:278-302`）。
  - **为什么不改成放宽 A2 的 profile 形状**：把 `discardOrphanPin` 扩展到"已 disabled 的 tombstone"就等于允许对**任何**没有 endpoint 的档案删 pin —— 那会把"孤儿 pin（失败激活）"和"刚被降级的锚点"合并成同一条无需证明的删除路径，正是 6.1 铁律 1 要挡住的事。现在的写法把"删除"限制在**有字节证据**的那一侧，代价是"不可读 pin"要人工收尾（可诊断、可见）。
- 禁止动作：删除 pin 文件"让校验通过"（销毁唯一锚点）；把 `verifiedEndpoint` 手工改指到另一个端点；用 source 的旧 pin 给新 hostId 复用（`pinAlias` 必须等于 `pideck-<hostId>`，`RemoteHostStoreCodec.ts:55`，实际上做不到，但必须在文档里禁掉这个念头）。
- 回到可用：第 3 步完成后 `refresh()` 应 `ready`；断言坏 hostId ∈ `retiredHostIds` 且其 pin 已被 `pruneRetiredPins` 清掉。

**C 类｜`REMOTE_HOST_LOCK_PRESENT` / `REMOTE_HOST_LOCK_UNREADABLE`**

- 前置检查：确认没有其它 PiDeck 实例在写——主机目录锁在基线时**没有 owner 信息**（`:356`，当前 `:544` 仍是空的 `open("wx")`），因此落地实现按两级判据（`RemoteHostRepair.ts:294-320`）：(a) 若锁文件里有 owner 元数据（tx 锁的格式：`{pid, bootId, startedAt}`），owner 是自己、或"同 bootId 且进程活着" ⇒ `HOST_REPAIR_LOCK_HELD`（`:307-308`）；(b) 无 owner（当前主机目录锁就是这种情况）⇒ 要求同目录没有近期的 `remote-hosts.json.<nonce>.tmp`（`:437-454`，正则 `:445`）**且**锁文件 mtime 年龄 ≥ `lockAgeMs`（默认 120 000 ms，`:104`），否则同样 `HOST_REPAIR_LOCK_HELD`（`:309-313`）。锁文件 `lstat` 非 `ENOENT` 失败 ⇒ `HOST_REPAIR_LOCK_UNREADABLE`。
- 允许动作：`clearStaleHostLock(observerPid, confirmation)` 删除锁文件（删除失败 ⇒ `HOST_REPAIR_WRITE_FAILED`）；随后 `refresh()`。测试：`tests/remoteHostRepair.test.mjs:365-413`（旧的空锁可清、活写入者/自己的 pid/新鲜锁/活跃 tmp 全被拒）。
- 禁止动作：在有活跃写入者时删锁（会造成双写者）；删除锁文件后不 refresh 就继续 mutate（会拿到 `REMOTE_HOST_STORE_BUSY`）。
- 回到可用：`refresh()` 后 `status === "ready"`，并成功执行一次无害写入（如 `createDraft` + `disable`）作为端到端验证。
- **改进项**：**tx 锁**已经写入 `{pid, bootId, startedAt}`（`HostRebindJournal.ts:560-568`），因此 tx 侧的 C 类判定可以自动化；**主机目录锁仍没有 owner 信息**，只能靠年龄阈值 + 活跃 tmp 信号兜底（G5 仍未完全关闭；给 store 的锁补 owner 见 §7.1 第 10 项）。

**D 类｜快照类（`SNAPSHOT_INVALID` / `PRIMARY_INVALID` / `SNAPSHOT_CONFLICT` / `BACKUP_SELECTED`）**

- 前置检查：人为阅读 `<userData>/remote-hosts.json` 与 `.bak` 的 `revision`，确认哪一份更完整；确认是否存在 `retiredHostIds` 只在其中一份里的情况（涉及 INV-8，不能丢）。
- 允许动作：`diagnose()` 输出两份快照的摘要（revision、profile 数、retired 数、每个 verified profile 的 pin 是否可读），由人工选择以哪一份为准；写入走 `writeDurableJsonFile`（不经手工编辑）。
- 禁止动作：用空快照覆盖（会同时丢掉 `retiredHostIds`，从而允许 id 复用，破坏 INV-8）；把 `.bak` 复制成 primary 后**不**检查 pin（会造成 I5 的误判/漏判）。
- 回到可用：`refresh()` 返回 `ready` 且 `revision` 与所选快照一致。

**E 类｜`REMOTE_HOST_WRITE_UNCERTAIN` / `REMOTE_HOST_STATE_UNCERTAIN`**

- 前置检查：先 `refresh()`（**不是**先重试写），读 revision 与 profile 集合，判断上次写入是否落地。
- 允许动作：按落地结果续做（`already-applied` 视为成功；未落地则用新 revision 重试）。
- 禁止动作：假定"抛异常=没写成"（`:388-395` 的 finally 分支会推翻这个假设）。
- 回到可用：`refresh()` 后 `ready`，且目标变更的语义（例如 source 是否已 retired）与操作意图一致。

### 6.3 修复后的确认清单（每次修复都必须全绿才算回到可用）

1. `refresh()` 返回 `status === "ready"` 且 `reasons` 为空。
2. 每个 verified profile 的 `readPin` 成功（等价于 I5）。
3. 每个 pin 文件都能被某个 profile 认领，或在 `retiredHostIds` 中（等价于 I4）。
4. 引用扫描 `complete === true` 且所有引用的 hostId 都能解析到 profile 或 retired id（INV-1）。
5. `projects.json` / `session-catalog.json` 均不在 `needs-repair` 状态（`ProjectStore.ts:420-426`、`SessionCatalog.ts:1495-1497`）。
6. journal 不存在（或为 `committed` 且删除成功）。
7. tx 锁不存在。

---

## 7. 实现清单与风险

### 7.1 需要改动的文件

> "脏"= `git status` 显示的未提交改动（`M` = 已跟踪被改，`??` = 未跟踪新增），属于 Phase 1（位置模型）在建工作。**建议等这批落地（提交/稳定）后再动**，否则 rebase 冲突与"哪个版本是基线"问题会直接落到跨 store 事务这种最不该有噪音的地方。

**A. 新建（干净树）**

> **落地状态（`9d0710470`）**：第 **1 / 2 / 4 / 7 / 8** 项已落地；同时落地了两处**不在原清单里**的文件 —— `tests/hostRebindJournal.test.mjs`（journal + tx 锁 + 收敛，吸收了原第 5/6 项里"逐记录 CAS、幂等重放、每个崩溃点"的部分）与 `tests/remoteHostStoreLifecycle.test.mjs` 追加的 3 个用例（注册表接入、不完整扫描拒写、无 provider 的编辑 fail-closed）。第 **3 / 5 / 6 / 9** 项**仍未实现**：协调器（`plan`/`rebind`/`describePending`）与 `plan()` 阶段的冲突检查完全不在本切片。

| # | 文件 | 内容 | 状态（`9d0710470`） |
| --- | --- | --- | --- |
| 1 | `src/main/remote/RemoteHostReferenceRegistry.ts` | 4.1 的注册表（含 `complete` 语义） | **已落地**（217 行） |
| 2 | `src/main/remote/HostRebindJournal.ts` | 4.3 的 journal 读写（复用 `writeDurableJsonFile`）+ §5.1 的 **tx 锁** + §5.4 的**收敛算法**（原清单把收敛放在第 3 项的协调器里，实际落在本文件）+ §4.4 的**端口契约类型与规范器** `canonicalHostLocatorJson` | **已落地**（**674 行 → `295877d8e` 拆分后 361 行**；tx 锁与收敛分别落在 `HostRebindTxLock.ts`(155) / `HostRebindConvergence.ts`(343)，拆分结果见 §7.4 风险 5） |
| 3 | `src/main/remote/HostRebindCoordinator.ts` | 4.2 的协调器：`plan` / `rebind` / `describePending` / 对 `resume` 的 `resumePendingRebind()` 包装（计划文档已预留该文件名，`docs/remote-development-plan.md:282`） | **未实现** |
| 4 | `src/main/remote/RemoteHostRepair.ts` | 4.5 的修复原语 + `diagnose` | **已落地**（526 行） |
| 5 | `tests/remoteHostRebind.test.mjs` | 计划、冲突、逐记录 CAS、幂等重放 | **未实现**；逐记录 CAS 与幂等重放已由第 6 项那个文件覆盖（`tests/hostRebindJournal.test.mjs:201`、`:253`），`plan()` 的冲突检查仍无测试 |
| 6 | `tests/hostRebindJournal.test.mjs`（原清单写作 `tests/remoteHostRebindRecovery.test.mjs`） | 5.4 表中每个崩溃点一个用例（stub 端口注入 + 真实 journal 文件） | **已落地**（461 行；`:228` 的用例断言"每个崩溃点收敛到与不中断跑完相同的终态"） |
| 7 | `tests/remoteHostReferenceRegistry.test.mjs` | 不完整扫描、源抛错、未注册源 | **已落地**（188 行） |
| 8 | `tests/remoteHostRepair.test.mjs` | 6.2 各类分诊的允许/禁止动作 | **已落地**（429 行） |
| 9 | `tests/remoteHostCrossStoreContract.test.mjs` | INV-11 的**正则扫描契约测试**：扫 `src/shared/types/*.ts` 与两个 codec 里的 `hostId` 字段，断言每个都归属一个已登记引用源 | **未实现**（INV-11 目前仍靠 code review 兜） |

**B. 修改 remote 域（干净树）**

| # | 文件 | 改动 | 测试断言建议 |
| --- | --- | --- | --- |
| 10 | `src/main/remote/RemoteHostStore.ts` | `references` 换成 4.1（或新增入口，保留旧名兼容）；provider 异常映射为 `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`；`updateDraft` 无 provider 时也要 fail closed；锁文件写入 owner 元数据；`forgetTrustAnchor` 的 store 级写入口 | **部分已落地**：新增 `referenceRegistry` 入口并保留 `references`（当前 `:232`；两者同时传视为歧义并拒绝，`:94`）、注册表码原样透出（`:353-355`）、`updateDraft` fail-closed（`:272`）、两个 main-only 修复写入口 + `mutateRepair`（`:446-486`、`:494-535`）。**仍未做**：锁文件写入 owner 元数据（当前 `:544` 仍写空锁）。测试建议不变，另加"修复写入口只在属于自己那一类 reason 下可写"（`tests/remoteHostRepair.test.mjs:304`） |
| 11 | `src/main/remote/SshHostPinStore.ts` | 新增只读 `listPins()`（供 `diagnose()` 与孤儿判定）；`readPin` 失败区分 `ENOENT` 与内容不匹配（新的稳定码，避免 6.2 B 的误诊）；**新增 main-only reverify API** —— 把 private 的 `verifierFor()`（`:110-115`）暴露成例如 `reverifyRoute(route, hostId)`，供 4.5 的 `HostRepairPinPort.verifyRoute` 注入（今天装配方只能用导出的 `verifyDraftSshHost`（`SshHostVerifier.ts:147`）+ 自建 `SshClientRuntime` 顶替，那会与 pin store 内部解析出的客户端实例分叉，违反"探测一个客户端、启动另一个"的禁令） | 缺失 vs 篡改返回不同码；`listPins` 不返回 pin 内容（只有 hostId/size/sha256）；reverify API 不接受调用方提供的端点字段，也不改写 pin。注意落地实现已经在 `RemoteHostRepair.orphanPinHostIds()` 里直接 `readdir` 扫 pin 目录（`:456-475`），`listPins()` 剩下的收益是把 pin 根的所有权收回 pin store **【推断】** |
| 12 | `src/main/remote/SshVerifiedConnection.ts` | 显式断言：pending journal / tx 进行中 ⇒ `SSH_HOST_NOT_READY`（现状已隐式满足，需固化） | 有 journal 时 `buildPinnedSshInvocation` 抛 `SSH_HOST_NOT_READY` 且不执行 `ssh -G` |
| 13 | `src/main/remote/RemoteHostStoreCodec.ts` | 若要保留"已退役主机的展示名"，需要 schema 变更；否则**不动**（见第 8 节 Q3） | 若改 schema：新增字段必须向后兼容（旧 `retiredHostIds: string[]` 仍可读） |

**C. 触碰 Phase 1 脏文件（建议等其落地后再动）**

| # | 文件 | 脏状态 | 改动 | 测试断言建议 |
| --- | --- | --- | --- | --- |
| 14 | `src/main/projects/ProjectStore.ts` | **M（脏）** | 实现 `readHostRecordLocators()` / `applyHostRebind()`（4.4；引用集合由 4.1 的 provider 提供，端口里**没有** `listHostReferences()`）；`remove()` 前做 interlock 检查。**落地形态**：只读端口已实现（`:441-450`，如实返回 local locator）；写端口**一律拒绝** —— 非空补丁直接抛 `PROJECT_STORE_REMOTE_UNSUPPORTED`（`:457-462`），不经过 `save()`、不碰磁盘；能力声明 `canHoldHostReferences = false`（`:38-43`） | **本行的写断言建议在 `PROJECT_STORE_REMOTE_UNSUPPORTED` 放开前不可能成立 ⇒ 标为 Phase 3**："逐记录 CAS：changed/missing ⇒ 整次不写"与"重放 ⇒ `already-applied` 且 revision 不变（幂等）"这些断言今天**一条都不可能观测到**（端口连一次写都不会发生），它们随 Phase 3 放开开关一起生效。**今天可断言的只有**：空批次 ⇒ `[]`、非空批次 ⇒ `PROJECT_STORE_REMOTE_UNSUPPORTED`、`projects.json` / `.bak` 逐字节不变、revision 不前进（`tests/hostRebindStorePorts.test.mjs:200-226`），以及"每个请求的 recordId 都必须回一条 snapshot（记录已删 ⇒ 缺省 locator）"（`:189-197`）。**逐记录 CAS 与幂等重放的可执行断言全部在 sessions 侧**（`tests/hostRebindStorePorts.test.mjs:340-396`） |
| 15 | `src/main/projects/projectStoreCodec.ts` | **??（Phase 1 新增，未跟踪）** | 决定 `PROJECT_STORE_REMOTE_UNSUPPORTED`（`:81`）的去留。**Phase 3 之前建议保留**：一旦放开，就必须同时上线 SSH 项目的 containment 校验（计划 §12 Phase 3 门禁），否则等于提前开启半成品能力 | 保留：ssh locator ⇒ 抛 `PROJECT_STORE_REMOTE_UNSUPPORTED`；放开：必须新增"缺 hostId/remotePath 拒绝"+ 契约测试。注意同一个码**也被写侧复用**（端口拒绝任何补丁，`ProjectStore.ts:457-462`；§4.4），放开时两处必须一起改 |
| 16 | `src/main/sessions/SessionCatalog.ts` | **M（脏）** | `readHostRecordLocators()` / `applyHostRebind()`；catalog 无 revision ⇒ 只能逐记录 CAS（4.4）。**origin 冲突检查不在端口里**（见右栏） | 同 #14 的 sessions 版本（逐记录 CAS / 幂等重放已在 `tests/hostRebindStorePorts.test.mjs:340-396` 固化）。**`REMOTE_HOST_REBIND_ORIGIN_CONFLICT` 不属于端口层**：端口只做逐记录 CAS（`SessionCatalog.ts:738-787`），且 `hostRebindTargetLocator` 只接受"仅 hostId 变化"的补丁（`:375-386`），端口里没有任何 origin/去重检查；该码今天**只有声明、没有产出点**（`HostRebindJournal.ts:116`）。它归 `plan()` —— §4.2 的 plan 失败表已把它列在协调器一侧，而协调器仍未实现（§7.1 第 3 项）。所以"同一 host 下重复 `remoteSessionId` ⇒ `REMOTE_HOST_REBIND_ORIGIN_CONFLICT`"这条用例必须等 `plan()` 落地后才能写，**不能**写成端口用例 |
| 17 | `src/main/sessions/SessionLocatorRouter.ts` | **??（Phase 1 新增）** | 不改：ssh 抛 `UNSUPPORTED_PROJECT_LOCATION`（`:15`）是目标语义 | 只加测试：rebind 后 ssh locator 仍不可进本地 fs 路径 |
| 18 | `src/shared/locationAdapters.ts` | **??（Phase 1 新增）** | 建议新增 `canonicalLocatorJson(locator)`（固定键序）供 before/after 比对；**不要**在这里做 rebind 逻辑 | 同一 locator 不同键序 ⇒ 同串；ssh 分支不产出 legacy 字段（`:48` 已如此） |
| 19 | `src/shared/types/project.ts` / `src/shared/types/session.ts` | **M（脏）** | 仅在需要"引用索引"时才动类型；建议不动（`hostId` 已在 locator 里，见 `project.ts:3`、`session.ts:108`） | 类型不加测试，靠 #9 的契约扫描 |
| 20 | `src/main/index.ts` | **M（脏）** | 装配：构造 registry + coordinator + repair port；**在暴露 IPC/启动扫描之前**调用 `resumePendingRebind()`（计划 `docs/remote-development-plan.md:255`） | 启动序列契约测试：恢复调用早于 IPC 注册 |
| 21 | `src/main/ipc/projectsIpc.ts` | 干净 | interlock：`projectsRemove`（`:95-111`）在 tx 进行中拒绝，或改为经协调器 | journal 存在 ⇒ 返回 `REMOTE_HOST_REBIND_IN_PROGRESS` 且 projects.json 未变 |
| 22 | `src/main/ipc/sessionIpc.ts` | **M（脏）** | 同 #21（会话删除/归档路径） | 同上 |
| 23 | `src/main/sessions/SessionRuntimeCoordinator.ts` | **M（脏）** | 可选：tx 进行中禁止 attach 到 source 引用（现状已对 ssh 全线 fail closed，`:960`、`:1269`） | ssh locator 依然不可 attach；新增"引用指向 retired id ⇒ 稳定码而非崩溃" |
| 24 | `src/shared/i18n/mainProcessCopy.ts` | 干净 | 新稳定码的用户文案（按 `SessionCommandIpcError.ts:11-20` 的 code→copy key 映射模式） | `typecheck` 能强制覆盖全部新码 |

**D. 本次落地后补出的条目（`9d0710470` 之后）**

| # | 文件 | 改动 |
| --- | --- | --- |
| 25 | `src/main/remote/RemoteHostPaths.ts`（新增） | `resolveRemoteHostPaths(userDataDir)` 作为远程主机域**磁盘根的唯一来源**：`remote-hosts.json`(+`.bak`) / `remote-hosts.json.lock` / `ssh-host-keys/` / `remote-host-rebind.json`(+`.lock`)。今天这四类路径各自派生：`RemoteHostStore.ts:133`、`:167`、`:191`、`:226`（store 文件 / 锁 / pin 根，其中 pin 根在 store 与 pin store 各拼一次）、`SshHostPinStore.ts:101`、`RemoteHostRepair.ts:188-189`（还额外提供 `paths.pinRoot` / `paths.hostLockFile` 覆盖 —— 这正是漂移入口）、`HostRebindJournal.ts:280-281`（journal 与 tx 锁路径；`295877d8e` 拆分后仍在原模块）；`RemoteHostRepair.hasActiveWriteTemp()` 里的 `remote-hosts\.json\..*\.tmp` 正则（`:445`）是同一 basename 的第五处字面依赖。这呼应 `AGENTS.md`「同一磁盘根必须同源」；同源入口的既有先例是 `src/main/index.ts` 的 `resolveBuiltInExtensionRoots()` 与 `resolveImageGenStorageRoots()`。**推断**：同源后，`RemoteHostRepair` 的 `paths?` 覆盖应从生产装配里消失（只留给测试），否则"测试与生产走不同根"的漂移仍然存在 |
| 26 | `src/main/remote/HostRebindJournal.ts` / `src/main/remote/RemoteHostRepair.ts`（拆分） | 拆分前两者都已超 400 行目标（`HostRebindJournal.ts` 617 → **674 行**，已越过 600 行的"必须评估拆分"线；`RemoteHostRepair.ts` 526 行）。**`HostRebindJournal.ts` 已在 `295877d8e` 拆成三块**（361 / 155 / 343 行，见 §7.4 风险 5）；`RemoteHostRepair.ts`（526 行）**仍未拆**，边界建议见 §7.4 风险 5 |

**不建议改**：`SshCommandBuilder.ts`、`SshHostVerifier.ts`、`RemoteControlClient.ts`、`RemoteHostConnectionState.ts` —— 跨 store 事务不触碰 argv/协议/连接状态机（`needs-attention` 是连接层概念，与 store 的 `needs-repair` 是两回事，见 `RemoteHostConnectionTypes.ts:8` 与 `RemoteHostStore.ts:9`，**不要合并这两个状态**）。

### 7.2 测试断言建议（要点）

- **幂等**：同一个 `rebind()` 连续调用两次 ⇒ 第二次全部 `already-applied`，`revision` 与记录内容不变。
- **阶段原子性**：在每个阶段后注入"崩溃"（stub 的端口实现抛错），重启收敛 ⇒ 终态等于不中断跑完的终态（INV-5）。
- **不复活**：journal 记录的 projectId 在收敛前被删除 ⇒ `REMOTE_HOST_REBIND_RECORD_MISSING` 且**不重建**记录（INV-6）。
- **信任不继承**：target 未 verified / pin 不可读 ⇒ `plan()` 拒绝；source 的 fingerprint 绝不出现在 target profile 或 target pin 中（字符串级断言）。
- **锚点保护**：任意收敛路径后 `ssh-host-keys/<retiredId>` 可能残留（容忍），但 `ssh-host-keys/<targetId>` 必然存在且 sha256 未变（INV-4）。
- **退役不可逆**：`retire` 后 `createDraft` 无法产出同一 id（`REMOTE_HOST_ID_REUSED`，`:294`）；引用写入侧对 retired id 必须返回稳定码。
- **引用完整性扫描**：直接断言 `projects.json`/`session-catalog.json` 里所有 ssh locator 的 hostId 可解析（INV-1 的"每次测试收尾都跑一遍"形式）。
- **fail closed**：`needs-repair` / journal 存在 / tx 锁被占 三种情况下，`buildPinnedSshInvocation` 与 `rebind` 都返回稳定码，且**没有**任何文件被修改（对比测试前后的目录哈希）。
- **崩溃后不删锚点**：在 `source-retired` 之后、pin 清理之前注入崩溃 ⇒ 重启后 target pin 仍在、source pin 最多被 prune（INV-4）。
- 回归护栏：#9 的契约扫描测试在有人新增 `hostId` 持久化字段而不登记引用源时必须失败。

### 7.3 三个最大风险

**风险 1｜引用源漏登记 ⇒ `retire` 硬删仍被引用的主机（数据/信任不可逆）。**
成因是 G1：接口无法表达"扫描不完整"，且 `retire` 只看集合成员（`RemoteHostStore.ts:267-268`）。Phase 3 一旦放开 `projectStoreCodec.ts:81`，`ProjectStore` 立刻成为新的引用源，而它今天连读都被拒绝——最容易出现的错误就是把扫描实现成"只扫 sessions"并当作完备。
缓解：注册表 + `complete` 硬失败 + 契约扫描测试（#9）+ `retire` 前的保守并集扫描 + `retire` 之后的第三次事后扫描与补偿迁移（5.3 步骤 4/5）。**这条必须在实现顺序上排第一**：没有它，其余设计都在保护一个可能不成立的引用集合。

**风险 2｜与普通 mutator 的交错（TOCTOU）产生"退役后才出现的引用"。**
成因是 G4：两个 store 没有跨进程锁与磁盘 CAS（`ProjectStore.ts:463-465`；`SessionCatalog.ts:84-89`），多版本并行是产品既有行为。设计上已明确放弃"严格互斥"（5.3），改为"可检测 + 可补偿"。残余风险是补偿本身也可能失败（例如并发把项目删了），此时只能停在可诊断状态并转人工。
缓解：advisory interlock + 逐记录 CAS + 事后扫描补偿 + `REMOTE_HOST_REBIND_STALE_PLAN`/`_RECORD_MISSING` 明确转人工；中期建议在 Phase 3 给这两个 store 补同源持久锁，把保证升级为严格互斥。

**风险 3｜单点损坏把整个主机 store 变成只读，人工"修复"反而毁掉信任锚（G6/G7）。**
成因是 store 级 `needs-repair` 语义（`RemoteHostStore.ts:139`、`:350`）叠加 `pinIssues` 的严格检查（`:79-86`）：一台主机的 pin 丢了，所有主机的管理动作全部拒绝；而"删 pin 让校验通过"是最省事的假修复。
缓解：4.5 的修复原语（尤其 `forgetTrustAnchor` 与 `discardOrphanPin` 的分工）+ 6.1 的三条铁律 + `HOST_REPAIR_ANCHOR_STILL_VALID` 之类的反向保护 + 6.3 的确认清单。中期建议评估"坏档案隔离"（只让受损 hostId 不可写、其余仍可管理），但那是 store 语义变更，需要单独评审。

### 7.4 未决风险（本次落地留下，2 条）

**风险 4｜A1 的生产绑定缺失：`verifyRoute` 只能由装配方注入，未注入时 A1 与 A 类诊断在生产不可用。**
事实：`HostRepairPinPort.verifyRoute(route, pinAlias)`（`RemoteHostRepair.ts:54`）是 A1 重新认证活主机的唯一入口，而它需要的能力 —— "用 pin store 自己那个 `SshClientRuntime` 跑一次 `ssh -G` + host key 候选验证" —— 目前是 private：`SshHostPinStore.verifierFor()`（`SshHostPinStore.ts:110-115`）与它惰性解析的 `resolvedClient`（`:112`）都不对外暴露，模块内的 `pinDigest`（`:32-35`）同样不可调用。装配方今天只有两条路：(a) 用导出的 `verifyDraftSshHost(route, pinAlias, { client })`（`SshHostVerifier.ts:147`）配一个**自建**的 `SshClientRuntime`；(b) 让 `SshHostPinStore` 暴露一个 main-only 的 reverify API（§7.1 第 11 项）。诊断侧同样受影响：`diagnose()` 把 `REMOTE_HOST_PIN_ORPHAN` 映射成 `["complete-activation-from-pin", "discard-orphan-pin"]`（`:205-207`），其中 A1 在生产不可执行 ⇒ 用户拿到的建议里有一条是空动作。缓解：A2（`discardOrphanPin`）不需要 `verifyRoute`，仍是可执行的兜底；但 A2 会丢弃 pin（重新激活必须重做一次完整确认），所以它不是 A1 的等价替代。**【待确认】** 选 (a) 还是 (b) 需要装配层拍板；倾向 (b)，理由是"客户端实例的所有权留在 pin store"能避免 (a) 带来的双客户端分叉。

**风险 5｜两个模块已超 400 行目标，其中一个已越过 600 行的评估线；拆分已在 `295877d8e` 落地，剩 `RemoteHostRepair.ts`。**
事实：`9d0710470` 后的当前工作树里 `HostRebindJournal.ts` 已从 617 涨到 **674 行（非空 615）**，越过 600 行的"必须评估拆分"硬线；`RemoteHostRepair.ts` 526 行（非空 483）、`RemoteHostStore.ts` 586 行（非空 549）、`RemoteHostReferenceRegistry.ts` 217 行（非空 192）均逼近 400 行目标。
**拆分已落地（`295877d8e`）**：实际边界与本文原先的建议一致（模块名也照用），下表按现状给出：

| 模块（现状） | 搬走了什么 | 实测规模 | 拆分前位置（674 行基线） |
| --- | --- | --- | --- |
| `HostRebindTxLock.ts`（新） | tx 锁：`HostRebindTxLockOwner` 类型、`MAX_LOCK_BYTES`（`:30`）、`currentBootId`（`:65`）、`defaultIsProcessAlive`（`:69`）、`classifyRebindTxLockOwner`（`:86`）、`acquireRebindTxLock`（`:120`）、`REBIND_TX_LOCK_UNWRITABLE`（`:28`） | **155 行** | `HostRebindJournal.ts:156`、`:158`、`:243-257`、`:610-673` |
| `HostRebindConvergence.ts`（新） | 收敛：`convergeRebindJournal`（`:160-205`，含 roll-forward 与最终扫描）、`advance`（`:207-212`）、`classify`（`:249-274`）、`applyStore`（`:276-294`）、`classifyRebindRecord`（`:112-117`）、`classifyRebindResult`（`:126-133`）、`asStableError` 折叠（`:97-101`）、`assertStorePort`（`:150-152`） | **343 行** | `HostRebindJournal.ts:421-608` |
| `HostRebindJournal.ts`（保留） | 端口/journal 契约类型（`:28-101`）、稳定码词表（`:104-155`）、`canonicalHostLocatorJson`（`:190-202`）、`assertHostRebindRecordIds`（`:214-217`）、`decodeRebindJournal`（`:224-257`）、文件 I/O（`read` `:296-320` / `write` `:327-334` / `remove` `:336-342`）与 `resume` 外壳（`:350-360`） | **361 行** | `HostRebindJournal.ts:1-419` 的剩余部分 |
| `RemoteHostRepairDiagnosis.ts`（**仍未拆**） | `diagnose()` + 孤儿/坏锚点扫描（只读） | 建议 ≈ 70 行 | `RemoteHostRepair.ts:200-235`、`:456-488` |
| `RemoteHostRepairPrimitives.ts`（**仍未拆**） | 四个原语 + pin 检查/锁检查 | 建议 ≈ 160 行 | `RemoteHostRepair.ts:242-355`、`:388-415` |

> **仍然超线的是 `RemoteHostRepair.ts`（526 行）**：拆分边界按上表最后两行，且它的行号未受 `295877d8e` 影响（该提交只改了它 1 行 import：`RemoteHostRepair.ts:21` 现在 `import { currentBootId } from "./HostRebindTxLock"`）。**注意这条 import 边的归属已按当时的"耦合风险"处理完毕**：拆锁时先把边指向了新模块，没有再导出环。
> **可选（若要把 `HostRebindJournal.ts` 也压到 400 行以内）**：把 §4.4 的端口契约类型 + `canonicalHostLocatorJson` + `assertHostRebindRecordIds` 单独立成 `HostRebindPorts.ts`（现 `:50-101`、`:182-217`），两个 store 与收敛模块都从它 import；这样它会降到 ≈ 250 行。**代价**是 `canonicalHostLocatorJson` 的 import 路径要改两处（`SessionCatalog.ts:9`、`ProjectStore.ts:9`）。**【待确认】** 是否连这一步一起做，由落地者按当次改动面拍板（`295877d8e` 选择了"不拆端口契约"，因为契约与码表同源、拆开反而多一条 import 边）。

成本与风险：本次拆分为纯搬迁 + 导出调整，没有状态语义变化；测试也是端口注入（`tests/hostRebindJournal.test.mjs:33-136` 的 stub 端口），拆完用例不需要改，`295877d8e` 另加了两个模块级用例（`tests/hostRebindTxLock.test.mjs`、`tests/hostRebindConvergence.test.mjs`）。

---

## 8. 待确认问题（需产品/用户拍板）

| # | 问题 | 我的推荐答案 | 理由 |
| --- | --- | --- | --- |
| Q1 | 被项目/会话引用的主机能否"强制退役"（force retire）？ | **不能**。只允许 disable → （迁移引用后）retire；提供"迁移并退役"（rebind）与"先删引用再退役"两条显式路径 | `retire` 要求引用为空（`RemoteHostStore.ts:248`）是唯一能保证 locator 不悬空的机制；强制退役会让项目/会话记录永久指向不存在的档案，而 retired id 永不复用（`:294`）意味着**没有任何自动修复的可能** |
| Q2 | rebind 是否必须重新做一次完整 fingerprint 确认？ | **必须**。target 必须是独立走完 offerPin/confirmPin 的 verified 档案；禁止任何形式的锚点/指纹继承，包括"同一 endpoint 只换 identityFile"的场景 | 指纹是用户对"这台机器"的确认；把它搬到新 hostId 等于把确认语义扩大到一个用户从未看过的新状态。计划 §5.2 也明确"rebind 不继承 project trust，必须在新端点重新确认"（`docs/remote-development-plan.md:247`）。代价是换 key 也要重新确认，接受 |
| Q3 | 会话历史里的 hostId 在退役后如何展示？ | **不需要特殊展示**：因为退役前引用必然已迁走，正常路径下不存在"引用指向 retired id"的历史条目。若产品要在审计视图里显示"这个会话曾经属于某主机"，需要把展示名快照进 retired 记录（schema 变更）——建议**先不做**，等有真实诉求再加 | 现状 `retire` 只保留 id（`:250`），label 一并消失；要展示就得改 schema，而 `RemoteHostStoreCodec.ts:107-129` 是严格白名单解码，改动要连 migration 一起做。**【待确认】** 是否有产品场景真的需要"已退役主机名" |
| Q4 | rebind / 修复原语是否需要高风险确认（`PendingConfirmationBroker`）？ | **需要**，全部绑定 (txId, source, target, 记录集 digest, expectedRevision) | 会改写多台主机引用关系的是高风险动作；仓库既有模式就是 main-only pending + 一次性 sender 绑定（`SshHostPinStore.ts:134`、`:159`，计划 §14.1 `docs/remote-development-plan.md:805`）。无 UI 阶段可以先由主进程函数 + 显式 requestId 实现，接口不变 |
| Q5 | 崩溃后自动收敛（roll-forward）是否需要用户确认？ | **引用迁移与 retire 自动收敛；任何"降信任/删锚点"动作必须人工确认** | 收敛本身不改变信任关系（target 早已独立验证），中断在"半迁移"状态比自动完成更危险；而删 pin / `forgetTrustAnchor` 会降低信任，不能自动 |
| Q6 | `PROJECT_STORE_REMOTE_UNSUPPORTED`（`projectStoreCodec.ts:81`）在 Phase 3 之前是否放开？ | **不放开**，但必须现在就实现 ProjectStore 的引用扫描端口并在"无 ssh 项目"时声明 `canHoldHostReferences=false` | 放开就等于提前开启 Phase 3 能力（远端 browse root containment、文件/Git 路由都还没落地，计划 §12 Phase 3 门禁）；但端口先建好，可以让放开的那个 PR 只改开关而不是补事务 |
| Q7 | 坏档案（pin 丢失）造成的 store 级只读，是否接受"全局停写"？ | **短期接受**（fail closed 优先），但要求 6.2 B 的修复路径可用；中期评估"坏档案隔离" | 现状是 store 级判断（`:139`、`:350`），改成 per-host 可写会放松 `needs-repair` 的语义，属于安全语义变更，需要单独评审而不是顺手做 |
| Q8 | journal 文件是否要 `.bak`？ | **不要**。journal 丢失的后果是"合法但半迁移"，可用同一对 source/target 重跑（5.3） | 加备份会引入"哪份 journal 权威"的第二个 CAS 问题，收益（少一次人工重跑）远小于复杂度 |
| Q9 | 引用扫描是否需要覆盖运行期（非持久化）状态？ | **不需要**，只扫持久化引用；运行期条目在重启后消失，且任何使用点都必须对"hostId 已退役/档案缺失"fail closed | 把运行期状态纳入引用集合会让 `retire` 依赖瞬时状态，产生不可复现的拒绝；正确做法是使用侧 fail closed（`SshVerifiedConnection.ts:31` 已是此模式） |
| Q10 | `needs-repair` 与连接层 `needs-attention` 是否统一为一个状态？ | **不统一** | 两者生命周期与责任人都不同：store 的 `needs-repair` 是磁盘一致性（`RemoteHostStore.ts:9`），连接层 `needs-attention` 是终态连接失败（`RemoteHostConnectionTypes.ts:8`，只允许显式 `user-retry` 离开）。合并会让"删掉锁文件就能修"之类的误判渗进连接状态机 |
