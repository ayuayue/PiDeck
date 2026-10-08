# PiDeck SSH 远程开发 — 协作与交接

> 当前开发分支：`feat/remote-development`。代码核对基线：`d01464f0`；首次交接提交：`a663947c`。
> 本页是协作入口：实现状态、下一批任务、验收与验证方法。架构和发布范围见 [实施计划](remote-development-plan.md)，跨 store 设计见 [事务设计](remote-host-cross-store-design.md)。
> 文档中的任务包是待实施工作，不表示已分配给具体开发者或已创建 GitHub issue。

## 1. 当前能做什么

远端功能仍限定为开发构建且显式设置 `PIDECK_REMOTE_EXPERIMENTAL=1`。正式包不开放这些能力。

| 能力 | 实现与验证状态 |
| --- | --- |
| 主机添加、独立核验指纹、严格 pin、连接、诊断与修复 | 已接开发态 UI/IPC；Linux 客户端到 Linux 远端有实机证据，不能据此宣称所有平台验收完成 |
| Node 定位、helper 上传与 finalize、连接状态机、NDJSON 控制客户端 | 已接开发态应用链路；有离线测试与实机 `BOOTSTRAP_FINALIZED` 证据 |
| 确认目录后列目录、读文件、拒绝越界 | 第一段设置页浏览已实机验收；与项目读取共用 helper 的根切换仍有下文所列缺口 |
| SSH 项目持久化、登记确认、按 `projectId` 只读浏览 | 已提交，相关定向测试通过；第二段尚无完整 Electron/实机验收，Phase 3 未收口 |
| 跨 store rebind | journal、tx 锁、收敛算法及 store 端口已有实现；应用协调器与严格跨 store 写入互斥仍缺失 |
| 远端 pi RPC | 曾完成一次 `get_available_models` 成功往返；尚未接入应用的远端 Agent/Session 生命周期 |
| 搜索、远端 Session 扫描、写文件、Git、终端 | 尚未开放；不能回落到本地实现 |

**已接线的调用链**：`main/index.ts` → `RemoteHostConnectionService` → `bootstrapPinnedHost` → `RemoteBootstrapDeployment` → upload/finalize；连接 manager/attempt 消费 `RemoteControlClient`。修复也已有 IPC。不要把这些模块当作“只有脚本会调用”的桩，也不要只凭 `index.ts` 有没有直接 import 判定可达性。

`HostRebindJournal.resume()` 内部已有收敛调用；欠缺的是应用层协调与恢复入口，不是重新实现 journal 算法。源码与长计划中部分“尚未装配”注释来自旧阶段，判断当前行为应追踪调用链。

## 2. 完成目标与顺序

| 里程碑 | 用户能完成的操作 | 完成判据 |
| --- | --- | --- |
| M1：远端项目可靠可用（Phase 3 收口） | 侧栏“+”添加远端目录，立即出现项目；多项目切换只读浏览；重启找回项目；断线/根漂移有明确反馈；只读搜索与 Session 发现 | 下方 A/B/C 集成验收通过，补齐搜索/扫描与 UI/实机测试；仍是开发态预览 |
| M2：远端编码实验版（Phase 4） | 在远端项目新建会话、发送、流式接收、停止、重启和恢复；随后完成计划中其余 Session 生命周期与配置能力 | 双会话事件隔离、断线不重复发送、历史由远端 pi 管理；完整 Phase 4 门禁通过后才称实验 beta |
| M3：Remote v1（Phase 5） | 远端文件修改、基础 Git 工作流和 SSH 终端，以及计划要求的跨平台体验 | 实施计划 §13 的“必须”项与 Phase 5 发布门禁全部通过，才开放稳定版 |

关键顺序：**先完成 A/B/C 的项目读取和持久化边界 → 补齐 Phase 3 搜索/扫描 → Phase 4 会话闭环 → Phase 5 写操作/Git/终端**。
Phase 4 的接口梳理与 mock 测试可以并行准备，接入依赖已验收的项目/root 与 Session 身份契约。多 root helper、传输替换、自带 Node 分发、端口转发等另行排期。

## 3. 第一批可分工的任务

A/B/C 可由不同开发者并行，D 随开发跟进。每块指定一个负责人；同一集成文件由一个人协调，避免多人同时改同一个大文件。这里分配的是职责，不额外引入审批流程。

| 任务包 | 主要修改范围 | 依赖与验收 |
| --- | --- | --- |
| **A：项目读取与确认边界** | `src/main/ipc/remoteHostIpc.ts`、`src/main/remote/RemoteHostConnectionService.ts` 及同域模块 | 保持已选定的单主机单 helper/root；把切根、ready 判定、整次列目录/分块读文件放进同一受控操作。B 可先复用现有 project IPC；A 统一维护 shared/preload/preview 契约与废弃通道清理 |
| **B：项目入口与 UI 状态** | `ProjectTree.tsx`、侧栏动作接口、远端项目登记对话框、`ConnectionsTab.tsx`、`RemoteProjectPanel.tsx`、i18n | 设置页只留设备管理；侧栏“+”进入远端登记，成功后刷新并选中新项目；异步旧结果不能覆盖新项目。`App.tsx` 只装配 |
| **C：持久化与主机引用一致性** | `ProjectStore.ts`、`projectStoreCodec.ts`、`RemoteHostReferenceSources.ts` 与定向测试 | 写入口与读 codec 使用一致校验；扫描与 store 恢复语义一致；异常数据不得被判成“无引用”。把严格跨进程 CAS/跨 store interlock 的未完成部分明确记录，不能用当前内存比较代替 |
| **D：集成与验证** | 对应 `tests/*.test.mjs`、必要的 renderer/Electron 验证、交接状态 | 先复现并发/断线/迟到结果等行为，再验证修复；A/B/C 合在一起验证完整操作链。对比失败名称与断言，不只比失败数量 |

### A：必须覆盖的行为

- 当前 `rootSwitchByHost` **只串行 setRoot/connect**，`reader.list/readFile` 在队列外；A/B 两个项目仍可能互相切根。串行边界必须覆盖最后一块读取结束，并处理错误后队列继续工作。
- `getWorkspaceRoot()` 返回配置值，不能证明 live helper 已 ready。连接失败后或断线后读取同 root，要能正确恢复或明确返回不可用；不能因为字符串相同跳过连接状态检查。用户显式断开不能被后台读取悄悄撤销。
- 设置页旧 `remote:workspace-list/read` 仅用内存 root 放行，不重新对齐 helper。按 B 的已定方向删除这套临时浏览及旧 IPC；**删除它只解决旧入口问题，不解决项目之间的并发串根**。底层 `RemoteWorkspaceReader`、root resolver 和 helper 测试保留。
- 登记 offer 解析完路径后，approve 目前直接写库。确认时须复核主机状态及被确认路径；确认等待期间目录失效或 symlink 改指时拒绝写入，不能静默接受新目录。
- 持久项目重连时复核 canonical root；漂移/无法复核需拒绝读取并显示待处理状态。重连到同一路径字符串不等于重新验证了目录边界。

验收样例：同主机两个根下各放同名不同内容的文件，让 A/B/A 请求交错并跨多个读取分块；验证内容不会混用、失败可重试、断线不返回另一项目的数据。再覆盖不同主机可独立工作、根漂移与主机禁用发生在确认窗口内等路径。测试用可控替身，实机复核单独进行。

### B：已确定的产品行为

- 设置页仅管理主机添加、信任、连接/断开、诊断和修复；移除 `RemoteWorkspacePanel`。
- 侧栏“+”提供现有本地添加入口和“远端（SSH）”。保留当前本地/WSL 的真实选择行为，不包装成实际仍指向同一行为的假菜单项。
- 第一版远端登记：选已验证且未禁用的主机 → 输入路径 → 展示 canonical 路径确认 → 登记。无可用主机时引导设备设置。**这一版仍是路径输入，不宣称已有登记前远端目录树选择器**。
- 复用 `remote:project-enroll` / `remote:project-answer`；确认弹框只挂一处，按当前请求关联，卸载要退订。登记成功后显式刷新项目列表并选择返回的 `projectId`，不创建本地会话。
- `RemoteProjectPanel` 加请求代次或取消处理，忽略切项目后的迟到结果；处理 IPC reject，loading 必须结束，错误与空目录分别呈现。

验收操作：设置页加主机 → 侧栏加项目 → 立即显示并打开 → 切 A/B 项目 → 断线恢复 → 重启恢复；旧设置页不再能发文件浏览请求。

### C：已有代码不能替代的证明

- `addRemote()` 当前只检查非空，codec 对路径的检查更严格；scanner 要求 UUID hostId，codec 接受范围不同，写入/读取/引用扫描的有效值域需对齐。
- `scanPersistedProjects()` 对缺 locator 的记录直接跳过，未完整校验元数据和 remotePath；主文件/备份的扫描语义需与 store 选择有效 revision 的规则对照。
- `applyHostRebind()` 比较内存 locator 后排队保存，**不是跨进程 CAS**。缺记录结果、失败后恢复、批次校验及幂等行为仍需核验。
- 严格跨 store 锁与 rebind 协调器是独立交付项，必须在开放对应能力前完成；现有代码与测试不能被描述为事务安全已闭环。

## 4. M1 之后如何推进

1. **Phase 3 剩余只读能力**：目录/内容搜索与远端 Session 发现走 helper，由 catalog 保存远端 locator；不得把远端路径交给本地 scanner。结果数量、字节和超时必须有界。
2. **Phase 4 先做最小端到端会话**：沿现有 runtime 接口加入 SSH launcher，新建一个远端 pi 会话，完成发送 → 流式消息/工具事件 → 停止 → 重启恢复。扩展快照、trust、security artifact 和 pi 版本门禁是启用这条链路的前置条件。
3. **Phase 4 再补生命周期**：双会话隔离、断线处理、历史恢复、rename/archive/restore/remove/delete、edit/resend/fork/export 和目标主机的配置能力。所有事件绑定 `sessionId + agentId + runtimeGeneration`；不确定是否执行的 prompt 不能自动重发。
4. **Phase 5**：文件写入、Git、终端按领域分工，统一复用项目定位与 capability 边界；最后执行 §13 能力对照、安全与跨平台验收。Remote v1 不等同于“能聊天”。

完整范围与禁用项以实施计划 §12–13 为准；本页的先后顺序不删减已有发布门禁。

## 5. 开发与验证

完成仓库 [贡献指南](../CONTRIBUTING.md) 中的开发环境准备后，在 POSIX shell 启用：

```bash
PIDECK_REMOTE_EXPERIMENTAL=1 npm run dev
```

门禁位于 `src/main/index.ts`：`!app.isPackaged && process.env.PIDECK_REMOTE_EXPERIMENTAL === "1"`。目前主机管理和临时登记入口均在设置页“连接”，B 完成后项目入口才迁到侧栏。

日常只跑改动涉及的检查。例如 A 的读取/连接改动：

```bash
npm run typecheck
node --test tests/remoteHostIpc.test.mjs tests/remoteHostConnectionService.test.mjs tests/remoteBrowseRoot.test.mjs tests/remoteWorkspaceReader.test.mjs tests/remoteWorkspaceEndToEnd.test.mjs
```

C 对应 `projectStoreCodec.test.mjs`、`projectStoreMigration.test.mjs`、`remoteHostReferenceSources.test.mjs`；B 需更新 `settingsTabLayout.test.mjs` 并补实际交互状态覆盖。格式化仅涉及文件（`node_modules/.bin/biome format --write <files...>`）；集成时运行 `npm run check:format`。纯文档修改检查差异、链接与命令准确性即可。

**测试记录的边界**：在交接时 Linux/Node 24 环境，全量测试曾记录 **7181 项 / 7157 pass / 18 fail / 6 skip**；先前定向 129 项通过，类型和格式检查通过。全量并未全绿。失败涉及平台路径、编辑器/宿主环境、Git integration、旧 UI 与工作流契约等，不能全部归为 Windows 用例，也不能因为数量仍是 18 就认为没有回归。

需要基线对照时，在相同环境的独立干净 checkout 比较同名测试的失败断言；不要为跑基线 stash 或清理其他开发者的工作。跨域集成/合并前才扩大到 `npm test`，不为每个文档或局部改动重复跑全量。本任务未授权全仓库构建。

真机脚本的参数是 **IPv4、用户名、独立核验过的 ED25519 指纹**，不是只传 SSH alias：

```bash
node scripts/verify-remote-host.mjs '<IPv4>' '<user>' '<independently-verified-ED25519-SHA256-fingerprint>' --bootstrap
node scripts/verify-remote-connection-service.mjs '<IPv4>' '<user>' '<independently-verified-ED25519-SHA256-fingerprint>'
```

只替换成自己的已授权测试主机信息。这些脚本会连接并可能部署 helper；远端 Node 需 ≥22.3，执行需有界，失败即停。脚本通过仍不替代 Electron UI、多项目并发与 Session 生命周期验收。

## 6. 代码定位与协作方式

| 领域 | 入口 |
| --- | --- |
| 应用装配/IPC | `src/main/index.ts`、`src/main/ipc/remoteHostIpc.ts`、`src/shared/ipc.ts`、`src/preload/index.ts` |
| SSH/信任/生命周期 | `src/main/remote/SshVerifiedConnection.ts`、`SshHostPinStore.ts`、`RemoteHostStore.ts`、`RemoteHostConnectionService.ts`、`SshConnectionManager.ts` |
| helper 部署与读取 | `RemoteBootstrapSession.ts`、`RemoteBootstrapDeployment.ts`、`RemoteControlClient.ts`、`RemoteBrowseRoot.ts`、`RemoteWorkspaceReader.ts`（均在 `src/main/remote/`） |
| 项目与引用 | `src/shared/types/project.ts`、`src/shared/projectLocation.ts`、`src/main/projects/ProjectStore.ts`、`projectStoreCodec.ts`、`src/main/remote/RemoteHostReferenceSources.ts` |
| UI | `src/renderer/src/components/sidebar/ProjectTree.tsx`、`components/app/settings/ConnectionsTab.tsx`、`components/session/RemoteProjectPanel.tsx`（后两者相对 `src/renderer/src/`） |

远端 `Project` 只有 SSH locator，没有本地 `path`。用 `isLocalProject` / `isRemoteProject` 窄化；不能用 `as`、非空断言或默认 cwd 绕过。类型调整曾产生 71 个编译错误、涉及 21 个文件，这是一次检查结果，不是消费点穷尽证明；可选链和默认路径仍需按直接调用链审查。

建议不同开发者使用独立 checkout，从 `feat/remote-development` 开工作分支，PR 的 base 选 `feat/remote-development`。当前同一工作区的代理继续当前分支，避免并行切换污染彼此工作。每个 PR 包含单一可验收任务、验证结果和剩余缺口；接口/装配文件由集成负责人统一协调。

分支与 `main` 已分叉，这是普通 Git 合并情形，**不代表不能合并**。集成负责人单独处理与 main 的能力对照、冲突和验证；协作者不各自做大规模 rebase，也不强推共享分支。合并/发布另行执行已规定的门禁。

## 7. 不改变的边界

- 每台主机独立核验指纹，不采用首次连接自动信任（TOFU）；保持系统 OpenSSH、严格 pin 与路由复核。
- pi 负责 Agent、工具、模型与会话行为；PiDeck 管窗口、进程和 UI，经 stdio JSON-RPC 通信。
- 不复制本地秘密到远端，不把 remotePath 交给本地文件、Git、终端或 Agent 实现；不擅自改用户的 Node/SSH 环境。
- helper 当前要求远端 Node ≥22.3；版本探测使用实际选中的可执行文件，不用不同 Node 的探测结果代替。
- 所有未验收能力继续受开发态门禁约束；失败必须显式呈现，不能通过删断言或回落本地掩盖。

更多背景：[项目位置 ADR](project-location-architecture.md)、[WSL 位置基线](wsl-location-baseline.md)。
