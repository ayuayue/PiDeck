# PiDeck SSH 远程开发实施计划

> 状态：Proposed（未开工；开工前需按 §16 重新核验上游快照与 3.1 版本表）
>
> 文档维护约定：本文只保留决策（范围/架构/阶段门禁/能力对照）；§4.2 bootstrap、§6.5 终端握手、§7 协议帧等 implementation 级细节在对应 Phase 开工时拆出为独立 spec 并随代码演进，本文留指针。每个 Phase 收口时回填状态。
>
> 最后更新：2026-09-24（评审修订：snapshot 分块协议、remoteSessionId/标题来源、远端 Node 准入门控、部署锁机制与多客户端并存、helper 并发模型与延迟预算、命名统一；§16 补上游 client/server 采用预案与采用触发条件）
>
> 目标：让本地 PiDeck 通过 SSH 管理远程主机、远程项目和远程 Pi Session，并在不复制 Pi Agent 行为的前提下，逐步达到本地项目的核心使用体验。

## 1. 结论

PiDeck 应采用「本地 Electron UI + 系统 SSH + PiDeck 远端 helper + 远端 Pi stdio RPC」架构。

- PiDeck UI、会话编排和本地 catalog 仍运行在用户电脑。
- 远端主机上的 Pi 必须是实际执行 Agent、工具和模型调用的唯一主体。
- 每个远程 Agent runtime 使用独立 SSH 进程启动远端 `pi --mode rpc`，PiDeck 继续消费 Pi 官方 stdio JSON-RPC。
- 文件、Git、目录浏览、Session 扫描以及 PiDeck 已有的受限 Session 存储变换由 PiDeck 自带的轻量远端 helper 提供；helper 不 import Pi SDK，不实现 Agent、工具或模型行为。
- 首版不依赖 Pi 当前的实验性 client/server 体系。截至 2026-09-23，低层的 `@earendil-works/pi-client`、`pi-protocol`、`pi-server` 虽已随 `v0.87.1` 发布，但官方 README 仍明确标为 experimental；coding-agent 的 `./client` 与 `./experimental/plugin` 只有源码条件导出，server/client CLI 也仍位于实验源码并被正式包的 `dist` 排除。对 PiDeck 可承诺的 coding-agent 集成面仍是本地 SDK 与 stdio RPC。
- 为未来切换到 Pi 官方稳定远程协议保留 launcher/transport 接口，但不提前适配不稳定协议。

这与 Zed、VS Code Remote SSH 的成熟做法一致：本地保留 UI，远端部署版本匹配的执行组件，使用 SSH 认证和连接能力；与 Codex 的经验一致：远程运行必须显式区分配置、凭据、沙箱和工作目录的归属。

## 2. 范围与非目标

### 2.1 首个稳定版本范围

1. 添加、编辑、检测、删除 SSH 主机配置。
2. 在远端主机上添加已有目录或创建空项目。
3. 启动、停止和重启远端 Pi runtime。
4. 创建、扫描、打开、恢复、重命名、归档、移除索引和删除远端文件等远端 Session 生命周期；任何破坏性远端删除都单独确认。
5. 远端文件树、受限文件读写和文件名搜索（与本地 `searchNames` 能力对齐，不含文件内容搜索）。
6. 远端 Git 状态、diff、stage/unstage/discard、commit、基础分支、历史/refs/compare、fetch/push/pull 和 ahead/behind；禁用项必须显式呈现且不得回落本地 Git。
7. 打开以远端项目目录为 cwd 的终端。
8. 按目标主机管理 Pi models/settings，并在目标主机执行 provider 连接测试和模型目录拉取；秘密不回传本机。
9. 远端连接中断、版本不兼容和依赖缺失的可诊断错误。
10. 本地项目行为、旧设置和旧 Session catalog 完全兼容。
11. 远端首发仅支持 `backend: "pi"`、`source: "pi"`；DSH、imagegen 和其他来源的导入 Session 保持本地能力。

### 2.2 后续能力

- Git clone、worktree，以及 cherry-pick/revert/reset/drop 等高风险 Git 操作的完整远端体验。
- SSH 密码、键盘交互、硬件密钥和图形化 AskPass。
- 端口转发与远端 Web 预览。
- VS Code Remote / Zed SSH URI 外部编辑器跳转。
- 跨主机复制项目或 Session。
- 显式的设置、技能和扩展同步向导。
- 远端 checkpoint/rewind backend 与受管的本机附件上传。
- Windows OpenSSH Server 作为远端目标。

### 2.3 明确不做

- 不把远端目录挂载成本地文件系统。
- 不通过 HTTP/WebSocket 访问 Pi 内部。
- 不在 PiDeck 中重写 Pi 的工具执行、会话格式或模型调用。
- 不自动复制 `auth.json`、API key、SSH 私钥或其他凭据。
- 不把远端绝对路径交给本地 `node:fs`、本地 Git 或本地 shell。
- 不在网络中断后自动重放可能已被 Pi 接收的 prompt。
- 不将 Pi 源码中的实验性 client/server 作为生产依赖。

## 3. 调研依据

### 3.1 PiDeck 实际使用的 Pi 分发线

- PiDeck 当前安装、定位和认证适配的包是 `@earendil-works/pi-coding-agent`，因此产品兼容基准是其对应仓库 `earendil-works/pi`，不是看到同源仓库或任意 fork 就直接替换。原始上游 `badlogic/pi-mono` 用于跟踪共同演进背景，但不能替代实际分发包的 changelog、exports 和 CLI 行为验证。
- “Pi v2”不是一个可直接采用的 coding-agent 产品分支。截至 2026-09-23，公开的 `harness-v2/j4` 停在 2026-08-07，落后 `main` 数百个提交，且其提交内容已经继续演进到 v3/v4 Session 规范；`0.84.0` changelog 中的 “v2 Session / AgentHarness API” 指 `pi-agent-core` API 代际，不代表 Pi coding-agent 2.0 或远程开发产品已完成。

本计划核验的官方快照：

| ref | 核验提交 | 最近提交时间 | 判断 |
| --- | --- | --- | --- |
| `main` | `898ab804` | 2026-09-23 | 当前开发主线；比 `v0.87.1` 多 4 个提交 |
| `v0.87.1` | `f07218c4` | 2026-09-22 | 核验时最新正式 Release |
| `harness-v2/j4` | `f7f933c6` | 2026-08-07 | 过期研究分支，不是产品 v2 分支 |
| `feat/coding-agent-server-backend` | `515455fb` | 2026-08-03 | 14 个未合入的分支提交；后续主线已改走 Chord/service 架构 |
| `feat/unix-socket-cli` | `ba9339e8` | 2026-08-02 | 3 个未合入的 CLI 实验提交 |
| `experiment/client-capability-bindings` | `fec371a3` | 2026-07-24 | 1 个未合入的 capability binding 实验提交 |

这些分支用于理解设计演进，不作为 PiDeck 的依赖来源；每次真正开工或升级 Pi 前都必须重新核验主线、最新 tag 和 npm 产物，不能把上述 commit 当作永久版本锁。

官方能力的实际演进如下：

- Pi `0.84.0` changelog 曾宣布 experimental transport-neutral `PiClient`、CBOR 协议、Unix socket transport 和 remote-session controller。
- Pi `0.85.1` 明确说明此前意外发布了内部实验代码；coding-agent 的 `client`、`experimental/plugin` 子路径和 server/client 命令改为 source-only，本地 SDK 与 stdio RPC 不受影响。
- 在 `v0.87.1` 与当前 `main` 中，`@earendil-works/pi-client`、`@earendil-works/pi-protocol`、`@earendil-works/pi-server` 已作为独立 npm 包提供正常 `dist` exports；但它们的 README 仍明确声明 experimental，`pi-protocol` 没有兼容承诺，peer authentication 与 server/worker lifecycle 明确留给应用层。
- 同一版本的 `@earendil-works/pi-coding-agent` 只给根入口和 `./rpc-entry` 提供可执行 `import` export；`./client` 与 `./experimental/plugin` 只有 `source` 条件，且 `files` 排除 `dist/client`、`dist/experimental`、`dist/cli/experimental`。完整 coding-agent server/client 集成因此仍不是正式消费面。
- 当前 client 是 ordered byte transport 抽象，官方现成 transport 只有 Unix-domain socket；它不提供 SSH、跨机部署、peer authentication、凭据管理或自动重连/重放。server README 也明确称其为 “experimental local server”。

结论：PiDeck 可以借鉴其 `serverId + sessionId + attachmentId` fencing、请求不自动重放以及 Session 控制与 transport 解耦方向，但不能把低层包已发布误判为 coding-agent 远程产品已可用；Remote v1 仍以 SSH + 官方 stdio RPC 为基线。

### 3.2 可借鉴产品

| 产品 | 可借鉴 | 不直接照搬 |
| --- | --- | --- |
| Zed Remote Development | 本地 UI、系统 SSH、远端版本匹配 server、SSH config 继承、远端进程负责文件/语言工具 | Zed server 协议和二进制分发体系 |
| VS Code Remote SSH | 本地/远端设置分域、连接诊断、远端 server 生命周期、SSH forwarding 安全选项 | VS Code Extension Host 和完整远端 IDE 运行时 |
| Codex remote/cloud | 环境、凭据、依赖安装和代码来源必须显式建模 | 云任务平台、托管容器和云端账号体系 |

主要依据：

- [PiDeck 使用的 Pi 分发线 changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
- [PiDeck 使用的 Pi 分发线源码](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src)
- [Pi Client（experimental）](https://github.com/earendil-works/pi/blob/main/packages/client/README.md)
- [Pi Server（experimental local server）](https://github.com/earendil-works/pi/blob/main/packages/server/README.md)
- [Pi Protocol（experimental，无兼容承诺）](https://github.com/earendil-works/pi/blob/main/packages/protocol/README.md)
- [Pi v0.87.1 Release](https://github.com/earendil-works/pi/releases/tag/v0.87.1)
- [Pi v0.87.1 RPC 命令类型（`export_html.outputPath`）](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [Pi v0.87.1 RPC 实现（`session.exportToHtml(command.outputPath)`）](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Pi 原始上游](https://github.com/badlogic/pi-mono)
- [Zed Remote Development](https://zed.dev/docs/remote-development)
- [VS Code Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh)
- [Codex cloud environments](https://developers.openai.com/codex/cloud/environments)

## 4. 目标架构

```text
Renderer
  │ desktopApi / typed IPC
  ▼
Electron main
  ├─ RemoteHostManager ── SSH control channel ── PiDeck remote helper
  │                                              ├─ fs operations
  │                                              ├─ git operations
  │                                              ├─ session scan/read
  │                                              └─ capability probe
  │
  ├─ SessionRuntimeCoordinator
  │    └─ PiProcess
  │         └─ PiRuntimeLauncher
  │              ├─ LocalPiRuntimeLauncher ── local pi --mode rpc
  │              └─ SshPiRuntimeLauncher ──── SSH ── remote pi --mode rpc
  │
  └─ TerminalSessionManager
       ├─ local PTY
       └─ ssh PTY
```

### 4.1 两条远端通路

**控制通路**

- 一个主机一个逻辑控制连接；每次连接或重连都新建一条 SSH stdio，并在该连接内启动一个临时 helper 进程，不部署可脱离 SSH 独立存活的 daemon。
- 负责能力探测、目录、文件、Git、Session 索引等请求。
- 使用带 request id 的 NDJSON v1 协议；stdout 只允许协议帧，日志走 stderr。
- helper 只使用 Node 内置模块，禁止 import Pi SDK。
- SSH stdin EOF、连接关闭或收到退出信号时，helper 必须取消全部请求、终止并回收其子进程、释放 lock/lease，并在硬超时后退出；重连由本地 `RemoteConnection` 启动全新 helper。

**Agent 通路**

- 每个 Session runtime 一个独立 SSH 子进程。
- SSH 只启动 PiDeck 自带 runner 的固定入口，不把 cwd、Pi 参数或用户文本拼进远端 shell command。
- `SshPiRuntimeLauncher` 先通过 stdin 发送一帧初始化请求（cwd、Pi argv、run nonce），并独占消费 runner 的一帧 ready/error 响应；握手解析器必须保留该换行后已进入同一 chunk 的所有 Pi stdout 字节，握手完成后才把剩余 stdin/stdout 作为 `PiSpawnHandle` 交给 `PiProcess`。
- runner 使用 `spawn(piCommand, args, { cwd, shell: false, detached: true })` 为真实的 `pi --mode rpc` 创建独立 POSIX process group，记录 `pgid = child.pid`；握手之后 stdout/stdin 只承载 Pi 原生 JSON-RPC，不增加 PiDeck 自定义 Agent 消息。
- runner 先原子写入并 fsync 带 nonce、pid/pgid 和进程启动标识的 lease，再发送 ready；退出时对 `-pgid` 执行 TERM → 有界等待 → KILL，确认整个进程组已回收后才删除 lease。
- SSH 进程退出即视为 runtime 退出；runner 必须监听 stdin EOF、`SIGHUP`、`SIGTERM` 并执行同一清理流程。runner 崩溃留下的 lease 只能在 nonce、pid/pgid 和进程启动标识同时匹配时用于回收，不能按裸 pid 杀进程。
- runner 与 lease 是本计划中**预期寿命最短**的模块（上游官方 client/server 若达标即可整体取代，见 §16.2）：只做握手、进程组与 lease 回收，不承载 PiDeck 的业务语义，避免把远端会话/工具行为长进 runner。

采用两条通路的原因：控制通路需要 host 级连接和文件能力；Agent 通路需要维持现有 `PiProcess` 的 RPC 语义与独立生命周期。两者都走 SSH stdio，不新增到 Pi 的 HTTP 或私有 SDK 通道。

### 4.2 远端 helper 部署

- 源码放 `resources/remote-host/`，仅使用 Node 内置模块，按功能拆文件并保持单文件体量约束。
- `package.json.extraResources` 打包整个 helper 目录和 manifest。
- manifest 至少包含 `protocolVersion`、`bundleVersion`、文件 sha256 和 bytes；由 `scripts/generate-remote-host-manifest.mjs` 生成并提交，`npm run check:remote-host-manifest` 校验源码、manifest 与 `package.json.extraResources` 一致，挂入 build/pack 门禁。
- 目标目录：`~/.pideck/remote-host/<protocolVersion>/<bundleSha256>/`。
- 上传流程：本地校验 → bootstrap 创建 staging 目录 → 将 manifest/bundle 上传至该 staging → 远端 Node 按本地预期 bytes/sha256 重新校验 → 原子激活。
- 不依赖远端 `curl`、GitHub 或 npm registry；安装包自身就是可信来源。
- 首次部署不能假设目标 helper 目录已存在。`RemoteBootstrapper` 只能在已 pin 的 SSH 连接上调用用户配置并验证过的 Node executable，以固定、版本化的 inline bootstrap 入口创建 mode `0700` 的 `.staging-<nonce>`；remote command 除固定源码/入口和已验证 executable 外，只允许协议整数、64 位十六进制 bundle hash 和 main 生成的 nonce，全部经 schema 校验与统一 POSIX quoting，禁止 host/path/用户文本进入模板。bootstrap SSH 进程在创建 staging 前取得部署锁，返回 main-only、限定于该 staging 的上传位置并保持 stdio 活跃；main 在另一条使用同一 endpoint/pin 的 `scp` 连接上传 manifest/bundle，随后经原 bootstrap stdin 请求 finalize。bootstrap 在锁内按本地 manifest 预期值逐文件复核 bytes/sha256、owner/mode，fsync 文件和可支持的平台目录，再原子 rename 完成激活（「active」的判定语义见下文多客户端规则，不是全局单指针）。scp 上传路径只由 bootstrap 返回的 staging 身份和固定文件清单导出，校验其处于该 host 的部署根，按 `scp` 的 SFTP/legacy 模式分别安全编码；不得让 renderer/项目路径进入远端目标实参。bootstrap 自身及其固定 inline source 也进入 manifest/build 契约测试；SSH 断线、超时或任何一步失败时释放锁，绝不把半包标成 active，只留下受 1 小时规则管理的 staging。
- 后续 helper 与 PiDeck 协议不兼容时复用同一 bootstrap 流程上传匹配版本。清理使用 lock/lease 可达性而非目录年龄猜测：始终保留 active、上一份已验证 rollback 快照和所有被活跃 lease 引用的 hash；其余未引用快照最多保留 2 份且最长 7 天，超出任一条件即可按最旧优先删除。无活跃 bootstrap lock 的 `.staging-*` 超过 1 小时清理；runtime/security/export 临时 artifact 在正常结束立即删除，并由 24 小时 TTL sweep 兜底；terminal launch ticket 原子消费后立即删除，未消费 ticket 的 TTL 不得超过 60 秒，helper 启动和周期 sweep 都清理过期项。owner、权限、manifest 或 lease 状态无法验证时 fail closed：不启动未知 bundle、不删除可疑目录并记录结构化告警。
- 部署锁是部署根下 mode `0600` 的 lock 文件，内容为 owner pid、进程启动标识和 bootstrap nonce；锁的生命周期由持有它的 bootstrap SSH 进程存活维系，持有进程退出即失效，stale 判定沿用 lease 的身份校验规则（同时匹配进程启动标识，不按裸 pid）。不支持 `flock` 的平台以 `O_EXCL` 创建 + 身份校验回收，不引入长 TTL 猜测；锁等待有界超时后返回结构化 `DEPLOY_LOCK_HELD`。
- 同一远端账号可能被多台机器/多个 PiDeck 版本同时连接（PiDeck 本身支持多版本并行）。因此清理与激活判据按「当前活跃连接注册的 bundle + rollback + 活跃 lease」计算，而不是全局单一 active 指针：每个控制连接建立时向 helper 注册其使用的 bundle hash，断开即注销，两个 PiDeck 版本各持不同 bundle 并存时互不删除。`hostId` 是各实例本地 store 的 id，跨实例不唯一；artifact/lease 命名靠 nonce 防碰撞，清理只依据「存在活跃 lease/连接注册」这一事实，不解析他人 lease。多客户端并存（并发 bootstrap 锁互斥、staging sweep 不误删对方上传中目录、双方 bundle 均因活跃注册而保留）进入 14.1 fixture。
- helper 目录权限默认 `0700`，普通文件 `0600`、入口文件 `0700`；权限或 owner 异常时拒绝启动。sha256 和权限用于校验 PiDeck 分发内容、发现传输损坏或意外漂移，不宣称能隔离同一远端 Unix 账号下的恶意进程。
- 首版远端要求 Linux/macOS、POSIX shell、OpenSSH、可执行的 `stty` 与 `tar`、Node LTS（22.x 或 ≥24 的偶数 LTS 版本线）和可执行的 Pi CLI。Node 门控按主版本判定：helper 只用内置模块，没有已知的 patch 级依赖，capability probe 以 `process.versions.node` 检查主版本并拒绝奇数非 LTS 线（原稿 `>=22.19.0` 的写法会放行 23.x）；若后续发现 helper 依赖某个具体 patch 修复，把依据写回本节并把门控收紧为具体 patch。
- 「上传便携 Node」曾与「要求用户预装」比较过：本机 `runtimeNodeInstall` 已有 pinned Node 归档（当前 24.13.0）+ sha256 固化 + tar 解压的完整先例，bootstrap/scp/manifest 通道也天然可复用，能力上可行且不构成协议变更。v1 暂不做的取舍是首次连接时长与远端磁盘占用（解压后百 MB 级），以及把 bootstrap 传输面保持在最小；准入失败时 probe 返回结构化诊断与对应 LTS 的安装指引（含 nvm/asdf 绝对路径配置提示）。若「远端必须预装 Node」成为主要落地反馈，后续按同一 bootstrap/manifest 机制补自动安装，不破坏本节其余约束。
- 远端 Pi 使用 system installation：探测 `pi --version` 和 RPC capability，低于 PiDeck 声明的最小兼容版本时阻止启动并给出升级命令；PiDeck 不静默安装或升级远端 Pi。

## 5. 身份与持久化模型

### 5.1 执行位置

新增共享判别联合，避免继续用路径字符串猜测本地或远端：

```ts
export type ProjectLocation =
	| { kind: "local"; environment: SessionEnvironment; wslDistro?: string }
	| { kind: "ssh"; hostId: string };

export type ProjectLocator =
	| { kind: "local"; environment: SessionEnvironment; localPath: string; wslDistro?: string }
	| { kind: "ssh"; hostId: string; remotePath: string };

export type SessionLocator =
	| { kind: "local"; environment: SessionEnvironment; filePath?: string; wslDistro?: string; wslUser?: string }
	| { kind: "ssh"; hostId: string; remotePath?: string; remoteSessionId?: string; remotePathAliases?: string[] };
```

持久化兼容和运行时安全分开处理：各 store reader 接受没有 `location`/`locator` 的旧结构，并在加载边界规范化为必带判别字段的内部对象；业务服务只接收规范化对象，不能继续用 `environment !== "wsl"` 推断为本机。迁移期可由 store serializer / preload compatibility adapter 仅为 local 记录继续输出旧 `Project.path/environment`、`SessionRecord.environment/filePath/wsl*` 一个发布周期；remote arm 在共享类型上将这些 legacy 字段声明为不可出现，也永不写入伪造值。

约束：

- v2 `Project` 持久化 `locator: ProjectLocator`；规范化后的业务类型不再暴露无判别的 `Project.path: string`。旧 `path/environment` 只在 store 读取边界映射为 local `localPath`：旧 `"windows"`（包括 macOS/Linux 上的历史默认值）规范化为 `"native"`，`"wsl"` 保持不变；并通过 local compatibility adapter 临时输出。remote project 只存在 `remotePath`，因此调用本地 `node:path`/`node:fs` 前必须先窄化 `locator.kind === "local"`。`ProjectLocation` 仅用于不需要路径的 target 选择，可从 locator 派生，不作为第二份持久化真相。
- v2 规范化 `SessionRecord` 同样以 `locator` 作为唯一位置真相：local arm 从 locator 读取 `environment/filePath/wsl*`，SSH arm 在类型上使用 `environment?: never; filePath?: never; wslDistro?: never; wslUser?: never`，不能满足旧必填字段而伪造 `native`。旧记录缺少 locator 时由 store reader 按 `environment/filePath/wsl*` 规范化为 local；只在 local compatibility serializer/adapter 暂时回写或暴露旧字段。
- 持久化 schema 升级必须显式版本化：`SessionCatalog` 从 v1 读入后规范化为 v2，继续保留 primary/backup 恢复和串行写队列；`ProjectStore` 同步升级为 `{ schemaVersion: 2, revision, projects }` envelope，所有 mutator 进入同一串行写队列，并复用一个跨平台 durable replace helper：temp 文件写入并 `FileHandle.sync()` → 旧 primary 经 `renameWithRetry` 换成 `.bak` → temp rename 为 primary → 在支持目录句柄同步的平台 fsync 父目录。文件 flush、revision 校验和 primary/backup 恢复是全平台硬要求；Windows 不宣称 Node 无法稳定提供的目录 fsync 保证，改由 rename 重试与启动时选择最高有效 revision 兜底。二者都坏则进入可诊断的 `needs-repair`，不得静默回空数组。
- 项目去重键从单一规范化路径改为 `locationKey + NUL + canonicalPath`；远端 canonical path 按远端 `realpath` 原样区分大小写，不能套用 Windows 小写规则。
- `buildSessionOriginKey()` / `buildSummaryOriginKey()` 增加 locator 输入；远端 origin key 必须包含 `hostId`，不能只用 `remotePath`。
- 同一远端路径在不同 host 上是两个项目和两个 Session origin。
- `SessionRecord.id` 继续是 PiDeck 跨重启稳定身份；`agentId` 仍只代表当前 Pi 子进程。
- draft 阶段的 ssh locator 可以尚无远端文件身份；一旦转为 active，`remotePath` 与 `remoteSessionId` 至少存在一个，扫描回填后优先同时保存，禁止生成两者都缺失的 active 记录。
- runtime 替换、SSH 重连或恢复 Session 必须递增 `runtimeGeneration`，继续拒绝旧 runtime 的迟到事件。

### 5.2 主机配置

```ts
export interface VerifiedSshEndpoint {
	hostName: string;
	port: number;
	user: string;
	pinAlias: string;
	routeDigest: string;
	knownHostsSha256: string;
	hostKeyFingerprints: string[];
}

export interface RemoteHostProfile {
	id: string;
	label: string;
	sshHost: string;
	port?: number;
	user?: string;
	identityFile?: string;
	proxyJump?: string;
	remotePiCommand?: string;
	remoteNodeCommand?: string;
	browseRoots?: string[];
	connectTimeoutMs: number;
	createdAt: string;
	updatedAt: string;
	lastConnectedAt?: string;
	verifiedEndpoint?: VerifiedSshEndpoint;
	verifiedAt?: string;
	disabledAt?: string;
}
```

- `VerifiedSshEndpoint` 是「端点身份」的持久化形态；6.2 trust key 与 8.2 共用的 endpoint identity hash = 对 `routeDigest + pinAlias + knownHostsSha256` 三元组的无歧义序列化 hash。本节是该定义的唯一出处，其余章节只引用不重复定义。
- `sshHost` 可以是 `~/.ssh/config` alias；alias、user、port、identityFile、proxyJump 等字段必须拒绝 NUL、换行和以 `-` 开头的值，port/timeout 还要做数值范围限制。`identityFile` 保存前由 main 展开 `~`、规范化为本机绝对路径并只作为 OpenSSH 的 `-i` 引用，不读取、复制或记录私钥内容；文件暂时不存在时 profile 可以保存但连接诊断必须明确失败。
- `hostId` 表示稳定且不可复用的远端端点身份。只有从未成功验证且没有 project/session 引用的 draft profile 才能原地修改 `sshHost/user/port/proxyJump`；其余 endpoint identity 变更一律创建新 profile/new `hostId`，再通过显式 rebind 迁移引用并执行目标冲突检查。rebind 不继承 project trust，必须在新端点重新确认。
- 被 project/session 引用的 profile 禁止硬删除，只能标记 `disabledAt` 形成 tombstone；tombstone 保留 `hostId`、端点字段、`verifiedEndpoint` 和展示信息，使离线 locator 仍可解析。只有在引用已全部删除或显式迁移后才能把完整 profile 压缩成 retired-id 记录；`RemoteHostStore` 的版本化 envelope 持久保存 `retiredHostIds`，历史 `hostId` 永不重新分配。
- `remoteNodeCommand` 只能是单个 executable token（如 `node` 或绝对路径），禁止携带空格、参数和 shell 元字符；`remotePiCommand` 同样只表示 executable，参数由 runner 单独传给 `spawn`。
- `browseRoots` 不能把 renderer 文本直接存成授权边界。profile 激活或 root 变更时，main 必须在已 pin 且 route digest 一致的连接上逐项调用 helper：要求绝对 POSIX path、存在且为目录，取 canonical `realpath` 与 owner/mode 元数据；UI 展示请求值到 canonical 值的变化，用户确认后只持久化 canonical roots。默认 root 是探测得到并验证过的远端 home；root 变更会撤销旧连接注册并重新验证，`/` 只能经单独高风险确认添加。
- 不接受自由格式 `extraArgs`，所有 SSH 参数使用显式字段和 argv 数组生成。
- 不保存密码、私钥内容和 passphrase；`identityFile` 只是本地路径引用。
- 首次验证先运行用于解析 alias 的 `ssh -G <sshHost>`，只覆盖 profile 自身明确填写的 user/port/proxyJump，不填入尚不存在的已验证 `HostName/User/Port`；从其有效 `HostName/User/Port/ProxyJump-or-ProxyCommand` 生成候选 route digest。保存后每次连接仍先用**相同的候选解析规则**重新计算 digest，必须与保存值相等；随后才由连接 builder 显式覆盖已验证的 `HostName/User/Port` 以启动 probe/helper/Agent/terminal。这样 alias 改指会在预检时失败，不会因为连接参数覆盖而被掩盖。digest 只描述端点和跳转路径，不把 `IdentityFile`/IdentityAgent 等可轮换凭据算作端点身份；主机 SSH 配置在两次进程启动之间被本地同账号进程并发篡改不属于本方案的安全隔离承诺。首次 probe 使用仅用于该 draft 的临时 `known_hosts`、`StrictHostKeyChecking=accept-new`、固定 `HostKeyAlias=<pinAlias>` 并禁用 agent forwarding/端口转发；真实 SSH 认证成功后从临时文件计算 key fingerprint，UI 同时展示有效 endpoint 与 fingerprint。用户确认后才把 key 行原子写入 `<userData>/ssh-host-keys/<hostId>` 并保存其 sha256。未经认证的 `ssh-keyscan` 不能进入 pin 文件。首版只承诺精确 host key pinning；只有 CA 信任而无法固化目标 key 的 host-certificate 环境必须 fail closed，后续单独设计 CA pin。
- 后续每条 helper、Agent runtime、bootstrap `scp` 和 terminal 连接都必须先复算目标 alias 的 route digest，并统一显式传入 `UserKnownHostsFile=<profile pin file>`、`GlobalKnownHostsFile=/dev/null`、`StrictHostKeyChecking=yes`、`HostKeyAlias=<pinAlias>` 及已验证的 host/user/port。目标 alias 的 digest、pin 文件 sha256 或最终目标 host key 不一致时进入 `needs-attention`，不允许只做一次 preflight 后放行另一条未 pin 的连接。`ProxyJump`/`ProxyCommand` 在目标 `ssh -G` 输出中的声明变化会使 digest 失效；跳板 alias 内部的 `HostName` 变化、外部 ProxyCommand 的实际去向无法仅凭目标 `ssh -G` 保证检出。跳板机自身继续由系统 OpenSSH policy/known_hosts 校验，最终目标仍独立使用 profile pin；需要整个跳板链不可变的环境必须额外由管理员固定并审计 SSH config。
- rebind 是跨 `RemoteHostStore`、`ProjectStore` 和 `SessionCatalog` 的 main-only 事务。所有会新增、删除或迁移 host/project/session 引用的 mutator 都必须先取得同一份跨进程持久锁；应用启动在暴露任一 store 前先恢复未完成事务。journal 记录 tx id、source/target、各 store expectedVersion、目标记录集合和 `prepared → projects-written → sessions-written → source-retired → committed` 阶段，每次推进前都通过同一个 durable replace helper flush journal/store 文件，并在平台支持时同步父目录。恢复只按记录的 CAS 结果幂等 roll-forward，版本异常时停在 `needs-repair`，不得用旧快照覆盖并发数据；source retire 前在锁内做最终全量引用扫描和目标冲突检查，`committed` 持久化后才清理 journal。renderer 不能分别调用多个 IPC 自行拼迁移。
- 保存到 `<userData>/remote-hosts.json`，复用上述 version/revision、temp + backup、文件 flush、rename 重试和平台能力内的目录同步协议后才视为提交。
- 探测得到的 OS、arch、home、Node/Pi/helper 版本属于可刷新缓存，不作为用户配置真相。

### 5.3 远端 Session

- Pi 的 JSONL 和会话目录始终留在远端，主存储由远端 Pi 创建和维护。PiDeck 不新增 Session 格式实现；用户显式触发现有 history edit/delete/truncate-for-resend/repair 时，只复用计划从 `AgentManager` 现有逻辑抽出的 main-only `SessionMutationService`，并优先使用受支持的 Pi RPC/CLI 操作。remote helper 只提供 opaque、大小有界的 snapshot/version 与原子 replace/move/remove 原语，绝不解析、生成或修复 JSONL；超出变换字节上限且 Pi 没有官方操作时，UI 必须禁用该功能而不是把第二套解析器下放到 helper。
- PiDeck 本地 `SessionCatalog` 只保存 locator、标题、项目关系、摘要和最后活动时间等索引；`parentSessionPath` 等路径关系也必须转换成带 host 的 locator/origin key，不能跨 host 串父子树。
- `remoteSessionId` 的定义：远端 Pi 会话文件的文件名 stem（Pi 官方命名），由 helper `session.list` 原样返回的文件名派生，不解析文件内容；它只作为远端侧稳定身份参与匹配，与本地 `SessionRecord.id` 的映射由 catalog 维护（见下一条匹配顺序）。
- 远端会话的标题、首条用户文本和父子关系分两层取得：列表级扫描只消费 `session.list` 的文件名级元数据（name/size/mtime），不做内容级解析；导入或首次打开时由 main 经有界 `session.readPage` 拉取文件头部，复用本地 `SessionScanner` 既有的头部解析逻辑生成标题/摘要/父子标记——与本地「轻量扫描 + 按需取头部」的分层一致，helper 对正文始终字节透明。目录级批量取标题的并发与总量必须有界，避免首屏触发全量头部拉取。
- 首次扫描按 `(hostId, remoteSessionId)`、当前 `(hostId, remotePath)`、持久化 `remotePathAliases` 的顺序匹配已有 stable id。经 helper 验证的 move/archive/restore 必须在同一个 catalog 原子写中把旧 path 加入 aliases 并写入新 path；alias 只允许同一 host、规范化去重、最多保留最近 8 个。新 path/alias 与其他 Session 的 current path、alias 或 remoteSessionId 冲突时整次操作失败，避免一份远端会话被重复导入或两个 stable id 合并。
- 打开 Session 时由 helper 读取有界尾部或分页结果，禁止整份大文件无上限传输。
- 离线时可显示最近 catalog 元数据；首版不承诺离线查看完整远端消息。
- 删除/归档必须显式区分「只从 PiDeck 移除引用」与「删除远端 Session 文件」，后者需要确认。

## 6. 服务边界与代码改造

### 6.1 新增模块

```text
src/shared/types/remote.ts
src/shared/types/project.ts              # 增加 ProjectLocation / ProjectLocator
src/shared/types/session.ts              # 增加 SessionLocator
src/shared/ipc.ts                        # remote:* 通道

src/main/remote/
  RemoteHostStore.ts
  HostRebindCoordinator.ts
  RemoteHostManager.ts
  RemoteConnection.ts
  RemoteBootstrapper.ts
  RemoteControlClient.ts
  RemoteProtocol.ts
  SshCommandBuilder.ts
  SshHostVerifier.ts
  SshProcessLauncher.ts
  remotePath.ts

src/main/projects/
  RemoteProjectEnrollmentService.ts
  ProjectTrustService.ts

src/main/pi/runtime/
  PiRuntimeLauncher.ts
  LocalPiRuntimeLauncher.ts
  SshPiRuntimeLauncher.ts

src/main/files/
  ProjectFileBackend.ts
  LocalProjectFileBackend.ts
  RemoteProjectFileBackend.ts

src/main/git/
  GitBackend.ts
  LocalGitBackend.ts
  RemoteGitBackend.ts

src/main/sessions/
  SessionStorageBackend.ts
  LocalSessionStorageBackend.ts
  RemoteSessionStorageBackend.ts
  SessionMutationService.ts

src/main/config/
  PiConfigBackend.ts
  LocalPiConfigBackend.ts
  RemotePiConfigBackend.ts

src/main/terminal/
  TerminalSessionLauncher.ts
  LocalTerminalSessionLauncher.ts
  SshTerminalSessionLauncher.ts

src/main/persistence/
  durableJsonStore.ts

src/main/security/
  PendingConfirmationBroker.ts

src/main/ipc/remoteIpc.ts
src/preload/index.ts                     # 只增加 typed invoke/subscription bridge

src/renderer/src/atoms/remoteHosts.ts
src/renderer/src/hooks/useRemoteHosts.ts
src/renderer/src/components/app/settings/RemoteHostsPanel.tsx
src/renderer/src/components/sidebar/RemoteProjectLocationPicker.tsx
src/renderer/src/i18n/rendererCopy.zh-CN.ts
src/renderer/src/i18n/rendererCopy.en-US.ts

resources/remote-host/
  pideck-remote-host.mjs
  runner.mjs
  terminal-runner.mjs
  protocol.mjs
  roots.mjs
  fs.mjs
  git.mjs
  sessions.mjs
  artifacts.mjs
  config.mjs
  runtime.mjs
  processes.mjs
  remote-host-manifest.json
```

名称可在落地时微调，但 owner 不得退回 `main/index.ts` 或 `App.tsx`。新增 UI 只用现有 shadcn/Tailwind 原语，不新增手写 CSS class；host/session 状态放 Jotai atom family，订阅按 hostId/sessionId 隔离。

IPC 契约继续遵守现有三层边界：通道常量只定义在 `src/shared/ipc.ts`，`remoteIpc.ts` 和改造后的 files/git/session handler 先校验 sender、结构、枚举、长度与 stable id，再调用领域服务；preload 只暴露逐方法 typed invoke 和必要事件，不透传 `ipcRenderer`。每个事件订阅必须返回 unsubscribe，renderer unmount 时调用，main 在 `webContents` 销毁/host disconnect/app shutdown 时清理该 sender 的订阅、pending confirmation、timer 和 watcher。`main/index.ts` 只装配这些 owner。

### 6.2 `PiProcess` 的最小重构

新增进程启动接口，保持 RPC 解析、命令和事件语义不动：

```ts
export interface PiSpawnHandle {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid?: number;
	stop(reason: "abort" | "restart" | "shutdown"): Promise<void>;
	onExit(listener: (exit: PiRuntimeExit) => void): () => void;
}

export interface PiRuntimeLauncher {
	launch(request: PiRuntimeLaunchRequest): Promise<PiSpawnHandle>;
}
```

- `LocalPiRuntimeLauncher` 必须完整保留当前 `PiProcess` 的命令定位、版本探测、WSL path 转换、诊断参数、trust flag、资源白名单、命令行长度 fallback、环境清洗和进程树清理；不能把它简化成裸 `spawn(command, args, { cwd, env })`。
- `SshPiRuntimeLauncher` 只负责 SSH/runner 握手和流的交接；远端 runner 以 `shell: false` 启动 Pi。
- 启动输入先规范化为 location-aware `PiRuntimeLaunchPlan`。本地 plan 保存现状；远端 plan 只能包含远端路径和已部署 artifact ref，禁止出现本机绝对路径。
- 本地 ssh 子进程使用独立的 `sanitizeSshChildEnv()`：只保留 OpenSSH、代理跳板和 ssh-agent 必需变量，不继承本地 `PI_*`、模型 API key、`NODE_OPTIONS` 或 Pi proxy 设置。远端 Pi 只继承 sshd/远端账号环境和 PiDeck 明确允许的标记。
- `PiProcess.start(...)` 从 coordinator 注入 launcher 和 location，不自行判断远端类型。
- `AgentManager` 当前直接拥有 Session history/edit/delete/resend/fork/export/checkpoint、项目 trust、启动前 JSONL repair 和资源解析；这些调用必须按“存储 backend / Pi RPC / checkpoint backend / launch preparation”拆到 location-aware owner，不能只改 `PiProcess` 后留下本地 `node:fs` 路径。
- `SessionRuntimeCoordinator` 仍是 session/runtime 唯一 owner；transport 变化不进入 renderer。
- 任何 launcher 重建都先增加 `runtimeGeneration`，再发布状态。

远端启动准备规则：

| 当前本地启动能力 | 远端处理 |
| --- | --- |
| `PIDECK_SECURITY_CONFIG` | main 生成同一份脱敏安全快照，经 control helper 原子写入 `runtime-artifact` root、权限 `0600`，launch plan 只传远端 artifact ref；Session 结束/TTL 后清理 |
| `PIDECK_SESSION_ID` / auto-title / Feishu marker | 只传经过字段校验的非秘密标量；所有 runtime 命令/事件仍带 `sessionId + agentId + runtimeGeneration` |
| 项目 trust | helper 检查远端项目 `.pi` 配置，main 展示确认，runner 只接收枚举 `approve \| no-approve`；禁止本地 `fs.stat(remotePath)`。新增统一 `buildProjectTrustKey()`：local/WSL 保留兼容迁移，SSH key 必须由 `ssh + hostId + verifiedEndpointIdentity + canonicalRemotePath` 构成，其中 endpoint identity 使用 5.2 定义的 `routeDigest + pinAlias + knownHostsSha256` 无歧义 hash；endpoint identity、helper `realpath` 结果变化或 host rebind 时旧授权均不命中并重新确认 |
| 启动前 Session repair | 通过 `RemoteSessionStorageBackend` 在远端执行，同一规则、同一大小上限、先备份后修复 |
| PiDeck 内置扩展 | 上传已验证的有效快照并把 `-e` 路径翻译为远端 immutable path |
| project/user skills、prompts、extensions | project scope 从远端项目发现；user scope 默认使用远端 Pi 自己的配置，不传本机路径；显式同步留到 Phase 6 |
| incompatible extension fallback | 保留一次 `--no-extensions` 诊断重试，但不得移动/改名远端用户扩展；错误中标明被禁用范围 |
| per-session proxy | 只读取远端 host/Pi 设置；本地 Pi proxy override 不跨主机复制 |

任何远端 artifact 都以 `hostId + runtimeGeneration + nonce` 命名并受 TTL 清理，日志禁止记录正文。

### 6.3 文件、Git 与 Session 存储后端

- `filesIpc.ts` 的新输入统一为 `ProjectFileTarget = { projectId: string; relativePath: string }`；main 根据 projectId 解析 location 和可信 root，再选择 local/remote backend。
- 输出契约也要迁移：`FileTreeNode` / search result 必须携带 `projectId + relativePath`，`displayPath` 只用于展示。远端节点不得伪造本地绝对 `path` 或 `file://` URI。
- 本地旧 IPC 可保留一个发布周期的 adapter，但 remote project 只允许新 target；Phase 1 所谓“无回归”指 UI 行为不变，不是继续保留不安全的 root/path 参数。
- remote helper 的项目级 API 只接受 helper 端已登记的 root id 和相对路径；每次控制连接建立后，main 从 `ProjectStore` 登记授权 root，断线即失效。
- root 分为 `browse`、`project`、`session` 和 `runtime-artifact` scope；不同 scope 的 method 不可混用。Session root 由远端 Pi 配置/探测结果产生，不能由 renderer 指定。
- 规范化路径后必须仍位于对应 root 内；创建目标不存在时，从最近存在的父目录开始 `realpath` 校验；写入最终组件在平台支持时使用 `O_NOFOLLOW`，并在操作前后复核父链与结果。该检查防止普通 `..`/symlink 逃逸和错误路由，但不宣称能抵御同一 Unix 账号下恶意进程在检查与使用之间竞态替换目录；这项边界在 8.1 明确限定。
- Git backend 不能直接复用当前所有共享 DTO：现有 `GitResource.path` 等字段可能含本机绝对路径。先审计每个 path-bearing 字段并迁移为 `projectId + relativePath`（另有只展示用的 `displayPath`）；只有 commit hash、branch、计数等 location-neutral DTO 才可原样复用。remote helper method 只接收结构化 DTO，不能接收 renderer 或 main 透传的自由 argv。每个 method 使用独立 argv builder 和固定 subcommand/option allowlist；路径必须是 project-relative、拒绝 NUL/换行/前导 `-` 并在支持处置于 `--` 后，branch/ref 拒绝 option-like 输入并先用 `git check-ref-format` 验证。
- 所有 Git 操作都要求 project trust；设置 `GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`、`GIT_EXTERNAL_DIFF` 为空和有界 timeout/output。读取 diff 固定使用 `--no-ext-diff --no-textconv`；PiDeck UI 发起的写操作使用 helper 管理的空 hooks 目录并关闭自动签名，避免 repo hooks、pager、signer 或 external diff 成为隐藏执行面。需要完整原生 Git 行为时用户使用远端终端，后续若开放 hooks/signing 必须单独提示并评审。

现有 `src/shared/ipc.ts` Git surface 必须逐项有结论，不能让 UI 因漏路由而落到本地 `GitService`：

| 现有 Git IPC/能力 | 远端 v1 决策 |
| --- | --- |
| list repos、init、status、original/workspace diff、stage、unstage、discard single/batch、commit、delete workspace files | Phase 5 支持；所有文件字段改为 project-relative DTO，删除仍走可恢复 trash 等价能力或明确确认 |
| branches、checkout、create branch、commit log/count、refs、branch compare、commit detail/file diff、diff between refs | Phase 5 支持；ref/hash/branch 分别做 allowlist 与解析 |
| fetch、push、pull、ahead/behind | Phase 5 支持；非交互、超时有界、认证失败结构化返回 |
| watch/unwatch refs、refs changed | Phase 5 以 control helper 有界 polling 实现，断线自动退订，事件带 `connectionGeneration` |
| worktree list/create/remove、cherry-pick、revert、reset、drop commit | 远端 v1 禁用并显示原因，后续逐项设计破坏性确认和恢复语义 |
| generate commit message | 远端 v1 禁用，直到其模型调用与 diff 输入都能按 host target 路由且不读取本地 path |
| detect/choose Git executable | 远端以 host capability probe 和 profile 中单-token executable 替代；本地文件选择器不对 remote target 展示 |

Phase 5 helper method 与 preload/UI capability 必须从这张表生成同一份 allowlist 或由契约测试逐项对齐；未列为支持的方法返回 `UNSUPPORTED_CAPABILITY`，不能静默 no-op。
- Session scanner/read/page 通过 location-aware `SessionStorageBackend` 路由，不允许 IPC、`AgentManager` 或 coordinator 直接读 remote path。
- main 中新增并从 `AgentManager` 抽出的唯一 `SessionMutationService` 持有当前已有 JSONL 变换规则。首版将 `MAX_SESSION_TRANSFORM_BYTES = 32 * 1024 * 1024` 抽成 session domain 的单一常量，供 `SessionScanner`、`SessionFileEditor`、local/remote mutation backend 共用，保持当前 32 MiB 整文件内存护栏；该值是解码后的原始 Session bytes 上限，不是 8 MiB 协议帧上限。
- remote backend 先调用 `session.stat` 比较 size，再以固定 `MAX_SESSION_TRANSFORM_BYTES` 请求 opaque snapshot + version；snapshot 经 7.2 定义的 snapshot handle 分块回传，单帧不超过 7.1 协议上限（32 MiB 变换上限 ≠ 8 MiB 帧上限，二者不得混用）；超限时 helper 在读取/传输正文前返回 `SESSION_TRANSFORM_TOO_LARGE`。main 在本地内存完成同一变换后，把结果按不超过 1 MiB 的块写入 purpose=`session-mutation` 的 one-shot artifact，再调用 `session.replaceAtomic(expectedVersion, artifactRef)`。helper 同时独立执行硬上限，不能相信 main 自报 size；helper 不接收 message id、truncate 语义或 repair 规则。文件超限、版本冲突或官方格式不受支持时返回显式 unsupported/conflict，不做无限传输。
- Session 变换由 `SessionRuntimeCoordinator` 持有贯穿“idle 检查 → stat/snapshot → transform → 原子 replace → Pi reload”的 mutation reservation；reservation 期间拒绝 send/restart/replacement，不能只做一次有 TOCTOU 窗口的状态检查。local/remote backend 跑同一组 main-owned fixture，证明路由、32 MiB 边界和错误码一致且 helper 保持字节透明。
- 活跃 runtime 的 `fork`、`get_fork_messages`、reload 和 prompt 仍走远端 Pi RPC；history resend 仅在现有 Pi RPC 没有等价操作时由上述 bounded mutation 截断，再由 composer 走普通 prompt。这些 Agent 命令不得加入 helper 协议。
- 官方 `v0.87.1` RPC 已定义 `{ type: "export_html", outputPath?: string }`，成功响应为 `{ path }`。活动会话导出时，main 先调用 `artifact.create` 申请 purpose=`session-export`、suffix=`.html` 的 one-shot ref；helper 只生成受管目录内的保留路径并向 main 返回 `{ artifactRef, remotePath }`，renderer 永远看不到该远端路径。main 把 `remotePath` 作为 `outputPath` 显式传给 Pi `export_html`，不得依赖 Pi 的默认输出目录。
- Pi 返回后，main 要求响应 `path` canonicalize 后与 helper 签发路径一致，再调用 `artifact.commit`；helper 只接受该 ref 对应的普通文件，复核 no-symlink、用途、owner、TTL 与导出字节上限并计算 size/hash。随后 main 以 `artifact.readChunk` 有界下载到本地临时文件，校验 size/hash 后原子移动到 Downloads，并在成功、失败、取消和断线路径都调用 `artifact.remove`/TTL 清理。未打开的远端会话也不得由 PiDeck 解析 JSONL 或自行生成 HTML：main 启动绑定目标 locator 的临时远端 Pi runtime，复用完全相同的 `artifact.create → export_html(outputPath) → commit → download → remove` 流程；目标 Pi 不支持显式 `outputPath`、返回路径不一致或连接不可用时，UI 明确禁用并给出兼容性错误。
- checkpoint/rewind 另走 location-aware checkpoint backend；未实现前在远端 UI 明确禁用，不能调用本地 Git/fs fallback。
- `SessionSummary.filePath`、history page 和 runtime info 等 path-bearing shared contract 必须改成 locator/ref 可判别结构；迁移期只对 local adapter 暴露旧 path。
- 所有输出维持现有大小上限；新增远端超时、取消和协议帧大小上限。

### 6.4 配置、认证与资源作用域

当前 `ConfigManager.configureWsl()`、`PromptManager.configureWsl()`、`SkillManager.configureWsl()` 和 `ExtensionManager.configureWsl()` 都通过修改单例的“当前 home”切环境，这不能表达本机、WSL 和多个 SSH host 并存。远程能力不得再扩展这套全局切换方式。

- 新增共享 `PiConfigTarget = { kind: "local"; environment: ... } | { kind: "ssh"; hostId: string }`，配置相关 IPC 每次显式携带 target；main 解析后路由 `LocalPiConfigBackend` / `RemotePiConfigBackend`。renderer 只保存设置页当前查看的 target，不改变其他 Session 的配置来源。
- `RemotePiConfigBackend` 通过 helper 的 config scope 访问 allowlist 中的 `models.json`、`settings.json` 和受支持的配置项，复用与本地相同的 schema/fixture，并使用 `expectedVersion` + 原子写；禁止退化成任意 `~/.pi/agent` 文件读写。
- 远端配置 DTO 不返回已有 secret 明文，只返回 `missing | configured`；保存使用 patch 语义，未填写 replacement 时在远端保留原值。`auth.json` 不通过 helper 读取或写入，远端登录首版只走远端终端 `/login`。
- provider 连接测试与模型目录拉取必须在凭据和 provider 实际所在的远端执行，只回传脱敏结果。远端 v1 明确不支持「用量查询」：现有 provider-specific 与 `usage-probes.json` 模板都可能携带任意 URL/header/body，在定义远端 allowlist request schema 与 secret redaction 前，remote target 下入口禁用并解释；绝不能误用本地网络或本地 key。
- 远端 Raw Files、MCP 和可能含未知 secret 的配置在完成字段级脱敏与保留写入前保持禁用；不能为了功能对齐把完整文件拉回本机。
- 项目级 prompts/skills/extensions 由 project location backend 读取；远端 user scope 默认使用远端既有资源。跨 host 复制/同步仍属于 Phase 6，必须显式选择且永不包含 `auth.json`。

### 6.5 终端

- 保留 `TerminalSessionManager` 对 tab、replay buffer、input/resize/close 和事件订阅的单一所有权，但把进程创建抽为 `TerminalSessionLauncher`。`LocalTerminalSessionLauncher` 原样承接现有本地/WSL shell 候选、cwd 转换和 node-pty 行为；`SshTerminalSessionLauncher` 只负责远端 ticket、固定 runner 握手和本地 ssh PTY 生命周期，不能让 `TerminalSessionManager` 自行拼远端命令。
- `TerminalProjectTarget` 迁移为只携带 `{ kind: "project", projectId }`，main 从 `ProjectStore` 解析 location/canonical cwd；`TerminalAgentTarget` 继续携带 `sessionId + agentId + runtimeGeneration` 并由 coordinator 校验。project terminal owner key 改为 `project:<projectId>`，agent terminal owner key 至少包含 `sessionId + agentId + runtimeGeneration`，禁止继续以 renderer 提交的 cwd 或单独 agentId 隔离。`TerminalTab` 的远端 cwd 只能是 `displayCwd`/locator 元数据，不能作为本地 `node:fs` 或 spawn authority。
- `terminal:list/ensure/create/shells` 全部按 target 路由。远端 target 不展示本机 shell 列表，也不接受 renderer 指定 shell/path/argv；首版固定启动远端账号的登录 shell，UI 只显示 helper 探测并脱敏后的 shell label。既有 `terminal:input/resize/close` 仍只接受 main 签发的 tab id，并校验调用 sender 与 tab owner；agent-bound 命令和事件保留 identity/generation fence。
- main 先经控制 helper 调用 `terminal.prepare`。helper 从已注册 project root 或经 coordinator 验证的 agent project root 解析 canonical cwd，写入 mode `0600`、短 TTL、一次性消费的 launch ticket；ticket 绑定 `hostId + routeDigest + projectId/sessionId + canonical cwd + random nonce + expiry`，只返回 opaque ref。renderer 不能提交 cwd、ticket 或“已校验”标志。
- 本地 node-pty 使用 `SshCommandBuilder` 启动 `ssh -tt`，remote command 只包含经统一 POSIX quoting 的受信任 Node executable、固定 bundle path/hash 和 `terminal-runner.mjs`，不得包含 cwd、shell、ticket 或用户文本。`terminal-runner.mjs` 必须进入 manifest/extraResources，与 helper bundle 同版本校验；不能使用 `ssh -t "cd ${cwd} && $SHELL"`。
- runner 启动后先用受信任的 `stty` 捕获当前 termios，仅临时关闭 echo，再输出固定 `PIDECK_TERMINAL/1 READY`；main 才发送以换行终止、长度有严格上限的 base64url init frame `{ ticketRef }`，无需把 TTY 切到 raw mode。runner 原子消费 ticket 并复核 owner/expiry/canonical directory 后，必须先恢复捕获的 termios；恢复失败就关闭 PTY，成功才输出固定 `START` frame并启动 shell。信号、超时、非法 frame 等所有握手退出路径也都 best-effort 恢复 termios。main 只在握手完成前解析并剥离 READY/START 与可能的终端控制回显，之后所有 bytes 原样作为终端数据；握手帧和首段 shell 输出落在同一 chunk 时不得丢字节，shell 后续输出的伪控制文本按普通内容处理。ticket 重放、bundle 不匹配、`stty` 失败或握手超时都关闭 PTY并返回结构化错误。
- runner 从远端账号环境取得登录 shell；只接受不带参数和控制字符、可 `stat` 且通过 `X_OK` 检查的绝对文件路径，无效时回退 `/bin/sh`。runner 以 `shell: false`、受信任 cwd 和 login argv0 启动它并继承 TTY stdio，不得把 renderer 文本交给 shell 解释。node-pty 的 `resize` 作用于本机 ssh PTY，由 OpenSSH 转发 window-change；集成测试必须验证 rows/cols 到达远端 shell。
- `terminal.close` 必须幂等：main 先从可写 tab registry 中撤销该 tab，再请求关闭本地 ssh PTY；短宽限后若进程仍存活则强制回收本地 ssh 进程树，close 后到达的 output/exit 事件只做资源收尾，不能复活 tab 或写入新 owner。runner/sshd 对正常前台 shell 做 HUP/TERM 的 best-effort 收敛。PiDeck 不宣称拥有远端 shell pid/pgid，也不承诺杀掉用户主动 daemonize/disown 的进程；只有受 PiDeck Agent runner 管理且有 nonce lease 的进程组使用 TERM → KILL 保证清理。关闭一个 tab 不得调用 host 级 `pkill` 或影响同主机其他终端/Agent。

## 7. Helper 协议 v1

### 7.1 基本帧

```json
{"v":1,"hostId":"host-1","generation":7,"id":"req-1","method":"hello","timeoutMs":30000,"params":{"clientVersion":"0.x","nonce":"..."}}
{"v":1,"hostId":"host-1","generation":7,"id":"req-1","ok":true,"result":{"protocolVersion":1,"platform":"linux","arch":"x64","home":"/home/u","capabilities":[]}}
{"v":1,"hostId":"host-1","generation":7,"id":"req-2","ok":false,"error":{"code":"PATH_OUTSIDE_ROOT","message":"...","retryable":false}}
```

要求：

- 每行一个 JSON object，UTF-8，单帧上限初始设为 8 MiB；文件正文默认每块不超过 1 MiB，二进制使用 base64 后也必须计入帧上限。
- `id` 在一个连接内唯一；response 必须回显 `hostId + id + generation`。main 校验 hostId 并只接受当前 `RemoteControlClient.connectionGeneration` 的 frame，旧 generation、未知 id 和重复 terminal response 只记脱敏诊断并丢弃。
- 未知 method 返回 `METHOD_NOT_FOUND`，未知字段向前兼容忽略。
- stderr 只写结构化诊断，不输出 token、环境变量值或文件正文。
- 每个普通请求携带相对 `timeoutMs`，避免依赖两台机器时钟同步；helper 按 method 上限 clamp，并从完整 frame 收到时启动 `AbortController`。main 同时持有本地 deadline，先到者取消请求。`cancel` 自身有独立 id，params 为 `{ requestId }`：目标尚未进入 commit point 时，helper 中止子进程/读取并让目标请求恰好返回一次 `REQUEST_CANCELLED`，cancel 返回 `{ cancelled: true }`；目标已完成或原子 mutation 已进入 rename/commit point 时，cancel 返回 `{ cancelled: false, reason: "already-settled" | "commit-started" }`，原请求仍返回真实结果，不能伪装回滚成功。
- helper 对每个已接受请求最多发送一个 terminal response。连接关闭时 helper abort 全部 request scope 并回收其子进程；main 立即以本地 `REMOTE_CONNECTION_LOST` 拒绝该 generation 的 pending promises，重连后不得把旧请求重发到新 generation。
- 任何可能超过单帧上限的结果都必须分页/分块传输，禁止用单个无限大 frame：文件与目录结果用显式 cursor/offset 分页；`session.readSnapshot` 用 snapshot handle 分块（定义见 7.2）；声明为单帧语义的 method 必须各自声明低于帧上限的输出上限，超限返回结构化 `RESULT_TOO_LARGE` 而不是截断——`git.workspaceDiff` 等大输出 method 属于此列，要么分块要么收紧输出上限。
- helper 在单连接内并发处理请求（有界并发，初始上限 4），长传输（snapshot 分块、artifact readChunk、大 diff）不得队头阻塞 stat/文件树等短请求；每个请求沿用上述 timeout/cancel 语义；新增 method 必须声明是否占用并发槽。
- `file.readRange` 返回 version token（`mtimeMs:size`，与本地 `SessionSummary.indexVersion` 同构）；main 在同一 version 代内完成多块读取，后续块请求若文件已变化，helper 返回 `FILE_CHANGED`，main 重新 stat 后整组重读，不拼接跨代数据。`file.writeAtomic` 必须携带调用方最后读取的 `expectedVersion`，不匹配返回 `FILE_CONFLICT`，避免覆盖远端并发修改。

### 7.2 首版方法

| 域 | 方法 |
| --- | --- |
| 生命周期 | `hello`, `health`, `cancel`, `shutdown`, `capabilities` |
| 授权根 | `root.register`, `root.unregister`, `root.list` |
| 路径 | `path.resolve`, `path.stat`, `path.list`, `path.mkdir` |
| 文件 | `file.readRange`, `file.writeAtomic`, `file.rename`, `file.delete`, `file.searchNames` |
| Git | `git.listRepos`, `git.init`, `git.status`, `git.originalContent`, `git.workspaceDiff`, `git.stage`, `git.unstage`, `git.discard`, `git.discardMany`, `git.commit`, `git.deleteFiles`, `git.branches`, `git.checkout`, `git.createBranch`, `git.commitLog`, `git.commitCount`, `git.refs`, `git.branchCompare`, `git.commitDetail`, `git.commitFileDiff`, `git.diffBetweenRefs`, `git.fetch`, `git.push`, `git.pull`, `git.aheadBehind`, `git.watchRefs`, `git.unwatchRefs` |
| Session 存储 | `session.list`, `session.readPage`, `session.readTail`, `session.readSnapshot`, `session.stat`, `session.replaceAtomic`, `session.move`, `session.archive`, `session.listArchived`, `session.restoreArchived`, `session.remove`；内容对 helper 始终是不透明 bytes，snapshot 受固定字节上限约束并经 snapshot handle 分块传输（见下文） |
| Runtime artifact | `artifact.create`, `artifact.writeChunk`, `artifact.commit`, `artifact.readChunk`, `artifact.remove`；只操作 helper 签发的 opaque ref，按用途限制 bytes/TTL，不能接收 renderer path；仅 `artifact.create` 可向 main 同时返回 helper 自选的 `remotePath`，用于 Pi `export_html(outputPath)` 等受管外部写入，路径永不进入 renderer IPC |
| 终端准备 | `terminal.prepare`；只从已注册 project/agent root 签发短 TTL、mode `0600`、一次性 opaque launch ticket，不传 shell 命令 |
| 配置 | `config.getModels`, `config.patchModels`, `config.getSettings`, `config.patchSettings`, `config.testProvider`, `config.fetchModels`；返回值必须脱敏 |
| Runtime | `runtime.probePi`, `runtime.preparePi`；实际 Pi RPC 不经过控制协议 |

任何新方法必须先明确是 PiDeck UI/工作区/Session 浏览存储能力还是 Pi Agent 能力；`fork`、`export_html`、prompt、模型与工具命令等后者不得加入 helper，继续走 Pi stdio RPC。`artifact.create/commit/readChunk/remove` 只负责为 Pi 的受管输出保留、验收、传输和清理文件，不解释导出内容；`terminal.prepare` 只签发 cwd ticket，终端字节流仍在独立 ssh PTY 上。`session.replaceAtomic` 只接受 session file ref、helper 签发且已 commit 的 one-shot opaque artifact ref 和 `expectedVersion`，不得出现 message id、JSONL entry 或 repair/truncate 等格式语义；artifact 必须与请求 host/session/purpose 绑定，成功 replace 或超时后不可复用，main 还必须持有对应 runtime 的 mutation reservation。

`session.readSnapshot` 的分块协议：首次调用只携带 session ref，helper 在硬上限内 stat 并分配短 TTL 的 snapshot handle（绑定 size/mtime/inode 身份），返回 `{ snapshotId, version, totalBytes }` 与首个数据块；后续调用以 `snapshotId + offset` 取块，直到累计 `totalBytes`。读取途中文件被改写时 handle 失效并返回 `SESSION_SNAPSHOT_CHANGED`，main 丢弃已收字节整组重读，不拼接跨代数据；handle 在完成、cancel、连接关闭或 TTL 后释放，同一连接的活跃 handle 数量有并发上限。这样 32 MiB 的变换上限与 8 MiB 的单帧上限各自成立：内容按块流动，身份与版本按 handle 一次性确立。

远端 Session 生命周期固定为以下语义：

- rename：运行中调用 Pi `set_session_name` 并更新 catalog；未运行时复用 main 的 bounded `SessionMutationService`，helper 仍只做 opaque replace。任何一步失败都保留可重试状态，不创建第二个 stable id。
- archive/restore：仅允许 idle Session；helper 在 session scope 内做 opaque move 并返回新 ref/version，main 在同一 catalog commit 中更新 current path 与 aliases。`session.listArchived` 只返回有界元数据/ref，不解析消息。
- remove from PiDeck：只删本地 catalog 引用并写 tombstone，绝不调用远端 remove；后续扫描不会立刻重新导入，用户可从“待导入”显式恢复。
- delete remote Session：单独的破坏性确认后，取得 mutation reservation，校验 expectedVersion/locator 后调用 `session.remove`；运行中、版本冲突或身份不明时 fail closed。父子 Session 的处理必须沿用现有本地规则并在确认文案中列出影响范围。
- foreign import/sync：`session.list` 的 stable remote id/path 经去重规则导入；已 tombstone 的记录默认跳过，显式导入才清 tombstone。

所有 lifecycle response 都携带 opaque session ref、version 和 canonical path 元数据；helper 不生成 `SessionRecord.id`，稳定 id 始终由本地 `SessionCatalog` 拥有。

## 8. SSH、安全与信任

### 8.1 威胁模型

- PiDeck 信任本机 Electron main、系统 OpenSSH 客户端以及用户明确选择的远端 Unix 账号；renderer 输入、网络、远端项目内容、协议帧和命令输出都按不可信数据校验。
- 远端 Pi、helper、runner、Git 和终端首版运行在同一 Unix 账号。该账号本来就能通过 Pi/bash 读写其权限覆盖的文件，因此项目 root、sha256、owner 和 lease 校验是产品路由、误操作防护与完整性检测，不是抵御同账号恶意进程的 OS sandbox。
- 项目在确认 trust 前不启动 Pi、不执行 Git，也不运行项目配置、hook、filter、skill 或 extension；确认意味着用户允许该项目以远端账号权限执行代码。PiDeck 管理的 Git UI 仍默认禁用 hooks、external diff/textconv 和 signer，避免 trust 被无关配置隐式扩大。
- 同账号恶意进程可以制造 symlink TOCTOU、改写 helper artifact 或伪造 lease；首版对此明确不提供多租户安全保证。需要运行不可信 workload 时必须使用独立远端账号、容器或 VM；若未来要把 root confinement 提升为安全边界，应引入受保护的独立 helper 身份以及 `openat2(RESOLVE_BENEATH...)`/平台等价实现，不能只加强 Node path 字符串检查。
- 网络端点在首次用户确认后由 profile 专用 known-hosts pin 保护；首次连接仍是显式 TOFU，UI 必须展示解析后的 endpoint 和 fingerprint，不能把“认证成功”描述成第三方身份背书。
- 所有高风险确认都由 main 的 `PendingConfirmationBroker` 持有状态，不能相信 renderer 自报的 `confirmed: true`。主机 fingerprint、添加 `/` browse root、project trust、host rebind 和远端删除开始时，main 生成短期随机 `requestId`，在 pending map 中绑定发起的 `webContents.id`、action type、host/project/session stable id、route/fingerprint/canonical path/expectedVersion 等不可变字段的 digest 和过期时间；preload 只暴露“回答该 requestId”的窄 API。未知、过期、sender 不同、digest 已变化或已消费的回答一律 fail closed，窗口销毁等同拒绝；执行前 main 再校验当前状态并原子消费 request。broker 在窗口销毁和 app shutdown 时清空 timer/pending entry。

### 8.2 项目信任

- 项目 trust 是 location-aware 的持久化决策，不得继续以裸 `cwd` 为键。`buildProjectTrustKey()` 对 tagged tuple 做无歧义序列化并 hash；SSH tuple 包含 `hostId + verifiedEndpointIdentity + canonicalRemotePath`，其中 endpoint identity 为 5.2 定义的 `routeDigest + pinAlias + knownHostsSha256` 三元组 hash（唯一定义点在 5.2），确保不同主机上的同一路径、本地/WSL 同名路径以及主机重装后的新 key 互不继承授权。
- 远端 project 首次确认前必须由 helper 返回 canonical `realpath`；endpoint identity、canonical path 或 host 绑定变化后重新弹出 trust prompt。显式 rebind 只迁移 project/session locator，不复制 trust。旧本地 `cwd` trust 记录继续兼容读取，并在本地项目再次确认/保存时迁移到 location-aware key。

### 8.3 SSH 客户端

- 使用系统 `ssh`/`scp`，继承用户 `~/.ssh/config` 中的 identity/agent/ProxyJump 等连接能力，但 endpoint route 必须与 profile 保存的 route digest 一致。
- `SshCommandBuilder` 为 helper、Agent、bootstrap transfer 和 terminal 生成同一组 endpoint 参数：destination 保持原始 `sshHost` 以命中对应 SSH config stanza，`ssh -G` 候选解析不覆盖已验证 endpoint；只有候选 route digest 匹配后，实际连接才显式覆盖已验证的 host/user/port。所有连接都固定 profile 专用 `UserKnownHostsFile`、`GlobalKnownHostsFile=/dev/null`、`StrictHostKeyChecking=yes`、稳定 `HostKeyAlias`、`ForwardAgent=no`、`ClearAllForwardings=yes`、`PermitLocalCommand=no`。profile 显式设置 `identityFile` 时传 `-i <resolved-absolute-path> + IdentitiesOnly=yes`；OpenSSH 的 `-i` 会追加而非清除 alias 已配置的 `IdentityFile`，`IdentitiesOnly=yes` 不等于“只试这一把密钥”。未设置时不替用户枚举身份，继续使用该 alias 的 SSH config/IdentityAgent/ssh-agent；UI 不能宣传排他身份选择。terminal 只额外启用 TTY；未来 ControlMaster 也必须以相同 pin/route 建立，不能复用其他配置的 control socket。
- 首版非交互连接显式使用 `BatchMode=yes`、有限 `ConnectTimeout`、`ServerAliveInterval=15`、`ServerAliveCountMax=3`；主机 key、route digest 或 pin 文件 hash 未知/变化时立即失败，绝不自动降级到 `StrictHostKeyChecking=no` 或系统宽松 policy。
- 禁止 shell 拼接本地命令；统一 `spawn(executable, argv, { shell: false })`。`scp` 与 `ssh` 参数差异只在 builder 内处理，业务模块不能绕过公共 endpoint 参数。
- OpenSSH 的 remote command 仍会由远端登录 shell 解释，因此只允许 `SshCommandBuilder` 生成固定模板：经过单测的 POSIX quoting 只包裹受信任的 Node executable、helper 固定目录和 bundle hash。cwd、Pi argv、项目路径、prompt 等数据一律在连接建立后通过 NDJSON 传输，不能出现在 remote command 字符串中。
- 启动前定位 OpenSSH 并输出脱敏诊断：可记录 host profile id、端口、阶段和 exit code，不记录 identity path、ProxyCommand、完整命令或响应正文。

### 8.4 认证分期

首个开发里程碑支持 SSH config、agent 和无交互 identity file。首次 profile 验证允许一次隔离在 draft 临时 known-hosts 中的 `accept-new` 握手，成功后必须由用户确认 endpoint/fingerprint 才激活；之后全部使用 `BatchMode=yes + StrictHostKeyChecking=yes`。失败时给出明确原因和「在终端验证连接」入口。

图形化 AskPass 单独立项：

- 通过一次性本地 IPC/named pipe 连接 askpass 子进程和 Electron main。
- UI 展示远端 host 与原始 prompt，结果只在内存中传递。
- 不持久化密码/passphrase，不写日志。
- 主机指纹首次确认必须展示 fingerprint；不得无提示使用 `StrictHostKeyChecking=no`。

### 8.5 路径授权

- host 配置的 `browseRoots` 默认只有 helper 探测并经用户确认的 canonical 远端 home。新增或修改 root 必须经过 5.2 的已 pin 连接验证流程；未验证字符串永远不能进入 `root.register`。
- 远端目录选择器只能浏览 browse roots。
- 添加已有远端项目的 IPC 只接收 `{ hostId, candidatePath }`，由 main 的单一 enrollment service 在当前已 pin/route-matched 连接上调用 browse-scope `path.resolve/stat`，确认结果是目录且 canonical path 位于某个已注册 canonical browse root 内，随后才原子写入 `ProjectStore`。创建项目时先以同样规则验证最近存在父目录，再由 helper 创建并返回 canonical path 后持久化。renderer 不能直接调用 `root.register`，也不能提交“已 canonical”标志跳过验证。
- 每次重连为已存项目注册 project root 前，main 都重新验证 stored host/fingerprint/route 与 canonical containment；失败时项目进入 `needs-attention`，绝不把未经验证的 store 字符串注册成授权根。
- 项目添加后，所有文件/Git API 从 main 的 `projectId` 解析 root，不接受 renderer 自报的任意绝对 root。
- helper 拒绝 NUL、绝对 relativePath 和 lexical `..`，对 root 与最近存在父目录做 `realpath`/`lstat`，写入最终组件尽量使用 `O_NOFOLLOW`，操作后复核结果仍在 root；静态 symlink 逃逸必须 fail closed。
- 这些检查不改变 8.1 的同账号信任边界。检测到校验期间 inode/父链变化时返回 conflict 并要求重试，不宣称普通 Node 路径 API 能消除恶意并发替换的竞态。
- 远端项目删除只删 PiDeck 记录，不递归删除项目目录。

### 8.6 扩展与供应链

远端 Pi 无法加载本地 `resources/extensions/*.ts` 路径。支持远端 Agent 前必须同步 PiDeck 内置扩展快照：

- 将当前本机 `resolveBuiltInExtensionRoots()` 解析出的、整份校验通过的有效快照上传到 `~/.pideck/extensions/<bundleSha256>/`；若本地 hot-update overlay 生效，远端必须得到同一份 overlay 内容而不是退回安装包 base。
- 快照包含 manifest 内的完整扩展集合和 vendored runtime dependencies。
- 远端重新校验每个文件 sha256 后才允许作为 `-e` 参数。
- 目录按内容寻址且不原地覆盖正在运行的快照；同账号写入能力意味着它是约定上的 immutable，不是权限隔离。执行前再次校验可发现漂移，无法阻止同账号恶意进程的 check-to-exec race。
- 扩展快照沿用 4.2 的可达性清理：active、上一份 rollback 和活跃 runtime lease 引用的 bundle 永不清理；其他 bundle 最多保留 2 份且最长 7 天。更新器必须在新 bundle 校验和 active pointer fsync 完成后才把旧 active 标为 rollback；任何 lease/owner/manifest 校验失败都跳过删除并产生日志。
- 相对 import 所需辅助文件必须一起上传，判据继续是逐文件 sha256。
- 本地用户扩展不默认上传；远端用户扩展由远端 Pi 自己发现。

## 9. 设置归属

| 设置/数据 | 默认归属 | 规则 |
| --- | --- | --- |
| PiDeck 主题、字体、布局、通知 | 本地 | 永不随 host 切换 |
| SSH profile、超时、browse roots | 本地 host profile | 不上传到远端 |
| Pi provider、model catalog、`settings.json` | 远端 | 由远端 Pi 读取；启动前校验 Pi 版本/RPC capability |
| `auth.json` / API key | 远端 | 不自动复制；首版通过远端终端登录，禁止扩大本地 `pi-auth` 例外 |
| 网络代理 | 分域 | SSH 连接用本地连接设置；Pi/provider 请求用远端环境和远端 Pi 设置，不透传本地 API/proxy env |
| 项目 `.pi` 配置、AGENTS、skills | 远端项目 | 与代码同处远端 |
| PiDeck 内置扩展 | PiDeck 管理的远端只读快照 | manifest + sha256 校验 |
| Session JSONL | 远端 | 本地仅存索引和有界缓存 |
| 会话 UI 状态、tab、split、草稿 | 本地 | 以稳定 `SessionRecord.id` 关联 |
| model/thinking 当前选择 | Session runtime | 启动后以远端 Pi 能力校验 |

首版默认「使用远端现有 Pi 配置」。后续同步向导必须逐项显示差异并显式选择；`auth.json` 永远不进入通用同步。

## 10. 连接状态与恢复

主机状态与 Agent send state 分开建模：

```ts
export type RemoteHostConnectionState = "disconnected" | "connecting" | "probing" | "bootstrapping" | "ready" | "degraded" | "reconnecting" | "offline" | "needs-attention";
export type RuntimeTransportState = "local" | "connecting" | "ready" | "connection-lost" | "recovering";
```

不要把这些值直接塞进现有 `AgentStatus`；renderer 以 session-scoped atom family 订阅本栏 runtime transport，host 列表另订 host state。

主机状态机：

```text
disconnected → connecting → probing → bootstrapping → ready
                     └──────────────→ needs-attention
ready → degraded → reconnecting → ready/offline
```

规则：

- `RemoteControlClient` 每次建连递增 `connectionGeneration`；host 请求/响应和推送 frame 都回显 `hostId + connectionGeneration`，main 只交付当前 generation 且仍处于 pending map 的 id。断线会一次性 reject 该 generation 全部 pending request，cancel/response 晚到只能被丢弃；`runtimeGeneration` 是独立的 Session runtime fence，二者不得混用。
- 控制连接使用带 jitter 的 `1s, 2s, 5s, 10s, 30s` 退避，30s 封顶；用户操作可立即重试一次。
- 主机 ready 不代表每个 Agent runtime ready；两者状态分开显示。
- 控制连接重连不替换正在运行的 Agent SSH 进程。
- Agent SSH 断开时，独立的 runtime transport 进入 `connection-lost`，coordinator 增加 `runtimeGeneration` 并拒绝旧事件；现有 `AgentStatus` 只反映 Agent 生命周期。
- 若断线发生在 Agent 忙碌期间，不自动重发 prompt。重新连接后扫描远端 Session：
  - 已有完整 assistant 结果：刷新并恢复 idle。
  - 只有部分结果或文件仍在变化：标记 interrupted，允许用户继续或重启。
  - 无法判断命令是否被接受：显示「执行状态未知」，要求用户确认。
- 应用退出时清理 helper、Agent SSH、terminal SSH 和 timers；远端 runner 在 stdin EOF/信号后执行 TERM → 超时 → KILL。
- 每个 runner 使用随机 run nonce 写短期 lease（pid、进程启动标识、Session id）。重连时只清理能够同时证明 owner nonce 和进程启动标识匹配的 stale runtime；不能证明所有权时只报告诊断，绝不按复用过的裸 pid 杀进程。

## 11. UI 信息架构

### 11.1 主机管理

设置页新增「远程主机」面板：

- 主机列表显示 label、`user@host`、最近状态、Node/Pi/helper 版本。
- 操作：添加、编辑、测试连接、查看诊断、删除。
- 测试连接按阶段显示：OpenSSH → 认证 → 平台 → Node → helper → Pi。
- 删除有项目或 Session 引用的 host 时只允许「取消」或「停用并保留离线记录」；停用写入 tombstone，不删除远端数据，也不释放 `hostId`。彻底删除前必须先显式删除引用或 rebind 到新 `hostId`，并完成 Session origin、project locator 和冲突检查。

### 11.2 项目

新增项目流程先选择位置：本机 / WSL / SSH host。

远端提供三种动作（按 §12 阶段解锁，未到阶段的动作在 UI 显式禁用并标注所属阶段，不是隐藏）：

1. 添加已有目录（Phase 3）。
2. 创建空目录，可选 `git init`（Phase 5）。
3. Clone repository（Phase 6 评审后的独立能力）。

侧栏给远端项目使用图标和 host label；离线时仍可见但明确禁用运行操作。不要把 host 连接状态混成 Session send state。

### 11.3 Session

- 新建 Session 默认继承项目 location。
- Session 列表允许按 host/project 分组和筛选。
- 打开离线 Session 先展示本地 catalog 元数据；消息不可用时显示重连动作。
- Composer 在 `connecting`、`connection-lost`、`needs-attention` 时禁用并展示具体原因。
- 所有用户可见文本同步加入中英文 i18n。

## 12. 分阶段交付

发布边界固定如下，不能把中间架构里程碑包装成“远端首发”：Phase 0-2 仅开发基础设施；Phase 3 可在开发构建中以默认关闭的 feature flag 做只读预览；Phase 4 只允许邀请制/显式实验开关 beta，并在 UI 持续标记文件写入、Git 与终端尚未可用；**完成 Phase 5 全部门禁后才允许发布 PiDeck Remote v1 稳定版**。Phase 6 是 v1 之后的认证与优化，不是把 Phase 5 已承诺的安全审查延期。

### Phase 0：架构护栏与技术验证

目标：证明无需改 Pi 协议即可穿过 SSH 运行完整 RPC turn。

- 写独立 spike：system ssh 启动远端 `pi --mode rpc`，完成 `get_state → prompt → abort`。
- 验证 stderr/stdout、signal、远端 cwd、环境变量和退出清理。
- 验证 `SshHostVerifier` 能从 Windows/macOS/Linux 的 OpenSSH 已认证握手中稳定取得 normalized fingerprint；不得用 helper 自报或裸 `ssh-keyscan` 替代。
- 记录 Linux/macOS、Node/Pi 版本矩阵。
- 不合入产品 UI；失败则先修正 launcher 设计。

门禁：无 orphan Pi；stdout 无额外 banner；网络断开能在有限时间内触发 exit；能 fail-closed 地取得已认证 host fingerprint；不需修改 Pi。

### Phase 1：位置模型和本地行为无回归

Phase 1 是全计划风险最高的契约迁移（全库 path-bearing contract 改造），因此按 **files → git → terminal → session history** 的域顺序分小批合入，每批独立过 typecheck + 针对性测试并保持 main 可发布；若迁移受阻或超期，已合批次必须收口在「本地行为无回归」的可发布状态，剩余批次重新排期，不允许半迁移状态长期停在 main（与 §17 批次纪律一致）。

- 加入 `ProjectLocation`、`ProjectLocator`、`SessionLocator`，把规范化 `Project`/`SessionRecord` 改为 locator 判别联合，并实现 v1 store reader 与 local-only compatibility serializer/adapter。
- 抽出 `PiRuntimeLauncher`，先只实现 local launcher。
- 建立文件、Git、Session repository/backend 接口，先全部路由 local。
- 迁移 `FileTreeNode`、Session summary/history/runtime 以及 `TerminalTarget`/`TerminalTab` 等 path-bearing shared/IPC contract 到 project target、stable owner identity 或 locator；renderer/preload/main 三层同批修改，保留 local compatibility adapter。project terminal 输入不再携带 cwd，远端 tab 的 cwd 只允许作为 display 元数据。
- 抽出 location-aware launch preparation，逐项锁定现有 Pi command/version/WSL/trust/security/resource/repair 行为。
- 抽出 `TerminalSessionLauncher` 并先用 `LocalTerminalSessionLauncher` 保持现有 local/WSL node-pty 行为；owner key 改用稳定 project/session/runtime identity，证明不同 host 的同路径不会共用终端桶。
- 保持本地用户可见行为，不承诺旧 IPC shape 永久不变。

门禁：本地项目、WSL、Session 恢复、history edit/delete/resend/fork/export、Git、终端、security gate、trust prompt 和扩展 fallback 针对性测试全绿；旧 ProjectStore 数组、SessionCatalog v1 fixture 可读，local compatibility 输出仍满足旧调用方且迁移后 primary/backup 可恢复；remote `Project`/`SessionRecord`/`TerminalTarget` fixture 在类型与运行时都不含伪造 `path/environment/filePath/wsl*/cwd` authority，也不能进入本地 `node:fs`/Git/path/shell helper。

### Phase 2：主机管理与 helper

- 将已实现的 `RemoteHostStore`、`SshClientRuntime` 和已验证连接预检/参数 builder 装配到 main 生命周期，并继续实现连接状态机和诊断。
- 在 store 层落实 draft/verified endpoint identity 规则、referenced profile tombstone、持久化 `retiredHostIds`，以及由 main 持有 durable journal 的幂等 rebind；迁移必须覆盖 ProjectStore/SessionCatalog 引用、origin 冲突检查和崩溃恢复。
- 实现 helper v1、manifest、上传、校验、原子激活和版本清理。
- 增加 `remote:*` IPC、preload API 和设置页主机面板。
- 首批仅支持 key/agent 认证和 POSIX 远端。

> 当前 Phase 2 安全切片已完成候选 `ssh -G` argv、路由摘要、隔离临时 `known_hosts` 的认证后 host key 候选验证、main-only `PendingConfirmationBroker` 与 `SshHostPinStore` 的一次性 sender 绑定确认、认证重验及不覆盖已有文件的 pin 写入/读取校验。已新增离线 `RemoteHostStore`：严格版本化 profile/retired-id envelope、revision CAS 和主机目录锁，备份仅供 needs-repair 下离线查看；`offerPin/confirmPin` 只能从主进程待决确认取得 endpoint，锁内复核 pin 后提交档案，启动和提交失败会检测未知、孤儿、缺失或不匹配的 pin 并 fail closed。档案生命周期已补齐引用感知：`updateDraft` 只允许**从未验证**的 draft 原地改（已验证档案的 endpoint 身份冻结，改指必须新建/显式 rebind），并在锁内先查引用；`retire` 要求显式注入 `RemoteHostStoreReferences`（否则 `REMOTE_HOST_REFERENCES_UNAVAILABLE`）、要求对象已是 disabled tombstone、且引用为空，成功时**先提交快照再删 pin**（反序会在任何提交失败时销毁仍存在主机的信任锚并把目录锁进 needs-repair；已退役 id 的残留 pin 由加载器容忍并在下次 open 清理），retired id 永久保留。已新增 main-only `buildPinnedSshInvocation`：每次重新加载 ready profile/pin，沿首次认证的候选 `ssh -G` 校验 route 与 endpoint，再以拟用的严格参数复查 `ssh -G`、有效 pin/禁用控制复用/转发，最后二次加载并发档案与 pin，在本次调用内生成 SSH/SCP argv，不启动连接进程。显式 identityFile 不存在、非普通文件或不可读时失败关闭。已新增 main-only `SshClientRuntime` 客户端上下文：不从 PATH 解析，Windows 取 `%SystemRoot%\System32\OpenSSH\ssh.exe`（32 位进程走 Sysnative）并从同目录取 `scp.exe`，非 Windows 未验证平台在显式给出绝对路径前 `SSH_CLIENT_UNSUPPORTED_PLATFORM` 失败关闭；只接受普通可执行文件（拒绝符号链接与 .cmd/.bat/.ps1 等脚本 shim），并做 `ssh -V` 版本自检（要求 OpenSSH ≥ 8）。环境为白名单快照（保留 SystemRoot/ProgramData/账户 home/APPDATA/PATH/TEMP/SSH_AUTH_SOCK 等 OpenSSH 与 agent/ProxyCommand 必需项，剔除 PI_*/PIDECK_*/NODE_OPTIONS/ELECTRON_*/模型密钥/通用代理/SSH_ASKPASS 等），指纹验证与连接预检共用同一实例，预检返回绝对可执行文件路径与该环境，杜绝「探测一个客户端、启动另一个」。**装配状态**：`SshConnectionManager` 已在 main 内消费该上下文（预检 → launcher 启动 → 状态机 → 诊断），但**尚未接入 app 生命周期**（`main/index.ts` 不构造它、无 IPC/preload/设置页入口，运行时不启动任何真实 SSH 会话）；`ssh -G` 自身可能通过用户配置的 `Match exec`、规范化/DNS 执行外部命令或网络访问，不承诺严格离线。SCP 传输目标、固定远端命令模板、跨检查和实际启动的同账号文件/config 竞态仍未解决。已新增 main-only 连接状态机与诊断切片：`RemoteHostConnectionState` 纯函数实现 §10 的 `disconnected → connecting → probing → bootstrapping → ready`、`ready → degraded → reconnecting → ready|offline`、`needs-attention` 终态（仅显式 `user-retry` 可离开）、generation fencing、1s/2s/5s/10s/30s 有界 jitter 退避与 shutdown latch；`SshConnectionDiagnostics` 只接受可枚举状态/阶段/错误码并做有界历史，任何路径、命令或响应正文都无法进入诊断；`SshProcessLauncher` 只以 `shell:false` + 绝对路径 + 清洗环境启动已 pin 调用，输出有界、停止幂等；`SshConnectionManager` 把预检、启动、状态机与诊断串起来：显式传入会话期限与输出上限（不继承启动器的一次性命令默认值），瞬时失败按阶梯重试，致命错误码（路由/pin/身份/客户端/严格配置）不重试，阶梯或「短命会话」抖动预算耗尽后转 `needs-attention`（`SSH_CONNECTION_RETRIES_EXHAUSTED` / `SSH_CONNECTION_UNSTABLE`），避免成功即清零 attempts 造成的无限重连；诊断写入运行在进程退出与定时器回调上，任何非法码/超域退出码（如 Windows 0xC0000005）都被归一化而不是抛出；abort 与 shutdown 分离（abort 回 idle 且 generation 单调不回退，shutdown 才 latch），并以 epoch 栅栏确保「spawn 中中止」的迟到进程被停止、迟到 exit 被忽略；`dispose()` 等待在飞尝试后才返回，之后 connect/retry 显式失败。以上均为 main-only 且有离线单测，**尚未装配**到 app 生命周期、IPC、preload 或设置页，运行时不启动任何真实 SSH 会话；`ready` 仅表示受 pin 的 SSH 进程已启动并存活，不代表 helper/Pi 已验证——§11.1 的 platform/node/helper/pi 阶段当前无生产代码可达，manager 只驱动到 `openssh`/`authenticate`。已知限制：pinned `ssh -T` 的认证失败（私钥错误、被拒）只能表现为退出码 255，当前按瞬时丢失处理并由抖动预算收敛到 `needs-attention`，未解析 stderr 分类（避免把响应正文引入判定）。协议与引导契约已按 §7.1/§168 落地为离线模块：`RemoteControlClient`（单帧上限不截断、response 必须回显 hostId+id+当前 generation、旧代/未知 id/重复终帧只丢弃并脱敏诊断、本地 deadline 先到者胜、cancel 独立 id 且目标已结算时返回 `{cancelled:false,reason:"already-settled"}`、close 一次性收敛该代 pending 且新代不重发）；`RemoteBootstrapContract`（固定 8 token 模板 + 逐 token POSIX quoting、deploy root 相对 `.staging-<nonce>`、manifest 严格解码与逐文件 bytes/sha256/owner/mode 复核，只有全部通过才允许原子激活）。二者都**尚无生产调用方**：`SshProcessLauncher` 现已按有界行流暴露 stdout/stderr（`onStdoutLine`/`onStderrLine`，StringDecoder 处理跨块多字节、CRLF 归一、空行丢弃、超长行终止为 `SSH_LAUNCHER_LINE_TOO_LARGE`、进程结束前冲刷残行、首个订阅者前的行做有界 backlog 重放），因此 helper 帧的传输链路已在 main 侧打通：launcher 按请求开 stdin 并暴露 `write(line)`（NUL/CR/LF 与超长行拒绝、settle 后拒绝、写失败映射稳定码、异步 EPIPE 被吸收），`maxOutputBytes` 语义改为「未消费字节」并让 backlog 行数/字节双重有界，长会话不会再被累计输出上限误杀；`SshConnectionManager` 每个 attempt 建一个 `RemoteControlClient`，stdout 行喂 `handleLine`、stderr 只记 `SSH_HELPER_STDERR` 不记文本，`request(hostId, …)` 仅在 ready 且有 control 时放行，exit/abort/shutdown 一律 close 并让该代 pending 恰好收敛一次；每个 attempt 的 handle/订阅/client 归该 attempt 私有释放（晚到 exit 只能拆自己，不会把替换它的新会话打成「假 ready」或留下停不掉的孤儿进程），stdout/stderr 的读侧 `error` 被吸收为 `SSH_LAUNCHER_STREAM_FAILED`（否则一条管道错误会带走主进程），持有区保证装得下一个最大帧，诊断按「代 + 码」去重以免远端噪声冲掉 200 条历史。**仍缺**：固定远端 helper 命令模板的实际下发（当前 invocation 仍是无远端命令的 `ssh -T`，因此真实远端跑的是登录 shell 而不是 helper）与 helper 二进制本身；`SshProcessLauncher.ts` 已 591 行，超过 400 行目标但仍低于 600 行的评估线，后续宜把行解码/计量抽成独立纯模块。bootstrap 部署的 finalize 已钉死为分帧方言（`finalize-begin`/`finalize-file`/`finalize-commit`，因为冻结入口的入站行上限是 4096 字节，manifest 必须逐文件送）：主进程侧驱动 `RemoteBootstrapTransfer`（帧序列 + 严格结果解码 + 终帧收敛 + 超时释放订阅）已实现并有离线测试；入口侧在锁内逐文件复核 bytes/sha256/owner/mode → fsync（文件、staging、bundles）→ 原子 rename 到内容寻址的 `<deployRoot>/bundles/<bundleSha256>`（rename 是唯一提交点；目标已存在则复核后幂等成功、绝不覆盖，不一致报 `BOOTSTRAP_ACTIVE_CONFLICT`；失败路径不触碰 `bundles/`，commit 期间到达的 abort 不删除已激活目录）已实现并有真实子进程测试（入口用 `globalThis.crypto.subtle` 做哈希以满足「不新增 require」，因此**远端 node 需 ≥19**，缺失时在取锁/建 staging 之前以 `BOOTSTRAP_INTERNAL` 失败关闭；POSIX 专属的 uid/mode 比对与目录 fsync 分支在本机 Windows 未能执行，模式用例在 Linux/macOS 上运行）。**上传侧约束**：落盘 mode 必须等于声明的 `0600`/`0700`（普通 `scp` 的 0644 会被 finalize 以 `BOOTSTRAP_MODE_INVALID` 拒绝，需 `scp -p` 或等效手段），且上传目标只能取自 ready 帧校验过的 staging 身份。已知缺口（独立复核发现，已记录待办）：`verifyBundleFiles`/`assertActivationPreconditions` 的观察值仍只有 name/sha256/bytes（无文件类型/nlink），main 侧若要单独用它排除符号链接替换需补 `lstat` 语义（冻结入口自己的 finalize 已做非符号链接普通文件校验）；`REMOTE_HELPER_MAX_CHUNK_BYTES`/`MAX_CONCURRENT_REQUESTS` 已定义但无执行点，main 侧 pending 也未设上限（§7.1 把有界并发放在 helper）；`cancel` 对从未发出的 id 也返回 `already-settled`，UI 无法区分「已结算」与「不存在」；bootstrap 的 upload 侧（scp 目标编码、staging 路径导出）仍未实现。不能标记 Phase 2 完成。**尚未装配**到 app、IPC、preload、设置页或产品连接入口；pin 与 profile 跨文件崩溃后只会进入 needs-repair，缺少安全的人工修复流程，ProjectStore/SessionCatalog 的共同锁、引用检查及 rebind journal 也尚未实现，不能标记 Phase 2 完成。验证器首批仅接受单条普通 `ssh-ed25519` host key，RSA/ECDSA、host certificate/CA 及异常 pin 均 fail closed；扩大算法支持前须有对应 OpenSSH 解析与跨平台 fixture。首次握手前若 `ssh -G` 最终配置仍含 `SendEnv`/`SetEnv` 即拒绝，且显式禁用 X11/agent/端口转发；这不替代真实客户端环境传播矩阵。Windows/macOS/Linux 客户端的产品级已认证 fingerprint 和完整环境矩阵仍未通过，不得据此激活主机或启动 helper。

门禁：恶意 host/port/path 不可注入 argv；协议畸形、超时、hash 不匹配和版本不兼容都有结构化错误；OpenSSH 已认证 fingerprint 无法取得时 fail closed，alias 改指不会启动 helper；伪造/重放/过期或来自其他 sender 的高风险确认不能激活 profile/root/rebind/delete；被引用 profile 不可硬删除或原地改指；rebind 中途崩溃可恢复，完成后 locator/origin 无冲突且 trust 不继承；所有资源有清理路径。

### Phase 3：远端项目与只读工作区

- 只允许添加已有远端目录；创建空目录和 `git init` 属于写操作，移到 Phase 5。
- 文件树、文件读取、搜索和 Session 扫描先只读上线。
- 本地 catalog 记录远端项目和 Session locator。
- 完成离线和重连 UI。

门禁：不存在本地 fs 读取 remotePath 的路径；未经验证的 browse root 不能注册；add-project IPC 绕过 picker 直接提交 root 外路径、symlink 改指或伪造 canonical 标志都必须失败且不写 ProjectStore；重连时 root 复核失败进入 `needs-attention`；目录遍历/symlink 逃逸测试全绿；大文件和大目录有硬上限。该阶段只能由默认关闭的开发 feature flag 暴露。

### Phase 4：远端 Agent 与 Session 生命周期

- 实现 `SshPiRuntimeLauncher`。
- 上传并校验 PiDeck 内置扩展快照和每 Session security artifact。
- 接入远端 trust 检查、Session repair、远端 project resource discovery 和 Pi version capability gate。
- 接入 target-aware remote config backend；模型/settings 使用脱敏 patch，auth 只提供远端终端入口。
- 新建、打开、恢复、重命名、归档、恢复归档、只移除 PiDeck 索引、显式删除远端文件、停止和重启远端 Session；每项严格使用 7.2 定义的 lifecycle 语义、tombstone、alias 与 mutation reservation。
- 接通 history edit/delete/truncate-for-resend 等 storage backend；活动会话的 fork/reload 和 resend 后的 prompt 继续走远端 Pi RPC。所有整文件变换沿用统一 32 MiB `MAX_SESSION_TRANSFORM_BYTES`，remote helper 必须在下载前按 `session.stat`/自身硬上限拒绝超限文件。
- 活动与未打开会话导出都使用官方 `export_html(outputPath)`：helper 签发 purpose=`session-export` 的 ref + main-only `.html` 路径，Pi 写入后 helper commit/校验，main 分块下载并在所有结束路径清理；未打开会话临时启动远端 Pi runtime，helper 不解析 JSONL、不生成 HTML。
- 明确 composer 输入：文本和现有有界 inline image content 继续直接走 Pi RPC；远端项目文件引用只传 project-relative 语义，由远端 Pi 在项目中读取；任何只提供本机绝对路径的附件/拖入文件在 remote target 下禁用并解释，受管临时上传不属于 v1。

门禁：并行打开两个远端 Session 不串事件；切换 host 不串 catalog；同路径跨 host/fingerprint 不共享 trust；断线时不重复 prompt；重连能从远端 JSONL 恢复；rename/archive/restore/remove/delete 的成功、冲突、崩溃恢复与 tombstone 行为均有测试；未打开会话导出只调用远端 Pi `export_html`；本地路径附件不会误传给远端；本地 Session 无性能回退。同时在 50ms RTT 参考链路（Docker sshd fixture）上记录核心交互延迟并对照初始预算——终端回显 ≤150ms、文件树首屏 ≤2s、打开会话首屏（尾部一页）≤3s、`git status` ≤3s——超预算先做传输/并发/连接复用优化再谈后续发布节奏；预算本身可随实测修订，但必须显式修订而不是绕过。该阶段仍是显式实验 beta，不能宣称 Remote v1 稳定可用。

### Phase 5：写操作、Git 与终端

- 远端文件原子写、rename、delete，以及创建空项目目录。
- 按 6.3 完成远端 Git v1 全部支持项及能力禁用：status/diff/stage/unstage/discard/commit、仓库发现/init、基础分支、历史/refs/compare、fetch/push/pull/ahead-behind 和 refs polling；worktree 与破坏性历史改写保持禁用。
- SSH terminal 与项目 cwd：先由 `terminal.prepare` 签发一次性 cwd ticket，再以 node-pty 启动 `ssh -tt` 和固定 `terminal-runner.mjs`；不得把 cwd/shell/user text 拼进 remote command，remote shell picker 不复用本机候选。
- Remote v1 不包含 clone、worktree、cherry-pick/revert/reset/drop、checkpoint/rewind、受管本机附件上传或外部编辑器 URI；这些能力进入 Phase 6 单独评审。

门禁：所有写操作受 project root 限制；commit/branch/ref/path 参数无 shell 或 option 注入；支持的每个现有 Git IPC 都命中 remote backend，禁用项都返回 `UNSUPPORTED_CAPABILITY` 且 UI 不触发；终端 ticket 不可伪造/重放/跨 project 使用，握手字节不泄漏到 shell，resize 到达远端，关闭无残留本地 ssh 且不影响同 host 其他 tab/Agent，远端前台 shell收敛，文档/UI 不承诺清理 daemonized job；Git 输出有大小和超时限制；Phase 0-5 全量 capability parity 表通过；完成安全审查、Windows/macOS 本地到 Linux 远端 smoke、`npm run pack` 资源检查、helper 升降级与断电/半写入恢复测试。满足本门禁后才可发布 Remote v1。

### Phase 6：v1 后认证、同步和优化

- 图形化 SSH AskPass（密码/passphrase；host fingerprint 确认已在 Phase 2 完成）。
- 按价值单独设计 clone、worktree、cherry-pick/revert/reset/drop 等高风险 Git 操作，以及支持 SSH URI 的外部编辑器集成。
- 设计 location-aware checkpoint/rewind backend 和受管本机附件上传（sha256、大小/TTL、清理与 project-relative 引用）。
- 显式配置/skills/扩展同步向导，不同步秘密。
- 连接复用优化、可选 SSH ControlMaster（仅支持的平台）。
- 遥测只记录阶段、耗时和错误码，不记录主机名、路径、命令正文或凭据。
- 评估 Windows 远端和端口转发。

门禁：每项能力单独安全评审和跨平台 smoke 后再开启；Phase 6 未完成不影响已满足 Phase 5 门禁的 Remote v1，但也不能预先宣传这些能力。

## 13. 能力对照与发布门禁

先看总账：本地完整、远端 v1 明确缺失或降级的能力——checkpoint/rewind、worktree 与 cherry-pick/revert/reset/drop 等历史改写、Git clone、用量查询、本机路径附件/拖入文件、外部编辑器跳转、端口转发/浏览器面板、DSH/imagegen 等其他来源会话。发布沟通、功能开关文案和发布说明必须与这份总账对齐，不能只宣传「远程可用」而不列降级面；其中 checkpoint/rewind 是本地完整能力，属于最显著的体验落差，发布说明需单独说明并给出预期。

| 能力 | 本地现状 | 远端首发 | 允许差异 |
| --- | --- | --- | --- |
| 新建/发送/停止 Agent | 完整 | 必须 | 无 |
| Session 创建/恢复/列表/rename/archive/restore/remove/delete | 完整 | 必须 | remove 只移除索引并 tombstone；远端 delete 单独确认；全部保持 stable id/path alias |
| Session edit/delete/resend/fork/export | 完整 | 必须 | 存储变换走 helper；活动会话 Agent 动作走 Pi RPC；未打开会话导出使用临时远端 Pi runtime 调用官方 `export_html` |
| 文件树/读写/搜索 | 完整 | 必须 | watch 可先轮询 |
| Git 基础工作流、历史与同步 | 完整 | 必须 | 精确范围见 6.3；diff 更严格限流，refs watch 可轮询 |
| 终端 | 完整 | 必须 | 首版仅 POSIX 远端 |
| worktree/cherry-pick/revert/reset/drop | 完整 | v1 禁用 | UI 标明不支持，绝不回落本地 Git |
| 外部编辑器/文件管理器 | 本地路径 | 可后续 | 只提供支持 SSH URI 的编辑器 |
| Pi 登录 | PiDeck auth 弹窗/终端 | 首版远端终端 | 不复制或读取 `auth.json` |
| Pi models/settings | 本地配置 UI | 必须按 host target | secret 只显示状态；不支持项明确禁用 |
| provider 测试/模型拉取 | 本地执行 | 必须在目标 host 执行 | 脱敏返回，禁止误用本地 key/网络 |
| 用量查询 | 本地执行 | v1 禁用 | 通用 probe 可携带任意请求；远端 allowlist/redaction 设计完成前不开放 |
| 内置扩展 | 本地 resources/overlay | 必须上传校验快照 | 更新在新 Session 生效 |
| 用户扩展/skills | 本地发现 | 使用远端已有 | 后续显式同步 |
| inline image/文本粘贴 | 完整 | 必须 | 走现有有界 Pi RPC content，不创建路径 |
| 本机路径附件/拖入文件 | 本地路径可达 | v1 禁用 | 不把本机 path 发远端；后续需受管上传、sha256、大小/TTL 和清理 |
| checkpoint/rewind | 完整 | 首发禁用 | 必须先实现远端 backend，不能回落本地 fs |
| DSH/imagegen/外部来源 Session | 完整 | 首发不支持远端 | 只允许 local location |
| 浏览器服务 | 本地 | 可后续 | 需端口转发设计 |

Remote v1 发布条件：完成 Phase 5；表中「必须」项和 6.3 Git 支持清单全部通过；任何“v1 禁用”都必须由 capability 驱动禁用并有 i18n 解释，不能隐藏失败、静默 no-op 或调用本地实现。

## 14. 测试策略

### 14.1 单元与契约测试

建议新增：

```text
tests/remoteHostStore.test.mjs
tests/sshCommandBuilder.test.mjs
tests/remoteProtocol.test.mjs
tests/remoteBootstrapper.test.mjs
tests/projectLocationMigration.test.mjs
tests/sessionLocatorMigration.test.mjs
tests/remotePathSecurity.test.mjs
tests/remoteRuntimeGeneration.test.mjs
tests/remoteDisconnectRecovery.test.mjs
tests/remoteExtensionSnapshot.test.mjs
tests/remoteArtifactCleanup.test.mjs
tests/remoteSessionLifecycle.test.mjs
tests/remoteSessionMutationLimits.test.mjs
tests/remoteSessionExport.test.mjs
tests/remoteTerminalSession.test.mjs
tests/remoteGitCapability.test.mjs
tests/remoteIpcContract.test.mjs
```

覆盖：

- argv 注入、换行/NUL、以 `-` 开头的 host，以及 remote command 不包含 cwd/用户文本；profile 显式 `identityFile` 的 `-i` 追加行为/`IdentitiesOnly=yes` 与未设置时的 alias/agent 身份行为均有 fixture；首次 `ssh -G` 不预设已验证 endpoint，已验证目标 alias 的 HostName/ProxyJump 声明改指必须在 digest 预检时失败；跳板 alias 内部变更由跳板自身 host-key policy 验证，不能误断言目标 digest 一定变化。
- 高风险确认的 pending request 绑定 sender/action/stable id/route/fingerprint/canonical path/expectedVersion digest；未知、过期、跨窗口、字段变化和重复回答都失败，关闭窗口默认拒绝且不留 pending entry，确认前后状态变化必须要求重新确认。
- remote Node/Pi executable 拒绝参数和 shell 元字符，固定 helper path/hash 的 POSIX quoting 有跨 shell fixture。
- `sanitizeSshChildEnv()` 不泄漏 `PI_*`、provider key、`NODE_OPTIONS` 和本地代理配置。
- browse root 注册只接受已 pin 当前 route 上存在目录的 canonical absolute path；不存在、文件、symlink 改指、owner/mode 不合要求、`/` 未二次确认、route/fingerprint 变化以及 renderer 直接注入都 fail closed。
- add-project IPC，以及 Phase 5 启用后的 create-project IPC，即使绕过 picker 也必须在 main 重做 canonical containment；root 外路径、伪造 canonical 标志、并发 symlink 替换和重连后 containment 漂移均不得写入/注册 ProjectStore。
- helper 半包、多包、非法 JSON、超大帧、deadline、stderr 噪声和超时；cancel 在执行中、响应同时到达、commit point 前后和断线时都恰好 settle 一次；旧 `connectionGeneration`/错误 hostId 的迟到 response 永不命中新 pending request。并发模型 fixture：大传输（snapshot 分块/artifact readChunk/大 diff）进行中 stat/文件树等短请求不被队头阻塞，并发槽位与活跃 snapshot handle 耗尽时返回结构化错误而非静默排队到超时。
- runner 握手 ready 与首个 Pi stdout frame 落在同一 chunk 时不丢字节。
- 文件 `expectedVersion` 冲突不会覆盖远端新内容；`file.readRange` 多块读取途中文件被改写时返回 `FILE_CHANGED` 并整组重读，不拼接跨代数据。
- bootstrap 上传中断、两条 SSH/SCP 连接的 pin/route 不同、部署锁竞争与断线释放、hash 错误、manifest 与 extraResources 漂移、rename/fsync 失败、active pointer 半写入和旧版本回滚；active/rollback/活跃 lease 永不被清理，未引用 bundle 的“最多 2 份且最长 7 天”、staging 1 小时、artifact 24 小时和 terminal ticket 最长 60 秒规则可用 fake clock 验证。多客户端 fixture：两个 PiDeck 实例（可视为不同版本）连同一远端账号时并发 bootstrap 锁互斥（`DEPLOY_LOCK_HELD`）、staging sweep 不误删对方上传中目录、双方各自 bundle 因活跃连接注册而保留、持有锁进程退出后 stale 锁按进程启动标识回收。
- 连接断开、迟到事件、连续重连、app shutdown。
- 旧 ProjectStore 数组、SessionCatalog v1 和新 v2 fixture 的兼容读取；并发 mutator 串行化；在 temp file sync、primary→backup、temp→primary、支持平台的 directory sync 各 crash point 恢复最高有效 revision；Windows rename 重试/目录 sync 不可用的 fallback 有独立 fixture；primary/backup 都损坏时进入 `needs-repair` 而不是空列表。
- `buildSessionOriginKey()` 在同 path/不同 host 下不碰撞，remote path 不走 Windows 小写规则。
- path-bearing IPC 中 remote target 不能进入 local adapter。
- Session rename/archive/restore/remove/delete 的 idle/busy、expectedVersion conflict、catalog commit 崩溃恢复、最多 8 个 alias、跨 Session path/alias/remoteSessionId 冲突和 tombstone 显式再导入；任何失败都不产生第二个 stable id。
- 远端 security snapshot 上传/权限/TTL/清理，runner 收到的 `PIDECK_SECURITY_CONFIG` 必须是远端路径。
- project trust key 必须隔离 local/WSL/SSH；两个 host 上相同 canonical path 不共享授权，fingerprint、canonical path 或 host rebind 变化后必须重新确认。
- referenced host 只能 tombstone；verified profile 的 endpoint 变化必须创建新 `hostId`，retired id 永不复用；rebind 在 ProjectStore/SessionCatalog 任一步中断后可幂等恢复或回滚，且完成后 trust 不继承。
- Session storage edit/delete/truncate/repair 都在 coordinator mutation reservation 内命中 remote backend，并校验 `expectedVersion`；`MAX_SESSION_TRANSFORM_BYTES` 在 scanner/editor/local/remote backend 固定为 32 MiB，边界值可成功，超 1 byte 在读取/下载正文前返回 `SESSION_TRANSFORM_TOO_LARGE`；活动会话 fork/reload/prompt 命中远端 Pi RPC。`session.readSnapshot` 分块在块边界对齐、读途中改写（`SESSION_SNAPSHOT_CHANGED`）、handle TTL/并发上限、cancel 与断线途中都有 fixture，任何单帧不超过协议上限。
- 活动和未打开会话的 `export_html` 都先取得 purpose-bound artifact ref + `.html` remotePath，再把该 path 作为官方 RPC `outputPath`；返回 path 改指、symlink、超限、hash/size 不符、下载中断和本地 rename 失败均 fail closed 并清理 artifact，成功结果是可打开的本地路径；checkpoint 未实现时返回显式 unsupported。
- Git 支持表中的每个现有 IPC 都命中 remote method，禁用项全部返回 `UNSUPPORTED_CAPABILITY` 且从不触碰本地 Git；adversarial path/ref/branch、hooks/signing/pager/textconv、输出上限、timeout、认证失败、断线取消和 refs polling generation 均有覆盖；超帧上限的大输出（如 workspaceDiff）返回 `RESULT_TOO_LARGE` 而非截断。
- remote config 请求必须携带 target；返回不含 secret 明文，provider 网络操作从远端发出，本地/另一 host 的并发设置页请求不会串 scope；用量查询在 remote target 下不发出任何网络请求并返回明确 unsupported。
- 本机路径附件在 remote target 下被 UI 与 main 双重拒绝；inline content 仍受既有 RPC/大小上限，project-relative 引用不会被转换成本机绝对路径。
- `TerminalProjectTarget` 的 renderer 输入不含 cwd，project/agent owner key 使用 stable id/generation；同 path 不同 host、同 agentId 不同 generation 不共享 tab。`terminal.prepare` ticket 的过期、重放、跨 project/route 使用全部失败；remote command 不含 cwd/shell/ticket/用户文本；READY/START 与首段 shell 输出同 chunk 时不丢字节，伪控制文本在握手后按普通输出处理，handshake timeout 会回收 PTY。
- 远端 terminal 的 input/resize/close 只允许创建 tab 的 sender；resize fixture 验证 rows/cols 经 OpenSSH 到达远端。关闭后本地 ssh PTY 被回收，正常远端前台 shell 只做 HUP/TERM 的 best-effort 收敛，另一个 tab/Agent 不受影响；daemonize/disown fixture 只验证 UI 不宣称已清理，不以不可能的全局 kill 作为门禁。
- 日志与 IPC 错误不含 password、key、token、环境变量值、完整 host/path、artifact 正文或 security snapshot 正文。

生产 TS 模块测试继续使用现有 `loadTsCommonJs.mjs` 或 `createTsSandbox.mjs` helper。

### 14.2 集成测试

- 提供仅开发/CI 使用的 Docker `sshd` fixture，内置 Node 和 fake Pi RPC executable。
- 默认单测不依赖真实网络或真实 Pi；Docker suite 独立命令运行。
- fake Pi 覆盖正常 turn、长流、stderr、退出、断网、残留 JSONL 和协议错误。
- 至少在 Windows 本地主机 + Linux 远端、macOS 本地主机 + Linux 远端做人工 smoke。

### 14.3 每阶段验证

- `npm run typecheck`
- 本阶段针对性 `node --test tests/<remote-related>.test.mjs`
- 涉及 IPC、session/runtime 装配时运行 `npm test`
- 打包资源变更后运行 `npm run pack` 并检查 helper/manifest/内置扩展快照存在

## 15. 风险与既定决策

| 风险 | 应对 | 责任模块 | 验证与阻塞门禁 |
| --- | --- | --- | --- |
| Pi 实验性远程协议继续变化 | 只依赖稳定 stdio RPC；通过 `PiRuntimeLauncher` 保留替换点 | `SshPiRuntimeLauncher` | 固定 RPC fixture + Pi 兼容矩阵；阻塞 Phase 4 |
| 非交互 SSH 找不到 nvm/asdf 下的 Node/Pi | 按 LTS 大版本门控（22.x/≥24 偶数线，拒绝奇数非 LTS），探测并允许配置绝对 command；helper 启动后使用 `spawn`，不依赖 login shell；准入门槛过高时按 4.2 的 bootstrap/manifest 机制补便携 Node 上传 | `RemoteBootstrapper` | bash/zsh 与 nvm/asdf smoke；fish 等非 POSIX 登录 shell 返回明确不支持诊断；阻塞 Phase 0 |
| 远端 Pi 版本与 PiDeck RPC/扩展不兼容 | 维护最小/最大兼容范围并在启动前 capability probe；不静默升级 | `RemoteBootstrapper`、`SshPiRuntimeLauncher` | 最低/最高/超范围版本 fixture；阻塞 Phase 0 和 Phase 4 |
| SSH 断线导致重复执行 | 永不自动重放未确认 prompt；重新扫描 Session 后由用户决定 | `SshPiRuntimeLauncher`、`SessionRuntimeCoordinator` | prompt 执行中断线测试证明零自动重放；阻塞 Phase 4 |
| 远端路径误入本地 API | `ProjectLocator` 判别联合 + backend router；迁移所有 path-bearing shared/IPC contract，并用契约测试扫描直接 `fs` 调用边界 | project/session/workspace/git routers | legacy local 迁移 + remote locator 契约扫描；阻塞 Phase 1 和 Phase 3 |
| trust 跨主机或主机重装后误复用 | trust key 绑定 location、`hostId`、已验证 fingerprint 与 canonical path；rebind 不迁移授权 | `ProjectTrustService` | host key/route/path 改变后 trust 失效测试；阻塞 Phase 4 |
| 删除/编辑 host 使既有 locator 改指或失联 | verified/referenced profile 身份字段不可变且只能 tombstone；rebind 创建新 `hostId`，通过 durable journal 幂等迁移 ProjectStore/SessionCatalog；retired id 永不复用 | `RemoteHostStore`、rebind coordinator | 每个 journal crash point 恢复 + 多进程竞争；阻塞 Phase 2 |
| PiDeck 重做 Pi Session HTML 导出导致格式漂移 | 活动和未打开会话都通过远端 Pi `export_html`；helper 只传输 artifact，不解释 Pi Session 格式 | `RemoteSessionStorageBackend`、`SshPiRuntimeLauncher` | active/idle session export 与校验失败 fixture；阻塞 Phase 4 |
| 本地 security/trust/resource 路径误传到远端 Pi | location-aware launch plan；security artifact 上传、trust 远端检查、资源路径翻译，并断言 remote plan 无本机绝对路径 | `SshPiRuntimeLauncher`、artifact deployer | launch plan 快照不得含本机路径；阻塞 Phase 4 |
| renderer 伪造或重放高风险确认 | main-only pending request 绑定 sender、action 与当前状态 digest；执行前复核并原子消费 | `PendingConfirmationBroker` + 各域 IPC | 未知/过期/跨窗口/字段变化/重复回答与 shutdown 清理 fixture；阻塞 Phase 2，并阻塞各后续破坏性能力 |
| renderer 利用 IPC 读取任意远端文件 | browse root 只在已 pin 连接上 canonicalize/确认/注册；add/create-project 在 main 重做 containment；projectId/hostId 在 main 解析，project root 二次限制 | `RemoteProjectEnrollmentService`、workspace IPC | add 绕过 picker/root 外路径/symlink/重连漂移测试阻塞 Phase 3；create 等价测试阻塞 Phase 5 |
| Git UI 在 remote project 上误跑本地 Git 或隐式执行 hook | 逐 IPC capability 矩阵和 target router；unsupported fail closed；managed UI 禁用 hooks/signing/pager/textconv | `RemoteGitBackend`、git IPC | 所有 Git IPC remote parity + hook/signing 注入测试；阻塞 Phase 5 |
| helper/扩展更新留下半成品或误删活跃版本 | manifest + extraResources build 门禁、sha256、临时目录、原子 rename/fsync、active（按活跃连接注册计算，非全局单指针）/rollback/lease 可达性清理；验证失败 fail closed | artifact deployer、packaging | 中断上传/坏 hash/并发启动/多客户端并存 + `npm run pack`；helper 部署阻塞 Phase 2，runtime/扩展快照阻塞 Phase 4，打包发布阻塞 Phase 5 |
| ProjectStore 半写入使项目“消失” | version/revision envelope、串行 mutator、跨平台 durable replace、temp+backup、启动选择最高有效 revision；双损坏进入 `needs-repair` | `ProjectStore` | file sync/rename/支持平台的 directory sync crash point、Windows fallback + 双损坏；阻塞 Phase 1 |
| 远端凭据和本地凭据混淆 | 设置归属表；默认不复制任何 auth 数据 | `RemotePiConfigBackend`、settings UI | launch/env/artifact 扫描无 auth/token；阻塞 Phase 4 |
| SSH terminal 关闭后远端后台任务仍存活 | 通过 `terminal.prepare` 一次性 ticket + 固定 `terminal-runner.mjs` 启动可信 cwd/login shell；close 先撤销 tab，再关闭并兜底强制回收本地 ssh 进程树，正常前台 shell 只做 best-effort 收敛；明确不承诺清理 daemonized/disowned job，只有带 nonce lease 的 Agent runner 可强制 TERM→KILL | `TerminalSessionManager`、`SshTerminalSessionLauncher`、`terminal-runner.mjs` | ticket 过期/重放/跨 project、shell 路径校验、握手/resize、close/output/exit 竞态、shell/前台子进程/相邻 tab/daemonized job 行为 smoke；阻塞 Phase 5 |
| cancel/断线迟到响应污染新连接 | frame 绑定 hostId + connectionGeneration + request id；exactly-once settle，断线不重放，旧 generation 丢弃 | `RemoteControlClient` | cancel/response/disconnect 竞态与 generation reuse fixture；阻塞 Phase 2 和 Phase 4 |
| Windows SSH 客户端行为差异 | 首版远端只支持 POSIX；本地 Windows 纳入 smoke；连接复用仅做可选优化 | `SshCommandBuilder`、release smoke | Windows/macOS 到 Linux smoke；阻塞 Phase 5 |
| 多 Session 造成连接过多 | 先保证正确性；记录连接数并设置并发上限，后续按平台启用 ControlMaster 或稳定复用方案 | `RemoteHostManager` | 超上限返回结构化错误、并发/长稳测试；阻塞 Phase 4 |
| cleanup policy 泄漏磁盘或误删运行中 artifact | active/rollback/lease 可达性优先，未引用版本按数量+TTL 清理，staging/artifact 独立 TTL；无法验证 owner/lease 时宁可保留并告警 | artifact deployer、runner registry | 活跃/回滚/过期 lease 与磁盘压力 fixture；阻塞 Phase 4 |

首发决策已经固定，后续若扩大范围必须单独评审：

1. 首发只支持 SSH config、ssh-agent 和无交互 identity file；密码、passphrase、键盘交互与图形化 AskPass 留在 Phase 6，避免在基础生命周期尚未稳定前扩大秘密处理面。
2. 远端 Git clone 不阻塞首发；Remote v1 先支持添加已有目录和创建空目录，clone 进入 Phase 6 或后续独立能力，不能混入 Phase 5 发布门禁。

## 16. 上游跟踪条件

每次升级 Pi 版本时检查：

- `packages/coding-agent/package.json` 是否给完整 coding-agent client/server 集成提供了可执行 `import` export，而不是仅有 `source` 条件或被 `files` 排除的实验源码。
- `packages/client/README.md`、`packages/server/README.md`、`packages/protocol/README.md` 是否仍标记 experimental，以及 protocol version 与 compatibility policy 是否变化。
- 是否出现受支持的跨机器 transport、peer authentication、协议版本协商、server/worker 生命周期和远端安装升级文档；只有 TCP/WebSocket 字节 transport 仍不足以替代 PiDeck 的 SSH 主机管理。
- stdio RPC 的 breaking changes，尤其 `message_update`、Session resume 和 command response。
- 官方文档是否仍把「RPC 模式 + SDK」列为推荐的嵌入方式（`pi.dev/docs/latest` 的 Automate or embed Pi 一节与 RPC 文档把 IDE/custom clients 列为一等适用面，这是 PiDeck 继续依赖 stdio 的公开依据）。

只有同时满足「完整 coding-agent controller/server 消费面正式发布、正式远程文档、版本兼容承诺、跨机认证与生命周期闭环、非 source-only」时，才评估用 Pi 官方 remote client 替换 `SshPiRuntimeLauncher`。低层 `pi-client` / `pi-protocol` / `pi-server` 包单独发布不满足该门槛。即使替换，也只能影响 Agent 通路；PiDeck 的主机管理、项目文件、Git 和终端仍属于 PiDeck。若届时官方方案不再基于 SSH 承载的 stdio JSON-RPC，必须先单独评审并更新 `AGENTS.md` 的通信边界；本计划不授权新增到 Pi 内部的第二条通道。

### 16.1 采用触发条件与现状结论

现状结论（2026-09-24 核对）：**不做任何改动也能继续用**。PiDeck 不 import `pi-client` / `pi-protocol` / `pi-server`，消费的是官方文档化的 `pi --mode rpc` stdio 面；这三个包自述 experimental、无兼容承诺，官方文档导航里没有远程/server 章节，且其 README 明确把 peer authentication 与 server/worker 生命周期留给应用层。只有出现下列信号才重开评估，并按最小面积处理：

| # | 触发信号 | 影响面 |
| --- | --- | --- |
| 1 | stdio RPC 出现 breaking change 或被标记 deprecated | 全量 RPC 消费面，最高优先级 |
| 2 | 新会话能力只在 Chord service 层暴露、RPC 不再跟进 | 会话/Agent 命令面 |
| 3 | 我们需要「同一远端会话被多窗口/多实例附着」——stdio 一对一结构上做不到 | 仅 Agent 通路 |
| 4 | 上游满足上面的替换门槛 | 仅 Agent 通路 |
| 5 | 官方方案不再基于 SSH 承载的 stdio JSON-RPC | 需单独评审并更新 `AGENTS.md` 通信边界 |

已排除的误判：**「低层包已发 npm」不等于「官方远程产品可用」**，也不等于 PiDeck 的 SSH/主机管理工作过时。当前官方现成 transport 只有 Unix domain socket（本机），没有跨机部署、凭据管理或自动重连/重放（client README 明确 *never reconnects or replays requests automatically*），这些仍由 PiDeck 负责。

### 16.2 采用官方协议时删什么、留什么

关键结论：采用官方协议**不是**新增第二条通信通道，而是同一条 SSH 通道上换协议层。`pi-client` 的入口契约就是 `ByteTransportFactory`（README 原文：*"Connect using WebSocket, Unix socket, or another ordered byte transport"*），而 SSH stdio **本身就是一个 ordered byte transport**；官方只提供 Unix socket 现成实现，认证与生命周期留给应用层——正是本计划在做的事。替换的只是协议层，SSH/主机管理/bootstrap 工作不废弃。

| 计划模块 | 采用官方协议后 |
| --- | --- |
| 控制 helper（fs/git/session 索引）、bootstrap/manifest、终端、配置、trust、catalog、UI | **全部保留**（上游明确不覆盖这些） |
| `SshPiRuntimeLauncher` 的流交接层 | 改为在既有 SSH stdio 上实现 `ByteTransportFactory` |
| `resources/remote-host/runner.mjs`、lease/nonce、进程组 TERM → KILL、自研 `runtimeGeneration` fencing | **可删除**，由 server 侧 attachment 生命周期与 `attachmentId` 取代 |
| 多呈现附着（一个远端会话挂多个客户端） | 新增能力，stdio 结构上给不了 |

因此 `runner.mjs` 与随附的 lease 逻辑是本计划中**预期寿命最短**的模块：保持它薄、不把 PiDeck 特有语义长进去，将来替换成本才低（对应 4.1 的 runner 职责边界）。

## 17. 推荐实施顺序

以可审查的小批次合入，避免长期分叉：

1. 计划与 spike 结果。
2. location/locator 类型和迁移测试。
3. local launcher/backend 抽象，零行为变化。
4. host store、SSH argv builder 和诊断。
5. helper protocol、打包与 bootstrap。
6. 远端项目和只读文件/Session。
7. 远端 Pi runtime 与内置扩展快照。
8. 文件写入、Git、terminal。
9. AskPass、同步和平台扩展。

每个批次都必须保持 main 可发布；不使用长期 `remote-v2` 分支，不允许用远端功能的引入破坏本地 Session 路径。
