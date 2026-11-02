# 远程 SFTP Phase 1：流式传输与安全提交

> 状态：离线实现已接线；真实 SSH / Electron 验收 `NOT RUN`。2026-11-02。
> 基线：`c06d528fb`（SFTP-0 原生执行器原型）。
> 范围：单文件/多选上传、单文件下载、任务进度、取消、稳定错误与能力探测。
> 不在本阶段：目录读取迁移、文本保存迁移、搜索/watch/Git/回收站、server、SFTP 递归传输、断点续传、双向同步。

## 1. 结论

SFTP-1 继续使用系统 OpenSSH + 一次性 Go 执行器，但**不把现有 `upload` 的目标 rename 接入生产**。

正确链路是：

1. 主进程先建立项目会话并验证 root / host generation；
2. helper 为目标准备一次有界上传事务，签发一次性 opaqueness token，并建立项目私有 spool；
3. SFTP 只把本地文件流式写入 `deployRoot/upload-spool/<uploadId>.part`，不直接写用户目标；
4. helper 在目标父目录完成非覆盖发布、fsync、读回和摘要校验；
5. 只有 helper 明确返回成功才发布成功；提交请求发出后断连、超时或回包无效一律 unknown，不自动重放。

这样保留 OpenSSH route/pin/auth，不让 renderer 或 SFTP 执行器持有项目目标写权，也不把 helper 扩成通用命令桥。

## 2. 对 renderer 的窄契约

新增 `src/shared/types/remoteTransfers.ts`，只暴露任务级数据：

- `ProjectTransferStart = { jobId }`
- `ProjectTransferProgress = { jobId, operation, transferred, total }`
- `ProjectTransferSettled = { jobId, outcome: "succeeded" | "failed" | "cancelled" | "unknown", code?, result? }`
- `ProjectTransferReceipt`：文件级字节数、目标相对路径、摘要与提交确认；不返回绝对远端路径、SSH argv、token 或 spool 路径。
- `ProjectTransferCancelResult = { accepted: boolean }`

IPC 只增加 start / cancel / event 三条。`jobId` 由 main 随机生成且不编码 path；绑定：

`senderId + projectId + hostId + canonicalRoot + connectionId + hostRevision + AbortController`。

任务只能由原 sender 取消和收结果。renderer 的 project generation 只用于丢弃旧 UI 结果，main 不拿它代替连接代或 host revision。

`ProjectFileService` 增：

- `uploadFiles(target, source): Promise<RemoteProjectUploadResult>`
- `downloadFile(target): Promise<RemoteProjectDownloadResult>`

`source` 只有 `picker` 或经拖放解析出的本机绝对路径数组；本地路径仍由 main 校验常规文件、大小和控制字符。renderer 的传输 client 先订阅 event、再 start，并按 `jobId + operation` 聚合终态，不把 IPC 对象泄漏给组件。main 与 event 契约已支持 progress/cancel；当前文件抽屉只消费最终 settlement，还没有进度条和取消按钮。

## 3. 上传提交协议

helper 新增三个窄方法，沿用现有 NDJSON、能力协商、固定 root 与并发/取消生命周期：

### `fs.uploadPrepare`

输入：`uploadId`、项目相对目标路径、`policy: "create"`、`size`、`sha256`。

输出：一次性 `token`、`stageRef`、`expiresAt`。

- `uploadId`、`token`、`stageRef` 都用 32 位 hex；
- token 绑定 host / generation / root / relative / policy / base revision / size / sha256；
- token 单次、短期有效；Spool 只位于 helper 已验证的 `deployRoot/upload-spool/`；
- `create` 模式要求目标不存在。首版不开放覆盖；`replace-if-unchanged` 留到文本/二进制覆盖需求单独冻结。

### `fs.uploadCommit`

输入：`uploadId`、`token`。输出：`committed`、`path`、`size`、`sha256`、`revision`、`fsync`、`stageCleaned`。

- 重新证明 root realpath、父链逐级非 symlink、目标父目录 `/proc/self/fd` 锚定；
- 在目标父目录创建 `.32hex.pideck-put`（`O_EXCL|O_NOFOLLOW`、0600）；
- 从 spool 复制/校验 size + sha256 + uid/gid，执行 `fchmod`、`fsync`；
- `create` 用同目录 hard link 做原子 no-clobber 发布，`EEXIST` 是已拒绝、非 unknown；
- 发布后 fsync 目录、读回 revision，再清理 spool 临时文件；
- commit 请求已发出后断连、超时、回包丢失、回包畸形或发布后读回失败统一 unknown，不自动重试。

### `fs.uploadAbort`

输入：`uploadId`、`token`。只允许消费该次 prepare 签发的一次性 token 并清理对应 spool；不能指定任意路径，也不是通用删除入口。

远端必须满足 Linux、`/proc/self/fd`、`O_NOFOLLOW`、hard link；不满足时上传能力为 unsupported，不让 SFTP 直接写目标兜底。

## 4. 下载发布

1. main 先弹保存对话框；用户取消不创建 job；
2. SFTP 下载到目标同目录的随机 `.pideck-part-*`，不覆盖任何现有文件；
3. 流式写完后核对远端前后 revision，`fsync` 并关闭；
4. 用 hard link 无覆盖发布，竞争出现 `EEXIST` 时拒绝；
5. 取消/失败删除临时文件，半文件绝不发布；若发布完成后结果通道丢失，按 unknown 处理并允许用户显式检查本地文件。

## 5. 任务状态与取消

- `start` 只在 host ready 且写能力可用时受理；成功后立即返回 opaqueness `jobId`。
- progress 只接受与 job 的 operation 和 monotonically increasing bytes 相符的帧。
- 每个 job 只 settle 一次；sender 销毁、项目关闭、连接代变化都撤销任务。
- 取消是幂等请求。SFTP 阶段取消后必须等子进程真正退出并清理 spool 才 settle `cancelled`。
- 一旦 helper commit 已发出，取消不能承诺撤回；settle `unknown`，不显示成功。
- 取消 A 项目不得影响同主机 B 项目；任务不共享可变 cwd、token 或 spool 文件。

`RemoteSftpAdapter` 已改为等待子进程关闭后再结算取消，避免取消结果先于进程树清理。

## 6. 能力与降级

SFTP subsystem 不能由 helper capability 推断，首次传输必须独立 probe。能力缓存键至少包含：

`hostId + canonicalRoot + connectionId + hostRevision + binary build identity`。

- positive 只在同一连接代内复用；
- negative 使用短 TTL，并在重连、重绑、root 退休时失效；
- subsystem 缺失、helper 方法缺失、平台不满足分别给出稳定 unsupported code；
- legacy upload 只能在**尚未向远端写任何字节**时因显式功能开关选择，不能在新路径开始后自动回退或重试。

`files` capability 增加 upload / download 及稳定关闭原因；UI 上传入口同时受 `write` 与 `upload` gate，下载受 `read` 与 `download` gate。

## 7. 实施顺序

1. **离线协议证据**：已完成 `pkg/sftp.NewServer` 集成测试、stage/download/cancel/timeout 用例。
2. **adapter 收尾**：已完成取消进程树语义、stage 本地路径与摘要、空文件和路径校验。
3. **主进程任务服务**：已完成 job registry、sender/project/generation fence、progress、cancel 与事实失效。
4. **helper 事务**：已完成 prepare/commit/abort、能力门禁、no-clobber/unknown/cleanup；Linux WSL 上传切片通过。
5. **公共 contract / IPC / preload**：已完成 start/cancel/event 三通道，`check:ipc-wiring` 通过。
6. **ProjectFileService**：已完成 local 显式 unsupported、remote jobful API 接线。
7. **UI 接线**：已替换文件抽屉旧 private transfer 调用并保留部分失败反馈；进度与取消控件尚未接线。
8. **删除旧直连**：待真机与 Electron 验收通过后删除 private upload/download 通道，避免两套写路径长期并存。

公共汇聚文件 `src/shared/ipc.ts`、`preload/index.ts`、`ProjectFileService` 契约、i18n 与 package/build 文件同一时刻只允许一个 writer。

## 8. 验证矩阵

离线：

- Go：空文件、二进制、中文/空格、跨 chunk 大文件、1001 项目录、权限/缺失、摘要不符、stage cleanup、commit 回包丢失。
- TS：probe 缓存失效、sender/project/job 归属、跨项目取消、进度关联、unknown 不重放、下载不发布半文件。
- sidecar：真实进程 + 本地测试 SFTP subsystem，区分 timeout / cancel / 非零退出，验证 Windows 进程树与 POSIX group。
- 服务：ProjectFileService conformance、能力关闭零调用、事实失效、双 project 隔离。

必须真机：

- OpenSSH ≥ 8、ed25519 host pin、SFTP subsystem、ProxyJump（若产品路径支持）与 askpass；
- 空文件、大于 16 MiB、接近/超过 8 GiB 边界、中文/空格路径、权限不足、target race、断网/重连、commit unknown；
- 同主机两个项目并行上传/下载，关闭或重连一个不影响另一个；
- Electron UI 进度、取消、部分失败与明确 unknown。

没有真实主机授权时，上述真机项记录 `NOT RUN`，不得用 SFTP-0/离线全绿替代。

## 9. 当前边界

- 现有 SFTP `upload` 仍是原型，`atomicRename: false`，生产上传只走 `stage → helper prepare/commit`，不得接旧 upload。
- `ReadDir` 仍会 materialize 整目录，SFTP-2 才能迁移目录读。
- 文本保存继续走现有 version + helper 路径，不与二进制上传共用 token。
- 本阶段不新增常驻 server，也不承诺无 Node 远端项目。
- 当前上限为单文件 8 GiB、单批 32 个文件；首版只创建，不覆盖同名远端文件。
- 真机 SSH、连接中断、Electron 传输 UI 和 close/rebind 交叉验收仍需授权 target 后执行。

## 10. 本轮离线验证（2026-11-02）

- `npm run typecheck`、`npm run check:ipc-wiring`（811 通道 / 8 agentEventTags）、
  `npm run check:test-shape`（sourceOnly 395 / 1880，新增 0）与 `npm run check:format`
  （4372 文件）均通过。
- 统一接口快照与远端 E2E 定向套件 33/33 通过；传输 client、registry、job IPC、
  capability probe/cache、upload job 与 Go executor 的定向回归均通过。
- `go test ./...`、`go vet ./...`、`npm run build:remote-sftp`（Windows amd64）通过。
- 全量 `npm test`：15,923 tests / 15,634 pass / 2 fail / 287 skip，退出码 1。
  两个失败均不在本分支改动面：`scrollContainerGuard.test.mjs` 命中的
  `AgentIconPicker.tsx`，以及 `sessionRefreshSafety.test.mjs` 读取的 `App.tsx` /
  `useProjectSync.ts`，相对 HEAD 与 `origin/dev` 均无差异。
- Linux/WSL helper 上传切片此前 4/4 通过，本轮最终树未重跑。
- 真实 SSH、断连/重连、Electron 进度/取消以及 commit unknown 真机验收仍为 `NOT RUN`；
  不得以离线套件和 SFTP-0 原型替代。
