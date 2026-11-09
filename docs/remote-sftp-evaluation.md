# 远程文件管理与 SFTP 接入调研

> 状态：迁移前 SFTP-0 调研快照。2026-11-02。
> 当时代码核对基线：`dev` 的 `4db671223` + SFTP-0 改动；当时尚未完成真实 SSH/Electron 验收。
> 本轮用户重新提出采用 SFTP，因此此前“本期暂不上 SFTP”不再作为后续方案的前提。
>
> 2026-11-03 后续：SFTP-1 的新事务式上传/下载已通过真实 SSH + Electron 验收；SFTP-2
> 普通目录读取的代码迁移已在 `codex/sftp-cleanup-sftp2` 完成，待最终集成 Agent 验收。
> 本文 1.1、2 节保留迁移前快照，用于对照旧直连路径，不再描述当前生产接线。

## 1. 结论

建议采用 SFTP，目标覆盖远程目录浏览和文件上传下载。先迁移传输，再迁移目录读；继续通过现有项目服务供 UI 调用。

收益来自标准文件协议、二进制流式传输、成熟客户端实现，以及减少自行维护的文件传输代码。SFTP 不自动提供目录变更通知、全文搜索、Git、编辑器版本冲突检查或回收站语义；这些能力仍由 PiDeck/helper 承担。

这次不需要新建 PiDeck 常驻 server。SFTP 需要远端 SSH 服务提供 SFTP subsystem，常见实现为 `sftp-server` 或 `internal-sftp`，仍须探测是否启用。多端独立接入、桌面退出后后台继续运行的 server 决策保持独立。

已核实代码和公开文档；尚未测量真实服务器的吞吐、内存、兼容性。不能承诺换协议必然更快。

## 1.1 SFTP-0 原型：已落地的边界

客户端选型冻结为**系统 OpenSSH + 一次性 Go 执行器**：Go 使用 `github.com/pkg/sftp v1.13.12`，经 `sftp.NewClientPipe` 消费 `ssh -T -s -- <host> sftp` 的 stdin/stdout。没有引入 Node `ssh2` 的第二套认证、跳板机和 host-key 验证链路，也没有新建常驻 server。

已实现：

- `SshCommandBuilder` 新增 `ssh-sftp`，保留现有 host pin、严格 host key、ProxyJump、identity/askpass、超时和连接选项；`SshVerifiedConnection` 的 `ssh -G` 复核会去掉仅传输用的 `-T -s` 与 subsystem 参数。
- `native/remote-sftp` 是每任务一进程的执行器：严格解析有界 JSON 请求，支持 `probe/list/download/upload`，输出 NDJSON progress/result，固定错误码，不把原始远端错误带给 renderer。
- 下载写同目录临时文件并流式复制，最终用不覆盖的 hard link 发布；上传从本地文件流式读取，远端临时文件使用 `O_EXCL`，标准 rename 后返回结果。
- `RemoteSftpAdapter` 在宿主持有请求/响应校验、进度、超时、取消和子进程清理；取消或超时会终止该任务的执行器，不复用 SFTP 会话或可变 cwd。
- 构建/打包链已接 `build:remote-sftp`、`extraResources`、dev 自动构建及 Windows/Linux/macOS workflow 的 Go 测试和 `REMOTE_SFTP_OS/ARCH`。

证据：Go 单测与 `go vet` 通过；Windows 原生与 Linux/amd64 交叉构建产物分别为 4.4 MiB / 4.2 MiB；SFTP/SSH 定向 TS 用例 15/15 与 `sshVerifiedConnection` 16/16；`typecheck` 通过；更新后的 Linux 远端/SSH 硬门禁 24 文件退出码 0。

尚未通过、因此不能宣称可投入生产：

- **没有真实远端 subsystem 证据。** 当前只证明编译、协议校验、模拟客户端和宿主生命周期；尚未连接授权主机完成真实目录/传输/断网/取消验收。
- **上传提交语义未冻结。** 标准 SFTP rename 没有可移植的 no-clobber/原子保证；结果明确返回 `atomicRename: false`。rename 回包丢失时返回 `SFTP_REMOTE_COMMIT_UNKNOWN` 且不自动重放；写入口在 SFTP-1 用版本化 helper 提交或等价方案证明前保持未接线。
- **目录仍是整目录 materialize 后截断。** `ReadDir` 只限制输出，不限制服务端返回内存；SFTP-2 必须换有界目录读取。
- **路径检查不是 fd 锚定。** root realpath、父链 symlink 拒绝和写前后文件属性检查仍存在路径替换竞态，不能替代 helper 的 `/proc/self/fd` 锚定。
- **取消的进程树语义仍待真机证明。** POSIX 下执行器位于独立进程组并捕获终止信号，通过 `CommandContext` 结束 ssh；Windows 用 `taskkill /T /F` 清树并回退单进程 kill。实现已覆盖，但真实 Windows ssh/ProxyJump/超时取消仍须纳入验收。
- 真实吞吐、峰值内存、SFTP 扩展差异和大目录行为尚未测量；IPC、capability、renderer 与真实项目服务接线均未开始。

## 2. 迁移前实际使用的方式

| 用户操作                         | 当前实现                                                                                 | 已核实的限制/语义                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 展开目录、文件属性、普通文件读取 | SSH 承载自有 Node helper 协议，调用 `fs.list` / `fs.stat` / `fs.read`                    | 目录结果受预算约束；文件内容以 base64 分块；有项目与连接代检查        |
| 下载到本地                       | `RemoteWorkspaceReader.readFile` 收齐字节，再由主进程保存对话框选路径并 `writeFile`      | 单文件上限 16 MiB，完整文件驻留内存；当前不是磁盘到磁盘的持续流       |
| 上传本地文件                     | 主进程 `readFile` 读入完整文件，另开 pinned SSH，将 base64 行经 stdin 送给固定 Node 脚本 | 单文件上限 16 MiB；1 MiB 原始字节一块；支持背压，但本地源仍是整块内存 |
| 编辑文本并保存                   | pinned SSH 执行固定 Node 命令；读取、临时写入、校验后提交                                | 文本上限 256 KiB；保存必须带读取时签发的 version；有版本冲突检查      |
| 创建、改名、移动、回收站、恢复   | pinned SSH 执行条目操作脚本                                                              | 带项目范围、令牌、结果收据及失败/未知结果语义                         |
| 监听、搜索、Git                  | helper 或既有专项命令                                                                    | 不是标准文件传输协议的替代对象                                        |
| 部署 helper 等运行资源           | pinned `scp`                                                                             | OpenSSH 9.0 起 scp 默认使用 SFTP；代码按客户端版本区分路径引用方式    |

因此，准确表述是：**产品文件管理尚未采用 SFTP；本轮只落地了未接线的 SFTP-0 执行器原型，部署资源的 scp 链路可能已经使用 SFTP 协议。**

当前不是没有上传下载，也不是明文传输。主要改进点是传输实现、容量、内存与操作体验。base64 本身使字节表示约增加三分之一；这不是实际吞吐提升的测量值。

界面已有上传按钮、外部文件拖入与右键下载，`RemoteProjectPanel` 经 `useRemoteProjectTransfer` 调用远端专用 preload 接口。此前记录的“上传/下载仍是远端薄壳”指尚未统一进入项目文件服务，不代表按钮没有后端实现。既有 F/G 项目服务改造继续保留，SFTP 接入其下层。

代码依据：

- `src/main/ipc/remoteProjectDirFacts.ts`：目录事实加载调用显式注入的
  `RemoteSftpDirectoryReader`；SFTP 不可用时直接失败，不回退 helper `fs.list`。
- `src/main/remote/RemoteWorkspaceReader.ts`：16 MiB 上限、完整 Buffer、分块读取与前后属性检查。
- `src/main/ipc/remoteProjectTransferJobIpc.ts`：事务式上传/下载任务、进度、取消与事件收口。
- `src/renderer/src/components/session/RemoteProjectPanel.tsx`、`src/renderer/src/hooks/useRemoteProjectTransfer.ts`：上传、拖入和下载的现有 UI 接线。
- `src/main/remote/RemoteProjectUploadJob.ts`、`RemoteProjectTransferRegistry.ts`：SFTP 暂存、
  摘要校验、版本化 helper 提交与任务生命周期。
- `src/main/remote/RemoteProjectFileCommands.ts`、`RemoteProjectFileService.ts`：文本预算、version 与写入边界。
- `src/main/remote/RemoteProjectEntryService.ts`：条目与回收站的领域操作。
- `src/main/remote/RemoteBootstrapUpload.ts`：scp 的 SFTP/legacy 模式选择。

## 3. 建议的职责分配

| 层                  | 接入后的职责                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| 文件抽屉与项目服务  | 调用目录/文件/传输能力，展示进度与明确结果；不持有 SSH 凭据或 SFTP client |
| 主进程项目文件服务  | 解析 project/root、校验身份、管理任务和取消、维护事实失效及错误语义       |
| SFTP adapter        | 列目录、属性、范围读取及流式字节传输；能力来自实际 subsystem/扩展探测     |
| helper/既有领域服务 | 监听、搜索、Git、文本版本检查、回收站及需要保留的安全提交逻辑             |

SFTP 完成写入后，仍要触发已有项目事实失效链，刷新文件树和 Git；不能只刷新按钮所在的组件。

现有 `ProjectFileService` 已有 `listDirectory/stat/readText/writeText` 等方法，**尚无上传下载任务接口**。传输服务、进度、取消和能力位需要先定窄契约，再实施。不要直接把 SFTP 对象或绝对远端路径暴露给 renderer。

目录浏览也纳入目标，但排在传输后：它当前已可用，需迁移的是后台实现与能力来源，保留 `truncated/revision/generation`、显式刷新和既有预算。不得为了 SFTP 将整棵树预读，或把“读不到”变成“不存在”。

纯 SFTP 浏览理论上不要求远端 Node，但当前项目连接与能力依赖 helper。**只接一个 SFTP 库不会自动获得“无 Node 远端项目”支持**；后者是独立产品范围，本轮不承诺。

## 4. 客户端选择

| 方案                             | 优点                                                            | 代价与判断                                                                                |
| -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 系统 OpenSSH + SFTP 协议库       | 能沿用当前 OpenSSH 客户端、配置解析、主机 pin、认证和跳板机链路 | 优先验证；当前 builder 尚无 subsystem 类型，要正式增加适配，不能拼任意远端命令            |
| Node `ssh2` / `ssh2-sftp-client` | 主进程接入直接，已有目录、流、进度等 API                        | 可选；它自行建立 SSH，会引入另一套认证/agent/跳板/host-key 验证实现，不能视为复用现有 SSH |
| 调用系统 `sftp` 并解析命令输出   | 复用系统客户端，批量传输容易试验                                | 不建议作为目录 UI 的长期基础；文本输出、路径引用、状态归因和进度解析较脆弱                |

系统 OpenSSH 路线有公开可用的实现例子：Go `github.com/pkg/sftp.NewClientPipe` 明确支持通过外部 `ssh ... -s sftp` 的 stdin/stdout 建立客户端。这证明无需重写 SFTP 协议，但若采用 Go 实现，会增加本机侧车的构建、打包和生命周期成本；不把它塞进职责无关的索引侧车。

`ssh2` 的 `sock` 是 SSH 连接底层流，不等于能直接消费 `ssh -s sftp` 已建立的 subsystem 流。不能只为复用连接而组合不匹配的接口。若选择 `ssh2`，必须显式实现 hostVerifier：其文档默认行为是未配置时接受 host key，与当前严格 pin 不等价。

当前生产 builder 显式关闭 OpenSSH ControlMaster。SFTP 接入不顺便改变该决策，也不自动开启跨项目共享连接池。首版每项操作绑定明确项目/root/连接代；同主机多项目不用共享可变 cwd，关闭 A 或取消 A 的传输不得误伤 B。

**建议：先验证保留系统 OpenSSH 的路线，再冻结客户端选型。** 不同时维护两个新 SFTP 引擎。协议方向可以确定，客户端与部署成本仍需原型证据。

## 5. 不能在换协议时丢掉的行为

1. **写入确认与冲突。** 上传临时文件后提交；文本保存继续核对原始 version。OpenSSH `posix-rename` 扩展提供 POSIX rename，不能替代“仅当原版本未变时提交”。`fsync`、rename 等扩展须探测，不能假定任意 SFTP 服务器都有。
2. **项目路径边界。** 当前写脚本有父链非符号链接检查和 `/proc/self/fd` 锚定。普通 SFTP 的路径操作与客户端 `realpath` 预检不能直接证明相同的抗路径替换能力。原型必须给出对照；如需 SFTP 暂存后由 helper 安全提交，暂存区也要有明确边界。没有通过对照，不启用对应直接写入路径。
3. **结果不确定。** 最后提交附近断网可能已经落地，继续返回 unknown 并允许显式核实；不自动重放写操作，也不在超时后偷偷改用旧上传通道重试。
4. **取消和代次。** 文件句柄、传输任务与临时文件有明确所有者；旧连接的迟到结果不能写回新项目状态。取消不等于已撤回远端提交。
5. **有界资源。** 上传从本地流读取，下载写本地临时文件，完成后再交付；文件大小不决定同等大小的内存分配。目录与请求并发仍有上限。`readdir` 包装器若会收齐整个目录，不能直接冒充有界目录页。
6. **能力真实。** subsystem 不可用、权限不足、文件缺失分别映射；监听能力仍看 helper。保留旧链路时明确是迁移兼容路径，不能把两套写路径作为自动重试机制。

这些属于现有契约的保留工作，不要求用户因为更新既有测试再单独放行。当前根 `AGENTS.md` 第 10 条已经允许测试随需求/契约演进，同时禁止仅为消红削弱有效断言。

## 6. 下一轮实施与并行边界

### SFTP-0：一个所有者先完成接入原型与契约

交付一项客户端选择、项目/传输任务身份、进度/取消/错误语义、能力来源，以及第 5 节的安全边界对照。证明能够建立 subsystem、列一个目录、流式收发文件；远端操作限于已授权主机和测试目录。测量当前链路与原型共同支持的文件大小，另测原型超过 16 MiB 的文件与峰值内存。安装依赖、公共类型与打包文件由同一所有者处理，不与现有并行任务抢写。

### SFTP-1：传输实现与界面可在契约冻结后并行

- Agent A 拥有主进程 adapter/任务生命周期/针对性行为测试，实现流式上传下载、暂存提交、取消与真实错误。
- Agent B 拥有文件抽屉的传输入口与进度展示，先用契约替身开发，再接公共项目服务；不自行调用 preload 私有传输或持有 SSH 状态。
- 公共 IPC/preload/服务类型/i18n/package 文件指定一个写者；两个 agent 同时改源码优先隔离 worktree。

首版交付单文件和多选文件传输、可见进度、取消、明确的覆盖规则。目录递归上传、跨重启断点续传和双向目录同步不作为首版完成条件。

### SFTP-2：目录读取迁移与一次集成验收

将目录/属性/适用的文件读取接到 adapter，保留树的预算、事实、连接代与边界。按服务能力启用；替代完成后删除对应旧传输实现，不扩大 SFTP 到 Git/终端/Agent 通道。

完成条件：

- 浏览、上传、下载在 SSH + Electron 真机链路通过；测试空文件、二进制、中文/空格路径、超 16 MiB 文件、权限不足及缺失文件。
- 大目录保持预算与截断提示；项目根、符号链接和路径替换负例保留有效防护。
- 中途断网、取消、提交回包丢失如实呈现；半文件不当成功，unknown 不重放。
- 同主机两个项目并行操作；关闭一个、重连一个、取消一个，不影响另一个或错写结果。
- 文本版本冲突、写后文件/Git 刷新继续通过；记录 subsystem/扩展缺失时的能力行为。
- Windows/Linux 针对性测试及相关 Electron E2E 通过；集成时执行仓库要求的类型和受影响测试门禁。

当前另一个 agent 承担的 manifest、SSH/Electron 验收、Linux CI 按原范围完成。它们验证现有版本；新 SFTP 路径要补自身验收，不能沿用旧版本“全绿”作为证明。

## 7. 官方与上游资料

查阅日期：2026-10-31。

- [OpenSSH ssh(1)](https://man.openbsd.org/ssh)：`-s` 请求 subsystem，SSH 可承载 SFTP。
- [OpenSSH sftp(1)](https://man.openbsd.org/sftp)：目录、get/put、批处理与传输选项。
- [OpenSSH sshd_config(5)](https://man.openbsd.org/sshd_config)：Subsystem、sftp-server、internal-sftp。
- [OpenSSH 9.0 release notes](https://www.openssh.com/txt/release-9.0)：9.0 起 scp 默认采用 SFTP。
- [OpenSSH PROTOCOL](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)：posix-rename、fsync 等扩展。
- [ssh2 README](https://github.com/mscdex/ssh2/blob/master/README.md)、[SFTP API](https://github.com/mscdex/ssh2/blob/master/SFTP.md)：认证、hostVerifier、sock、目录与流式接口。
- [ssh2-sftp-client README](https://github.com/theophilusx/ssh2-sftp-client)：get/put 与 fastGet/fastPut；后者对服务器并发和包大小支持有兼容性要求，不能默认追求最大并发。
- [pkg/sftp](https://pkg.go.dev/github.com/pkg/sftp)、[外部 ssh 示例](https://github.com/pkg/sftp/blob/master/example_test.go)：NewClientPipe、目录与文件 API。
