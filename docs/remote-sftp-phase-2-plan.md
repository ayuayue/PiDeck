# 远程 SFTP Phase 2：有界目录读取迁移

> 状态：代码接线与离线验证完成，待最终集成 Agent 做真实 SSH/Electron 验收。2026-11-03。
> 基线：`eca70c60d`；分支：`codex/sftp-cleanup-sftp2`。
> 范围：普通远端目录列表及其公共目录页，附带 `files.stat` 的 present / missing / unavailable 三态。
> 不在范围：搜索、watch、Git、回收站、文本保存、递归传输、断点续传、真实 SSH 验收。

## 1. 当前能力对照

| 能力 | 迁移前 helper `fs.list` | SFTP `list` 目标 | 处理 |
|---|---|---|---|
| 单目录读取 | 是，单层 | 是，单层 | 迁移到 SFTP |
| 结果上限 | 4096；超限整次 `RESULT_TOO_LARGE` | 4096；超过后返回有界前缀并标 `truncated` | 有意改为可显示的截断结果 |
| 排序 | 名称排序 | 保留条目按名称排序 | 保持 |
| 隐藏文件 | 返回 | 返回 | 保持，不按点前缀过滤 |
| 大小 | 可选 `bytes` | `bytes`（含目录/其他项元数据） | 公共投影继续按需保留 |
| mtime | 当前 reader 不投影 | 原生有 `mtimeMs` | 暂不新增公共字段，避免扩大 UI 契约 |
| 普通条目类型 | file / directory / other | file / directory / other | 保持 |
| 条目符号链接 | `other`，不跟随 | `other`，不跟随 | 保持 |
| 目标目录为符号链接 | 拒绝 | 拒绝 | 保持 |
| 祖先路径含符号链接 | 拒绝 | 拒绝 | 保持 |
| 空目录 | `[]` | `[]` | 保持 |
| 缺失 | 稳定失败 | `SFTP_REMOTE_NOT_FOUND` | 不得伪装为空 |
| 权限不足 | 稳定失败 | `SFTP_PERMISSION_DENIED` | 不得伪装为空 |
| 连接失败 | 稳定失败 | `SFTP_REMOTE_CONNECTION_LOST` 等 | 不得伪装为空 |

原生 `pkg/sftp.Client.ReadDir` 会先收齐整目录再返回，不能直接用于生产目录页。SFTP-2
在宿主持有 SFTP 包边界的读取器：最多保留 4096 条目；一旦观察到下一批 READDIR 仍含条目，
结束本次一次性 SFTP job 并返回截断结果。内存上界是“4096 条目 + 一个受 4 MiB 帧上限约束的
NAME 包”，不随远端目录总大小增长。

## 2. 分页与截断语义

- 原生上限 `4096`，与 helper 现有 `REMOTE_HELPER_MAX_LIST_ENTRIES` 对齐。
- `entries` 最多 4096；`truncated=true` 只表示“至少还有一个未读取条目”，不是总数。
- `scanned` 表示本次实际读取并检查到的条目数；截断时允许略高于 4096（由最后一个被接收的
  READDIR 批大小决定），不等同于远端目录总数。
- 被保留的条目按名称排序；截断时不承诺它们必然是全目录的字典序前 N 个，因为协议没有目录游标。
- 公共目录页继续在 4096 结果上执行现有的 2000 条投影。`truncated` 为
  `SFTP 截断 || 投影超过 2000`，不能仅凭“刚好 2000 条”猜测。
- 旧 `remoteProjectList` 与公共目录页继续共享 `readDirSnapshot` 事实缓存；旧入口同步携带
  `truncated/scanned` 元数据，避免隐藏原生截断。

## 3. 边界矩阵

| 场景 | 预期 |
|---|---|
| 空目录 | 成功 `{entries:[], truncated:false}` |
| 大目录 | 有界读取，返回至多 4096 条并明确 `truncated:true` |
| 隐藏文件 | 正常返回；只过滤 PiDeck 精确上传临时名与根层回收站 |
| 条目符号链接 | 作为 `other` 返回，不跟随、不递归 |
| 目标目录符号链接 / 祖先链接 | 稳定拒绝，不把目标内容搬到项目边界外 |
| 权限错误 | `SFTP_PERMISSION_DENIED`，不返回空目录 |
| ENOENT | `SFTP_REMOTE_NOT_FOUND`，与空目录区分 |
| 非法/畸形 SFTP 响应 | `SFTP_RESULT_INVALID`，不缓存为事实 |
| SFTP binary 缺失 | `REMOTE_SFTP_BINARY_UNAVAILABLE` |
| subsystem/probe 不可用 | probe 的稳定 capability 错误；普通目录读不回退 helper |

## 4. `files.stat` 三态

`files.stat` 增加向后兼容的 `availability`：

- `present`：已证明存在，`isDirectory` 有事实依据；
- `missing`：只接受明确的 `PATH_NOT_FOUND` / `SFTP_REMOTE_NOT_FOUND` / `ENOENT`；
- `unavailable`：权限、连接、超时、协议或边界失败，不能显示成“文件不存在”。

`exists` 继续保留为 `availability === "present"` 的兼容字段。远端 stat 本轮仍走现有只读
helper `fs.stat` / `fs.statMany`，不顺手改写成 SFTP stat；这保证授权、路径和 64/帧预算不变。

## 5. generation 与迟到结果

- 目录装载仍由现有 `withProjectSession` 钉住 host/root/manager，入口与出口各核一次
  `assertCurrent()`。
- `projectEpochs` 继续围栏项目关闭、root 退休和主机断开；SFTP 迟到结果不能写回已清理的项目。
- `FactCache` 继续按 `projectId + NUL + relative` 和连接代合并/失效；暖缓存命中前仍查询本项目
  root 的 `projectConnectionFacts`。
- sender 归属、项目关闭、root 池换代和目录事实通知沿用现有路径，不新增第二份缓存或事件总线。
- 截断 job 会主动结束一次性 SFTP 连接；无论连接如何退出，只有成功解析出有界结果且
  `assertCurrent()` 通过才发布事实。

## 6. 保持走 helper 的能力

| 能力 | 保留原因 |
|---|---|
| `fs.watch` / 深层目录订阅 | 标准 SFTP 没有变更推送；改用轮询会改变延迟与预算 |
| 文件名/正文搜索 | helper 有递归预算、结果投影与内容扫描语义，SFTP list 不能替代 |
| Git | 仓库发现、status、diff 需要 Git 语义，不是目录协议 |
| 回收站/条目令牌 | 需要 helper 的授权、version、原子提交与保护路径 |
| 文本保存 | 需要 version 冲突检查与 helper 安全提交 |

这些入口通过模块与函数显式分流。普通目录读取在 SFTP 不可用时返回能力错误，不静默调用
`RemoteWorkspaceReader.list`；没有运行期双路径回退。

## 7. 接线与回滚点

- 主进程共享现有 SFTP binary identity、capability probe/cache 与一次性 adapter。
- `remoteProjectDirFacts` 的 loader 改为显式注入的 SFTP 目录 reader；缓存、watch 登记、失效、
  generation 与通知代码保持原位。
- 旧 `remoteProjectList` 继续复用同一事实缓存和同一 SFTP reader，避免第二套目录源。
- 兼容边界：只保证 SFTP list 不可用时明确失败；要回滚生产路径，必须回退代码中的目录 reader
  装配并重新发布，不在请求失败后自动跨协议重试。
- 可回滚点：Phase 1 清理完成后的未提交工作树；Phase 2 先完成原生有界读取与服务测试，再切
  `readDirSnapshot`。切接线前的代码可单独回退，目录缓存与公共页面形状不变。

## 8. 验证

- Go：空目录、超过上限、隐藏项、符号链接、权限/缺失映射、畸形包、有界 reader 不继续消费。
- TS：binary/probe/adapter 失败码、4001 条截断、无 helper 回退、generation/项目切换迟到结果、
  旧 `remoteProjectList` 与目录页共享事实。
- 页面：2000/2001 截断、未知 children、展开目录刷新、目录事实通知与 watch 降级保持。
- 门禁：`go test ./...`、`go vet ./...`、相关 Node 定向测试、`typecheck`、IPC wiring、
  test-shape、format。真实 SSH 留给最终集成 Agent。
